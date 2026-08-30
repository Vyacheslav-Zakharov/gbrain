import type { ReservedConnection } from './engine.ts';
import {
  P0B_GOOGLE_RECONCILER_CONTRACT,
  P0BGoogleReconcilerError,
  runP0BGoogleReconciler,
  type P0BGoogleReconcilerInput,
  type P0BGoogleReconcilerReceipt,
} from './p0b-google-reconciler.ts';

export const P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT = Object.freeze({
  schema_version: 1,
  schema_identity: 'gbrain:p0b:google-g768-reconciler-postgres:v1',
  coordination: 'PERSISTED_LEASE_FENCE_AND_CHECKPOINT_CAS',
  checkpoint_singleton_key: 'google-g768',
  checkpoint_table: 'p0b_google_reconciler_checkpoint',
  provenance_table: 'p0b_google_embedding_provenance',
  migration_required: true,
  migration_execution: 'FORBIDDEN_IN_ADAPTER',
  schema_gate: 'INCOMPLETE_MOCK_ONLY',
} as const);

export type P0BGoogleReconcilerPostgresErrorCode =
  | 'POSTGRES_REQUIRED'
  | 'SCHEMA_MISMATCH'
  | 'SESSION_FAILED'
  | 'TRANSACTION_FAILED';

export class P0BGoogleReconcilerPostgresError extends Error {
  readonly code: P0BGoogleReconcilerPostgresErrorCode;

  constructor(code: P0BGoogleReconcilerPostgresErrorCode) {
    super(code);
    this.name = 'P0BGoogleReconcilerPostgresError';
    this.code = code;
  }
}

export interface P0BPostgresClock {
  readonly now_epoch_ms: () => unknown;
}

interface Cursor {
  readonly chunk_index: number;
  readonly chunk_id: string;
}

interface Checkpoint {
  readonly schema_version: 1;
  readonly pass: number;
  readonly cursor: Cursor | null;
  readonly revision: string;
}

interface Authority {
  readonly lease_id: string;
  readonly fence_token: string;
}

interface ExpectedRow {
  readonly chunk_id: string;
  readonly page_id: string;
  readonly chunk_index: number;
  readonly chunk_text: string;
  readonly chunk_source: string;
  readonly page_content_hash: string | null;
  readonly page_generation: number;
  readonly source_fingerprint: string;
}

interface CommitUpdate {
  readonly chunk_id: string;
  readonly expected_row: ExpectedRow;
  readonly vector: readonly number[];
}

interface CommitRequest {
  readonly schema_version: 1;
  readonly kind: 'BATCH' | 'PASS_COMPLETE';
  readonly authority: Authority;
  readonly expected_checkpoint: Checkpoint;
  readonly new_checkpoint: Checkpoint;
  readonly updates: readonly CommitUpdate[];
  readonly deadline_epoch_ms: number;
}

interface ReadRequest {
  readonly schema_version: 1;
  readonly pass: number;
  readonly after: Cursor | null;
  readonly max_rows: number;
  readonly deadline_epoch_ms: number;
  readonly authority: Authority;
}

type ConflictReason = 'CHECKPOINT_CAS' | 'LOST_LEASE' | 'FENCE_MISMATCH';

class TransactionConflict extends Error {
  constructor(
    readonly reason: ConflictReason,
    readonly checkpoint: Checkpoint,
  ) {
    super('transaction conflict');
  }
}

export interface P0BGoogleReconcilerPostgresPorts {
  readonly read_batch: (request: unknown) => Promise<unknown>;
  readonly commit: (request: unknown) => Promise<unknown>;
}

export interface P0BGoogleReconcilerPostgresInput {
  readonly kind: 'postgres';
  readonly withReservedConnection: <T>(
    work: (connection: ReservedConnection) => Promise<T>,
  ) => Promise<T>;
  readonly initial_checkpoint: unknown;
  readonly limits: unknown;
  readonly authority: unknown;
  readonly clock: P0BPostgresClock;
  readonly provider: P0BGoogleReconcilerInput['provider'];
  readonly cancellation: P0BGoogleReconcilerInput['cancellation'];
}

