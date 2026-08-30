import type { ReservedConnection } from './engine.ts';
import {
  parseP0BState,
  transitionP0BState,
  type P0BState,
  type P0BTransitionInput,
} from './p0b-additive-bridge.ts';

export const P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT = Object.freeze({
  schema_version: 1,
  schema_identity: 'gbrain:p0b:google-g768-control-postgres:v1',
  singleton_key: 'google-g768',
  state_table: 'p0b_google_bridge_state',
  checkpoint_table: 'p0b_google_reconciler_checkpoint',
  nonce_ledger_table: 'p0b_google_control_nonce_ledger',
  migration_required: true,
  migration_execution: 'FORBIDDEN_IN_ADAPTER',
  schema_gate: 'INCOMPLETE_MOCK_ONLY',
} as const);

/** Documentation-only schema outline. This mock adapter never installs schema. */
export interface P0BGoogleBridgeStateSchemaOutline {
  readonly singleton_key: 'text primary key';
  readonly schema_identity: 'text not null';
  readonly state_json: 'jsonb not null';
  readonly state_fingerprint: 'text not null';
}

export interface P0BGoogleCheckpointLeaseSchemaOutline {
  readonly singleton_key: 'text primary key';
  readonly schema_identity: 'text not null';
  readonly revision: 'text not null';
  readonly fence_epoch: 'bigint not null';
  readonly fence_token: 'text not null';
  readonly lease_id: 'text not null';
  readonly lease_nonce: 'text not null';
  readonly lease_expires_at: 'timestamptz not null';
}

export interface P0BGoogleControlNonceLedgerSchemaOutline {
  readonly singleton_key: 'text not null';
  readonly nonce: 'text not null';
  readonly action: 'text not null';
  readonly state_fingerprint: 'text not null';
  readonly checkpoint_revision: 'text not null';
  readonly issued_at: 'timestamptz not null';
  readonly primary_key: '(singleton_key, nonce)';
}

export type P0BGoogleControlPostgresErrorCode =
  | 'INVALID_REQUEST'
  | 'DEADLINE_EXCEEDED'
  | 'LIFECYCLE_READ_FAILED'
  | 'STATE_CAS_CONFLICT'
  | 'STATE_CONFLICT'
  | 'CHECKPOINT_CAS'
  | 'LOST_LEASE'
  | 'FENCE_MISMATCH'
  | 'NONCE_REPLAY'
  | 'FENCE_EXHAUSTED'
  | 'TRANSACTION_FAILED';

export class P0BGoogleControlPostgresError extends Error {
  readonly code: P0BGoogleControlPostgresErrorCode;

  constructor(code: P0BGoogleControlPostgresErrorCode) {
    super(code);
    this.name = 'P0BGoogleControlPostgresError';
    this.code = code;
  }
}

export interface P0BGoogleControlClock {
  readonly now_epoch_ms: () => unknown;
}

export interface P0BGoogleTrustedTransitionAuthority {
  readonly authenticity: 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED';
  readonly expected_artifact_digest: string;
  readonly expected_root_digest: string;
  readonly allowed_actors: readonly string[];
}

export interface P0BGoogleControlPostgres {
  readonly read_state: (request: unknown) => Promise<P0BState>;
  readonly cas_state: (request: unknown) => Promise<P0BState>;
  readonly issue_lease: (request: unknown) => Promise<unknown>;
  readonly renew_lease: (request: unknown) => Promise<unknown>;
  readonly release_lease: (request: unknown) => Promise<unknown>;
}

const SET_STATEMENT_TIMEOUT_SQL = "SELECT set_config('statement_timeout', $1, true) AS statement_timeout";
const SET_LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true) AS lock_timeout";

const READ_STATE_SQL = `
SELECT state_json, state_fingerprint
FROM p0b_google_bridge_state
WHERE singleton_key = $1
  AND schema_identity = $2
`.trim();

const CAS_STATE_SQL = `
UPDATE p0b_google_bridge_state AS state
SET state_json = $1::text::jsonb,
    state_fingerprint = $2
WHERE state.singleton_key = $3
  AND state.schema_identity = $4
  AND state.state_fingerprint = $5
  AND EXISTS (
    SELECT 1 FROM p0b_google_reconciler_checkpoint AS checkpoint
    WHERE checkpoint.singleton_key = state.singleton_key
      AND checkpoint.schema_identity = 'gbrain:p0b:google-g768-reconciler-postgres:v1'
      AND checkpoint.revision = $6
  )
RETURNING state_json, state_fingerprint
`.trim();

