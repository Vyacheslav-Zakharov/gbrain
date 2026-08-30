import { createHash, type Hash } from 'node:crypto';

export const P0B_GOOGLE_RECONCILER_CONTRACT = Object.freeze({
  schema_version: 1,
  embedding_model: 'google:gemini-embedding-001',
  embedding_dimensions: 768,
  cost_per_1m_tokens_usd: 0.15,
  token_estimator: 'UTF8_BYTES_CEIL_DIV_4_MIN_1',
} as const);

const DIGEST_RE = /^[a-f0-9]{64}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const AUTHORITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,255}$/;
const INPUT_KEYS = [
  'initial_checkpoint', 'limits', 'authority', 'clock', 'reader', 'provider', 'committer', 'cancellation',
] as const;
const LIMIT_KEYS = [
  'max_rows', 'max_batch_rows', 'max_batch_tokens', 'max_total_tokens',
  'max_cost_usd', 'deadline_epoch_ms',
] as const;
const SOURCE_KEYS = [
  'schema_version', 'chunk_id', 'page_id', 'chunk_index', 'chunk_text', 'chunk_source',
  'page_content_hash', 'page_generation', 'embedding_model', 'embedding_dimensions',
] as const;
const ROW_KEYS = [
  'chunk_id', 'page_id', 'chunk_index', 'chunk_text', 'chunk_source', 'page_content_hash',
  'page_generation', 'has_embedding', 'stored_source_fingerprint',
] as const;
const CHECKPOINT_KEYS = ['schema_version', 'pass', 'cursor', 'revision'] as const;
const CURSOR_KEYS = ['chunk_index', 'chunk_id'] as const;
const AUTHORITY_KEYS = ['lease_id', 'fence_token'] as const;

export type P0BGoogleReconcilerErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CLOCK'
  | 'INVALID_READ_BATCH'
  | 'PROVIDER_FAILED'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'INVALID_COMMIT_RESPONSE'
  | 'CHECKPOINT_CAS'
  | 'LOST_LEASE'
  | 'FENCE_MISMATCH';

export class P0BGoogleReconcilerError extends Error {
  readonly code: P0BGoogleReconcilerErrorCode;

  constructor(code: P0BGoogleReconcilerErrorCode) {
    super(code);
    this.name = 'P0BGoogleReconcilerError';
    this.code = code;
  }
}

export interface P0BGoogleReconcilerLimits {
  readonly max_rows: number;
  readonly max_batch_rows: number;
  readonly max_batch_tokens: number;
  readonly max_total_tokens: number;
  readonly max_cost_usd: number;
  readonly deadline_epoch_ms: number;
}

export interface P0BGoogleSource {
  readonly schema_version: 1;
  readonly chunk_id: string;
  readonly page_id: string;
  readonly chunk_index: number;
  readonly chunk_text: string;
  readonly chunk_source: string;
  readonly page_content_hash: string | null;
  readonly page_generation: number;
  readonly embedding_model: typeof P0B_GOOGLE_RECONCILER_CONTRACT.embedding_model;
  readonly embedding_dimensions: typeof P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions;
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

interface ReconcilerRow {
  readonly chunk_id: string;
  readonly page_id: string;
  readonly chunk_index: number;
  readonly chunk_text: string;
  readonly chunk_source: string;
  readonly page_content_hash: string | null;
  readonly page_generation: number;
  readonly has_embedding: boolean;
  readonly stored_source_fingerprint: string | null;
}

export interface P0BGoogleReconcilerReceipt {
  readonly schema_version: 1;
  readonly outcome: 'CONVERGED' | 'LIMIT_REACHED' | 'CANCELLED';
  readonly rows_read: number;
  readonly rows_eligible: number;
  readonly rows_updated: number;
  readonly row_conflicts: number;
  readonly provider_batches: number;
  readonly estimated_tokens: number;
  readonly estimated_cost_usd: number;
  readonly completed_passes: number;
  readonly source_fingerprint_digest: string;
  readonly vector_digest: string;
  readonly checkpoint_digest: string;
}

export interface P0BGoogleReconcilerInput {
  readonly initial_checkpoint: unknown;
  readonly limits: unknown;
  readonly authority: unknown;
  readonly clock: { readonly now_epoch_ms: () => unknown };
  readonly reader: { readonly read_batch: (request: unknown) => Promise<unknown> };
  readonly provider: { readonly embed: (request: unknown) => Promise<unknown> };
  readonly committer: { readonly commit: (request: unknown) => Promise<unknown> };
  readonly cancellation: { readonly is_cancelled: () => unknown };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exact keys: ${expected.join(', ')}`);
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error(`${label} keys must be data properties`);
    }
  }
  return value;
}

function denseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a dense plain array`);
  }
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must be a dense plain array`);
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error(`${label} entries must be data properties`);
    }
  }
  return value;
}

function frozenClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => frozenClone(item))) as T;
  }
  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) clone[key] = frozenClone(value[key]);
    return Object.freeze(clone) as T;
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function opaqueId(value: unknown, label: string, authority = false): string {
  const grammar = authority ? AUTHORITY_ID_RE : OPAQUE_ID_RE;
  if (typeof value !== 'string' || !grammar.test(value)) throw new Error(`${label} has invalid grammar`);
  return value;
}

function digestOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest or null`);
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseP0BGoogleReconcilerLimits(value: unknown): P0BGoogleReconcilerLimits {
  const record = exactObject(value, LIMIT_KEYS, 'P0-B reconciler limits');
  const maxCost = record.max_cost_usd;
  if (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost < 0) {
    throw new Error('max_cost_usd must be a finite non-negative number');
  }
  return Object.freeze({
    max_rows: positiveInteger(record.max_rows, 'max_rows'),
    max_batch_rows: positiveInteger(record.max_batch_rows, 'max_batch_rows'),
    max_batch_tokens: positiveInteger(record.max_batch_tokens, 'max_batch_tokens'),
    max_total_tokens: positiveInteger(record.max_total_tokens, 'max_total_tokens'),
    max_cost_usd: maxCost,
    deadline_epoch_ms: positiveInteger(record.deadline_epoch_ms, 'deadline_epoch_ms'),
  });
}