const SCHEMA_ASSERT_SQL = `
SELECT schema_identity
FROM p0b_google_reconciler_checkpoint
WHERE singleton_key = $1
`.trim();

const SET_STATEMENT_TIMEOUT_SQL = "SELECT set_config('statement_timeout', $1, true) AS statement_timeout";
const SET_LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true) AS lock_timeout";

const READ_SQL = `
SELECT
  cc.id::text AS chunk_id,
  cc.page_id::text AS page_id,
  cc.chunk_index,
  cc.chunk_text,
  cc.chunk_source,
  p.content_hash AS page_content_hash,
  p.generation::text AS page_generation_text,
  (cc.embedding_g768 IS NOT NULL) AS has_embedding,
  provenance.source_hash AS stored_source_fingerprint
FROM content_chunks AS cc
JOIN pages AS p ON p.id = cc.page_id
JOIN p0b_google_reconciler_checkpoint AS control
  ON control.singleton_key = $6
 AND control.schema_identity = $7
 AND control.pass = $8
 AND control.cursor_chunk_index IS NOT DISTINCT FROM $9
 AND control.cursor_chunk_id IS NOT DISTINCT FROM $10
 AND control.lease_id = $11
 AND control.fence_token = $12
 AND control.lease_expires_at > clock_timestamp()
LEFT JOIN p0b_google_embedding_provenance AS provenance
  ON provenance.chunk_id = cc.id
 AND provenance.embedding_model = $4
 AND provenance.embedding_dimensions = $5
WHERE p.deleted_at IS NULL
  AND (
    ($1::integer IS NULL AND $2::text IS NULL)
    OR (cc.chunk_index, cc.id::text COLLATE "C") > ($1::integer, $2::text COLLATE "C")
  )
ORDER BY cc.chunk_index ASC, cc.id::text COLLATE "C" ASC
LIMIT $3
`.trim();

const LOCK_CHECKPOINT_SQL = `
SELECT
  revision,
  pass,
  cursor_chunk_index,
  cursor_chunk_id,
  lease_id,
  fence_token,
  floor(EXTRACT(EPOCH FROM lease_expires_at) * 1000)::bigint::text AS lease_expires_at_epoch_ms_text,
  floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS db_now_epoch_ms_text
FROM p0b_google_reconciler_checkpoint
WHERE singleton_key = $1
  AND schema_identity = $2
FOR UPDATE
`.trim();

const READ_AUTHORITY_SQL = `
SELECT
  pass,
  cursor_chunk_index,
  cursor_chunk_id,
  lease_id,
  fence_token,
  floor(EXTRACT(EPOCH FROM lease_expires_at) * 1000)::bigint::text AS lease_expires_at_epoch_ms_text,
  floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS db_now_epoch_ms_text
FROM p0b_google_reconciler_checkpoint
WHERE singleton_key = $1
  AND schema_identity = $2
`.trim();

const DATABASE_NOW_SQL = `
SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS db_now_epoch_ms_text
`.trim();

// This is the adapter's only content mutation. Do not broaden this SET allowlist.
const UPDATE_VECTOR_SQL = `
UPDATE content_chunks AS cc
SET embedding_g768 = $1::vector
FROM pages AS p
WHERE cc.id::text = $2
  AND cc.page_id::text = $3
  AND cc.chunk_index = $4
  AND cc.chunk_text = $5
  AND cc.chunk_source = $6
  AND p.id = cc.page_id
  AND p.deleted_at IS NULL
  AND p.generation = $7
  AND p.content_hash IS NOT DISTINCT FROM $8
RETURNING cc.id::text AS chunk_id
`.trim();

const UPSERT_PROVENANCE_SQL = `
INSERT INTO p0b_google_embedding_provenance (
  chunk_id,
  embedding_model,
  embedding_dimensions,
  source_hash
) VALUES ($1, $2, $3, $4)
ON CONFLICT (chunk_id, embedding_model, embedding_dimensions)
DO UPDATE SET source_hash = EXCLUDED.source_hash
RETURNING
  chunk_id::text AS chunk_id,
  source_hash,
  embedding_model,
  embedding_dimensions
`.trim();