const LOCK_CONTROL_SQL = `
SELECT
  state.state_json,
  state.state_fingerprint,
  checkpoint.revision,
  checkpoint.fence_epoch::text AS fence_epoch_text,
  checkpoint.lease_id,
  checkpoint.lease_nonce,
  checkpoint.fence_token,
  CASE WHEN checkpoint.lease_expires_at = '-infinity'::timestamptz
    THEN NULL
    ELSE floor(EXTRACT(EPOCH FROM checkpoint.lease_expires_at) * 1000)::bigint::text
  END AS lease_expires_at_epoch_ms_text,
  floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS db_now_epoch_ms_text
FROM p0b_google_bridge_state AS state
JOIN p0b_google_reconciler_checkpoint AS checkpoint ON checkpoint.singleton_key = state.singleton_key
WHERE state.singleton_key = $1
  AND state.schema_identity = $2
  AND checkpoint.schema_identity = $3
FOR UPDATE OF state, checkpoint
`.trim();

const INSERT_NONCE_SQL = `
INSERT INTO p0b_google_control_nonce_ledger (
  singleton_key, nonce, action, state_fingerprint, checkpoint_revision, issued_at
) VALUES ($1, $2, 'ISSUE_LEASE', $3, $4, clock_timestamp())
ON CONFLICT (singleton_key, nonce) DO NOTHING
RETURNING nonce
`.trim();

const REVOKE_LEASE_FOR_TRANSITION_SQL = `
UPDATE p0b_google_reconciler_checkpoint
SET lease_id = 'inactive',
    lease_nonce = 'inactive',
    lease_expires_at = '-infinity',
    fence_epoch = fence_epoch + 1,
    fence_token = 'fence-' || lpad((fence_epoch + 1)::text, 20, '0')
WHERE singleton_key = $1
  AND schema_identity = $2
  AND revision = $3
  AND fence_epoch = $4::bigint
RETURNING revision, fence_epoch::text AS fence_epoch_text, lease_id, lease_nonce, fence_token,
  NULL::text AS lease_expires_at_epoch_ms_text
`.trim();

const ISSUE_LEASE_SQL = `
UPDATE p0b_google_reconciler_checkpoint
SET lease_id = $1,
    lease_nonce = $2,
    fence_epoch = fence_epoch + 1,
    fence_token = 'fence-' || lpad((fence_epoch + 1)::text, 20, '0'),
    lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond')
WHERE singleton_key = $4
  AND schema_identity = $5
  AND EXISTS (
    SELECT 1 FROM p0b_google_bridge_state AS state
    WHERE state.singleton_key = $4
      AND state.schema_identity = $6
      AND state.state_fingerprint = $7
      AND state.state_json->>'state' = 'RECONCILING'
  )
  AND revision = $8
  AND lease_expires_at <= clock_timestamp()
RETURNING
  $7::text AS state_fingerprint,
  revision,
  fence_epoch::text AS fence_epoch_text,
  lease_id,
  fence_token,
  floor(EXTRACT(EPOCH FROM lease_expires_at) * 1000)::bigint::text AS lease_expires_at_epoch_ms_text
`.trim();

const RENEW_LEASE_SQL = `
UPDATE p0b_google_reconciler_checkpoint
SET lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond')
WHERE singleton_key = $4
  AND schema_identity = $5
  AND revision = $6
  AND lease_id = $1
  AND fence_token = $2
  AND lease_expires_at > clock_timestamp()
  AND EXISTS (
    SELECT 1 FROM p0b_google_bridge_state AS state
    WHERE state.singleton_key = $4
      AND state.schema_identity = $8
      AND state.state_fingerprint = $7
      AND state.state_json->>'state' = 'RECONCILING'
  )
RETURNING
  $7::text AS state_fingerprint,
  revision,
  fence_epoch::text AS fence_epoch_text,
  lease_id,
  fence_token,
  floor(EXTRACT(EPOCH FROM lease_expires_at) * 1000)::bigint::text AS lease_expires_at_epoch_ms_text
`.trim();

const RELEASE_LEASE_SQL = `
UPDATE p0b_google_reconciler_checkpoint
SET lease_id = 'inactive',
    lease_nonce = 'inactive',
    lease_expires_at = '-infinity'
WHERE singleton_key = $3
  AND schema_identity = $4
  AND revision = $5
  AND lease_id = $1
  AND fence_token = $2
  AND lease_expires_at > clock_timestamp()
RETURNING
  $6::text AS state_fingerprint,
  revision,
  fence_epoch::text AS fence_epoch_text,
  lease_id,
  fence_token,
  NULL::text AS lease_expires_at_epoch_ms_text
`.trim();

