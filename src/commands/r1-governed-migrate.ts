#!/usr/bin/env bun
/** Fixed Avers R1 Google migration runner. Production requires separate G5 GO. */
import postgres, { type Sql } from 'postgres';
import { writeFileSync } from 'node:fs';
import { configureGateway, embed, resetGateway } from '../core/ai/gateway.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import {
  R1_BACKUP_COLUMN,
  R1_ADVISORY_LOCK_KEY,
  R1_COMPLETED_KEY,
  R1_SHADOW_COLUMN,
  R1_STATE_KEY,
  R1_TARGET_DIMENSIONS,
  R1_TARGET_MODEL,
  R1_WRITER_FENCE_KEY,
  R1_WRITER_FENCE_TABLES,
  assertR1DatabaseTarget,
  assertR1CompletionReality,
  assertR1EnvTarget,
  assertReadyForCutover,
  buildCutoverStatements,
  buildRollbackStatements,
  buildR1MigrationIdentity,
  buildWriterFenceDropSql,
  buildWriterFenceSql,
  identityFingerprint,
  parseR1MigrationArgs,
  resolveContentPlaneCounts,
  vectorLiteral,
  type R1CutoverStatus,
  type R1MigrationArgs,
  type R1MigrationIdentity,
  type R1CompletionReality,
} from '../core/r1-governed-migration.ts';

interface ColumnRow { type: string }
interface CountRow { total: number; populated: number }
interface StateEnvelope {
  schema_version: 1;
  identity: R1MigrationIdentity;
  fingerprint: string;
  phase: 'preparing' | 'prepared' | 'cutover' | 'completed' | 'rolled_back';
  started_at: string;
  updated_at: string;
  from_model: string;
  from_dimensions: number;
  prior_reranker_model: string;
  prior_reranker_enabled: boolean;
  writer_fence_tables: string[];
}

function nowIso(): string { return new Date().toISOString(); }
async function getConfig(sql: Sql, key: string): Promise<string | null> {
  const rows = await sql.unsafe('SELECT value FROM config WHERE key=$1', [key]) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}