const UPDATE_CHECKPOINT_SQL = `
UPDATE p0b_google_reconciler_checkpoint
SET revision = $1,
    pass = $2,
    cursor_chunk_index = $3,
    cursor_chunk_id = $4
WHERE singleton_key = $5
  AND schema_identity = $6
  AND revision = $7
  AND pass = $8
  AND cursor_chunk_index IS NOT DISTINCT FROM $9
  AND cursor_chunk_id IS NOT DISTINCT FROM $10
  AND lease_id = $11
  AND fence_token = $12
  AND lease_expires_at > clock_timestamp()
RETURNING revision
`.trim();

const READ_ROW_KEYS = [
  'chunk_id', 'page_id', 'chunk_index', 'chunk_text', 'chunk_source',
  'page_content_hash', 'page_generation_text', 'has_embedding', 'stored_source_fingerprint',
] as const;
const READ_REQUEST_KEYS = ['schema_version', 'pass', 'after', 'max_rows', 'deadline_epoch_ms', 'authority'] as const;
const COMMIT_REQUEST_KEYS = [
  'schema_version', 'kind', 'authority', 'expected_checkpoint', 'new_checkpoint', 'updates', 'deadline_epoch_ms',
] as const;
const AUTHORITY_KEYS = ['lease_id', 'fence_token'] as const;
const CHECKPOINT_KEYS = ['schema_version', 'pass', 'cursor', 'revision'] as const;
const CURSOR_KEYS = ['chunk_index', 'chunk_id'] as const;
const UPDATE_KEYS = ['chunk_id', 'expected_row', 'vector'] as const;
const EXPECTED_ROW_KEYS = [
  'chunk_id', 'page_id', 'chunk_index', 'chunk_text', 'chunk_source',
  'page_content_hash', 'page_generation', 'source_fingerprint',
] as const;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

function dataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('row is not an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('row prototype is not plain');
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (descriptor === undefined || !('value' in descriptor)) throw new Error('row contains accessor');
  }
  return row;
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = dataRecord(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('row shape mismatch');
  }
  return row;
}

function denseDataArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error('array shape mismatch');
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error('sparse array');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) throw new Error('array contains accessor');
  }
  return value;
}