const STATE_KEYS = [
  'schema_version', 'state', 'previous_search_column', 'consumed_nonces', 'rollback_target', 'fingerprint',
] as const;
const READ_REQUEST_KEYS = ['schema_version', 'deadline_epoch_ms'] as const;
const CAS_REQUEST_KEYS = [
  'schema_version', 'transition', 'expected_checkpoint_revision', 'deadline_epoch_ms',
] as const;
const TRANSITION_REQUEST_KEYS = ['authorization'] as const;
const TRANSITION_REQUEST_WITH_ROLLBACK_KEYS = ['authorization', 'rollback_policy'] as const;
const TRUSTED_AUTHORITY_KEYS = [
  'authenticity', 'expected_artifact_digest', 'expected_root_digest', 'allowed_actors',
] as const;
const ISSUE_REQUEST_KEYS = [
  'schema_version', 'expected_state_fingerprint', 'expected_checkpoint_revision',
  'lease_id', 'nonce', 'duration_ms', 'deadline_epoch_ms',
] as const;
const HELD_REQUEST_KEYS = [
  'schema_version', 'expected_state_fingerprint', 'expected_checkpoint_revision',
  'authority', 'duration_ms', 'deadline_epoch_ms',
] as const;
const RELEASE_REQUEST_KEYS = [
  'schema_version', 'expected_state_fingerprint', 'expected_checkpoint_revision',
  'authority', 'deadline_epoch_ms',
] as const;
const AUTHORITY_KEYS = ['lease_id', 'fence_token'] as const;
const LOCK_ROW_KEYS = [
  'state_json', 'state_fingerprint', 'revision', 'fence_epoch_text', 'lease_id', 'lease_nonce',
  'fence_token', 'lease_expires_at_epoch_ms_text', 'db_now_epoch_ms_text',
] as const;
const LEASE_RETURNING_KEYS = [
  'state_fingerprint', 'revision', 'fence_epoch_text', 'lease_id', 'fence_token',
  'lease_expires_at_epoch_ms_text',
] as const;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/;
const NONCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$/;
const FENCE_RE = /^fence-[0-9]{20}$/;
const MAX_LEASE_DURATION_MS = 300_000;
const CHECKPOINT_SCHEMA_IDENTITY = 'gbrain:p0b:google-g768-reconciler-postgres:v1';

class TransactionConflict extends Error {
  constructor(readonly code: P0BGoogleControlPostgresErrorCode) {
    super('transaction conflict');
  }
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a data record');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('non-data prototype');
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some(key => typeof key !== 'string')) throw new Error('symbol property');
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('non-data property');
    }
  }
  return record;
}

function cloneData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new Error('non-data value');
  if (seen.has(value)) throw new Error('cyclic data');
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('non-data array');
    const keys = Reflect.ownKeys(value);
    const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length'];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('array shape');
    const clone: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error('array property');
      clone.push(cloneData(descriptor.value, seen));
    }
    return clone;
  }
  const record = dataRecord(value);
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(record)) clone[key] = cloneData(record[key], seen);
  return clone;
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = dataRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('record shape mismatch');
  }
  return record;
}

function exactOne(rows: unknown[], keys: readonly string[]): Record<string, unknown> {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('row cardinality mismatch');
  return exactDataRecord(rows[0], keys);
}

function trustedNow(clock: P0BGoogleControlClock): number {
  let value: unknown;
  try {
    value = clock.now_epoch_ms.call(clock);
  } catch {
    throw new P0BGoogleControlPostgresError('DEADLINE_EXCEEDED');
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new P0BGoogleControlPostgresError('DEADLINE_EXCEEDED');
  }
  return value as number;
}

function remainingMilliseconds(clock: P0BGoogleControlClock, deadline: number): number {
  const remaining = deadline - trustedNow(clock);
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new P0BGoogleControlPostgresError('DEADLINE_EXCEEDED');
  }
  return remaining;
}

function parseDeadline(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('invalid deadline');
  return value as number;
}

function parseReadRequest(value: unknown): { schema_version: 1; deadline_epoch_ms: number } {
  const record = exactDataRecord(cloneData(value), READ_REQUEST_KEYS);
  if (record.schema_version !== 1) throw new Error('invalid schema version');
  return Object.freeze({ schema_version: 1, deadline_epoch_ms: parseDeadline(record.deadline_epoch_ms) });
}

