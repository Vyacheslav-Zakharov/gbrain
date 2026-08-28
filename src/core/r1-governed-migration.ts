/** Avers R1 collision-safe Google embedding migration primitives. */
import { createHash } from 'node:crypto';
import { validateColumnConfig, validateColumnKey } from './search/embedding-column.ts';

export const R1_LINEAGE = 'avers-fork-0.42.53-r1';
export const R1_OPERATION_ID = 'avers:r1:ze-exit:google-g768:v1';
export const R1_TARGET_MODEL = 'google:gemini-embedding-001';
export const R1_TARGET_DIMENSIONS = 768;
export const R1_SOURCE_MODEL = 'zeroentropyai:zembed-1';
export const R1_SOURCE_DIMENSIONS = 1280;
export const R1_STATE_KEY = 'avers.r1.embedding_migration.state';
export const R1_COMPLETED_KEY = 'avers.r1.embedding_migration.completed';
export const R1_ABORTED_KEY = 'avers.r1.embedding_migration.aborted';
export const R1_NONCE_LEDGER_KEY = 'avers.r1.embedding_migration.consumed_nonces';
export const R1_WRITER_FENCE_KEY = 'avers.r1.writer_fence';
export const R1_SHADOW_COLUMN = 'embedding_r1_g768';
export const R1_BACKUP_COLUMN = 'embedding_ze_r0';
export const R1_WRITER_FENCE_TABLES = [
  'pages', 'content_chunks', 'facts', 'takes', 'links', 'timeline_entries',
  'query_cache', 'sources', 'source_sync_state', 'source_ingest_runs',
  'source_ingest_run_items', 'take_proposals', 'concept_proposals',
  'minion_jobs', 'mcp_request_log', 'ingest_log', 'eval_candidates',
] as const;
export const R1_ADVISORY_LOCK_KEY = 7671003001;
export const R1_MIGRATION_OWNER_ROLE = 'gbrain_migration_owner';
export const R1_MIGRATOR_ROLE = 'gbrain_migrator';

export type R1ByteWriter = (buffer: Uint8Array, offset: number, length: number, position: number) => number;
export function writeR1BytesFully(bytes: Uint8Array, writer: R1ByteWriter): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writer(bytes, offset, bytes.byteLength - offset, offset);
    if (!Number.isInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
      throw new Error('R1_RECEIPT_SHORT_WRITE');
    }
    offset += written;
  }
}

let fenceLiftAfterDropHookForTests: (() => void) | null = null;
let receiptFinalizeHookForTests: (() => void) | null = null;
let abortPrepareAfterCleanupHookForTests: (() => void) | null = null;
export function __setR1FenceLiftAfterDropHookForTests(hook: (() => void) | null): void {
  fenceLiftAfterDropHookForTests = hook;
}
export function runR1FenceLiftAfterDropHookForTests(): void {
  fenceLiftAfterDropHookForTests?.();
}
export function __setR1ReceiptFinalizeHookForTests(hook: (() => void) | null): void {
  receiptFinalizeHookForTests = hook;
}
export function runR1ReceiptFinalizeHookForTests(): void {
  receiptFinalizeHookForTests?.();
}
export function __setR1AbortPrepareAfterCleanupHookForTests(hook: (() => void) | null): void {
  abortPrepareAfterCleanupHookForTests = hook;
}
export function runR1AbortPrepareAfterCleanupHookForTests(): void {
  abortPrepareAfterCleanupHookForTests?.();
}

export type R1MigrationMode = 'status' | 'dry-run' | 'prepare' | 'abort-prepare' | 'cutover' | 'rollback' | 'disable-fence';
export type R1Target = 'clone' | 'production';

export interface R1MigrationArgs {
  mode: R1MigrationMode;
  target: R1Target;
  yes: boolean;
  noEmbed: boolean;
  batchSize: number;
  paceMs: number;
  stopAfterBatches: number;
  receipt?: string;
  expectedCandidateSha?: string;
  implementationChecksum?: string;
  handoff?: R1HandoffIdentity;
}

export interface R1HandoffIdentity {
  g5a_run_id: string;
  g5b_run_id: string;
  backup_ready_sha256: string;
  control_manifest_sha256: string;
  topology_receipt_sha256: string;
  endpoint_identity_sha256: string;
  launcher_sha256: string;
  compiled_runtime_sha256: string;
  g5b1_go_sha256: string;
  handoff_nonce: string;
}