function parseSource(value: unknown): P0BGoogleSource {
  const record = exactObject(value, SOURCE_KEYS, 'P0-B Google source');
  if (record.schema_version !== 1) throw new Error('source schema_version must equal 1');
  if (record.embedding_model !== P0B_GOOGLE_RECONCILER_CONTRACT.embedding_model) {
    throw new Error('source embedding_model must equal the P0-B model');
  }
  if (record.embedding_dimensions !== P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions) {
    throw new Error('source embedding_dimensions must equal the P0-B dimensions');
  }
  if (typeof record.chunk_text !== 'string') throw new Error('chunk_text must be a string');
  return Object.freeze({
    schema_version: 1,
    chunk_id: opaqueId(record.chunk_id, 'chunk_id'),
    page_id: opaqueId(record.page_id, 'page_id'),
    chunk_index: nonnegativeInteger(record.chunk_index, 'chunk_index'),
    chunk_text: record.chunk_text,
    chunk_source: opaqueId(record.chunk_source, 'chunk_source'),
    page_content_hash: digestOrNull(record.page_content_hash, 'page_content_hash'),
    page_generation: nonnegativeInteger(record.page_generation, 'page_generation'),
    embedding_model: P0B_GOOGLE_RECONCILER_CONTRACT.embedding_model,
    embedding_dimensions: P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions,
  });
}

function serializeSource(source: P0BGoogleSource): string {
  return JSON.stringify({
    schema_version: source.schema_version,
    chunk_id: source.chunk_id,
    page_id: source.page_id,
    chunk_index: source.chunk_index,
    chunk_text: source.chunk_text,
    chunk_source: source.chunk_source,
    page_content_hash: source.page_content_hash,
    page_generation: source.page_generation,
    embedding_model: source.embedding_model,
    embedding_dimensions: source.embedding_dimensions,
  });
}

export function fingerprintP0BGoogleSource(value: P0BGoogleSource): string {
  return createHash('sha256').update(serializeSource(parseSource(value)), 'utf8').digest('hex');
}

function parseCursor(value: unknown): Cursor | null {
  if (value === null) return null;
  const record = exactObject(value, CURSOR_KEYS, 'checkpoint cursor');
  return Object.freeze({
    chunk_index: nonnegativeInteger(record.chunk_index, 'cursor chunk_index'),
    chunk_id: opaqueId(record.chunk_id, 'cursor chunk_id'),
  });
}

function parseCheckpoint(value: unknown): Checkpoint {
  const record = exactObject(value, CHECKPOINT_KEYS, 'checkpoint');
  if (record.schema_version !== 1) throw new Error('checkpoint schema_version must equal 1');
  if (typeof record.revision !== 'string' || !DIGEST_RE.test(record.revision)) {
    throw new Error('checkpoint revision must be a lowercase SHA-256 digest');
  }
  return Object.freeze({
    schema_version: 1,
    pass: positiveInteger(record.pass, 'checkpoint pass'),
    cursor: parseCursor(record.cursor),
    revision: record.revision,
  });
}