function parseCasRequest(value: unknown): {
  schema_version: 1;
  transition: {
    readonly authorization: P0BTransitionInput['authorization'];
    readonly rollback_policy?: P0BTransitionInput['rollback_policy'];
  };
  expected_checkpoint_revision: string;
  deadline_epoch_ms: number;
} {
  const record = exactDataRecord(cloneData(value), CAS_REQUEST_KEYS);
  if (record.schema_version !== 1) throw new Error('invalid schema version');
  const transitionRecord = dataRecord(record.transition);
  const transitionKeys = Object.keys(transitionRecord);
  const hasRollback = transitionKeys.includes('rollback_policy');
  exactDataRecord(
    transitionRecord,
    hasRollback ? TRANSITION_REQUEST_WITH_ROLLBACK_KEYS : TRANSITION_REQUEST_KEYS,
  );
  return Object.freeze({
    schema_version: 1,
    transition: Object.freeze({
      authorization: transitionRecord.authorization as P0BTransitionInput['authorization'],
      ...(hasRollback
        ? { rollback_policy: transitionRecord.rollback_policy as P0BTransitionInput['rollback_policy'] }
        : {}),
    }),
    expected_checkpoint_revision: digest(record.expected_checkpoint_revision),
    deadline_epoch_ms: parseDeadline(record.deadline_epoch_ms),
  });
}

function parseTrustedTransitionAuthority(value: unknown): P0BGoogleTrustedTransitionAuthority {
  const record = exactDataRecord(cloneData(value), TRUSTED_AUTHORITY_KEYS);
  if (record.authenticity !== 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED') throw new Error('invalid authenticity');
  const allowedActors = cloneData(record.allowed_actors);
  if (!Array.isArray(allowedActors) || allowedActors.length === 0
    || allowedActors.some(actor => typeof actor !== 'string')) throw new Error('invalid allowed actors');
  return Object.freeze({
    authenticity: 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED',
    expected_artifact_digest: digest(record.expected_artifact_digest),
    expected_root_digest: digest(record.expected_root_digest),
    allowed_actors: Object.freeze([...allowedActors]) as readonly string[],
  });
}

interface LeaseAuthority {
  readonly lease_id: string;
  readonly fence_token: string;
}

interface IssueLeaseRequest {
  readonly schema_version: 1;
  readonly expected_state_fingerprint: string;
  readonly expected_checkpoint_revision: string;
  readonly lease_id: string;
  readonly nonce: string;
  readonly duration_ms: number;
  readonly deadline_epoch_ms: number;
}

interface HeldLeaseRequest {
  readonly schema_version: 1;
  readonly expected_state_fingerprint: string;
  readonly expected_checkpoint_revision: string;
  readonly authority: LeaseAuthority;
  readonly duration_ms?: number;
  readonly deadline_epoch_ms: number;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new Error('invalid digest');
  return value;
}

function duration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_LEASE_DURATION_MS) {
    throw new Error('invalid duration');
  }
  return value as number;
}

function parseAuthority(value: unknown): LeaseAuthority {
  const record = exactDataRecord(value, AUTHORITY_KEYS);
  if (typeof record.lease_id !== 'string' || record.lease_id === 'inactive' || !ID_RE.test(record.lease_id)) throw new Error('invalid lease id');
  if (typeof record.fence_token !== 'string' || !FENCE_RE.test(record.fence_token)) throw new Error('invalid fence');
  return Object.freeze({ lease_id: record.lease_id, fence_token: record.fence_token });
}

function parseIssueRequest(value: unknown): IssueLeaseRequest {
  const record = exactDataRecord(cloneData(value), ISSUE_REQUEST_KEYS);
  if (record.schema_version !== 1) throw new Error('invalid schema version');
  if (typeof record.lease_id !== 'string' || record.lease_id === 'inactive' || !ID_RE.test(record.lease_id)) throw new Error('invalid lease id');
  if (typeof record.nonce !== 'string' || !NONCE_RE.test(record.nonce)) throw new Error('invalid nonce');
  return Object.freeze({
    schema_version: 1,
    expected_state_fingerprint: digest(record.expected_state_fingerprint),
    expected_checkpoint_revision: digest(record.expected_checkpoint_revision),
    lease_id: record.lease_id,
    nonce: record.nonce,
    duration_ms: duration(record.duration_ms),
    deadline_epoch_ms: parseDeadline(record.deadline_epoch_ms),
  });
}

