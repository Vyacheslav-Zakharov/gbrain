/** Avers R1 collision-safe Google embedding migration primitives. */
import { createHash } from 'node:crypto';

export const R1_LINEAGE = 'avers-fork-0.42.53-r1';
export const R1_OPERATION_ID = 'avers:r1:ze-exit:google-g768:v1';
export const R1_TARGET_MODEL = 'google:gemini-embedding-001';
export const R1_TARGET_DIMENSIONS = 768;
export const R1_STATE_KEY = 'avers.r1.embedding_migration.state';
export const R1_COMPLETED_KEY = 'avers.r1.embedding_migration.completed';
export const R1_WRITER_FENCE_KEY = 'avers.r1.writer_fence';
export const R1_SHADOW_COLUMN = 'embedding_r1_g768';
export const R1_BACKUP_COLUMN = 'embedding_ze_r0';
export const R1_WRITER_FENCE_TABLES = [
  'pages', 'content_chunks', 'facts', 'takes', 'links', 'timeline_entries',
  'query_cache', 'sources', 'source_sync_state', 'source_ingest_runs',
  'source_ingest_run_items', 'take_proposals', 'concept_proposals',
  'minion_jobs', 'mcp_request_log', 'ingest_log', 'eval_candidates',
] as const;
export const R1_ADVISORY_LOCK_KEY = 7_671_003_001;

export type R1MigrationMode = 'status' | 'dry-run' | 'prepare' | 'cutover' | 'rollback' | 'disable-fence';
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
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseR1MigrationArgs(argv: string[]): R1MigrationArgs {
  const modeFlags: Array<[string, R1MigrationMode]> = [
    ['--status', 'status'], ['--dry-run', 'dry-run'], ['--prepare', 'prepare'],
    ['--cutover', 'cutover'], ['--rollback', 'rollback'], ['--disable-fence', 'disable-fence'],
  ];
  const selected = modeFlags.filter(([flag]) => argv.includes(flag)).map(([, mode]) => mode);
  if (selected.length !== 1) throw new Error('Pass exactly one mode: --status, --dry-run, --prepare, --cutover, --rollback, or --disable-fence');
  const batchSize = Number(argValue(argv, '--batch-size') ?? '64');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new Error('--batch-size must be an integer in [1, 256]');
  }
  const paceMs = Number(argValue(argv, '--pace-ms') ?? '0');
  if (!Number.isInteger(paceMs) || paceMs < 0 || paceMs > 60_000) {
    throw new Error('--pace-ms must be an integer in [0, 60000]');
  }
  const targetRaw = argValue(argv, '--target') ?? 'clone';
  if (targetRaw !== 'clone' && targetRaw !== 'production') throw new Error('--target must be clone or production');
  const stopAfterBatches = Number(argValue(argv, '--stop-after-batches') ?? '0');
  if (!Number.isInteger(stopAfterBatches) || stopAfterBatches < 0 || stopAfterBatches > 10_000) throw new Error('--stop-after-batches must be in [0,10000]');
  if (targetRaw === 'production' && stopAfterBatches > 0) throw new Error('--stop-after-batches is clone-only');
  const receipt = argValue(argv, '--receipt');
  if (argv.includes('--receipt') && !receipt) throw new Error('--receipt requires a path');
  return {
    mode: selected[0],
    target: targetRaw,
    yes: argv.includes('--yes'),
    noEmbed: argv.includes('--no-embed'),
    batchSize,
    paceMs,
    stopAfterBatches,
    ...(receipt ? { receipt } : {}),
    ...(argValue(argv, '--expected-candidate-sha') ? { expectedCandidateSha: argValue(argv, '--expected-candidate-sha') } : {}),
    ...(argValue(argv, '--implementation-checksum') ? { implementationChecksum: argValue(argv, '--implementation-checksum') } : {}),
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
}