export function parseR1MigrationArgs(argv: string[]): R1MigrationArgs {
  const modeByFlag = new Map<string, R1MigrationMode>([
    ['--status', 'status'], ['--dry-run', 'dry-run'], ['--prepare', 'prepare'], ['--abort-prepare', 'abort-prepare'],
    ['--cutover', 'cutover'], ['--rollback', 'rollback'], ['--disable-fence', 'disable-fence'],
  ]);
  const booleanFlags = new Set(['--yes', '--no-embed']);
  const valueFlags = new Set([
    '--batch-size', '--pace-ms', '--target', '--stop-after-batches', '--receipt',
    '--expected-candidate-sha', '--implementation-checksum',
    '--g5a-run-id', '--g5b-run-id', '--backup-ready-sha256', '--control-manifest-sha256',
    '--topology-receipt-sha256', '--endpoint-identity-sha256', '--launcher-sha256',
    '--compiled-runtime-sha256', '--g5b1-go-sha256', '--handoff-nonce',
  ]);
  let mode: R1MigrationMode | undefined;
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const parsedMode = modeByFlag.get(token);
    if (parsedMode) {
      if (mode) throw new Error('Pass exactly one non-repeated migration mode');
      mode = parsedMode;
      continue;
    }
    if (booleanFlags.has(token)) {
      if (booleans.has(token)) throw new Error(`Duplicate flag: ${token}`);
      booleans.add(token);
      continue;
    }
    if (!valueFlags.has(token)) throw new Error(`Unknown migration option: ${token}`);
    if (values.has(token)) throw new Error(`Duplicate option: ${token}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires one value`);
    values.set(token, value);
  }
  if (!mode) throw new Error('Pass exactly one migration mode');
  const batchSize = Number(values.get('--batch-size') ?? '64');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new Error('--batch-size must be an integer in [1, 256]');
  const paceMs = Number(values.get('--pace-ms') ?? '0');
  if (!Number.isInteger(paceMs) || paceMs < 0 || paceMs > 60_000) throw new Error('--pace-ms must be an integer in [0, 60000]');
  const targetRaw = values.get('--target') ?? 'clone';
  if (targetRaw !== 'clone' && targetRaw !== 'production') throw new Error('--target must be clone or production');
  const stopAfterBatches = Number(values.get('--stop-after-batches') ?? '0');
  if (!Number.isInteger(stopAfterBatches) || stopAfterBatches < 0 || stopAfterBatches > 10_000) throw new Error('--stop-after-batches must be in [0,10000]');
  if (targetRaw === 'production' && stopAfterBatches > 0) throw new Error('--stop-after-batches is clone-only');
  const handoffFlags: Array<[string, keyof R1HandoffIdentity]> = [
    ['--g5a-run-id', 'g5a_run_id'], ['--g5b-run-id', 'g5b_run_id'],
    ['--backup-ready-sha256', 'backup_ready_sha256'], ['--control-manifest-sha256', 'control_manifest_sha256'],
    ['--topology-receipt-sha256', 'topology_receipt_sha256'], ['--endpoint-identity-sha256', 'endpoint_identity_sha256'],
    ['--launcher-sha256', 'launcher_sha256'], ['--compiled-runtime-sha256', 'compiled_runtime_sha256'],
    ['--g5b1-go-sha256', 'g5b1_go_sha256'], ['--handoff-nonce', 'handoff_nonce'],
  ];
  const suppliedHandoffValues = handoffFlags.flatMap(([flag, key]) => values.has(flag) ? [[key, values.get(flag)!] as const] : []);
  if (suppliedHandoffValues.length !== 0 && suppliedHandoffValues.length !== handoffFlags.length) throw new Error('handoff identity flags must be supplied as one complete set');
  let handoff: R1HandoffIdentity | undefined;
  if (suppliedHandoffValues.length === handoffFlags.length) {
    handoff = Object.fromEntries(suppliedHandoffValues) as unknown as R1HandoffIdentity;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(handoff.g5a_run_id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(handoff.g5b_run_id)) throw new Error('handoff run IDs are invalid');
    for (const [key, value] of Object.entries(handoff)) if ((key.endsWith('_sha256') || key === 'handoff_nonce') && !/^[0-9a-f]{64}$/.test(value)) throw new Error(`handoff ${key} must be a full SHA-256`);
  }
  return {
    mode,
    target: targetRaw,
    yes: booleans.has('--yes'),
    noEmbed: booleans.has('--no-embed'),
    batchSize,
    paceMs,
    stopAfterBatches,
    ...(values.get('--receipt') ? { receipt: values.get('--receipt') } : {}),
    ...(values.get('--expected-candidate-sha') ? { expectedCandidateSha: values.get('--expected-candidate-sha') } : {}),
    ...(values.get('--implementation-checksum') ? { implementationChecksum: values.get('--implementation-checksum') } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

export function assertR1DatabaseTarget(
  databaseUrl: string,
  target: R1Target,
  cloneAck: string | undefined,
  productionGo: string | undefined,
): URL {
  const parsed = new URL(databaseUrl);
  if (target === 'clone') {
    if (cloneAck !== '1') throw new Error('R1 clone acknowledgement R1_MIGRATION_CLONE_ACK=1 is required');
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('Clone target must use a loopback database host');
    if (parsed.pathname.replace(/^\//, '') !== 'gbrain_clone') throw new Error('Clone target database must be gbrain_clone');
  } else if (productionGo !== 'G5-EXPLICIT-GO') {
    throw new Error('Refusing production target without separate explicit G5 production GO');
  }
  return parsed;
}

export function assertR1EnvTarget(
  env: NodeJS.ProcessEnv,
  expected: 'target' | 'source',
  sourceModel?: string,
  sourceDimensions?: number,
): void {
  const model = expected === 'target' ? R1_TARGET_MODEL : sourceModel;
  const dimensions = expected === 'target' ? R1_TARGET_DIMENSIONS : sourceDimensions;
  if (!model || !dimensions) throw new Error('Source embedding identity is required');
  if (env.GBRAIN_EMBEDDING_MODEL && env.GBRAIN_EMBEDDING_MODEL !== model) {
    throw new Error(`GBRAIN_EMBEDDING_MODEL conflicts with the ${expected} migration identity`);
  }
  if (env.GBRAIN_EMBEDDING_DIMENSIONS && env.GBRAIN_EMBEDDING_DIMENSIONS !== String(dimensions)) {
    throw new Error(`GBRAIN_EMBEDDING_DIMENSIONS conflicts with the ${expected} migration identity`);
  }
}

export interface R1MigrationIdentity {
  lineage: string;
  operation_id: string;
  target_model: string;
  target_dimensions: number;
  candidate_sha: string;
  implementation_checksum: string;
  handoff?: R1HandoffIdentity;
}

export function buildR1MigrationIdentity(candidateSha: string, implementationChecksum: string, handoff?: R1HandoffIdentity): R1MigrationIdentity {
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) throw new Error('A full 40-character candidate SHA is required');
  if (!/^[0-9a-f]{64}$/.test(implementationChecksum)) throw new Error('A full SHA-256 implementation checksum is required');
  return {
    lineage: R1_LINEAGE,
    operation_id: R1_OPERATION_ID,
    target_model: R1_TARGET_MODEL,
    target_dimensions: R1_TARGET_DIMENSIONS,
    candidate_sha: candidateSha,
    implementation_checksum: implementationChecksum,
    ...(handoff ? { handoff } : {}),
  };
}

export function identityFingerprint(identity: R1MigrationIdentity): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))));
  return createHash('sha256').update(canonical).digest('hex');
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
export function buildWriterFenceSql(tables: string[]): string {
  const unique = [...new Set(tables)].sort();
  for (const table of unique) if (!IDENTIFIER.test(table)) throw new Error(`Unsafe writer-fence table name: ${table}`);
  const triggers = unique.map((table) => `
DROP TRIGGER IF EXISTS avers_r1_writer_fence_${table} ON ${table};
CREATE TRIGGER avers_r1_writer_fence_${table}
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${table}
FOR EACH STATEMENT EXECUTE FUNCTION avers_r1_writer_fence_guard();`).join('\n');
  return `CREATE OR REPLACE FUNCTION avers_r1_writer_fence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
BEGIN
  IF current_user IS DISTINCT FROM pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID)) THEN
    RAISE EXCEPTION 'AVERS_R1_WRITER_FENCE_ACTIVE' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$fn$;
${triggers}`;
}