function parseHeldRequest(value: unknown, release: boolean): HeldLeaseRequest {
  const record = exactDataRecord(cloneData(value), release ? RELEASE_REQUEST_KEYS : HELD_REQUEST_KEYS);
  if (record.schema_version !== 1) throw new Error('invalid schema version');
  return Object.freeze({
    schema_version: 1,
    expected_state_fingerprint: digest(record.expected_state_fingerprint),
    expected_checkpoint_revision: digest(record.expected_checkpoint_revision),
    authority: parseAuthority(record.authority),
    ...(release ? {} : { duration_ms: duration(record.duration_ms) }),
    deadline_epoch_ms: parseDeadline(record.deadline_epoch_ms),
  });
}

function canonicalBigintText(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid bigint text');
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw new Error('bigint overflow');
  return value;
}

function serializeState(state: P0BState): string {
  return JSON.stringify({
    schema_version: state.schema_version,
    state: state.state,
    previous_search_column: state.previous_search_column,
    consumed_nonces: state.consumed_nonces,
    rollback_target: state.rollback_target,
    fingerprint: state.fingerprint,
  });
}

function parseStoredState(row: Record<string, unknown>): P0BState {
  if (typeof row.state_fingerprint !== 'string' || !DIGEST_RE.test(row.state_fingerprint)) {
    throw new Error('invalid stored fingerprint');
  }
  let raw: unknown = row.state_json;
  if (typeof raw === 'string') raw = JSON.parse(raw);
  const state = parseP0BState(exactDataRecord(cloneData(raw), STATE_KEYS));
  if (state.fingerprint !== row.state_fingerprint) throw new Error('stored fingerprint mismatch');
  return state;
}

interface LockedControl {
  readonly row: Record<string, unknown>;
  readonly state: P0BState;
  readonly database_now: bigint;
  readonly lease_expiry: bigint | null;
}

function parseLockedControl(value: unknown): LockedControl {
  const row = exactDataRecord(value, LOCK_ROW_KEYS);
  const state = parseStoredState(row);
  digest(row.revision);
  const fenceEpoch = canonicalBigintText(row.fence_epoch_text);
  if (typeof row.lease_id !== 'string' || typeof row.lease_nonce !== 'string' || typeof row.fence_token !== 'string') {
    throw new Error('invalid lease row');
  }
  if (!FENCE_RE.test(row.fence_token) || row.fence_token !== `fence-${fenceEpoch.padStart(20, '0')}`) {
    throw new Error('fence tuple mismatch');
  }
  const databaseNowText = canonicalBigintText(row.db_now_epoch_ms_text);
  const expiryText = row.lease_expires_at_epoch_ms_text === null
    ? null
    : canonicalBigintText(row.lease_expires_at_epoch_ms_text);
  if (expiryText === null) {
    if (row.lease_id !== 'inactive' || row.lease_nonce !== 'inactive') throw new Error('inactive tuple mismatch');
  } else if (
    row.lease_id === 'inactive' || !ID_RE.test(row.lease_id)
    || row.lease_nonce === 'inactive' || !NONCE_RE.test(row.lease_nonce)
  ) throw new Error('active tuple mismatch');
  return Object.freeze({
    row,
    state,
    database_now: BigInt(databaseNowText),
    lease_expiry: expiryText === null ? null : BigInt(expiryText),
  });
}

function assertLifecycleAndCheckpoint(
  locked: LockedControl,
  expectedStateFingerprint: string,
  expectedCheckpointRevision: string,
): void {
  if (locked.state.state !== 'RECONCILING') throw new TransactionConflict('STATE_CONFLICT');
  if (locked.state.fingerprint !== expectedStateFingerprint) throw new TransactionConflict('STATE_CONFLICT');
  if (locked.row.revision !== expectedCheckpointRevision) throw new TransactionConflict('CHECKPOINT_CAS');
}

function assertHeldAuthority(locked: LockedControl, authority: LeaseAuthority): void {
  if (locked.row.lease_id !== authority.lease_id) throw new TransactionConflict('LOST_LEASE');
  if (locked.row.fence_token !== authority.fence_token) throw new TransactionConflict('FENCE_MISMATCH');
  if (locked.lease_expiry === null || locked.lease_expiry <= locked.database_now) {
    throw new TransactionConflict('LOST_LEASE');
  }
}