function parseAuthority(value: unknown): Authority {
  const record = exactObject(value, AUTHORITY_KEYS, 'reconciler authority');
  return Object.freeze({
    lease_id: opaqueId(record.lease_id, 'lease_id', true),
    fence_token: opaqueId(record.fence_token, 'fence_token', true),
  });
}

function sourceFromRow(row: ReconcilerRow): P0BGoogleSource {
  return {
    schema_version: 1,
    chunk_id: row.chunk_id,
    page_id: row.page_id,
    chunk_index: row.chunk_index,
    chunk_text: row.chunk_text,
    chunk_source: row.chunk_source,
    page_content_hash: row.page_content_hash,
    page_generation: row.page_generation,
    embedding_model: P0B_GOOGLE_RECONCILER_CONTRACT.embedding_model,
    embedding_dimensions: P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions,
  };
}

function parseRow(value: unknown): ReconcilerRow {
  const record = exactObject(value, ROW_KEYS, 'reconciler row');
  if (typeof record.chunk_text !== 'string') throw new Error('chunk_text must be a string');
  if (typeof record.has_embedding !== 'boolean') throw new Error('has_embedding must be boolean');
  return Object.freeze({
    chunk_id: opaqueId(record.chunk_id, 'chunk_id'),
    page_id: opaqueId(record.page_id, 'page_id'),
    chunk_index: nonnegativeInteger(record.chunk_index, 'chunk_index'),
    chunk_text: record.chunk_text,
    chunk_source: opaqueId(record.chunk_source, 'chunk_source'),
    page_content_hash: digestOrNull(record.page_content_hash, 'page_content_hash'),
    page_generation: nonnegativeInteger(record.page_generation, 'page_generation'),
    has_embedding: record.has_embedding,
    stored_source_fingerprint: digestOrNull(record.stored_source_fingerprint, 'stored_source_fingerprint'),
  });
}

function compareCursor(left: Cursor, right: Cursor): number {
  const indexOrder = left.chunk_index - right.chunk_index;
  if (indexOrder !== 0) return indexOrder;
  if (left.chunk_id === right.chunk_id) return 0;
  return left.chunk_id < right.chunk_id ? -1 : 1;
}