export function buildWriterFenceDropSql(tables: string[]): string {
  const unique = [...new Set(tables)].sort();
  for (const table of unique) if (!IDENTIFIER.test(table)) throw new Error(`Unsafe writer-fence table name: ${table}`);
  return `${unique.map((table) => `DROP TRIGGER IF EXISTS avers_r1_writer_fence_${table} ON ${table};`).join('\n')}\nDROP FUNCTION IF EXISTS avers_r1_writer_fence_guard();`;
}

export function buildAbortPrepareStatements(tables: readonly string[]): string[] {
  return [
    buildWriterFenceDropSql([...tables]),
    'ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_r1_g768',
    'ALTER TABLE facts DROP COLUMN IF EXISTS embedding_r1_g768',
  ];
}

export interface R1WriterFenceRow {
  table: string;
  trigger: string;
  schema: string;
  function_schema: string;
  function_name: string;
  function_definition: string;
  table_owner: string;
  function_owner: string;
  executor: string;
  function_volatility: string;
  function_security_definer: boolean;
  function_config: string[] | null;
  enabled: string;
  definition: string;
}

export function resolveR1WriterFenceTables(marker: unknown): string[] {
  if (!marker || typeof marker !== 'object') return [];
  const tables = (marker as { writer_fence_tables?: unknown }).writer_fence_tables;
  if (!Array.isArray(tables) || tables.length === 0) return [];
  if (!tables.every((table): table is string => typeof table === 'string' && IDENTIFIER.test(table))) return [];
  if (new Set(tables).size !== tables.length) return [];
  return tables;
}

export function expectedR1WriterFenceFunctionDefinition(): string {
  return `CREATE OR REPLACE FUNCTION PUBLIC.AVERS_R1_WRITER_FENCE_GUARD()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SET SEARCH_PATH TO 'pg_catalog'
AS $FUNCTION$
BEGIN
IF CURRENT_USER IS DISTINCT FROM PG_CATALOG.PG_GET_USERBYID((SELECT RELOWNER FROM PG_CATALOG.PG_CLASS WHERE OID=TG_RELID)) THEN
RAISE EXCEPTION 'AVERS_R1_WRITER_FENCE_ACTIVE' USING ERRCODE = '55000';
END IF;
RETURN NULL;
END;
$FUNCTION$`;
}

export function isExactR1WriterFence(expectedTables: string[], rows: R1WriterFenceRow[]): boolean {
  const expected = [...new Set(expectedTables)].sort();
  if (expected.length === 0 || expected.length !== expectedTables.length) return false;
  if (rows.length !== expected.length) return false;
  const canonicalFunction = expectedR1WriterFenceFunctionDefinition();
  const normalize = (value: string): string => value.toUpperCase().replace(/\s+/g, ' ').trim().replace(/;$/, '');
  const canonicalFunctionDefinition = normalize(canonicalFunction);
  const byTable = new Map(rows.map((row) => [row.table, row]));
  return expected.every((table) => {
    const row = byTable.get(table);
    if (!row) return false;
    const canonicalTriggerDefinition = normalize(
      `CREATE TRIGGER avers_r1_writer_fence_${table}
       BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.${table}
       FOR EACH STATEMENT EXECUTE FUNCTION avers_r1_writer_fence_guard()`,
    );
    return row.schema === 'public'
      && row.trigger === `avers_r1_writer_fence_${table}`
      && row.function_schema === 'public'
      && row.function_name === 'avers_r1_writer_fence_guard'
      && row.table_owner === row.executor
      && row.function_owner === row.executor
      && row.function_owner.length > 0
      && row.function_volatility === 'v'
      && row.function_security_definer === false
      && JSON.stringify(row.function_config) === JSON.stringify(['search_path=pg_catalog'])
      && normalize(row.function_definition) === canonicalFunctionDefinition
      && row.enabled === 'O'
      && normalize(row.definition) === canonicalTriggerDefinition;
  });
}

