import { createHash } from 'node:crypto';

export const P0B_CONTRACT = Object.freeze({
  embedding_column: 'embedding_g768',
  embedding_model: 'google:gemini-embedding-001',
  embedding_dimensions: 768,
  embedding_provider: 'google',
  embedding_base_url: 'https://generativelanguage.googleapis.com',
  registry_embedding_column: 'embedding_g768',
  registry_embedding_type: 'vector',
} as const);

export const P0B_CREDENTIAL_CONTRACT = Object.freeze({
  schema_version: 1,
  unit: 'gbrain-p0b-bridge.service',
  credential_id: 'google-generative-ai-api-key',
  directory: '/run/credentials/gbrain-p0b-bridge.service',
  filename: 'google-generative-ai-api-key',
  resolved_path: '/run/credentials/gbrain-p0b-bridge.service/google-generative-ai-api-key',
  load_credential_directive: 'LoadCredential=google-generative-ai-api-key',
  source_policy: 'SYSTEMD_CREDENTIAL_STORE_ONLY',
  env_fallback: 'FORBIDDEN',
} as const);

export const P0B_STATES = Object.freeze([
  'DRAFT',
  'PREPARING',
  'RECONCILING',
  'PREPARED',
  'ACTIVE',
  'COMPENSATING',
  'ROLLED_BACK',
  'ABORTED',
  'BLOCKED',
] as const);

export type P0BStateName = (typeof P0B_STATES)[number];
export type P0BRollbackTarget = 'ZE' | 'FTS_ONLY' | 'LAST_GOOD_GOOGLE';

export const P0B_SHUTDOWN_CUTOFF_ISO = '2026-09-04T00:00:00Z';
export const P0B_NONCE_MIN_BYTES = 32;
export const P0B_NONCE_MAX_BYTES = 128;
export const P0B_MAX_CONSUMED_NONCES = 128;
// Two durable ledger entries remain available for ACTIVE -> COMPENSATING -> ROLLED_BACK.
export const P0B_MAX_ORDINARY_NONCES = P0B_MAX_CONSUMED_NONCES - 2;
export const P0B_AUTHORIZATION_MAX_WINDOW_MS = 5 * 60 * 1000;
export const P0B_AUTHENTICITY = 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED';
export const P0B_OWNER_GO = 'AUTHORIZE_GBRAIN_P0B_STATE_TRANSITION';
export const P0B_ALLOWED_PREVIOUS_COLUMNS = Object.freeze([
  'embedding',
  'embedding_voyage',
  'embedding_ze',
] as const);

const STATE_SET = new Set<string>(P0B_STATES);
const ROLLBACK_TARGET_SET = new Set<string>(['ZE', 'FTS_ONLY', 'LAST_GOOD_GOOGLE']);
const PREVIOUS_COLUMN_SET = new Set<string>(P0B_ALLOWED_PREVIOUS_COLUMNS);
const HEX_DIGEST_RE = /^[a-f0-9]{64}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;
const NONCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$/;
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{2,127}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ALLOWED_TRANSITIONS: Readonly<Record<P0BStateName, readonly P0BStateName[]>> = Object.freeze({
  DRAFT: ['PREPARING', 'ABORTED', 'BLOCKED'],
  PREPARING: ['RECONCILING', 'ABORTED', 'BLOCKED'],
  RECONCILING: ['RECONCILING', 'PREPARED', 'ABORTED', 'BLOCKED'],
  PREPARED: ['ACTIVE', 'ABORTED', 'BLOCKED'],
  ACTIVE: ['ACTIVE', 'COMPENSATING', 'BLOCKED'],
  COMPENSATING: ['ROLLED_BACK', 'BLOCKED'],
  ROLLED_BACK: [],
  ABORTED: [],
  BLOCKED: [],
});

export interface P0BStatePayload {
  readonly schema_version: 1;
  readonly state: P0BStateName;
  readonly previous_search_column: string;
  readonly consumed_nonces: readonly string[];
  readonly rollback_target: P0BRollbackTarget | null;
}