function leaseReceipt(value: unknown, status: 'issued' | 'renewed' | 'released') {
  const row = exactDataRecord(value, LEASE_RETURNING_KEYS);
  const stateFingerprint = digest(row.state_fingerprint);
  const checkpointRevision = digest(row.revision);
  const fenceEpoch = canonicalBigintText(row.fence_epoch_text);
  if (typeof row.lease_id !== 'string' || (row.lease_id !== 'inactive' && !ID_RE.test(row.lease_id))) {
    throw new Error('invalid returned lease id');
  }
  if (typeof row.fence_token !== 'string' || !FENCE_RE.test(row.fence_token)) throw new Error('invalid returned fence');
  const expectedFence = `fence-${fenceEpoch.padStart(20, '0')}`;
  if (row.fence_token !== expectedFence) throw new Error('fence identity mismatch');
  const expiry = row.lease_expires_at_epoch_ms_text === null
    ? null
    : canonicalBigintText(row.lease_expires_at_epoch_ms_text);
  if ((status === 'released') !== (expiry === null && row.lease_id === 'inactive')) {
    throw new Error('lease activity mismatch');
  }
  return Object.freeze({
    schema_version: 1,
    status,
    authority: Object.freeze({ lease_id: row.lease_id, fence_token: row.fence_token }),
    fence_epoch: fenceEpoch,
    checkpoint_revision: checkpointRevision,
    state_fingerprint: stateFingerprint,
    lease_expires_at_epoch_ms: expiry,
  });
}

async function lockControl(
  tx: ReservedConnection,
  clock: P0BGoogleControlClock,
  deadline: number,
): Promise<LockedControl> {
  const row = exactOne(await executeBounded(tx, clock, deadline, LOCK_CONTROL_SQL, [
    P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.singleton_key,
    P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.schema_identity,
    CHECKPOINT_SCHEMA_IDENTITY,
  ]), LOCK_ROW_KEYS);
  const locked = parseLockedControl(row);
  if (locked.database_now >= BigInt(deadline)) throw new P0BGoogleControlPostgresError('DEADLINE_EXCEEDED');
  return locked;
}

async function configureTransactionTimeouts(
  connection: ReservedConnection,
  clock: P0BGoogleControlClock,
  deadline: number,
): Promise<void> {
  const statementDuration = `${Math.min(remainingMilliseconds(clock, deadline), 30_000)}ms`;
  const statement = exactOne(
    await connection.executeRaw(SET_STATEMENT_TIMEOUT_SQL, [statementDuration]),
    ['statement_timeout'],
  );
  if (statement.statement_timeout !== statementDuration) throw new Error('statement timeout mismatch');
  const lockDuration = `${Math.min(remainingMilliseconds(clock, deadline), 5_000)}ms`;
  const lock = exactOne(
    await connection.executeRaw(SET_LOCK_TIMEOUT_SQL, [lockDuration]),
    ['lock_timeout'],
  );
  if (lock.lock_timeout !== lockDuration) throw new Error('lock timeout mismatch');
}

async function executeBounded<T = Record<string, unknown>>(
  connection: ReservedConnection,
  clock: P0BGoogleControlClock,
  deadline: number,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  await configureTransactionTimeouts(connection, clock, deadline);
  return connection.executeRaw<T>(sql, params);
}

function invalidRequest(error: unknown): never {
  if (error instanceof P0BGoogleControlPostgresError) throw error;
  throw new P0BGoogleControlPostgresError('INVALID_REQUEST');
}