function parseReadBatch(value: unknown, after: Cursor | null, maxRows: number): { rows: ReconcilerRow[]; has_more: boolean } {
  const record = exactObject(value, ['schema_version', 'rows', 'has_more'], 'read batch');
  if (record.schema_version !== 1 || typeof record.has_more !== 'boolean') throw new Error('invalid read batch metadata');
  const rawRows = denseArray(record.rows, 'read batch rows');
  if (rawRows.length > maxRows) throw new Error('read batch exceeded max_batch_rows');
  if (rawRows.length === 0 && record.has_more) throw new Error('empty read batch cannot assert has_more');
  const rows = Object.freeze(rawRows.map(parseRow));
  let previous = after;
  for (const row of rows) {
    const cursor = { chunk_index: row.chunk_index, chunk_id: row.chunk_id };
    if (previous !== null && compareCursor(cursor, previous) <= 0) throw new Error('read batch violates keyset order');
    previous = cursor;
  }
  return Object.freeze({ rows: rows as ReconcilerRow[], has_more: record.has_more });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function estimatedCost(tokens: number): number {
  return tokens * P0B_GOOGLE_RECONCILER_CONTRACT.cost_per_1m_tokens_usd / 1_000_000;
}

function nextCheckpoint(expected: Checkpoint, cursor: Cursor | null, pass: number, kind: string): Checkpoint {
  const revision = createHash('sha256').update(JSON.stringify({
    schema_version: 1,
    expected_revision: expected.revision,
    expected_pass: expected.pass,
    kind,
    pass,
    cursor,
  }), 'utf8').digest('hex');
  return Object.freeze({ schema_version: 1, pass, cursor: frozenClone(cursor), revision });
}

function readClock(clock: { now_epoch_ms: () => unknown }): number {
  let value: unknown;
  try {
    value = clock.now_epoch_ms.call(clock);
  } catch {
    throw new P0BGoogleReconcilerError('INVALID_CLOCK');
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new P0BGoogleReconcilerError('INVALID_CLOCK');
  return value as number;
}

function isCancelled(cancellation: { is_cancelled: () => unknown }): boolean {
  let value: unknown;
  try {
    value = cancellation.is_cancelled.call(cancellation);
  } catch {
    throw new P0BGoogleReconcilerError('INVALID_INPUT');
  }
  if (typeof value !== 'boolean') throw new P0BGoogleReconcilerError('INVALID_INPUT');
  return value;
}

function parseProviderResponse(value: unknown, expectedCount: number): number[][] {
  const record = exactObject(value, ['schema_version', 'vectors'], 'provider response');
  if (record.schema_version !== 1) throw new Error('provider response schema_version must equal 1');
  const vectors = denseArray(record.vectors, 'provider vectors');
  if (vectors.length !== expectedCount) throw new Error('provider vector count mismatch');
  return Object.freeze(vectors.map((raw, vectorIndex) => {
    const values = denseArray(raw, `provider vector ${vectorIndex}`);
    if (values.length !== P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions) {
      throw new Error('provider vector width mismatch');
    }
    const normalized: number[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const component = values[index];
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new Error('provider vector components must be finite numbers');
      }
      normalized.push(Object.is(component, -0) ? 0 : component);
    }
    return Object.freeze(normalized) as number[];
  })) as number[][];
}

function parseCommitResponse(
  value: unknown,
  expected: Checkpoint,
  proposed: Checkpoint,
  updateCount: number,
): { updated: number; conflicted: number; checkpoint: Checkpoint } {
  if (!isPlainObject(value)) throw new Error('commit response must be a plain object');
  if (value.status === 'conflicted') {
    const record = exactObject(value, ['schema_version', 'status', 'reason', 'checkpoint'], 'conflicted commit response');
    if (record.schema_version !== 1 || !['CHECKPOINT_CAS', 'LOST_LEASE', 'FENCE_MISMATCH'].includes(String(record.reason))) {
      throw new Error('invalid commit conflict');
    }
    const actual = parseCheckpoint(record.checkpoint);
    if (!sameJson(actual, expected)) throw new Error('conflicted commit returned unexpected checkpoint');
    throw new P0BGoogleReconcilerError(record.reason as P0BGoogleReconcilerErrorCode);
  }
  const record = exactObject(
    value,
    ['schema_version', 'status', 'updated_rows', 'conflicted_rows', 'checkpoint'],
    'updated commit response',
  );
  if (record.schema_version !== 1 || record.status !== 'updated') throw new Error('invalid commit status');
  const updated = nonnegativeInteger(record.updated_rows, 'updated_rows');
  const conflicted = nonnegativeInteger(record.conflicted_rows, 'conflicted_rows');
  if (updated + conflicted !== updateCount) throw new Error('commit row counts do not match updates');
  const actual = parseCheckpoint(record.checkpoint);
  if (!sameJson(actual, proposed)) throw new Error('commit did not return the exact new checkpoint');
  return { updated, conflicted, checkpoint: actual };
}

function checkpointDigest(checkpoint: Checkpoint): string {
  return createHash('sha256').update(JSON.stringify(checkpoint), 'utf8').digest('hex');
}

function finish(
  outcome: P0BGoogleReconcilerReceipt['outcome'],
  counters: {
    rowsRead: number;
    rowsEligible: number;
    rowsUpdated: number;
    rowConflicts: number;
    providerBatches: number;
    tokens: number;
    completedPasses: number;
  },
  sourceHash: Hash,
  vectorHash: Hash,
  checkpoint: Checkpoint,
): P0BGoogleReconcilerReceipt {
  return Object.freeze({
    schema_version: 1,
    outcome,
    rows_read: counters.rowsRead,
    rows_eligible: counters.rowsEligible,
    rows_updated: counters.rowsUpdated,
    row_conflicts: counters.rowConflicts,
    provider_batches: counters.providerBatches,
    estimated_tokens: counters.tokens,
    estimated_cost_usd: estimatedCost(counters.tokens),
    completed_passes: counters.completedPasses,
    source_fingerprint_digest: sourceHash.digest('hex'),
    vector_digest: vectorHash.digest('hex'),
    checkpoint_digest: checkpointDigest(checkpoint),
  });
}

export async function runP0BGoogleReconciler(inputValue: P0BGoogleReconcilerInput): Promise<P0BGoogleReconcilerReceipt> {
  let input: Record<string, unknown>;
  let limits: P0BGoogleReconcilerLimits;
  let checkpoint: Checkpoint;
  let authority: Authority;
  try {
    input = exactObject(inputValue, INPUT_KEYS, 'P0-B reconciler input');
    limits = parseP0BGoogleReconcilerLimits(input.limits);
    checkpoint = parseCheckpoint(input.initial_checkpoint);
    authority = parseAuthority(input.authority);
    exactObject(input.clock, ['now_epoch_ms'], 'clock');
    exactObject(input.reader, ['read_batch'], 'reader');
    exactObject(input.provider, ['embed'], 'provider');
    exactObject(input.committer, ['commit'], 'committer');
    exactObject(input.cancellation, ['is_cancelled'], 'cancellation');
    if (
      typeof (input.clock as P0BGoogleReconcilerInput['clock']).now_epoch_ms !== 'function'
      || typeof (input.reader as P0BGoogleReconcilerInput['reader']).read_batch !== 'function'
      || typeof (input.provider as P0BGoogleReconcilerInput['provider']).embed !== 'function'
      || typeof (input.committer as P0BGoogleReconcilerInput['committer']).commit !== 'function'
      || typeof (input.cancellation as P0BGoogleReconcilerInput['cancellation']).is_cancelled !== 'function'
    ) throw new Error('ports must be functions');
  } catch {
    throw new P0BGoogleReconcilerError('INVALID_INPUT');
  }

  const clock = input.clock as P0BGoogleReconcilerInput['clock'];
  const reader = input.reader as P0BGoogleReconcilerInput['reader'];
  const provider = input.provider as P0BGoogleReconcilerInput['provider'];
  const committer = input.committer as P0BGoogleReconcilerInput['committer'];
  const cancellation = input.cancellation as P0BGoogleReconcilerInput['cancellation'];
  const counters = {
    rowsRead: 0,
    rowsEligible: 0,
    rowsUpdated: 0,
    rowConflicts: 0,
    providerBatches: 0,
    tokens: 0,
    completedPasses: 0,
  };
  const sourceHash = createHash('sha256');
  const vectorHash = createHash('sha256');
  let cleanPasses = 0;
  let passHadEligible = checkpoint.cursor !== null;

  for (;;) {
    if (isCancelled(cancellation)) return finish('CANCELLED', counters, sourceHash, vectorHash, checkpoint);
    if (readClock(clock) >= limits.deadline_epoch_ms) {
      return finish('LIMIT_REACHED', counters, sourceHash, vectorHash, checkpoint);
    }
    if (counters.rowsRead >= limits.max_rows) {
      return finish('LIMIT_REACHED', counters, sourceHash, vectorHash, checkpoint);
    }

    let batch: { rows: ReconcilerRow[]; has_more: boolean };
    try {
      const remainingRows = limits.max_rows - counters.rowsRead;
      const readLimit = Math.min(limits.max_batch_rows, remainingRows);
      const response = await reader.read_batch(frozenClone({
        schema_version: 1,
        pass: checkpoint.pass,
        after: checkpoint.cursor,
        max_rows: readLimit,
        deadline_epoch_ms: limits.deadline_epoch_ms,
        authority,
      }));
      batch = parseReadBatch(response, checkpoint.cursor, readLimit);
    } catch (error) {
      if (error instanceof P0BGoogleReconcilerError) throw error;
      throw new P0BGoogleReconcilerError('INVALID_READ_BATCH');
    }
    counters.rowsRead += batch.rows.length;

    const processed: ReconcilerRow[] = [];
    const eligible: Array<{ row: ReconcilerRow; fingerprint: string; tokens: number }> = [];
    let blocked = false;
    let batchTokens = 0;
    for (const row of batch.rows) {
      const fingerprint = fingerprintP0BGoogleSource(sourceFromRow(row));
      const needsEmbedding = !row.has_embedding || row.stored_source_fingerprint !== fingerprint;
      if (!needsEmbedding) {
        processed.push(row);
        continue;
      }
      passHadEligible = true;
      counters.rowsEligible += 1;
      const tokens = estimateTokens(row.chunk_text);
      const nextTotal = counters.tokens + batchTokens + tokens;
      const nextCost = estimatedCost(nextTotal);
      if (
        eligible.length >= limits.max_batch_rows
        || batchTokens + tokens > limits.max_batch_tokens
        || nextTotal > limits.max_total_tokens
        || nextCost > limits.max_cost_usd
        || readClock(clock) >= limits.deadline_epoch_ms
      ) {
        blocked = true;
        break;
      }
      processed.push(row);
      eligible.push({ row, fingerprint, tokens });
      batchTokens += tokens;
    }

    let vectors: number[][] = [];
    if (eligible.length > 0) {
      if (isCancelled(cancellation)) return finish('CANCELLED', counters, sourceHash, vectorHash, checkpoint);
      if (readClock(clock) >= limits.deadline_epoch_ms) {
        return finish('LIMIT_REACHED', counters, sourceHash, vectorHash, checkpoint);
      }
      let response: unknown;
      counters.providerBatches += 1;
      counters.tokens += batchTokens;
      try {
        response = await provider.embed(frozenClone({
          schema_version: 1,
          model: P0B_GOOGLE_RECONCILER_CONTRACT.embedding_model,
          dimensions: P0B_GOOGLE_RECONCILER_CONTRACT.embedding_dimensions,
          inputs: eligible.map(item => item.row.chunk_text),
          deadline_epoch_ms: limits.deadline_epoch_ms,
        }));
      } catch {
        throw new P0BGoogleReconcilerError('PROVIDER_FAILED');
      }
      if (isCancelled(cancellation)) return finish('CANCELLED', counters, sourceHash, vectorHash, checkpoint);
      if (readClock(clock) >= limits.deadline_epoch_ms) {
        return finish('LIMIT_REACHED', counters, sourceHash, vectorHash, checkpoint);
      }
      try {
        vectors = parseProviderResponse(response, eligible.length);
      } catch {
        throw new P0BGoogleReconcilerError('INVALID_PROVIDER_RESPONSE');
      }
    }

    const reachedPassEnd = !blocked && !batch.has_more && processed.length === batch.rows.length;
    if (processed.length === 0 && !reachedPassEnd) {
      return finish('LIMIT_REACHED', counters, sourceHash, vectorHash, checkpoint);
    }
    const last = processed.at(-1);
    const kind = reachedPassEnd ? 'PASS_COMPLETE' : 'BATCH';
    const newCheckpoint = nextCheckpoint(
      checkpoint,
      reachedPassEnd ? null : { chunk_index: last!.chunk_index, chunk_id: last!.chunk_id },
      reachedPassEnd ? checkpoint.pass + 1 : checkpoint.pass,
      kind,
    );
    const updates = eligible.map((item, index) => ({
      chunk_id: item.row.chunk_id,
      expected_row: {
        chunk_id: item.row.chunk_id,
        page_id: item.row.page_id,
        chunk_index: item.row.chunk_index,
        chunk_text: item.row.chunk_text,
        chunk_source: item.row.chunk_source,
        page_content_hash: item.row.page_content_hash,
        page_generation: item.row.page_generation,
        source_fingerprint: item.fingerprint,
      },
      vector: vectors[index]!,
    }));
    if (isCancelled(cancellation)) return finish('CANCELLED', counters, sourceHash, vectorHash, checkpoint);
    if (readClock(clock) >= limits.deadline_epoch_ms) {
      return finish('LIMIT_REACHED', counters, sourceHash, vectorHash, checkpoint);
    }
    let commitResult: { updated: number; conflicted: number; checkpoint: Checkpoint };
    try {
      const response = await committer.commit(frozenClone({
        schema_version: 1,
        kind,
        authority,
        expected_checkpoint: checkpoint,
        new_checkpoint: newCheckpoint,
        updates,
        deadline_epoch_ms: limits.deadline_epoch_ms,
      }));
      commitResult = parseCommitResponse(response, checkpoint, newCheckpoint, updates.length);
    } catch (error) {
      if (error instanceof P0BGoogleReconcilerError) throw error;
      throw new P0BGoogleReconcilerError('INVALID_COMMIT_RESPONSE');
    }

    for (let index = 0; index < eligible.length; index += 1) {
      sourceHash.update(eligible[index]!.fingerprint, 'utf8');
      vectorHash.update(JSON.stringify(vectors[index]), 'utf8');
    }
    counters.rowsUpdated += commitResult.updated;
    counters.rowConflicts += commitResult.conflicted;
    checkpoint = commitResult.checkpoint;

    if (reachedPassEnd) {
      counters.completedPasses += 1;
      if (!passHadEligible && commitResult.conflicted === 0) cleanPasses += 1;
      else cleanPasses = 0;
      passHadEligible = false;
      if (cleanPasses >= 2) return finish('CONVERGED', counters, sourceHash, vectorHash, checkpoint);
    }
    if (blocked || counters.rowsRead >= limits.max_rows || counters.tokens >= limits.max_total_tokens) {
      return finish('LIMIT_REACHED', counters, sourceHash, vectorHash, checkpoint);
    }
  }
}