export function assertR1AbortPrepareAuthority(
  state: {
    schema_version?: number;
    identity?: R1MigrationIdentity;
    fingerprint?: string;
    phase?: string;
    started_at?: string;
    updated_at?: string;
    from_model?: string;
    from_dimensions?: number;
    prior_reranker_model?: string;
    prior_reranker_enabled?: boolean;
    writer_fence_tables?: string[];
  },
  status: {
    writer_fence_active: boolean;
    content_chunks: { primary_type: string | null; shadow_type?: string | null; backup_type?: string | null };
    facts: { primary_type: string | null; shadow_type?: string | null; backup_type?: string | null };
    query_cache: { primary_type: string | null; backup_type?: string | null };
  },
  args: Pick<R1MigrationArgs, 'expectedCandidateSha' | 'implementationChecksum' | 'handoff'> & { target?: R1Target },
): void {
  if (!args.expectedCandidateSha || !args.implementationChecksum) {
    throw new Error('abort-prepare requires candidate SHA and implementation checksum');
  }
  if (state.schema_version !== 1) throw new Error('abort-prepare requires state schema version 1');
  for (const timestamp of [state.started_at,state.updated_at]) {
    if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error('abort-prepare state timestamp is invalid');
  }
  if (state.from_model !== R1_SOURCE_MODEL || state.from_dimensions !== R1_SOURCE_DIMENSIONS) throw new Error('abort-prepare source identity is invalid');
  if (typeof state.prior_reranker_model !== 'string' || state.prior_reranker_model.length < 1 || typeof state.prior_reranker_enabled !== 'boolean') throw new Error('abort-prepare reranker envelope is invalid');
  if (!state.identity || !state.fingerprint) throw new Error('abort-prepare requires exact migration identity');
  if (state.identity.candidate_sha !== args.expectedCandidateSha) throw new Error('abort-prepare candidate SHA mismatch');
  if (state.identity.implementation_checksum !== args.implementationChecksum) throw new Error('abort-prepare implementation checksum mismatch');
  const canonical = buildR1MigrationIdentity(args.expectedCandidateSha, args.implementationChecksum, args.handoff);
  const expectedFingerprint = identityFingerprint(canonical);
  if (identityFingerprint(state.identity) !== expectedFingerprint || state.fingerprint !== expectedFingerprint) {
    throw new Error('abort-prepare canonical migration identity mismatch');
  }
  if (state.phase !== 'preparing' && state.phase !== 'prepared') {
    throw new Error(`abort-prepare requires pre-cutover preparing or prepared state, got ${state.phase ?? 'missing'}`);
  }
  const stamped = resolveR1WriterFenceTables(state);
  if (stamped.length === 0) throw new Error('abort-prepare requires stamped writer-fence inventory');

  if (!status.writer_fence_active) throw new Error('abort-prepare requires exact active writer fence');
  if (status.content_chunks.primary_type !== 'vector(1280)'
    || status.facts.primary_type !== 'vector(1280)'
    || status.query_cache.primary_type !== 'vector(1280)') {
    throw new Error('abort-prepare source primary planes have changed');
  }
  if (status.content_chunks.backup_type || status.facts.backup_type || status.query_cache.backup_type) {
    throw new Error('abort-prepare refuses post-cutover backup planes');
  }
  if (status.content_chunks.shadow_type !== 'vector(768)' || status.facts.shadow_type !== 'vector(768)') {
    throw new Error('abort-prepare shadow planes do not match prepared state');
  }
}

export function vectorLiteral(vector: Float32Array): string {
  if (vector.length !== R1_TARGET_DIMENSIONS) throw new Error(`Expected ${R1_TARGET_DIMENSIONS} dimensions, got ${vector.length}`);
  return `[${Array.from(vector).join(',')}]`;
}

export function resolveContentPlaneCounts(
  shadowType: string | null,
  row: { total: number; populated: number } | undefined,
  totalWithoutShadow: number,
): { total: number; populated: number } {
  return shadowType
    ? { total: Number(row?.total ?? totalWithoutShadow), populated: Number(row?.populated ?? 0) }
    : { total: totalWithoutShadow, populated: 0 };
}

export interface R1CutoverStatus {
  writer_fence_active: boolean;
  content_chunks: { total: number; shadow_populated: number; primary_type: string | null; shadow_type: string | null; backup_type?: string | null };
  facts: { total_populated: number; shadow_populated: number; primary_type: string | null; shadow_type: string | null; backup_type?: string | null };
  query_cache: { primary_type: string | null; backup_type?: string | null; rows?: number };
  takes: { total_populated: number; primary_type: string | null };
}