async function setConfig(sql: Sql, key: string, value: string): Promise<void> {
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
}
async function columnType(sql: Sql, table: string, column: string): Promise<string | null> {
  const rows = await sql.unsafe(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=$1 AND a.attname=$2 AND a.attnum>0 AND NOT a.attisdropped`,
    [table, column],
  ) as ColumnRow[];
  return rows[0]?.type ?? null;
}
async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const rows = await sql.unsafe(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]) as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}
async function countPlane(sql: Sql, table: string, primary: string, shadow: string): Promise<{ total: number; populated: number }> {
  const rows = await sql.unsafe(`SELECT count(${primary})::int AS total, count(${shadow})::int AS populated FROM ${table}`) as CountRow[];
  return { total: Number(rows[0]?.total ?? 0), populated: Number(rows[0]?.populated ?? 0) };
}

async function readStatus(sql: Sql): Promise<Record<string, unknown> & R1CutoverStatus> {
  const contentShadowType = await columnType(sql, 'content_chunks', R1_SHADOW_COLUMN);
  const factsShadowType = await columnType(sql, 'facts', R1_SHADOW_COLUMN);
  const contentTotal = Number((await sql.unsafe('SELECT count(*)::int AS n FROM content_chunks') as Array<{ n: number }>)[0]?.n ?? 0);
  const contentRows = contentShadowType
    ? await sql.unsafe(`SELECT count(*)::int AS total, count(${R1_SHADOW_COLUMN})::int AS populated FROM content_chunks`) as CountRow[]
    : [];
  const contentCounts = resolveContentPlaneCounts(contentShadowType, contentRows[0], contentTotal);
  const factsCounts = factsShadowType
    ? await countPlane(sql, 'facts', 'embedding', R1_SHADOW_COLUMN)
    : { total: Number((await sql.unsafe('SELECT count(embedding)::int AS n FROM facts') as Array<{ n: number }>)[0]?.n ?? 0), populated: 0 };
  const takesPopulated = Number((await sql.unsafe('SELECT count(embedding)::int AS n FROM takes') as Array<{ n: number }>)[0]?.n ?? 0);
  const triggerCount = Number((await sql.unsafe(
    `SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'avers_r1_writer_fence_%'`,
  ) as Array<{ n: number }>)[0]?.n ?? 0);
  const model = await getConfig(sql, 'embedding_model');
  const dims = await getConfig(sql, 'embedding_dimensions');
  const markerRaw = await getConfig(sql, R1_STATE_KEY);
  let marker: unknown = null;
  try { marker = markerRaw ? JSON.parse(markerRaw) : null; } catch { marker = { corrupt: true }; }
  return {
    schema_version: 1,
    target_model: R1_TARGET_MODEL,
    target_dimensions: R1_TARGET_DIMENSIONS,
    current_model: model,
    current_dimensions: dims ? Number(dims) : null,
    marker,
    writer_fence_active: (await getConfig(sql, R1_WRITER_FENCE_KEY)) === 'active' && triggerCount > 0,
    writer_fence_trigger_count: triggerCount,
    content_chunks: {
      total: contentCounts.total,
      shadow_populated: contentCounts.populated,
      primary_type: await columnType(sql, 'content_chunks', 'embedding'),
      shadow_type: contentShadowType,
      backup_type: await columnType(sql, 'content_chunks', R1_BACKUP_COLUMN),
    },
    facts: {
      total_populated: factsCounts.total,
      shadow_populated: factsCounts.populated,
      primary_type: await columnType(sql, 'facts', 'embedding'),
      shadow_type: factsShadowType,
      backup_type: await columnType(sql, 'facts', R1_BACKUP_COLUMN),
    },
    query_cache: {
      primary_type: await columnType(sql, 'query_cache', 'embedding'),
      backup_type: await columnType(sql, 'query_cache', R1_BACKUP_COLUMN),
      rows: Number((await sql.unsafe('SELECT count(*)::int AS n FROM query_cache') as Array<{ n: number }>)[0]?.n ?? 0),
    },
    takes: { total_populated: takesPopulated, primary_type: await columnType(sql, 'takes', 'embedding') },
    image_planes: {
      embedding_image: await columnType(sql, 'content_chunks', 'embedding_image'),
      embedding_multimodal: await columnType(sql, 'content_chunks', 'embedding_multimodal'),
    },
  } as Record<string, unknown> & R1CutoverStatus;
}

async function activeEmbedJobs(sql: Sql): Promise<number> {
  const rows = await sql.unsafe(
    `SELECT count(*)::int AS n FROM minion_jobs
      WHERE status IN ('waiting','delayed','active','waiting-children')
        AND (name IN ('embed','embed-backfill','sync','extract','source-ingest') OR name LIKE '%embed%')`,
  ) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

function parseRegistryColumns(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('embedding_columns registry is corrupt'); }
  const names = Array.isArray(parsed)
    ? parsed.map((entry) => typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? String((entry as any).column ?? '') : ''))
    : parsed && typeof parsed === 'object' ? Object.keys(parsed as Record<string, unknown>) : [];
  return [...new Set(names.filter((name) => name && name !== 'embedding'))].sort();
}

async function readCompletionReality(sql: Sql): Promise<R1CompletionReality> {
  const signature = `${R1_TARGET_MODEL}:${R1_TARGET_DIMENSIONS}`;
  const counts = (await sql.unsafe(`
    SELECT
      (SELECT count(*)::int FROM content_chunks) AS content_total,
      (SELECT count(embedding)::int FROM content_chunks) AS content_populated,
      (SELECT count(${R1_BACKUP_COLUMN})::int FROM facts) AS facts_expected,
      (SELECT count(embedding)::int FROM facts) AS facts_populated,
      (SELECT count(*)::int FROM query_cache) AS query_cache_rows,
      (SELECT count(embedding)::int FROM takes) AS takes_populated,
      (SELECT count(*)::int FROM pages p WHERE p.embedding_signature=$1 AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND (c.embedding IS NULL OR c.model<>$2))) AS false_target_signatures,
      (SELECT count(*)::int FROM pages p WHERE p.embedding_signature IS NULL AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id)) AS null_signatures_with_chunks`,
    [signature, R1_TARGET_MODEL],
  ) as Array<Record<string, number>>)[0] ?? {};
  const sample = (await sql.unsafe(`SELECT id,chunk_text FROM content_chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT 1`) as Array<{ id: number; chunk_text: string }>)[0];
  let vectorRoundtripOk = false;
  if (sample) {
    const vectors = await embed([sample.chunk_text], { embeddingModel: R1_TARGET_MODEL, dimensions: R1_TARGET_DIMENSIONS, inputType: 'query', maxRetries: 1 });
    const hits = await sql.unsafe(`SELECT id FROM content_chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 1`, [vectorLiteral(vectors[0])]) as Array<{ id: number }>;
    vectorRoundtripOk = hits.length === 1;
  }
  return {
    current_model: await getConfig(sql, 'embedding_model'),
    current_dimensions: Number(await getConfig(sql, 'embedding_dimensions')) || null,
    content_primary_type: await columnType(sql, 'content_chunks', 'embedding'),
    content_total: Number(counts.content_total ?? 0), content_populated: Number(counts.content_populated ?? 0),
    facts_primary_type: await columnType(sql, 'facts', 'embedding'),
    facts_expected: Number(counts.facts_expected ?? 0), facts_populated: Number(counts.facts_populated ?? 0),
    query_cache_type: await columnType(sql, 'query_cache', 'embedding'), query_cache_rows: Number(counts.query_cache_rows ?? 0),
    takes_populated: Number(counts.takes_populated ?? 0),
    image_type: await columnType(sql, 'content_chunks', 'embedding_image'),
    multimodal_type: await columnType(sql, 'content_chunks', 'embedding_multimodal'),
    false_target_signatures: Number(counts.false_target_signatures ?? 0),
    null_signatures_with_chunks: Number(counts.null_signatures_with_chunks ?? 0),
    active_embed_jobs: await activeEmbedJobs(sql),
    custom_registry_columns: parseRegistryColumns(await getConfig(sql, 'embedding_columns')),
    scalar_watermark: Number(await getConfig(sql, 'version')),
    vector_roundtrip_ok: vectorRoundtripOk,
  };
}

async function existingFenceTables(sql: Sql): Promise<string[]> {
  const out: string[] = [];
  for (const table of R1_WRITER_FENCE_TABLES) if (await tableExists(sql, table)) out.push(table);
  return out;
}

async function probeTarget(): Promise<void> {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is required');
  configureGateway({ embedding_model: R1_TARGET_MODEL, embedding_dimensions: R1_TARGET_DIMENSIONS, env: { ...process.env } });
  const vectors = await embed(['gbrain Avers R1 migration probe'], {
    embeddingModel: R1_TARGET_MODEL,
    dimensions: R1_TARGET_DIMENSIONS,
    inputType: 'query',
    maxRetries: 1,
  });
  if (vectors.length !== 1 || vectors[0]?.length !== R1_TARGET_DIMENSIONS) {
    throw new Error(`Target provider probe returned ${vectors[0]?.length ?? 0} dimensions`);
  }
}

async function prepare(sql: Sql, args: R1MigrationArgs): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--prepare requires --yes');
  if (!args.expectedCandidateSha || !args.implementationChecksum) {
    throw new Error('--prepare requires --expected-candidate-sha and --implementation-checksum');
  }
  assertR1EnvTarget(process.env, 'target');
  const identity = buildR1MigrationIdentity(args.expectedCandidateSha, args.implementationChecksum);
  const fingerprint = identityFingerprint(identity);
  const currentStateRaw = await getConfig(sql, R1_STATE_KEY);
  if (currentStateRaw) {
    const current = JSON.parse(currentStateRaw) as StateEnvelope;
    if (current.fingerprint !== fingerprint) throw new Error(`Different R1 migration marker is active: ${current.fingerprint}`);
  }
  const statusBefore = await readStatus(sql);
  if (statusBefore.content_chunks.primary_type !== 'vector(1280)' || statusBefore.facts.primary_type !== 'vector(1280)') {
    throw new Error('Expected ZE baseline vector(1280) primary planes');
  }
  if (statusBefore.query_cache.primary_type !== 'vector(1280)' || statusBefore.takes.primary_type !== 'vector(1536)') {
    throw new Error('Dim-pinned baseline does not match the approved catalog');
  }
  if (statusBefore.takes.total_populated !== 0) throw new Error('takes.embedding became populated; STOP');
  const jobs = await activeEmbedJobs(sql);
  if (jobs > 0) throw new Error(`Refusing while ${jobs} embedding-producing job(s) are active/waiting`);
  await probeTarget();

  await sql.unsafe(`ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS ${R1_SHADOW_COLUMN} vector(${R1_TARGET_DIMENSIONS})`);
  await sql.unsafe(`ALTER TABLE facts ADD COLUMN IF NOT EXISTS ${R1_SHADOW_COLUMN} vector(${R1_TARGET_DIMENSIONS})`);
  const fenceTables = await existingFenceTables(sql);
  await sql.unsafe(buildWriterFenceSql(fenceTables));
  await setConfig(sql, R1_WRITER_FENCE_KEY, 'active');
  const startedAt = currentStateRaw ? (JSON.parse(currentStateRaw) as StateEnvelope).started_at : nowIso();
  const state: StateEnvelope = {
    schema_version: 1, identity, fingerprint, phase: 'preparing', started_at: startedAt, updated_at: nowIso(),
    from_model: String(statusBefore.current_model ?? 'unknown'),
    from_dimensions: Number(statusBefore.current_dimensions ?? 0),
    prior_reranker_model: await getConfig(sql, 'search.reranker.model') ?? 'zeroentropyai:zerank-2',
    prior_reranker_enabled: (await getConfig(sql, 'search.reranker.enabled')) === 'true',
    writer_fence_tables: fenceTables,
  };
  await setConfig(sql, R1_STATE_KEY, JSON.stringify(state));
  if (args.noEmbed) return { status: 'prepared_no_embed', state, ...(await readStatus(sql)) };

  let chunksEmbedded = 0;
  let factsEmbedded = 0;
  let batches = 0;
  while (true) {
    const rows = await sql.unsafe(
      `SELECT id,chunk_text FROM content_chunks WHERE ${R1_SHADOW_COLUMN} IS NULL ORDER BY id LIMIT $1`,
      [args.batchSize],
    ) as Array<{ id: number; chunk_text: string }>;
    if (rows.length === 0) break;
    const vectors = await embed(rows.map((r) => r.chunk_text), {
      embeddingModel: R1_TARGET_MODEL, dimensions: R1_TARGET_DIMENSIONS, inputType: 'document', maxRetries: 2,
    });
    if (vectors.length !== rows.length) throw new Error('Chunk embedding count mismatch');
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL avers.r1_migration_runner='on'`);
      for (let i = 0; i < rows.length; i++) {
        await tx.unsafe(`UPDATE content_chunks SET ${R1_SHADOW_COLUMN}=$1::vector WHERE id=$2 AND ${R1_SHADOW_COLUMN} IS NULL`, [vectorLiteral(vectors[i]), rows[i].id]);
      }
    });
    chunksEmbedded += rows.length;
    batches++;
    state.updated_at = nowIso();
    await setConfig(sql, R1_STATE_KEY, JSON.stringify(state));
    if (args.stopAfterBatches > 0 && batches >= args.stopAfterBatches) throw new Error(`R1_CONTROLLED_STOP_AFTER_BATCHES:${batches}`);
    if (args.paceMs > 0) await Bun.sleep(args.paceMs);
  }
  while (true) {
    const rows = await sql.unsafe(
      `SELECT id,fact,COALESCE(context,'') AS context FROM facts WHERE embedding IS NOT NULL AND ${R1_SHADOW_COLUMN} IS NULL ORDER BY id LIMIT $1`,
      [args.batchSize],
    ) as Array<{ id: number; fact: string; context: string }>;
    if (rows.length === 0) break;
    const vectors = await embed(rows.map((r) => `${r.fact}\n${r.context}`.trim()), {
      embeddingModel: R1_TARGET_MODEL, dimensions: R1_TARGET_DIMENSIONS, inputType: 'document', maxRetries: 2,
    });
    if (vectors.length !== rows.length) throw new Error('Fact embedding count mismatch');
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL avers.r1_migration_runner='on'`);
      for (let i = 0; i < rows.length; i++) {
        await tx.unsafe(`UPDATE facts SET ${R1_SHADOW_COLUMN}=$1::vector WHERE id=$2 AND ${R1_SHADOW_COLUMN} IS NULL`, [vectorLiteral(vectors[i]), rows[i].id]);
      }
    });
    factsEmbedded += rows.length;
    batches++;
    state.updated_at = nowIso();
    await setConfig(sql, R1_STATE_KEY, JSON.stringify(state));
    if (args.stopAfterBatches > 0 && batches >= args.stopAfterBatches) throw new Error(`R1_CONTROLLED_STOP_AFTER_BATCHES:${batches}`);
    if (args.paceMs > 0) await Bun.sleep(args.paceMs);
  }
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_chunks_${R1_SHADOW_COLUMN} ON content_chunks USING hnsw (${R1_SHADOW_COLUMN} vector_cosine_ops) WHERE ${R1_SHADOW_COLUMN} IS NOT NULL`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_facts_${R1_SHADOW_COLUMN}_hnsw ON facts USING hnsw (${R1_SHADOW_COLUMN} vector_cosine_ops) WHERE ${R1_SHADOW_COLUMN} IS NOT NULL AND expired_at IS NULL`);
  state.phase = 'prepared'; state.updated_at = nowIso();
  await setConfig(sql, R1_STATE_KEY, JSON.stringify(state));
  return { status: 'prepared', chunks_embedded_this_run: chunksEmbedded, facts_embedded_this_run: factsEmbedded, batches, state, ...(await readStatus(sql)) };
}

async function cutover(sql: Sql, args: R1MigrationArgs): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--cutover requires --yes');
  assertR1EnvTarget(process.env, 'target');
  const stateRaw = await getConfig(sql, R1_STATE_KEY);
  if (!stateRaw) throw new Error('No active R1 migration marker');
  const state = JSON.parse(stateRaw) as StateEnvelope;
  if (args.expectedCandidateSha && state.identity.candidate_sha !== args.expectedCandidateSha) throw new Error('Candidate SHA differs from active marker');
  const status = await readStatus(sql);
  const alreadyCutover = status.content_chunks.primary_type === 'vector(768)' && (status.content_chunks as any).backup_type === 'vector(1280)';
  if (!alreadyCutover) {
    assertReadyForCutover(status);
    state.phase = 'cutover'; state.updated_at = nowIso();
    await setConfig(sql, R1_STATE_KEY, JSON.stringify(state));
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL avers.r1_migration_runner='on'`);
      for (const statement of buildCutoverStatements()) await tx.unsafe(statement);
      await tx.unsafe(`INSERT INTO config(key,value) VALUES ('search.reranker.enabled','false') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
      await tx.unsafe(`INSERT INTO config(key,value) VALUES ('search.reranker.model','voyage:rerank-2.5') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
    });
  }
  const completion = await readCompletionReality(sql);
  assertR1CompletionReality(completion);
  state.phase = 'completed'; state.updated_at = nowIso();
  await setConfig(sql, R1_COMPLETED_KEY, JSON.stringify({ ...state, completed_at: nowIso(), completion }));
  await setConfig(sql, R1_STATE_KEY, JSON.stringify(state));
  return { status: 'cutover_complete', state, completion, ...(await readStatus(sql)) };
}