export function buildR1MigrationIdentity(candidateSha: string, implementationChecksum: string): R1MigrationIdentity {
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) throw new Error('A full 40-character candidate SHA is required');
  if (!/^[0-9a-f]{64}$/.test(implementationChecksum)) throw new Error('A full SHA-256 implementation checksum is required');
  return {
    lineage: R1_LINEAGE,
    operation_id: R1_OPERATION_ID,
    target_model: R1_TARGET_MODEL,
    target_dimensions: R1_TARGET_DIMENSIONS,
    candidate_sha: candidateSha,
    implementation_checksum: implementationChecksum,
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
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('avers.r1_migration_runner', true) IS DISTINCT FROM 'on' THEN
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

export interface R1WriterFenceRow {
  table: string;
  trigger: string;
  schema: string;
  function_schema: string;
  function_name: string;
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

export function isExactR1WriterFence(expectedTables: string[], rows: R1WriterFenceRow[]): boolean {
  const expected = [...new Set(expectedTables)].sort();
  if (expected.length === 0 || expected.length !== expectedTables.length) return false;
  if (rows.length !== expected.length) return false;
  const byTable = new Map(rows.map((row) => [row.table, row]));
  return expected.every((table) => {
    const row = byTable.get(table);
    if (!row) return false;
    const definition = row.definition.toUpperCase();
    return row.schema === 'public'
      && row.trigger === `avers_r1_writer_fence_${table}`
      && row.function_schema === 'public'
      && row.function_name === 'avers_r1_writer_fence_guard'
      && row.enabled === 'O'
      && definition.includes('BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE')
      && definition.includes('FOR EACH STATEMENT');
  });
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
  content_chunks: { total: number; shadow_populated: number; primary_type: string | null; shadow_type: string | null };
  facts: { total_populated: number; shadow_populated: number; primary_type: string | null; shadow_type: string | null };
  query_cache: { primary_type: string | null };
  takes: { total_populated: number; primary_type: string | null };
}

export interface R1CompletionReality {
  current_model: string | null;
  current_dimensions: number | null;
  content_primary_type: string | null;
  content_total: number;
  content_populated: number;
  facts_primary_type: string | null;
  facts_expected: number;
  facts_populated: number;
  query_cache_type: string | null;
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
}

export function assertR1CompletionReality(r: R1CompletionReality): void {
  if (r.current_model !== R1_TARGET_MODEL || r.current_dimensions !== R1_TARGET_DIMENSIONS) throw new Error('completion config identity mismatch');
  if (r.content_primary_type !== 'vector(768)' || r.content_populated !== r.content_total) throw new Error('completion content plane mismatch');
  if (r.facts_primary_type !== 'vector(768)' || r.facts_populated !== r.facts_expected) throw new Error('completion facts plane mismatch');
  if (r.query_cache_type !== 'vector(768)' || r.query_cache_rows !== 0) throw new Error('completion query cache mismatch');
  if (r.takes_populated !== 0) throw new Error('completion takes disposition mismatch');
  if (r.image_type !== 'vector(1024)' || r.multimodal_type !== 'vector(1024)') throw new Error('completion image plane drift');
  if (r.false_target_signatures !== 0 || r.null_signatures_with_chunks !== 0) throw new Error('completion page signature mismatch');
  if (r.active_embed_jobs !== 0) throw new Error('completion active embedding jobs remain');
  if (r.custom_registry_columns.length !== 0) throw new Error(`completion embedding registry unresolved: ${r.custom_registry_columns.join(',')}`);
  if (r.scalar_watermark !== 140) throw new Error(`completion scalar watermark drifted to ${r.scalar_watermark}`);
  if (!r.vector_roundtrip_ok) throw new Error('completion vector roundtrip failed');
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
    `ALTER INDEX IF EXISTS idx_chunks_embedding RENAME TO idx_chunks_embedding_ze_r0`,
    `ALTER INDEX IF EXISTS idx_chunks_embedding_null RENAME TO idx_chunks_embedding_null_ze_r0`,
    `ALTER INDEX IF EXISTS content_chunks_stale_idx RENAME TO content_chunks_stale_idx_ze_r0`,
    `ALTER TABLE content_chunks RENAME COLUMN embedding TO ${R1_BACKUP_COLUMN}`,
    `ALTER TABLE content_chunks RENAME COLUMN ${R1_SHADOW_COLUMN} TO embedding`,
    `ALTER INDEX IF EXISTS idx_chunks_${R1_SHADOW_COLUMN} RENAME TO idx_chunks_embedding`,
    `CREATE INDEX idx_chunks_embedding_null ON content_chunks(page_id, chunk_index) WHERE embedding IS NULL`,
    `CREATE INDEX content_chunks_stale_idx ON content_chunks(page_id, chunk_index) WHERE embedding IS NULL`,
    `UPDATE content_chunks SET model='${R1_TARGET_MODEL}', embedded_at=now() WHERE embedding IS NOT NULL`,
    `ALTER INDEX IF EXISTS idx_facts_embedding_hnsw RENAME TO idx_facts_embedding_hnsw_ze_r0`,
    `ALTER TABLE facts RENAME COLUMN embedding TO ${R1_BACKUP_COLUMN}`,
    `ALTER TABLE facts RENAME COLUMN ${R1_SHADOW_COLUMN} TO embedding`,
    `ALTER INDEX IF EXISTS idx_facts_${R1_SHADOW_COLUMN}_hnsw RENAME TO idx_facts_embedding_hnsw`,
    `UPDATE facts SET embedded_at=now() WHERE embedding IS NOT NULL`,
    `ALTER INDEX IF EXISTS idx_query_cache_embedding_hnsw RENAME TO idx_query_cache_embedding_hnsw_ze_r0`,
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
    `ALTER INDEX IF EXISTS idx_chunks_embedding RENAME TO idx_chunks_embedding_g768_r1`,
    `ALTER INDEX IF EXISTS idx_chunks_embedding_null RENAME TO idx_chunks_embedding_null_g768_r1`,
    `ALTER INDEX IF EXISTS content_chunks_stale_idx RENAME TO content_chunks_stale_idx_g768_r1`,
    `ALTER TABLE content_chunks RENAME COLUMN embedding TO embedding_g768_r1`,
    `ALTER TABLE content_chunks RENAME COLUMN ${R1_BACKUP_COLUMN} TO embedding`,
    `ALTER INDEX IF EXISTS idx_chunks_embedding_ze_r0 RENAME TO idx_chunks_embedding`,
    `ALTER INDEX IF EXISTS idx_chunks_embedding_null_ze_r0 RENAME TO idx_chunks_embedding_null`,
    `ALTER INDEX IF EXISTS content_chunks_stale_idx_ze_r0 RENAME TO content_chunks_stale_idx`,
    `UPDATE content_chunks SET model='${fromModel}', embedded_at=now() WHERE embedding IS NOT NULL`,
    `ALTER INDEX IF EXISTS idx_facts_embedding_hnsw RENAME TO idx_facts_embedding_hnsw_g768_r1`,
    `ALTER TABLE facts RENAME COLUMN embedding TO embedding_g768_r1`,
    `ALTER TABLE facts RENAME COLUMN ${R1_BACKUP_COLUMN} TO embedding`,
    `ALTER INDEX IF EXISTS idx_facts_embedding_hnsw_ze_r0 RENAME TO idx_facts_embedding_hnsw`,
    `UPDATE facts SET embedded_at=now() WHERE embedding IS NOT NULL`,
    `ALTER INDEX IF EXISTS idx_query_cache_embedding_hnsw RENAME TO idx_query_cache_embedding_hnsw_g768_r1`,
    `ALTER TABLE query_cache RENAME COLUMN embedding TO embedding_g768_r1`,
    `ALTER TABLE query_cache RENAME COLUMN ${R1_BACKUP_COLUMN} TO embedding`,
    `ALTER INDEX IF EXISTS idx_query_cache_embedding_hnsw_ze_r0 RENAME TO idx_query_cache_embedding_hnsw`,
    `DELETE FROM query_cache`,
    `INSERT INTO config(key,value) VALUES ('embedding_model','${fromModel}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('embedding_dimensions','${fromDimensions}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('search_embedding_column','embedding') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('search.reranker.model','${priorRerankerModel}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `INSERT INTO config(key,value) VALUES ('search.reranker.enabled','${String(priorRerankerEnabled)}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    `UPDATE pages p SET embedding_signature=CASE WHEN EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id) AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NULL) THEN '${signature}' ELSE NULL END`,
  ];
}