export interface R1CompletionReality {
  current_model: string | null;
  current_dimensions: number | null;
  reranker_model: string | null;
  content_primary_type: string | null;
  content_backup_type: string | null;
  content_total: number;
  content_populated: number;
  facts_primary_type: string | null;
  facts_backup_type: string | null;
  facts_expected: number;
  facts_populated: number;
  query_cache_type: string | null;
  query_cache_backup_type: string | null;
  query_cache_rows: number;
  takes_populated: number;
  image_type: string | null;
  multimodal_type: string | null;
  false_target_signatures: number;
  null_signatures_with_chunks: number;
  active_embed_jobs: number;
  custom_registry_columns: string[];
  scalar_watermark: number;
  vector_roundtrip_ok: boolean;
  postcutover_indexes_exact: boolean;
  rollback_indexes_exact: boolean;
}

export interface R1ZeroZeRuntimeConfig {
  db_embedding_model: string | null;
  db_embedding_dimensions: number | null;
  db_reranker_model: string | null;
  db_embedding_columns?: Record<string, { provider?: string; dimensions?: number; type?: string }>;
  file_embedding_model?: string;
  file_embedding_dimensions?: number;
  file_search_embedding_column?: string;
  file_embedding_columns?: Record<string, { provider?: string; dimensions?: number; type?: string }>;
  file_provider_base_urls?: Record<string, string>;
  env_embedding_model?: string;
  env_embedding_dimensions?: string;
}

export type R1EmbeddingRegistry = Record<string, { provider?: string; dimensions?: number; type?: string }>;

function normalizeR1RegistryEntry(name: string, value: unknown): R1EmbeddingRegistry[string] {
  try {
    validateColumnKey(name);
    validateColumnConfig(name, value);
  } catch (error) {
    throw new Error(`embedding_columns.${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entry = value as { provider: string; dimensions: number; type: 'vector' | 'halfvec' };
  return { provider: entry.provider, dimensions: entry.dimensions, type: entry.type };
}

function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;
  const whitespace = (): void => { while (/\s/.test(raw[index] ?? '')) index += 1; };
  const stringToken = (): string => {
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') { index += 2; continue; }
      if (raw[index++] === '"') return JSON.parse(raw.slice(start, index)) as string;
    }
    throw new Error('unterminated JSON string');
  };
  const value = (): void => {
    whitespace();
    if (raw[index] === '{') {
      index += 1;
      const keys = new Set<string>();
      whitespace();
      if (raw[index] === '}') { index += 1; return; }
      while (index < raw.length) {
        whitespace();
        if (raw[index] !== '"') throw new Error('invalid JSON object key');
        const key = stringToken();
        if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`);
        keys.add(key);
        whitespace();
        if (raw[index++] !== ':') throw new Error('invalid JSON object separator');
        value();
        whitespace();
        if (raw[index] === '}') { index += 1; return; }
        if (raw[index++] !== ',') throw new Error('invalid JSON object delimiter');
      }
      throw new Error('unterminated JSON object');
    }
    if (raw[index] === '[') {
      index += 1;
      whitespace();
      if (raw[index] === ']') { index += 1; return; }
      while (index < raw.length) {
        value();
        whitespace();
        if (raw[index] === ']') { index += 1; return; }
        if (raw[index++] !== ',') throw new Error('invalid JSON array delimiter');
      }
      throw new Error('unterminated JSON array');
    }
    if (raw[index] === '"') { stringToken(); return; }
    while (index < raw.length && !/[\s,}\]]/.test(raw[index])) index += 1;
  };
  value();
  whitespace();
  if (index !== raw.length) throw new Error('trailing JSON data');
}