function trustedNow(clock: P0BPostgresClock): number {
  let value: unknown;
  try {
    value = clock.now_epoch_ms.call(clock);
  } catch {
    throw new Error('clock failed');
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid clock');
  return value as number;
}

function remainingMilliseconds(clock: P0BPostgresClock, deadline: number): number {
  const remaining = deadline - trustedNow(clock);
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error('deadline expired');
  return remaining;
}

function canonicalSafeIntegerText(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('noncanonical integer text');
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unsafe integer text');
  return Number(parsed);
}

function exactOne(rows: unknown[], keys: readonly string[]): Record<string, unknown> {
  if (rows.length !== 1) throw new Error('expected exactly one row');
  return exactDataRecord(rows[0], keys);
}

async function configureTransactionTimeouts(
  connection: ReservedConnection,
  clock: P0BPostgresClock,
  deadline: number,
): Promise<void> {
  const statementRemaining = remainingMilliseconds(clock, deadline);
  const statementDuration = `${Math.min(statementRemaining, 30_000)}ms`;
  const statement = exactOne(
    await connection.executeRaw(SET_STATEMENT_TIMEOUT_SQL, [statementDuration]),
    ['statement_timeout'],
  );
  if (statement.statement_timeout !== statementDuration) throw new Error('statement timeout mismatch');
  const lockRemaining = remainingMilliseconds(clock, deadline);
  const lockDuration = `${Math.min(lockRemaining, 5_000)}ms`;
  const lock = exactOne(
    await connection.executeRaw(SET_LOCK_TIMEOUT_SQL, [lockDuration]),
    ['lock_timeout'],
  );
  if (lock.lock_timeout !== lockDuration) throw new Error('lock timeout mismatch');
}

async function executeBounded<T = Record<string, unknown>>(
  connection: ReservedConnection,
  clock: P0BPostgresClock,
  deadline: number,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  await configureTransactionTimeouts(connection, clock, deadline);
  return connection.executeRaw<T>(sql, params);
}

function sameCursor(row: Record<string, unknown>, expected: Checkpoint): boolean {
  const actualIndex = row.cursor_chunk_index === null ? null : row.cursor_chunk_index;
  const actualId = row.cursor_chunk_id === null ? null : row.cursor_chunk_id;
  if (expected.cursor === null) return actualIndex === null && actualId === null;
  return actualIndex === expected.cursor.chunk_index && actualId === expected.cursor.chunk_id;
}

function checkpointConflict(
  locked: Record<string, unknown>,
  request: CommitRequest,
  databaseNow: number,
  leaseExpiry: number,
): ConflictReason | null {
  if (
    locked.revision !== request.expected_checkpoint.revision
    || locked.pass !== request.expected_checkpoint.pass
    || !sameCursor(locked, request.expected_checkpoint)
  ) return 'CHECKPOINT_CAS';
  if (locked.lease_id !== request.authority.lease_id || leaseExpiry <= databaseNow) return 'LOST_LEASE';
  if (locked.fence_token !== request.authority.fence_token) return 'FENCE_MISMATCH';
  return null;
}

function assertReadAuthority(row: Record<string, unknown>, request: ReadRequest): void {
  const databaseNow = canonicalSafeIntegerText(row.db_now_epoch_ms_text);
  const leaseExpiry = canonicalSafeIntegerText(row.lease_expires_at_epoch_ms_text);
  const expectedCursor = request.after;
  const cursorMatches = expectedCursor === null
    ? row.cursor_chunk_index === null && row.cursor_chunk_id === null
    : row.cursor_chunk_index === expectedCursor.chunk_index && row.cursor_chunk_id === expectedCursor.chunk_id;
  if (
    row.pass !== request.pass
    || !cursorMatches
    || row.lease_id !== request.authority.lease_id
    || row.fence_token !== request.authority.fence_token
    || leaseExpiry <= databaseNow
    || databaseNow >= request.deadline_epoch_ms
  ) throw new Error('read authority invalid');
}

function conflictResponse(reason: ConflictReason, checkpoint: Checkpoint) {
  return Object.freeze({ schema_version: 1, status: 'conflicted', reason, checkpoint });
}

function parseAuthority(value: unknown): Authority {
  const row = exactDataRecord(value, AUTHORITY_KEYS);
  if (typeof row.lease_id !== 'string' || !ID_RE.test(row.lease_id)) throw new Error('invalid lease id');
  if (typeof row.fence_token !== 'string' || !ID_RE.test(row.fence_token)) throw new Error('invalid fence token');
  return Object.freeze({ lease_id: row.lease_id, fence_token: row.fence_token });
}

function parseCursor(value: unknown): Cursor | null {
  if (value === null) return null;
  const row = exactDataRecord(value, CURSOR_KEYS);
  if (!Number.isSafeInteger(row.chunk_index) || (row.chunk_index as number) < 0) throw new Error('invalid cursor index');
  if (typeof row.chunk_id !== 'string' || !ID_RE.test(row.chunk_id)) throw new Error('invalid cursor id');
  return Object.freeze({ chunk_index: row.chunk_index as number, chunk_id: row.chunk_id });
}

function parseCheckpoint(value: unknown): Checkpoint {
  const row = exactDataRecord(value, CHECKPOINT_KEYS);
  if (row.schema_version !== 1 || !Number.isSafeInteger(row.pass) || (row.pass as number) <= 0) throw new Error('invalid checkpoint');
  if (typeof row.revision !== 'string' || !DIGEST_RE.test(row.revision)) throw new Error('invalid checkpoint revision');
  return Object.freeze({
    schema_version: 1,
    pass: row.pass as number,
    cursor: parseCursor(row.cursor),
    revision: row.revision,
  });
}

function parseReadRequest(value: unknown): ReadRequest {
  const row = exactDataRecord(value, READ_REQUEST_KEYS);
  const request = {
    schema_version: row.schema_version,
    pass: row.pass,
    after: parseCursor(row.after),
    max_rows: row.max_rows,
    deadline_epoch_ms: row.deadline_epoch_ms,
    authority: parseAuthority(row.authority),
  };
  if (
    request.schema_version !== 1
    || !Number.isSafeInteger(request.pass)
    || (request.pass as number) <= 0
    || !Number.isSafeInteger(request.max_rows)
    || (request.max_rows as number) <= 0
    || !Number.isSafeInteger(request.deadline_epoch_ms)
    || (request.deadline_epoch_ms as number) <= 0
  ) throw new Error('invalid read request');
  return Object.freeze(request) as ReadRequest;
}

function parseExpectedRow(value: unknown): ExpectedRow {
  const row = exactDataRecord(value, EXPECTED_ROW_KEYS);
  for (const key of ['chunk_id', 'page_id', 'chunk_source'] as const) {
    if (typeof row[key] !== 'string' || !ID_RE.test(row[key] as string)) throw new Error('invalid expected row id');
  }
  if (typeof row.chunk_text !== 'string') throw new Error('invalid chunk text');
  if (!Number.isSafeInteger(row.chunk_index) || (row.chunk_index as number) < 0) throw new Error('invalid chunk index');
  if (!Number.isSafeInteger(row.page_generation) || (row.page_generation as number) < 0) throw new Error('invalid page generation');
  if (row.page_content_hash !== null && (typeof row.page_content_hash !== 'string' || !DIGEST_RE.test(row.page_content_hash))) {
    throw new Error('invalid page content hash');
  }
  if (typeof row.source_fingerprint !== 'string' || !DIGEST_RE.test(row.source_fingerprint)) throw new Error('invalid source fingerprint');
  return Object.freeze({ ...row }) as unknown as ExpectedRow;
}

function parseCommitRequest(value: unknown): CommitRequest {
  const row = exactDataRecord(value, COMMIT_REQUEST_KEYS);
  const updates = denseDataArray(row.updates).map(rawUpdate => {
    const update = exactDataRecord(rawUpdate, UPDATE_KEYS);
    const expected = parseExpectedRow(update.expected_row);
    if (typeof update.chunk_id !== 'string' || update.chunk_id !== expected.chunk_id) throw new Error('invalid commit update');
    const vector = Object.freeze(denseDataArray(update.vector).map(component => component));
    return Object.freeze({ chunk_id: update.chunk_id, expected_row: expected, vector }) as unknown as CommitUpdate;
  });
  const request = {
    schema_version: row.schema_version,
    kind: row.kind,
    authority: parseAuthority(row.authority),
    expected_checkpoint: parseCheckpoint(row.expected_checkpoint),
    new_checkpoint: parseCheckpoint(row.new_checkpoint),
    updates: Object.freeze(updates),
    deadline_epoch_ms: row.deadline_epoch_ms,
  };
  if (
    request.schema_version !== 1
    || (request.kind !== 'BATCH' && request.kind !== 'PASS_COMPLETE')
    || !Number.isSafeInteger(request.deadline_epoch_ms)
    || (request.deadline_epoch_ms as number) <= 0
  ) throw new Error('invalid commit request');
  return Object.freeze(request) as CommitRequest;
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions) throw new Error('wrong vector width');
  const normalized: number[] = [];
  for (const component of vector) {
    if (typeof component !== 'number' || !Number.isFinite(component)) throw new Error('invalid vector');
    normalized.push(Object.is(component, -0) ? 0 : component);
  }
  return `[${normalized.join(',')}]`;
}