export interface P0BState extends P0BStatePayload {
  readonly fingerprint: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exact keys: ${wanted.join(', ')}`);
  }
}

function validateNonce(value: unknown): string {
  if (typeof value !== 'string') throw new Error('nonce must be an ASCII string');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < P0B_NONCE_MIN_BYTES || bytes > P0B_NONCE_MAX_BYTES || !NONCE_RE.test(value)) {
    throw new Error(
      `nonce must be ${P0B_NONCE_MIN_BYTES}-${P0B_NONCE_MAX_BYTES} ASCII bytes matching the governed grammar`,
    );
  }
  return value;
}

function validatePreviousColumn(value: unknown): string {
  if (typeof value !== 'string') throw new Error('previous_search_column must be a string');
  if (value !== value.trim()) {
    throw new Error('previous_search_column must equal its canonical trim');
  }
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error('previous_search_column must satisfy the SQL identifier grammar');
  }
  if (!PREVIOUS_COLUMN_SET.has(value)) {
    throw new Error('previous_search_column is not in the allowed prior set');
  }
  return value;
}

const STATE_PAYLOAD_KEYS = [
  'schema_version',
  'state',
  'previous_search_column',
  'consumed_nonces',
  'rollback_target',
] as const;

function parseStatePayload(value: unknown, enforceSemantics: boolean): P0BStatePayload {
  const record = requirePlainObject(value, 'P0-B state payload');
  requireExactKeys(record, STATE_PAYLOAD_KEYS, 'P0-B state payload');
  if (record.schema_version !== 1) throw new Error('schema_version must equal 1');
  if (typeof record.state !== 'string' || !STATE_SET.has(record.state)) {
    throw new Error('state must be an exact P0-B state literal');
  }
  const state = record.state as P0BStateName;
  const previousSearchColumn = validatePreviousColumn(record.previous_search_column);
  if (!Array.isArray(record.consumed_nonces)) {
    throw new Error('consumed_nonces must be an array');
  }
  const nonceKeys = Object.keys(record.consumed_nonces);
  const expectedNonceKeys = Array.from(
    { length: record.consumed_nonces.length },
    (_, index) => String(index),
  );
  if (
    Object.getPrototypeOf(record.consumed_nonces) !== Array.prototype
    || nonceKeys.length !== expectedNonceKeys.length
    || nonceKeys.some((key, index) => key !== expectedNonceKeys[index])
  ) {
    throw new Error('consumed_nonces must be a dense plain array with no extra properties');
  }
  if (record.consumed_nonces.length > P0B_MAX_CONSUMED_NONCES) {
    throw new Error(`consumed_nonces ledger cap (${P0B_MAX_CONSUMED_NONCES}) exceeded`);
  }
  const consumedNonces = record.consumed_nonces.map(validateNonce);
  if (new Set(consumedNonces).size !== consumedNonces.length) {
    throw new Error('consumed_nonces must be durably unique');
  }
  if (
    record.rollback_target !== null
    && (typeof record.rollback_target !== 'string' || !ROLLBACK_TARGET_SET.has(record.rollback_target))
  ) {
    throw new Error('rollback_target must be null or an exact rollback target literal');
  }
  const rollbackTarget = record.rollback_target as P0BRollbackTarget | null;

  if (enforceSemantics) {
    const requiresRollback = state === 'ACTIVE' || state === 'COMPENSATING' || state === 'ROLLED_BACK';
    const forbidsRollback = state !== 'ACTIVE'
      && state !== 'COMPENSATING'
      && state !== 'ROLLED_BACK'
      && state !== 'BLOCKED';
    if (requiresRollback && rollbackTarget === null) {
      throw new Error(`${state} requires a non-null rollback_target`);
    }
    if (forbidsRollback && rollbackTarget !== null) {
      throw new Error(`${state} requires rollback_target to be null`);
    }
    const spentOrdinaryReserve = state !== 'COMPENSATING'
      && state !== 'ROLLED_BACK'
      && state !== 'BLOCKED'
      && consumedNonces.length > P0B_MAX_ORDINARY_NONCES;
    const spentRollbackReserve = state === 'COMPENSATING'
      && consumedNonces.length > P0B_MAX_CONSUMED_NONCES - 1;
    if (spentOrdinaryReserve || spentRollbackReserve) {
      throw new Error(`${state} consumed_nonces spends reserved safety capacity`);
    }
  }

  return {
    schema_version: 1,
    state,
    previous_search_column: previousSearchColumn,
    consumed_nonces: consumedNonces,
    rollback_target: rollbackTarget,
  };
}

// Deliberately fixed-schema: no generic recursive canonicalizer can admit unknown fields.
function serializeP0BStatePayload(payload: P0BStatePayload): string {
  return JSON.stringify({
    schema_version: payload.schema_version,
    state: payload.state,
    previous_search_column: payload.previous_search_column,
    consumed_nonces: payload.consumed_nonces,
    rollback_target: payload.rollback_target,
  });
}

export function fingerprintP0BState(payload: P0BStatePayload): string {
  const parsed = parseStatePayload(payload, false);
  return createHash('sha256').update(serializeP0BStatePayload(parsed), 'utf8').digest('hex');
}

function sealState(payload: P0BStatePayload): P0BState {
  const parsed = parseStatePayload(payload, true);
  const sealedPayload: P0BStatePayload = {
    ...parsed,
    consumed_nonces: Object.freeze([...parsed.consumed_nonces]),
  };
  return Object.freeze({
    ...sealedPayload,
    fingerprint: fingerprintP0BState(sealedPayload),
  });
}

export function parseP0BState(value: unknown): P0BState {
  const record = requirePlainObject(value, 'P0-B state');
  requireExactKeys(record, [...STATE_PAYLOAD_KEYS, 'fingerprint'], 'P0-B state');
  if (typeof record.fingerprint !== 'string' || !HEX_DIGEST_RE.test(record.fingerprint)) {
    throw new Error('fingerprint must be a lowercase SHA-256 digest');
  }
  const payload = parseStatePayload({
    schema_version: record.schema_version,
    state: record.state,
    previous_search_column: record.previous_search_column,
    consumed_nonces: record.consumed_nonces,
    rollback_target: record.rollback_target,
  }, true);
  if (fingerprintP0BState(payload) !== record.fingerprint) {
    throw new Error('State fingerprint integrity check failed');
  }
  return sealState(payload);
}

export function createP0BState(input: { previous_search_column: string }): P0BState {
  const record = requirePlainObject(input, 'P0-B state creation input');
  requireExactKeys(record, ['previous_search_column'], 'P0-B state creation input');
  return sealState({
    schema_version: 1,
    state: 'DRAFT',
    previous_search_column: validatePreviousColumn(record.previous_search_column),
    consumed_nonces: [],
    rollback_target: null,
  });
}

export interface P0BAuthorization {
  readonly schema_version: 1;
  readonly action: 'P0B_STATE_TRANSITION';
  readonly transition: string;
  readonly expected_state_fingerprint: string;
  readonly p0b_artifact_digest: string;
  readonly p0b_root_digest: string;
  readonly actor: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly nonce: string;
  readonly owner_go: typeof P0B_OWNER_GO;
  /** Derived once from the trusted authority; never supplied by the envelope. */
  readonly trusted_now_epoch_ms: number;
}

export interface P0BAuthorizationAuthority {
  readonly authenticity: typeof P0B_AUTHENTICITY;
  readonly now: Date | number;
  readonly expected_artifact_digest: string;
  readonly expected_root_digest: string;
  readonly allowed_actors: readonly string[];
}

const AUTHORIZATION_KEYS = [
  'schema_version',
  'action',
  'transition',
  'expected_state_fingerprint',
  'p0b_artifact_digest',
  'p0b_root_digest',
  'actor',
  'issued_at',
  'expires_at',
  'nonce',
  'owner_go',
] as const;

function trustedEpoch(value: unknown): number {
  const epoch = value instanceof Date ? value.getTime() : value;
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) {
    throw new Error('trusted now must be a valid Date or finite epoch milliseconds');
  }
  return epoch;
}

function parseCanonicalTimestamp(value: unknown, label: string): { iso: string; epoch: number } {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new Error(`${label} must be a real canonical UTC timestamp`);
  }
  return { iso: value, epoch };
}

export function parseP0BAuthorization(
  value: unknown,
  authorityInput: P0BAuthorizationAuthority,
): P0BAuthorization {
  const authority = requirePlainObject(authorityInput, 'authorization authority');
  requireExactKeys(
    authority,
    ['authenticity', 'now', 'expected_artifact_digest', 'expected_root_digest', 'allowed_actors'],
    'authorization authority',
  );
  if (authority.authenticity !== P0B_AUTHENTICITY) {
    throw new Error('Authorization requires a preverified signed or access-controlled envelope');
  }
  const now = trustedEpoch(authority.now);
  for (const key of ['expected_artifact_digest', 'expected_root_digest'] as const) {
    if (typeof authority[key] !== 'string' || !HEX_DIGEST_RE.test(authority[key])) {
      throw new Error(`authorization authority ${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (
    !Array.isArray(authority.allowed_actors)
    || Object.getPrototypeOf(authority.allowed_actors) !== Array.prototype
    || authority.allowed_actors.length === 0
    || new Set(authority.allowed_actors).size !== authority.allowed_actors.length
    || authority.allowed_actors.some(actor => typeof actor !== 'string' || !ACTOR_RE.test(actor))
  ) {
    throw new Error('authorization authority allowed_actors must be a non-empty unique governed actor list');
  }
  const record = requirePlainObject(value, 'P0-B authorization');
  requireExactKeys(record, AUTHORIZATION_KEYS, 'P0-B authorization');
  if (record.schema_version !== 1) throw new Error('authorization schema_version must equal 1');
  if (record.action !== 'P0B_STATE_TRANSITION') {
    throw new Error('authorization action must be P0B_STATE_TRANSITION');
  }
  if (typeof record.transition !== 'string') throw new Error('authorization transition must be a string');
  const transitionMatch = /^([A-Z_]+)->([A-Z_]+)$/.exec(record.transition);
  if (!transitionMatch || !STATE_SET.has(transitionMatch[1]!) || !STATE_SET.has(transitionMatch[2]!)) {
    throw new Error('authorization transition must bind two exact P0-B state literals');
  }
  for (const key of ['expected_state_fingerprint', 'p0b_artifact_digest', 'p0b_root_digest'] as const) {
    if (typeof record[key] !== 'string' || !HEX_DIGEST_RE.test(record[key])) {
      throw new Error(`${key} must be a lowercase SHA-256 digest`);
    }
  }
  const expectedStateFingerprint = record.expected_state_fingerprint as string;
  const artifactDigest = record.p0b_artifact_digest as string;
  const rootDigest = record.p0b_root_digest as string;
  if (typeof record.actor !== 'string' || !ACTOR_RE.test(record.actor)) {
    throw new Error('actor must use the governed ASCII identity grammar');
  }
  if (artifactDigest !== authority.expected_artifact_digest) {
    throw new Error('authorization artifact digest does not match trusted authority');
  }
  if (rootDigest !== authority.expected_root_digest) {
    throw new Error('authorization root digest does not match trusted authority');
  }
  if (!authority.allowed_actors.includes(record.actor)) {
    throw new Error('authorization actor is not allowed by trusted authority');
  }
  const issued = parseCanonicalTimestamp(record.issued_at, 'issued_at');
  const expires = parseCanonicalTimestamp(record.expires_at, 'expires_at');
  if (issued.epoch > now) throw new Error('issued_at may not be later than trusted now');
  if (expires.epoch <= now) throw new Error('expires_at must be later than trusted now');
  const window = expires.epoch - issued.epoch;
  if (window <= 0 || window > P0B_AUTHORIZATION_MAX_WINDOW_MS) {
    throw new Error('authorization time window exceeds the bounded maximum');
  }
  const validatedNonce = validateNonce(record.nonce);
  if (record.owner_go !== P0B_OWNER_GO) throw new Error(`owner_go must be exact literal ${P0B_OWNER_GO}`);

  return Object.freeze({
    schema_version: 1,
    action: 'P0B_STATE_TRANSITION',
    transition: record.transition,
    expected_state_fingerprint: expectedStateFingerprint,
    p0b_artifact_digest: artifactDigest,
    p0b_root_digest: rootDigest,
    actor: record.actor,
    issued_at: issued.iso,
    expires_at: expires.iso,
    nonce: validatedNonce,
    owner_go: P0B_OWNER_GO,
    trusted_now_epoch_ms: now,
  });
}

export interface P0BRollbackPolicyInput {
  readonly now: Date | number;
  readonly live_ze_probe: boolean;
  readonly last_good_google_available: boolean;
}

export function selectP0BRollbackTarget(input: P0BRollbackPolicyInput): P0BRollbackTarget {
  const record = requirePlainObject(input, 'rollback policy input');
  requireExactKeys(
    record,
    ['now', 'live_ze_probe', 'last_good_google_available'],
    'rollback policy input',
  );
  const now = trustedEpoch(record.now);
  if (typeof record.live_ze_probe !== 'boolean' || typeof record.last_good_google_available !== 'boolean') {
    throw new Error('rollback probe inputs must be booleans');
  }
  if (now < Date.parse(P0B_SHUTDOWN_CUTOFF_ISO) && record.live_ze_probe) return 'ZE';
  if (record.last_good_google_available) return 'LAST_GOOD_GOOGLE';
  return 'FTS_ONLY';
}

export interface P0BTransitionInput {
  readonly authorization: unknown;
  readonly authorization_authority: P0BAuthorizationAuthority;
  readonly rollback_policy?: {
    readonly live_ze_probe: boolean;
    readonly last_good_google_available: boolean;
  };
}

export interface P0BPersistenceCAS {
  readonly expected_fingerprint: string;
  readonly new_fingerprint: string;
}

export interface P0BTransitionResult {
  readonly state: P0BState;
  readonly persistence_cas: P0BPersistenceCAS;
}

/**
 * Produces a persistence CAS tuple. The persistence adapter MUST update atomically
 * with `WHERE fingerprint = expected_fingerprint` and MUST accept exactly one
 * affected row; zero or multiple affected rows are a failed transition.
 */
export function transitionP0BState(
  currentInput: P0BState,
  input: P0BTransitionInput,
): P0BTransitionResult {
  const current = parseP0BState(currentInput);
  const transitionInput = requirePlainObject(input, 'P0-B transition input');
  requireExactKeys(
    transitionInput,
    input.rollback_policy === undefined
      ? ['authorization', 'authorization_authority']
      : ['authorization', 'authorization_authority', 'rollback_policy'],
    'P0-B transition input',
  );
  const authorizationAuthority = transitionInput.authorization_authority as P0BAuthorizationAuthority;
  const authorization = parseP0BAuthorization(
    transitionInput.authorization,
    authorizationAuthority,
  );
  if (authorization.expected_state_fingerprint !== current.fingerprint) {
    throw new Error('Authorization expected state fingerprint is stale');
  }
  const [from, to] = authorization.transition.split('->') as [P0BStateName, P0BStateName];
  if (from !== current.state) {
    throw new Error('Authorization transition does not bind the current state');
  }
  if (!ALLOWED_TRANSITIONS[current.state].includes(to)) {
    throw new Error(`Invalid P0-B transition: ${current.state} -> ${to}`);
  }
  if (current.consumed_nonces.includes(authorization.nonce)) {
    throw new Error('Nonce already consumed');
  }
  if (current.consumed_nonces.length >= P0B_MAX_CONSUMED_NONCES) {
    throw new Error(`Nonce ledger cap (${P0B_MAX_CONSUMED_NONCES}) reached`);
  }
  const safetyTransition = to === 'COMPENSATING' || to === 'ROLLED_BACK' || to === 'BLOCKED';
  if (!safetyTransition && current.consumed_nonces.length >= P0B_MAX_ORDINARY_NONCES) {
    throw new Error(`Ordinary nonce ledger cap (${P0B_MAX_ORDINARY_NONCES}) reached`);
  }

  let rollbackTarget = current.rollback_target;
  if (to === 'ACTIVE') {
    const rollbackPolicy = requirePlainObject(transitionInput.rollback_policy, 'activation rollback policy');
    requireExactKeys(
      rollbackPolicy,
      ['live_ze_probe', 'last_good_google_available'],
      'activation rollback policy',
    );
    const derived = selectP0BRollbackTarget({
      now: authorization.trusted_now_epoch_ms,
      live_ze_probe: rollbackPolicy.live_ze_probe as boolean,
      last_good_google_available: rollbackPolicy.last_good_google_available as boolean,
    });
    if (rollbackTarget !== null && rollbackTarget !== derived) {
      throw new Error('Activation rollback target is immutable and differs from the derived policy result');
    }
    rollbackTarget ??= derived;
  } else if (transitionInput.rollback_policy !== undefined) {
    throw new Error('rollback_policy may only be supplied for activation');
  }

  const state = sealState({
    schema_version: 1,
    state: to,
    previous_search_column: current.previous_search_column,
    consumed_nonces: [...current.consumed_nonces, authorization.nonce],
    rollback_target: rollbackTarget,
  });
  return Object.freeze({
    state,
    persistence_cas: Object.freeze({
      expected_fingerprint: current.fingerprint,
      new_fingerprint: state.fingerprint,
    }),
  });
}

export interface P0BConfigAuthorityInput {
  readonly file_config: Record<string, unknown>;
  readonly env: Record<string, string | undefined>;
  readonly db_runtime: typeof P0B_CONTRACT;
  readonly per_call: Record<string, unknown>;
}

const CONFIG_AUTHORITY_KEYS = ['file_config', 'env', 'db_runtime', 'per_call'] as const;
const GOVERNED_CONFIG_KEYS = new Set([
  'embedding_column',
  'selected_embedding_column',
  'search_embedding_column',
  'gbrain_search_embedding_column',
  'embedding_model',
  'gbrain_embedding_model',
  'embedding_dimensions',
  'gbrain_embedding_dimensions',
  'embedding_provider',
  'provider',
  'gbrain_embedding_provider',
  'embedding_base_url',
  'base_url',
  'google_generative_ai_base_url',
  'embedding_columns',
  'registry_embedding_column',
  'gbrain_embedding_columns',
  'embeddingcolumn',
  'selectedembeddingcolumn',
  'searchembeddingcolumn',
  'embeddingmodel',
  'embeddingdimensions',
  'embeddingprovider',
  'embeddingbaseurl',
  'providerbaseurls',
  'provider_base_urls',
  'base_urls',
  'registryembeddingcolumn',
  'registryembeddingtype',
]);
const ENV_SECRET_KEYS = new Set([
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
]);

function findGovernedConfigKey(value: unknown, seen = new WeakSet<object>()): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) throw new Error('config planes must be acyclic JSON-shaped objects');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findGovernedConfigKey(nested, seen);
      if (found) return found;
    }
    return null;
  }
  const record = requirePlainObject(value, 'config plane');
  for (const [key, nested] of Object.entries(record)) {
    if (GOVERNED_CONFIG_KEYS.has(key.toLowerCase())) return key;
    const found = findGovernedConfigKey(nested, seen);
    if (found) return found;
  }
  return null;
}