export function parseR1EmbeddingRegistry(raw: string | null): R1EmbeddingRegistry {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    assertNoDuplicateJsonKeys(raw);
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`embedding_columns registry is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
  const out = new Map<string, R1EmbeddingRegistry[string]>();
  if (Array.isArray(parsed)) {
    for (const value of parsed) {
      if (typeof value === 'string') {
        try { validateColumnKey(value); } catch { throw new Error('embedding_columns legacy array contains an invalid column'); }
        if (out.has(value)) throw new Error('embedding_columns legacy array contains a duplicate column');
        out.set(value, {});
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('embedding_columns legacy array contains an invalid entry');
      const name = (value as Record<string, unknown>).column;
      if (typeof name !== 'string' || out.has(name)) throw new Error('embedding_columns legacy array contains an invalid or duplicate column');
      out.set(name, normalizeR1RegistryEntry(name, value));
    }
    return Object.fromEntries(out);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('embedding_columns registry must be an object or supported legacy array');
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (out.has(name)) throw new Error(`embedding_columns contains a duplicate column: ${name}`);
    out.set(name, normalizeR1RegistryEntry(name, value));
  }
  return Object.fromEntries(out);
}

export function assertR1RegistrySafeForPrepare(
  dbRegistry: R1EmbeddingRegistry | undefined,
  fileRegistry: R1EmbeddingRegistry | undefined,
  dbSelectedColumn?: string | null,
  fileSelectedColumn?: string,
): void {
  const dbNames = Object.keys(dbRegistry ?? {});
  if (dbNames.length > 0) throw new Error(`DB embedding registry requires explicit R1 disposition before prepare: ${dbNames.sort().join(',')}`);
  const fileNames = Object.keys(fileRegistry ?? {});
  if (fileNames.length > 0) throw new Error(`file embedding registry requires explicit R1 disposition before prepare: ${fileNames.sort().join(',')}`);
  if (dbSelectedColumn && dbSelectedColumn !== 'embedding') throw new Error(`DB selected embedding column requires explicit R1 disposition before prepare: ${dbSelectedColumn}`);
  if (fileSelectedColumn && fileSelectedColumn !== 'embedding') throw new Error(`file selected embedding column requires explicit R1 disposition before prepare: ${fileSelectedColumn}`);
}

function isZeroEntropyModel(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('zeroentropyai:');
}

export function assertR1NonDbRuntimeConfig(r: Omit<R1ZeroZeRuntimeConfig, 'db_embedding_model' | 'db_embedding_dimensions' | 'db_reranker_model' | 'db_embedding_columns'>): void {
  if (r.file_embedding_model !== undefined && r.file_embedding_model !== R1_TARGET_MODEL) throw new Error(`file embedding model overrides the R1 target: ${r.file_embedding_model}`);
  if (r.file_embedding_dimensions !== undefined && r.file_embedding_dimensions !== R1_TARGET_DIMENSIONS) throw new Error(`file embedding dimensions override the R1 target: ${r.file_embedding_dimensions}`);
  if (r.env_embedding_model !== undefined && r.env_embedding_model !== R1_TARGET_MODEL) throw new Error(`env embedding model overrides the R1 target: ${r.env_embedding_model}`);
  if (r.env_embedding_dimensions !== undefined && Number(r.env_embedding_dimensions) !== R1_TARGET_DIMENSIONS) throw new Error(`env embedding dimensions override the R1 target: ${r.env_embedding_dimensions}`);

  for (const [key, value] of Object.entries(r.file_provider_base_urls ?? {})) {
    if (key.toLowerCase() === 'zeroentropyai' || String(value).toLowerCase().includes('zeroentropy')) {
      throw new Error(`hosted ZeroEntropy base URL override remains configured: ${key}`);
    }
  }
  for (const [name, value] of Object.entries(r.file_embedding_columns ?? {})) {
    if (isZeroEntropyModel(value.provider)) throw new Error(`custom embedding column still targets hosted ZeroEntropy: ${name}`);
    if (name === 'embedding'
      && (value.provider !== R1_TARGET_MODEL || value.dimensions !== R1_TARGET_DIMENSIONS || value.type !== 'vector')) {
      throw new Error('file embedding registry primary override does not match the R1 target');
    }
  }
  const selected = r.file_search_embedding_column?.trim();
  if (selected && selected !== 'embedding') throw new Error(`custom embedding column remains selected after R1 cutover: ${selected}`);
}

/** Fail closed on every runtime config plane that could reactivate hosted ZE after cutover. */
export function assertR1ZeroZeRuntimeConfig(r: R1ZeroZeRuntimeConfig): void {
  if (r.db_embedding_model !== R1_TARGET_MODEL) throw new Error(`DB embedding model is not ${R1_TARGET_MODEL}`);
  if (r.db_embedding_dimensions !== R1_TARGET_DIMENSIONS) throw new Error(`DB embedding dimensions are not ${R1_TARGET_DIMENSIONS}`);
  if (r.db_reranker_model !== 'voyage:rerank-2.5') throw new Error(`DB reranker model is not the governed target: ${r.db_reranker_model}`);
  for (const [name, value] of Object.entries(r.db_embedding_columns ?? {})) {
    if (isZeroEntropyModel(value.provider)) throw new Error(`DB embedding registry still targets hosted ZeroEntropy: ${name}`);
    if (name === 'embedding'
      && (value.provider !== R1_TARGET_MODEL || value.dimensions !== R1_TARGET_DIMENSIONS || value.type !== 'vector')) {
      throw new Error('DB embedding registry primary override does not match the R1 target');
    }
  }
  assertR1NonDbRuntimeConfig(r);
}

export function assertR1CompletionReality(r: R1CompletionReality): void {
  if (r.current_model !== R1_TARGET_MODEL || r.current_dimensions !== R1_TARGET_DIMENSIONS) throw new Error('completion config identity mismatch');
  if (r.reranker_model !== 'voyage:rerank-2.5') throw new Error('completion reranker identity mismatch');
  if (r.content_primary_type !== 'vector(768)' || r.content_populated !== r.content_total) throw new Error('completion content plane mismatch');
  if (r.content_backup_type !== 'vector(1280)') throw new Error('completion content rollback plane mismatch');
  if (r.facts_primary_type !== 'vector(768)' || r.facts_populated !== r.facts_expected) throw new Error('completion facts plane mismatch');
  if (r.facts_backup_type !== 'vector(1280)') throw new Error('completion facts rollback plane mismatch');
  if (r.query_cache_type !== 'vector(768)' || r.query_cache_rows !== 0) throw new Error('completion query cache mismatch');
  if (r.query_cache_backup_type !== 'vector(1280)') throw new Error('completion query-cache rollback plane mismatch');
  if (r.takes_populated !== 0) throw new Error('completion takes disposition mismatch');
  if (r.image_type !== 'vector(1024)' || r.multimodal_type !== 'vector(1024)') throw new Error('completion image plane drift');
  if (r.false_target_signatures !== 0 || r.null_signatures_with_chunks !== 0) throw new Error('completion page signature mismatch');
  if (r.active_embed_jobs !== 0) throw new Error('completion active embedding jobs remain');
  if (r.custom_registry_columns.length !== 0) throw new Error(`completion embedding registry unresolved: ${r.custom_registry_columns.join(',')}`);
  if (r.scalar_watermark !== 140) throw new Error(`completion scalar watermark drifted to ${r.scalar_watermark}`);
  if (!r.vector_roundtrip_ok) throw new Error('completion vector roundtrip failed');
  if (!r.postcutover_indexes_exact) throw new Error('completion post-cutover index catalog mismatch');
  if (!r.rollback_indexes_exact) throw new Error('completion rollback index catalog mismatch');
}

interface R1FenceDisableMarker {
  identity?: R1MigrationIdentity;
  fingerprint?: string;
  phase?: string;
  writer_fence_tables?: string[];
  completed_at?: string;
  file_config_sha256?: string;
  completion?: R1CompletionReality;
}

/** Refuse writer-fence lift unless the active state and completion receipt are exact. */
export function assertR1FenceDisableAuthority(
  state: R1FenceDisableMarker,
  completed: R1FenceDisableMarker,
  args: Pick<R1MigrationArgs, 'expectedCandidateSha' | 'implementationChecksum' | 'handoff'>,
): void {
  if (!args.expectedCandidateSha || !args.implementationChecksum) {
    throw new Error('--disable-fence requires candidate SHA and implementation checksum');
  }
  if (!state.identity || !completed.identity) throw new Error('writer-fence lift requires migration identity');
  if (state.identity.candidate_sha !== args.expectedCandidateSha) throw new Error('writer-fence lift candidate SHA mismatch');
  if (state.identity.implementation_checksum !== args.implementationChecksum) throw new Error('writer-fence lift implementation checksum mismatch');
  const canonicalIdentity = buildR1MigrationIdentity(args.expectedCandidateSha, args.implementationChecksum, args.handoff);
  const expectedFingerprint = identityFingerprint(canonicalIdentity);
  if (identityFingerprint(state.identity) !== expectedFingerprint) throw new Error('writer-fence lift canonical migration identity mismatch');
  if (state.fingerprint !== expectedFingerprint) throw new Error('writer-fence lift state fingerprint mismatch');
  if (state.phase !== 'completed') throw new Error('writer-fence lift requires completed state');
  if (completed.fingerprint !== expectedFingerprint
    || identityFingerprint(completed.identity) !== expectedFingerprint) {
    throw new Error('writer-fence lift completion marker identity mismatch');
  }
  if (completed.phase !== 'completed') throw new Error('writer-fence lift completion marker phase mismatch');
  if (typeof completed.completed_at !== 'string' || !Number.isFinite(Date.parse(completed.completed_at))) {
    throw new Error('writer-fence lift completion timestamp is invalid');
  }
  if (!completed.file_config_sha256 || !/^[0-9a-f]{64}$/.test(completed.file_config_sha256)) {
    throw new Error('writer-fence lift file config fingerprint is invalid');
  }
  if (!completed.completion) throw new Error('writer-fence lift completion reality is missing');
  assertR1CompletionReality(completed.completion);
  const stateTables = resolveR1WriterFenceTables(state);
  const completedTables = resolveR1WriterFenceTables(completed);
  if (stateTables.length === 0 || JSON.stringify(completedTables) !== JSON.stringify(stateTables)) {
    throw new Error('writer-fence lift stamped inventory mismatch');
  }
}

export function assertReadyForCutover(status: R1CutoverStatus): void {
  if (!status.writer_fence_active) throw new Error('Refusing cutover while the writer fence is inactive');
  if (status.content_chunks.primary_type !== 'vector(1280)' || status.content_chunks.shadow_type !== 'vector(768)') {
    throw new Error('content_chunks vector widths do not match the expected 1280d -> 768d transition');
  }
  if (status.content_chunks.shadow_populated !== status.content_chunks.total) {
    throw new Error(`content_chunks shadow incomplete: ${status.content_chunks.shadow_populated}/${status.content_chunks.total}`);
  }
  if (status.facts.primary_type !== 'vector(1280)' || status.facts.shadow_type !== 'vector(768)') {
    throw new Error('facts vector widths do not match the expected 1280d -> 768d transition');
  }
  if (status.facts.shadow_populated !== status.facts.total_populated) {
    throw new Error(`facts shadow incomplete: ${status.facts.shadow_populated}/${status.facts.total_populated}`);
  }
  if (status.query_cache.primary_type !== 'vector(1280)') throw new Error('query_cache primary width is not vector(1280)');
  if (status.takes.total_populated !== 0) throw new Error('takes.embedding became populated; explicit disposition is required');
  if (status.takes.primary_type !== 'vector(1536)') throw new Error('takes.embedding width drifted from vector(1536)');
}

/** Atomic cutover statements; old vectors remain in *_ze_r0 columns. */
export function buildCutoverStatements(): string[] {
  const signature = `${R1_TARGET_MODEL}:${R1_TARGET_DIMENSIONS}`;
  return [
    `ALTER INDEX idx_chunks_embedding RENAME TO idx_chunks_embedding_ze_r0`,
    `ALTER INDEX idx_chunks_embedding_null RENAME TO idx_chunks_embedding_null_ze_r0`,
    `ALTER INDEX content_chunks_stale_idx RENAME TO content_chunks_stale_idx_ze_r0`,
    `ALTER TABLE content_chunks RENAME COLUMN embedding TO ${R1_BACKUP_COLUMN}`,
    `ALTER TABLE content_chunks RENAME COLUMN ${R1_SHADOW_COLUMN} TO embedding`,
    `ALTER INDEX idx_chunks_${R1_SHADOW_COLUMN} RENAME TO idx_chunks_embedding`,
    `CREATE INDEX idx_chunks_embedding_null ON content_chunks(page_id, chunk_index) WHERE embedding IS NULL`,
    `CREATE INDEX content_chunks_stale_idx ON content_chunks(page_id, chunk_index) WHERE embedding IS NULL`,
    `UPDATE content_chunks SET model='${R1_TARGET_MODEL}', embedded_at=now() WHERE embedding IS NOT NULL`,
    `ALTER INDEX idx_facts_embedding_hnsw RENAME TO idx_facts_embedding_hnsw_ze_r0`,
    `ALTER TABLE facts RENAME COLUMN embedding TO ${R1_BACKUP_COLUMN}`,
    `ALTER TABLE facts RENAME COLUMN ${R1_SHADOW_COLUMN} TO embedding`,
    `ALTER INDEX idx_facts_${R1_SHADOW_COLUMN}_hnsw RENAME TO idx_facts_embedding_hnsw`,
    `UPDATE facts SET embedded_at=now() WHERE embedding IS NOT NULL`,
    `ALTER INDEX idx_query_cache_embedding_hnsw RENAME TO idx_query_cache_embedding_hnsw_ze_r0`,
    `ALTER TABLE query_cache RENAME COLUMN embedding TO ${R1_BACKUP_COLUMN}`,
    `ALTER TABLE query_cache ADD COLUMN embedding vector(${R1_TARGET_DIMENSIONS})`,
    `CREATE INDEX idx_query_cache_embedding_hnsw ON query_cache USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL`,
    `DELETE FROM query_cache`,
    `INSERT INTO config(key,value) VALUES ('embedding_model','${R1_TARGET_MODEL}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('embedding_dimensions','${R1_TARGET_DIMENSIONS}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('search_embedding_column','embedding') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `UPDATE pages p SET embedding_signature=CASE WHEN EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id) AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NULL) THEN '${signature}' ELSE NULL END`,
  ];
}