function mappedReadRow(value: unknown): Readonly<Record<string, unknown>> {
  const row = exactDataRecord(value, READ_ROW_KEYS);
  const pageGeneration = canonicalSafeIntegerText(row.page_generation_text);
  return Object.freeze({
    chunk_id: row.chunk_id,
    page_id: row.page_id,
    chunk_index: row.chunk_index,
    chunk_text: row.chunk_text,
    chunk_source: row.chunk_source,
    page_content_hash: row.page_content_hash,
    page_generation: pageGeneration,
    has_embedding: row.has_embedding,
    stored_source_fingerprint: row.stored_source_fingerprint,
  });
}

export function createP0BGoogleReconcilerPostgresPorts(
  connection: ReservedConnection,
  clock: P0BPostgresClock,
): P0BGoogleReconcilerPostgresPorts {
  let schemaChecked = false;
  return Object.freeze({
    read_batch: async (value: unknown) => {
      try {
        const request = parseReadRequest(value);
        return await connection.transactionRaw(async tx => {
          if (!schemaChecked) {
            const schema = exactOne(
              await executeBounded(
                tx, clock, request.deadline_epoch_ms, SCHEMA_ASSERT_SQL,
                [P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.checkpoint_singleton_key],
              ),
              ['schema_identity'],
            );
            if (schema.schema_identity !== P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.schema_identity) {
              throw new P0BGoogleReconcilerPostgresError('SCHEMA_MISMATCH');
            }
            schemaChecked = true;
          }
          const authorityRow = exactOne(
            await executeBounded(tx, clock, request.deadline_epoch_ms, READ_AUTHORITY_SQL, [
              P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.checkpoint_singleton_key,
              P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.schema_identity,
            ]),
            ['pass', 'cursor_chunk_index', 'cursor_chunk_id', 'lease_id', 'fence_token',
              'lease_expires_at_epoch_ms_text', 'db_now_epoch_ms_text'],
          );
          assertReadAuthority(authorityRow, request);
          const rows = await executeBounded(tx, clock, request.deadline_epoch_ms, READ_SQL, [
            request.after?.chunk_index ?? null,
            request.after?.chunk_id ?? null,
            request.max_rows,
            P0B_GOOGLE_RECONCILER_CONTRACT.embedding_model,
            P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions,
            P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.checkpoint_singleton_key,
            P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.schema_identity,
            request.pass,
            request.after?.chunk_index ?? null,
            request.after?.chunk_id ?? null,
            request.authority.lease_id,
            request.authority.fence_token,
          ]);
          return Object.freeze({
            schema_version: 1,
            rows: Object.freeze(rows.map(mappedReadRow)),
            has_more: rows.length === request.max_rows,
          });
        });
      } catch (error) {
        if (error instanceof P0BGoogleReconcilerPostgresError && error.code === 'SCHEMA_MISMATCH') throw error;
        throw new P0BGoogleReconcilerPostgresError('SESSION_FAILED');
      }
    },

    commit: async (value: unknown) => {
      let request: CommitRequest;
      try {
        request = parseCommitRequest(value);
        const vectors = request.updates.map(update => vectorLiteral(update.vector));
        return await connection.transactionRaw(async tx => {
          const lockedRows = await executeBounded(tx, clock, request.deadline_epoch_ms, LOCK_CHECKPOINT_SQL, [
            P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.checkpoint_singleton_key,
            P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.schema_identity,
          ]);
          if (lockedRows.length === 0) throw new TransactionConflict('CHECKPOINT_CAS', request.expected_checkpoint);
          const locked = exactOne(lockedRows, [
            'revision', 'pass', 'cursor_chunk_index', 'cursor_chunk_id', 'lease_id', 'fence_token',
            'lease_expires_at_epoch_ms_text', 'db_now_epoch_ms_text',
          ]);
          const databaseNow = canonicalSafeIntegerText(locked.db_now_epoch_ms_text);
          const leaseExpiry = canonicalSafeIntegerText(locked.lease_expires_at_epoch_ms_text);
          if (databaseNow >= request.deadline_epoch_ms) throw new Error('database deadline expired');
          const initialConflict = checkpointConflict(locked, request, databaseNow, leaseExpiry);
          if (initialConflict !== null) throw new TransactionConflict(initialConflict, request.expected_checkpoint);

          let updatedRows = 0;
          let conflictedRows = 0;
          for (let index = 0; index < request.updates.length; index += 1) {
            const update = request.updates[index]!;
            const expected = update.expected_row;
            const vectorRows = await executeBounded(tx, clock, request.deadline_epoch_ms, UPDATE_VECTOR_SQL, [
              vectors[index], expected.chunk_id, expected.page_id, expected.chunk_index,
              expected.chunk_text, expected.chunk_source, expected.page_generation, expected.page_content_hash,
            ]);
            if (vectorRows.length === 0) {
              conflictedRows += 1;
              continue;
            }
            const vectorRow = exactOne(vectorRows, ['chunk_id']);
            if (vectorRow.chunk_id !== expected.chunk_id) throw new Error('vector identity mismatch');
            updatedRows += 1;

            const provenance = exactOne(await executeBounded(
              tx, clock, request.deadline_epoch_ms, UPSERT_PROVENANCE_SQL, [
              expected.chunk_id,
              P0B_GOOGLE_RECONCILER_CONTRACT.embedding_model,
              P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions,
              expected.source_fingerprint,
            ]), ['chunk_id', 'source_hash', 'embedding_model', 'embedding_dimensions']);
            if (
              provenance.chunk_id !== expected.chunk_id
              || provenance.source_hash !== expected.source_fingerprint
              || provenance.embedding_model !== P0B_GOOGLE_RECONCILER_CONTRACT.embedding_model
              || provenance.embedding_dimensions !== P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions
            ) throw new Error('provenance identity mismatch');
          }

          const finalClock = exactOne(
            await executeBounded(tx, clock, request.deadline_epoch_ms, DATABASE_NOW_SQL),
            ['db_now_epoch_ms_text'],
          );
          const finalDatabaseNow = canonicalSafeIntegerText(finalClock.db_now_epoch_ms_text);
          if (finalDatabaseNow >= request.deadline_epoch_ms) throw new Error('database deadline expired');
          if (leaseExpiry <= finalDatabaseNow) throw new TransactionConflict('LOST_LEASE', request.expected_checkpoint);

          const next = request.new_checkpoint;
          const expected = request.expected_checkpoint;
          const checkpointRows = await executeBounded(
            tx, clock, request.deadline_epoch_ms, UPDATE_CHECKPOINT_SQL, [
            next.revision, next.pass, next.cursor?.chunk_index ?? null, next.cursor?.chunk_id ?? null,
            P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.checkpoint_singleton_key,
            P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.schema_identity,
            expected.revision, expected.pass, expected.cursor?.chunk_index ?? null, expected.cursor?.chunk_id ?? null,
            request.authority.lease_id, request.authority.fence_token,
          ]);
          if (checkpointRows.length === 0) throw new TransactionConflict('CHECKPOINT_CAS', request.expected_checkpoint);
          const checkpointRow = exactOne(checkpointRows, ['revision']);
          if (checkpointRow.revision !== next.revision) throw new Error('checkpoint identity mismatch');

          return Object.freeze({
            schema_version: 1,
            status: 'updated',
            updated_rows: updatedRows,
            conflicted_rows: conflictedRows,
            checkpoint: next,
          });
        });
      } catch (error) {
        // transactionRaw rethrows only after its rollback has completed. Thus a
        // private sentinel reaching this boundary is safe to convert to the
        // orchestrator conflict shape; every other rejection is sanitized.
        if (error instanceof TransactionConflict) return conflictResponse(error.reason, error.checkpoint);
        throw new P0BGoogleReconcilerPostgresError('TRANSACTION_FAILED');
      }
    },
  });
}

export async function runP0BGoogleReconcilerPostgres(
  input: P0BGoogleReconcilerPostgresInput,
): Promise<P0BGoogleReconcilerReceipt> {
  if (input?.kind !== 'postgres' || typeof input.withReservedConnection !== 'function') {
    throw new P0BGoogleReconcilerPostgresError('POSTGRES_REQUIRED');
  }
  try {
    return await input.withReservedConnection(async connection => {
      const ports = createP0BGoogleReconcilerPostgresPorts(connection, input.clock);
      return runP0BGoogleReconciler({
        initial_checkpoint: input.initial_checkpoint,
        limits: input.limits,
        authority: input.authority,
        clock: input.clock,
        reader: { read_batch: ports.read_batch },
        provider: input.provider,
        committer: { commit: ports.commit },
        cancellation: input.cancellation,
      });
    });
  } catch (error) {
    if (error instanceof P0BGoogleReconcilerPostgresError) throw error;
    if (error instanceof P0BGoogleReconcilerError) throw error;
    throw new P0BGoogleReconcilerPostgresError('SESSION_FAILED');
  }
}