export function createP0BGoogleControlPostgres(
  connection: ReservedConnection,
  clock: P0BGoogleControlClock,
  trustedTransitionAuthority: P0BGoogleTrustedTransitionAuthority,
): P0BGoogleControlPostgres {
  let trustedAuthority: P0BGoogleTrustedTransitionAuthority;
  try {
    trustedAuthority = parseTrustedTransitionAuthority(trustedTransitionAuthority);
  } catch {
    throw new P0BGoogleControlPostgresError('INVALID_REQUEST');
  }
  return Object.freeze({
    read_state: async (value: unknown) => {
      let request: ReturnType<typeof parseReadRequest>;
      try {
        request = parseReadRequest(value);
        remainingMilliseconds(clock, request.deadline_epoch_ms);
      } catch (error) {
        invalidRequest(error);
      }
      try {
        return await connection.transactionRaw(async tx => {
          const row = exactOne(await executeBounded(tx, clock, request.deadline_epoch_ms, READ_STATE_SQL, [
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.singleton_key,
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.schema_identity,
          ]), ['state_json', 'state_fingerprint']);
          return parseStoredState(row);
        });
      } catch {
        throw new P0BGoogleControlPostgresError('LIFECYCLE_READ_FAILED');
      }
    },

    cas_state: async (value: unknown) => {
      let request: ReturnType<typeof parseCasRequest>;
      try {
        request = parseCasRequest(value);
        remainingMilliseconds(clock, request.deadline_epoch_ms);
      } catch (error) {
        invalidRequest(error);
      }
      try {
        return await connection.transactionRaw(async tx => {
          const locked = await lockControl(tx, clock, request.deadline_epoch_ms);
          if (locked.row.revision !== request.expected_checkpoint_revision) {
            throw new TransactionConflict('CHECKPOINT_CAS');
          }
          if (locked.state.state !== 'RECONCILING' && locked.lease_expiry !== null) {
            throw new TransactionConflict('STATE_CONFLICT');
          }
          let transition;
          try {
            transition = transitionP0BState(locked.state, {
              authorization: request.transition.authorization,
              authorization_authority: {
                ...trustedAuthority,
                now: Number(locked.database_now),
              } as P0BTransitionInput['authorization_authority'],
              ...(request.transition.rollback_policy === undefined
                ? {}
                : { rollback_policy: request.transition.rollback_policy }),
            });
          } catch {
            throw new TransactionConflict('STATE_CONFLICT');
          }
          const leavingReconciling = locked.state.state === 'RECONCILING'
            && transition.state.state !== 'RECONCILING';
          if (leavingReconciling) {
            if (locked.row.fence_epoch_text === '9223372036854775807') {
              throw new TransactionConflict('FENCE_EXHAUSTED');
            }
            const revokedRows = await executeBounded(tx, clock, request.deadline_epoch_ms, REVOKE_LEASE_FOR_TRANSITION_SQL, [
              P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.singleton_key,
              CHECKPOINT_SCHEMA_IDENTITY,
              request.expected_checkpoint_revision,
              locked.row.fence_epoch_text,
            ]);
            if (revokedRows.length === 0) throw new TransactionConflict('CHECKPOINT_CAS');
            const revoked = exactOne(revokedRows, [
              'revision', 'fence_epoch_text', 'lease_id', 'lease_nonce', 'fence_token',
              'lease_expires_at_epoch_ms_text',
            ]);
            if (
              revoked.revision !== request.expected_checkpoint_revision
              || revoked.lease_id !== 'inactive'
              || revoked.lease_nonce !== 'inactive'
              || revoked.lease_expires_at_epoch_ms_text !== null
              || BigInt(canonicalBigintText(revoked.fence_epoch_text)) !== BigInt(locked.row.fence_epoch_text as string) + 1n
              || revoked.fence_token !== `fence-${String(revoked.fence_epoch_text).padStart(20, '0')}`
            ) throw new Error('revocation tuple mismatch');
          }
          const rows = await executeBounded(tx, clock, request.deadline_epoch_ms, CAS_STATE_SQL, [
            serializeState(transition.state),
            transition.persistence_cas.new_fingerprint,
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.singleton_key,
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.schema_identity,
            transition.persistence_cas.expected_fingerprint,
            request.expected_checkpoint_revision,
          ]);
          if (rows.length === 0) throw new TransactionConflict('STATE_CAS_CONFLICT');
          return parseStoredState(exactOne(rows, ['state_json', 'state_fingerprint']));
        });
      } catch (error) {
        if (error instanceof TransactionConflict) throw new P0BGoogleControlPostgresError(error.code);
        throw new P0BGoogleControlPostgresError('TRANSACTION_FAILED');
      }
    },

    issue_lease: async (value: unknown) => {
      let request: IssueLeaseRequest;
      try {
        request = parseIssueRequest(value);
        remainingMilliseconds(clock, request.deadline_epoch_ms);
      } catch (error) {
        invalidRequest(error);
      }
      try {
        return await connection.transactionRaw(async tx => {
          const locked = await lockControl(tx, clock, request.deadline_epoch_ms);
          assertLifecycleAndCheckpoint(
            locked, request.expected_state_fingerprint, request.expected_checkpoint_revision,
          );
          if (locked.lease_expiry !== null && locked.lease_expiry > locked.database_now) {
            throw new TransactionConflict('LOST_LEASE');
          }
          if (locked.row.fence_epoch_text === '9223372036854775807') {
            throw new TransactionConflict('FENCE_EXHAUSTED');
          }
          const nonceRows = await executeBounded(tx, clock, request.deadline_epoch_ms, INSERT_NONCE_SQL, [
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.singleton_key,
            request.nonce,
            request.expected_state_fingerprint,
            request.expected_checkpoint_revision,
          ]);
          if (nonceRows.length === 0) throw new TransactionConflict('NONCE_REPLAY');
          const nonceRow = exactOne(nonceRows, ['nonce']);
          if (nonceRow.nonce !== request.nonce) throw new Error('nonce identity mismatch');
          const rows = await executeBounded(tx, clock, request.deadline_epoch_ms, ISSUE_LEASE_SQL, [
            request.lease_id,
            request.nonce,
            request.duration_ms,
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.singleton_key,
            CHECKPOINT_SCHEMA_IDENTITY,
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.schema_identity,
            request.expected_state_fingerprint,
            request.expected_checkpoint_revision,
          ]);
          if (rows.length === 0) throw new TransactionConflict('LOST_LEASE');
          const receipt = leaseReceipt(exactOne(rows, LEASE_RETURNING_KEYS), 'issued');
          if (
            receipt.authority.lease_id !== request.lease_id
            || BigInt(receipt.fence_epoch) !== BigInt(canonicalBigintText(locked.row.fence_epoch_text)) + 1n
          ) throw new Error('issued identity mismatch');
          return receipt;
        });
      } catch (error) {
        if (error instanceof TransactionConflict) throw new P0BGoogleControlPostgresError(error.code);
        if (error instanceof P0BGoogleControlPostgresError && error.code === 'DEADLINE_EXCEEDED') throw error;
        throw new P0BGoogleControlPostgresError('TRANSACTION_FAILED');
      }
    },

    renew_lease: async (value: unknown) => {
      let request: HeldLeaseRequest;
      try {
        request = parseHeldRequest(value, false);
        remainingMilliseconds(clock, request.deadline_epoch_ms);
      } catch (error) {
        invalidRequest(error);
      }
      try {
        return await connection.transactionRaw(async tx => {
          const locked = await lockControl(tx, clock, request.deadline_epoch_ms);
          assertLifecycleAndCheckpoint(
            locked, request.expected_state_fingerprint, request.expected_checkpoint_revision,
          );
          assertHeldAuthority(locked, request.authority);
          const rows = await executeBounded(tx, clock, request.deadline_epoch_ms, RENEW_LEASE_SQL, [
            request.authority.lease_id,
            request.authority.fence_token,
            request.duration_ms,
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.singleton_key,
            CHECKPOINT_SCHEMA_IDENTITY,
            request.expected_checkpoint_revision,
            request.expected_state_fingerprint,
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.schema_identity,
          ]);
          if (rows.length === 0) throw new TransactionConflict('LOST_LEASE');
          const receipt = leaseReceipt(exactOne(rows, LEASE_RETURNING_KEYS), 'renewed');
          if (
            receipt.authority.lease_id !== request.authority.lease_id
            || receipt.authority.fence_token !== request.authority.fence_token
            || receipt.fence_epoch !== locked.row.fence_epoch_text
          ) throw new Error('renewed identity mismatch');
          return receipt;
        });
      } catch (error) {
        if (error instanceof TransactionConflict) throw new P0BGoogleControlPostgresError(error.code);
        if (error instanceof P0BGoogleControlPostgresError && error.code === 'DEADLINE_EXCEEDED') throw error;
        throw new P0BGoogleControlPostgresError('TRANSACTION_FAILED');
      }
    },

    release_lease: async (value: unknown) => {
      let request: HeldLeaseRequest;
      try {
        request = parseHeldRequest(value, true);
        remainingMilliseconds(clock, request.deadline_epoch_ms);
      } catch (error) {
        invalidRequest(error);
      }
      try {
        return await connection.transactionRaw(async tx => {
          const locked = await lockControl(tx, clock, request.deadline_epoch_ms);
          if (locked.state.fingerprint !== request.expected_state_fingerprint) {
            throw new TransactionConflict('STATE_CONFLICT');
          }
          if (locked.row.revision !== request.expected_checkpoint_revision) {
            throw new TransactionConflict('CHECKPOINT_CAS');
          }
          assertHeldAuthority(locked, request.authority);
          const rows = await executeBounded(tx, clock, request.deadline_epoch_ms, RELEASE_LEASE_SQL, [
            request.authority.lease_id,
            request.authority.fence_token,
            P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT.singleton_key,
            CHECKPOINT_SCHEMA_IDENTITY,
            request.expected_checkpoint_revision,
            request.expected_state_fingerprint,
          ]);
          if (rows.length === 0) throw new TransactionConflict('LOST_LEASE');
          const receipt = leaseReceipt(exactOne(rows, LEASE_RETURNING_KEYS), 'released');
          if (
            receipt.authority.fence_token !== request.authority.fence_token
            || receipt.fence_epoch !== locked.row.fence_epoch_text
          ) throw new Error('released identity mismatch');
          return receipt;
        });
      } catch (error) {
        if (error instanceof TransactionConflict) throw new P0BGoogleControlPostgresError(error.code);
        if (error instanceof P0BGoogleControlPostgresError && error.code === 'DEADLINE_EXCEEDED') throw error;
        throw new P0BGoogleControlPostgresError('TRANSACTION_FAILED');
      }
    },
  });
}