export function buildRollbackStatements(
  fromModel: string,
  fromDimensions: number,
  priorRerankerModel: string,
  priorRerankerEnabled: boolean,
): string[] {
  if (!/^[A-Za-z0-9._/:-]+$/.test(fromModel)) throw new Error('Unsafe rollback embedding model');
  if (!Number.isInteger(fromDimensions) || fromDimensions < 1) throw new Error('Unsafe rollback dimensions');
  if (!/^[A-Za-z0-9._/:-]+$/.test(priorRerankerModel)) throw new Error('Unsafe rollback reranker model');
  const signature = `${fromModel}:${fromDimensions}`;
  return [
    `ALTER INDEX idx_chunks_embedding RENAME TO idx_chunks_embedding_g768_r1`,
    `ALTER INDEX idx_chunks_embedding_null RENAME TO idx_chunks_embedding_null_g768_r1`,
    `ALTER INDEX content_chunks_stale_idx RENAME TO content_chunks_stale_idx_g768_r1`,
    `ALTER TABLE content_chunks RENAME COLUMN embedding TO embedding_g768_r1`,
    `ALTER TABLE content_chunks RENAME COLUMN ${R1_BACKUP_COLUMN} TO embedding`,
    `ALTER INDEX idx_chunks_embedding_ze_r0 RENAME TO idx_chunks_embedding`,
    `ALTER INDEX idx_chunks_embedding_null_ze_r0 RENAME TO idx_chunks_embedding_null`,
    `ALTER INDEX content_chunks_stale_idx_ze_r0 RENAME TO content_chunks_stale_idx`,
    `UPDATE content_chunks SET model='${fromModel}', embedded_at=now() WHERE embedding IS NOT NULL`,
    `ALTER INDEX idx_facts_embedding_hnsw RENAME TO idx_facts_embedding_hnsw_g768_r1`,
    `ALTER TABLE facts RENAME COLUMN embedding TO embedding_g768_r1`,
    `ALTER TABLE facts RENAME COLUMN ${R1_BACKUP_COLUMN} TO embedding`,
    `ALTER INDEX idx_facts_embedding_hnsw_ze_r0 RENAME TO idx_facts_embedding_hnsw`,
    `UPDATE facts SET embedded_at=now() WHERE embedding IS NOT NULL`,
    `ALTER INDEX idx_query_cache_embedding_hnsw RENAME TO idx_query_cache_embedding_hnsw_g768_r1`,
    `ALTER TABLE query_cache RENAME COLUMN embedding TO embedding_g768_r1`,
    `ALTER TABLE query_cache RENAME COLUMN ${R1_BACKUP_COLUMN} TO embedding`,
    `ALTER INDEX idx_query_cache_embedding_hnsw_ze_r0 RENAME TO idx_query_cache_embedding_hnsw`,
    `DELETE FROM query_cache`,
    `INSERT INTO config(key,value) VALUES ('embedding_model','${fromModel}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('embedding_dimensions','${fromDimensions}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('search_embedding_column','embedding') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('search.reranker.model','${priorRerankerModel}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('search.reranker.enabled','${String(priorRerankerEnabled)}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `UPDATE pages p SET embedding_signature=CASE WHEN EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id) AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NULL) THEN '${signature}' ELSE NULL END`,
  ];
}