export function validateP0BConfigAuthority(input: P0BConfigAuthorityInput): typeof P0B_CONTRACT {
  const record = requirePlainObject(input, 'P0-B config authority');
  requireExactKeys(record, CONFIG_AUTHORITY_KEYS, 'P0-B config authority');
  const fileConfig = requirePlainObject(record.file_config, 'file_config plane');
  const env = requirePlainObject(record.env, 'env plane');
  const perCall = requirePlainObject(record.per_call, 'per_call plane');
  const dbRuntime = requirePlainObject(record.db_runtime, 'db_runtime plane');

  for (const [plane, value] of [
    ['file_config', fileConfig],
    ['env', env],
    ['per_call', perCall],
  ] as const) {
    const conflict = findGovernedConfigKey(value);
    if (conflict) throw new Error(`${plane} plane may not set governed key ${conflict}`);
  }
  for (const secretKey of ENV_SECRET_KEYS) {
    if (Object.hasOwn(env, secretKey) && env[secretKey] !== undefined) {
      throw new Error(`Secret environment fallback is forbidden: ${secretKey}`);
    }
  }

  requireExactKeys(dbRuntime, Object.keys(P0B_CONTRACT), 'db_runtime plane');
  for (const [key, expected] of Object.entries(P0B_CONTRACT)) {
    if (dbRuntime[key] !== expected) {
      throw new Error(`db_runtime ${key} must exactly match P0B_CONTRACT`);
    }
  }
  return P0B_CONTRACT;
}

export type P0BCredentialMetadata = typeof P0B_CREDENTIAL_CONTRACT;

export function validateP0BCredentialMetadata(value: unknown): typeof P0B_CREDENTIAL_CONTRACT {
  const metadata = requirePlainObject(value, 'P0-B credential metadata');
  requireExactKeys(metadata, Object.keys(P0B_CREDENTIAL_CONTRACT), 'P0-B credential metadata');
  for (const [key, expected] of Object.entries(P0B_CREDENTIAL_CONTRACT)) {
    if (metadata[key] !== expected) {
      throw new Error(`Unexpected credential metadata ${key}`);
    }
  }
  return P0B_CREDENTIAL_CONTRACT;
}