async function disableFence(sql: Sql, args: R1MigrationArgs): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--disable-fence requires --yes');
  const existing = await existingFenceTables(sql);
  await sql.unsafe(buildWriterFenceDropSql(existing));
  await setConfig(sql, R1_WRITER_FENCE_KEY, 'disabled');
  return { status: 'writer_fence_disabled', ...(await readStatus(sql)) };
}

async function rollback(sql: Sql, args: R1MigrationArgs): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--rollback requires --yes');
  const stateRaw = await getConfig(sql, R1_STATE_KEY);
  if (!stateRaw) throw new Error('No R1 migration marker available for rollback');
  const state = JSON.parse(stateRaw) as StateEnvelope;
  if (state.phase !== 'completed') throw new Error(`Rollback requires completed cutover state, got ${state.phase}`);
  assertR1EnvTarget(process.env, 'source', state.from_model, state.from_dimensions);
  const status = await readStatus(sql);
  if (!status.writer_fence_active) throw new Error('Rollback requires the writer fence to remain active');
  if (status.content_chunks.primary_type !== 'vector(768)' || (status.content_chunks as any).backup_type !== 'vector(1280)') {
    throw new Error('Content vector planes are not in the expected post-cutover state');
  }
  if (status.facts.primary_type !== 'vector(768)' || (status.facts as any).backup_type !== 'vector(1280)') {
    throw new Error('Fact vector planes are not in the expected post-cutover state');
  }
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL avers.r1_migration_runner='on'`);
    for (const statement of buildRollbackStatements(
      state.from_model,
      state.from_dimensions,
      state.prior_reranker_model,
      state.prior_reranker_enabled,
    )) await tx.unsafe(statement);
  });
  state.phase = 'rolled_back'; state.updated_at = nowIso();
  await setConfig(sql, R1_STATE_KEY, JSON.stringify(state));
  return { status: 'rollback_complete', state, ...(await readStatus(sql)) };
}

async function main(): Promise<void> {
  const args = parseR1MigrationArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  assertR1DatabaseTarget(databaseUrl, args.target, process.env.R1_MIGRATION_CLONE_ACK, process.env.R1_MIGRATION_PRODUCTION_GO);
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 30 });
  let lockHeld = false;
  try {
    if (args.mode !== 'status' && args.mode !== 'dry-run') {
      const lock = await sql.unsafe('SELECT pg_try_advisory_lock($1) AS ok', [R1_ADVISORY_LOCK_KEY]) as Array<{ ok: boolean }>;
      if (lock[0]?.ok !== true) throw new Error('Another Avers R1 migration runner holds the global lock');
      lockHeld = true;
    }
    const result = args.mode === 'status' || args.mode === 'dry-run'
      ? { status: args.mode, ...(await readStatus(sql)), active_embed_jobs: await activeEmbedJobs(sql) }
      : args.mode === 'prepare' ? await prepare(sql, args)
      : args.mode === 'cutover' ? await cutover(sql, args)
      : args.mode === 'disable-fence' ? await disableFence(sql, args)
      : await rollback(sql, args);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (args.receipt) writeFileSync(args.receipt, output, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(output);
  } finally {
    resetGateway();
    if (lockHeld) await sql.unsafe('SELECT pg_advisory_unlock($1)', [R1_ADVISORY_LOCK_KEY]).catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`[avers-r1-migrate] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  setCliExitVerdict(1);
});
