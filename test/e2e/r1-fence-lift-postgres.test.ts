import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres, { type Sql } from 'postgres';
import { validateHandoffNonceLedger } from '../../src/commands/r1-governed-migrate.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import {
  buildR1MigrationIdentity,
  buildWriterFenceSql,
  identityFingerprint,
  isExactR1WriterFence,
  R1_ADVISORY_LOCK_KEY,
  R1_NONCE_LEDGER_KEY,
  type R1WriterFenceRow,
} from '../../src/core/r1-governed-migration.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('r1-fence-lift-postgres requires DATABASE_URL');
const target = new URL(DATABASE_URL);
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (process.env.R1_FENCE_LIFT_TEST_ACK !== '1'
  || !loopbackHosts.has(target.hostname)
  || target.pathname !== '/gbrain_clone') {
  throw new Error('r1-fence-lift-postgres refuses non-disposable target; require ACK, loopback, and database gbrain_clone');
}
const sql = postgres(DATABASE_URL, { max: 1 });
const tables = ['r1_fence_facts', 'r1_fence_pages'];
const tmp = mkdtempSync(join(tmpdir(), 'r1-fence-lift-'));
const repo = resolve(import.meta.dir, '../..');
const runner = resolve(repo, 'src/commands/r1-governed-migrate.ts');
const cli = resolve(repo, 'src/cli.ts');
const roleLoginProbe = resolve(repo, 'test/helpers/r1-role-login-probe.ts');
const implementation = resolve(repo, 'src/core/r1-governed-migration.ts');
const candidateSha = 'a'.repeat(40);
const implementationSha = createHash('sha256').update(readFileSync(implementation)).digest('hex');
const preload = resolve(repo, 'test/helpers/r1-fence-lift-preload.ts');
const brainHome = join(tmp, 'home');
const configDir = join(brainHome, '.gbrain');
const targetConfig = `${JSON.stringify({
  engine: 'postgres',
  embedding_model: 'google:gemini-embedding-001',
  embedding_dimensions: 768,
  search_embedding_column: 'embedding',
  embedding_columns: {},
  search: { reranker: { enabled: false, model: 'voyage:rerank-2.5' } },
}, null, 2)}\n`;
const fileConfigSha = createHash('sha256').update(targetConfig).digest('hex');
const coreTables = ['content_chunks', 'facts', 'query_cache', 'takes', 'pages', 'minion_jobs'];

async function cleanup(): Promise<void> {
  for (const table of tables) await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  for (const table of coreTables) await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  await sql.unsafe('DROP FUNCTION IF EXISTS avers_r1_writer_fence_guard() CASCADE');
  await sql.unsafe(`DELETE FROM config WHERE key IN ('avers.r1.embedding_migration.state','avers.r1.embedding_migration.completed','avers.r1.embedding_migration.aborted','avers.r1.writer_fence')`);
}

async function fenceRows(): Promise<R1WriterFenceRow[]> {
  return await sql.unsafe(
    `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS trigger,
            pn.nspname AS function_schema, p.proname AS function_name,
            pg_get_functiondef(p.oid) AS function_definition,
            pg_get_userbyid(c.relowner) AS table_owner, pg_get_userbyid(p.proowner) AS function_owner,
            current_user AS executor,
            p.provolatile AS function_volatility, p.prosecdef AS function_security_definer, p.proconfig AS function_config,
            t.tgenabled AS enabled, pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_proc p ON p.oid=t.tgfoid
       JOIN pg_namespace pn ON pn.oid=p.pronamespace
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'avers_r1_writer_fence_%'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [tables],
  ) as R1WriterFenceRow[];
}

function runRunner(
  databaseUrl: string,
  receipt: string,
  mode: '--prepare' | '--abort-prepare' | '--cutover' | '--disable-fence',
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [
    '--preload', preload,
    runner, mode, '--target', 'clone', '--yes',
    ...(mode === '--prepare' ? ['--no-embed'] : []),
    '--expected-candidate-sha', candidateSha,
    '--implementation-checksum', implementationSha,
    '--receipt', receipt,
  ], {
    cwd: repo,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      R1_MIGRATION_CLONE_ACK: '1',
      GBRAIN_HOME: brainHome,
      GBRAIN_EMBEDDING_MODEL: 'google:gemini-embedding-001',
      GBRAIN_EMBEDDING_DIMENSIONS: '768',
      GOOGLE_GENERATIVE_AI_API_KEY: 'INJECTED-NON-SECRET',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function runCliWithMigrationMode(mode: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cli, 'config', 'show', '--no-retry-connect'], {
    cwd: repo,
    env: { ...process.env, DATABASE_URL, GBRAIN_HOME: brainHome, GBRAIN_MIGRATION_MODE: mode },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
}

function runRoleLoginProbe(databaseUrl: string, mode: 'migrator' | 'runtime'): Record<string, unknown> {
  const result = spawnSync(process.execPath, [roleLoginProbe], {
    cwd: repo,
    env: { ...process.env, R1_ROLE_DATABASE_URL: databaseUrl, R1_ROLE_PROBE_MODE: mode },
    encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

async function capturePostgresError(operation: Promise<unknown>): Promise<{ code?: string; message: string }> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  if (!caught) throw new Error('Expected PostgreSQL operation to fail');
  return { code: (caught as { code?: string }).code, message: String((caught as Error).message) };
}

async function seedCompletedFence(): Promise<void> {
  await cleanup();
  await sql.unsafe('CREATE TABLE pages(id bigint PRIMARY KEY, embedding_signature text)');
  await sql.unsafe(`CREATE TABLE content_chunks(
    id bigint PRIMARY KEY, page_id integer, chunk_index integer NOT NULL DEFAULT 0, chunk_text text NOT NULL, model text,
    embedding vector(768), embedding_ze_r0 vector(1280),
    embedding_image vector(1024), embedding_multimodal vector(1024)
  )`);
  await sql.unsafe('CREATE TABLE facts(id bigint PRIMARY KEY, expired_at timestamptz, embedding vector(768), embedding_ze_r0 vector(1280))');
  await sql.unsafe('CREATE TABLE query_cache(id bigint PRIMARY KEY, embedding vector(768), embedding_ze_r0 vector(1280))');
  await sql.unsafe('CREATE TABLE takes(id bigint PRIMARY KEY, embedding vector(1536))');
  await sql.unsafe('CREATE TABLE minion_jobs(id bigint PRIMARY KEY, status text, name text)');
  for (const table of tables) await sql.unsafe(`CREATE TABLE ${table}(id bigint PRIMARY KEY)`);
  await sql.unsafe('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL');
  await sql.unsafe('CREATE INDEX idx_facts_embedding_hnsw ON facts USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL AND expired_at IS NULL');
  await sql.unsafe('CREATE INDEX idx_query_cache_embedding_hnsw ON query_cache USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL');
  await sql.unsafe('CREATE INDEX idx_chunks_embedding_image ON content_chunks USING hnsw (embedding_image vector_cosine_ops) WHERE embedding_image IS NOT NULL');
  await sql.unsafe('CREATE INDEX idx_chunks_embedding_null ON content_chunks(page_id,chunk_index) WHERE embedding IS NULL');
  await sql.unsafe('CREATE INDEX content_chunks_stale_idx ON content_chunks(page_id,chunk_index) WHERE embedding IS NULL');
  await sql.unsafe('CREATE INDEX idx_chunks_embedding_ze_r0 ON content_chunks USING hnsw (embedding_ze_r0 vector_cosine_ops)');
  await sql.unsafe('CREATE INDEX idx_chunks_embedding_null_ze_r0 ON content_chunks(page_id,chunk_index) WHERE embedding_ze_r0 IS NULL');
  await sql.unsafe('CREATE INDEX content_chunks_stale_idx_ze_r0 ON content_chunks(page_id,chunk_index) WHERE embedding_ze_r0 IS NULL');
  await sql.unsafe('CREATE INDEX idx_facts_embedding_hnsw_ze_r0 ON facts USING hnsw (embedding_ze_r0 vector_cosine_ops) WHERE embedding_ze_r0 IS NOT NULL AND expired_at IS NULL');
  await sql.unsafe('CREATE INDEX idx_query_cache_embedding_hnsw_ze_r0 ON query_cache USING hnsw (embedding_ze_r0 vector_cosine_ops) WHERE embedding_ze_r0 IS NOT NULL');
  const vector = `[${new Array(768).fill('0.001').join(',')}]`;
  await sql.unsafe(`INSERT INTO pages(id,embedding_signature) VALUES (1,'google:gemini-embedding-001:768')`);
  await sql.unsafe(`INSERT INTO content_chunks(id,page_id,chunk_text,model,embedding)
    VALUES (1,1,'r1 fence lift probe','google:gemini-embedding-001',$1::vector)`, [vector]);
  for (const [key, value] of [
    ['embedding_model', 'google:gemini-embedding-001'],
    ['embedding_dimensions', '768'],
    ['search.reranker.model', 'voyage:rerank-2.5'],
    ['search.reranker.enabled', 'false'],
    ['embedding_columns', '{}'],
    ['search_embedding_column', 'embedding'],
    ['version', '140'],
  ]) await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);

  const identity = buildR1MigrationIdentity(candidateSha, implementationSha);
  const state = {
    schema_version: 1,
    identity,
    fingerprint: identityFingerprint(identity),
    phase: 'completed',
    started_at: '2026-08-27T00:00:00.000Z',
    updated_at: '2026-08-27T00:01:00.000Z',
    from_model: 'zeroentropyai:zembed-1',
    from_dimensions: 1280,
    prior_reranker_model: 'zeroentropyai:zerank-2',
    prior_reranker_enabled: false,
    writer_fence_tables: tables,
  };
  const completion = {
    current_model: 'google:gemini-embedding-001', current_dimensions: 768,
    reranker_model: 'voyage:rerank-2.5', content_primary_type: 'vector(768)', content_backup_type: 'vector(1280)',
    content_total: 1, content_populated: 1, facts_primary_type: 'vector(768)', facts_backup_type: 'vector(1280)',
    facts_expected: 0, facts_populated: 0, query_cache_type: 'vector(768)', query_cache_backup_type: 'vector(1280)',
    query_cache_rows: 0, takes_populated: 0, image_type: 'vector(1024)',
    multimodal_type: 'vector(1024)', false_target_signatures: 0,
    null_signatures_with_chunks: 0, active_embed_jobs: 0,
    custom_registry_columns: [], scalar_watermark: 140, vector_roundtrip_ok: true, postcutover_indexes_exact: true, rollback_indexes_exact: true,
  };
  await sql.unsafe(buildWriterFenceSql(tables));
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2)', ['avers.r1.embedding_migration.state', JSON.stringify(state)]);
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2)', ['avers.r1.embedding_migration.completed', JSON.stringify({
    ...state, completed_at: '2026-08-27T00:02:00.000Z', file_config_sha256: fileConfigSha, completion,
  })]);
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2)', ['avers.r1.writer_fence', 'active']);
}

async function seedPreparingFence(phase: 'preparing' | 'prepared' = 'preparing'): Promise<void> {
  await cleanup();
  await sql.unsafe('CREATE TABLE pages(id bigint PRIMARY KEY, embedding_signature text)');
  await sql.unsafe(`CREATE TABLE content_chunks(
    id bigint PRIMARY KEY, page_id bigint, chunk_text text NOT NULL, model text,
    embedding vector(1280), embedding_r1_g768 vector(768)
  )`);
  await sql.unsafe('CREATE TABLE facts(id bigint PRIMARY KEY, fact text, context text, expired_at timestamptz, embedding vector(1280), embedding_r1_g768 vector(768))');
  await sql.unsafe('CREATE TABLE query_cache(id bigint PRIMARY KEY, embedding vector(1280))');
  await sql.unsafe('CREATE TABLE takes(id bigint PRIMARY KEY, embedding vector(1536))');
  await sql.unsafe('CREATE TABLE minion_jobs(id bigint PRIMARY KEY, status text, name text)');
  for (const table of tables) await sql.unsafe(`CREATE TABLE ${table}(id bigint PRIMARY KEY)`);
  for (const [key, value] of [
    ['embedding_model', 'zeroentropyai:zembed-1'],
    ['embedding_dimensions', '1280'],
    ['search.reranker.model', 'zeroentropyai:zerank-2'],
    ['search.reranker.enabled', 'false'],
    ['search_embedding_column', 'embedding'],
    ['version', '140'],
  ]) await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
  const identity = buildR1MigrationIdentity(candidateSha, implementationSha);
  const state = {
    schema_version: 1,
    identity,
    fingerprint: identityFingerprint(identity),
    phase,
    started_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:01:00.000Z',
    from_model: 'zeroentropyai:zembed-1',
    from_dimensions: 1280,
    prior_reranker_model: 'zeroentropyai:zerank-2',
    prior_reranker_enabled: false,
    writer_fence_tables: tables,
  };
  await sql.unsafe(buildWriterFenceSql(tables));
  if (phase === 'prepared') {
    await sql.unsafe('CREATE INDEX idx_chunks_embedding_r1_g768 ON content_chunks USING hnsw (embedding_r1_g768 vector_cosine_ops) WHERE embedding_r1_g768 IS NOT NULL');
    await sql.unsafe('CREATE INDEX idx_facts_embedding_r1_g768_hnsw ON facts USING hnsw (embedding_r1_g768 vector_cosine_ops) WHERE embedding_r1_g768 IS NOT NULL AND expired_at IS NULL');
  }
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2)', ['avers.r1.embedding_migration.state', JSON.stringify(state)]);
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2)', ['avers.r1.writer_fence', 'active']);
}

beforeAll(async () => {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'config.json'), targetConfig, { mode: 0o600 });
  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await sql.unsafe('CREATE TABLE IF NOT EXISTS config(key text PRIMARY KEY, value text NOT NULL)');
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
  rmSync(tmp, { recursive: true, force: true });
});

describe('R1 writer-fence lift on PostgreSQL', () => {
  test('spawned CLI fails closed for malformed mode and pending runtime schema', async () => {
    await sql.unsafe("INSERT INTO config(key,value) VALUES ('version',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", ['1']);
    const malformed = runCliWithMigrationMode('migrator');
    expect(malformed.status).not.toBe(0);
    expect(`${malformed.stdout}\n${malformed.stderr}`).toContain('Invalid GBRAIN_MIGRATION_MODE');

    const pending = runCliWithMigrationMode('runtime');
    expect(pending.status).not.toBe(0);
    expect(`${pending.stdout}\n${pending.stderr}`).toContain('MIGRATION_RUNTIME_PENDING');
    const unchanged = await sql.unsafe("SELECT value FROM config WHERE key='version'") as Array<{ value: string }>;
    expect(unchanged[0]?.value).toBe('1');

    await sql.unsafe("UPDATE config SET value=$1 WHERE key='version'", [String(LATEST_VERSION)]);
    const current = runCliWithMigrationMode('runtime');
    expect(current.status).toBe(0);
  }, 60_000);

  test('consumed nonce ledger cannot be reinitialized after prior abort', async () => {
    const handoff = (nonce: string) => ({
      g5a_run_id: 'g5a-run', g5b_run_id: 'g5b-run',
      backup_ready_sha256: '1'.repeat(64), control_manifest_sha256: '2'.repeat(64),
      topology_receipt_sha256: '3'.repeat(64), endpoint_identity_sha256: '4'.repeat(64),
      launcher_sha256: '5'.repeat(64), compiled_runtime_sha256: '6'.repeat(64),
      g5b1_go_sha256: '7'.repeat(64), handoff_nonce: nonce,
    });
    const nonceA = 'a'.repeat(64);
    const nonceB = 'b'.repeat(64);
    const identityA = buildR1MigrationIdentity(candidateSha, implementationSha, handoff(nonceA));
    const identityB = buildR1MigrationIdentity(candidateSha, implementationSha, handoff(nonceB));
    await sql.unsafe('DELETE FROM config WHERE key=$1', [R1_NONCE_LEDGER_KEY]);
    try {
      await validateHandoffNonceLedger(sql, 'production', identityA, true);
      await validateHandoffNonceLedger(sql, 'production', identityB, true, nonceA);
      await sql.unsafe('DELETE FROM config WHERE key=$1', [R1_NONCE_LEDGER_KEY]);
      await expect(validateHandoffNonceLedger(sql, 'production', identityA, true, nonceB))
        .rejects.toThrow('ledger is missing after prior abort');
    } finally {
      await sql.unsafe('DELETE FROM config WHERE key=$1', [R1_NONCE_LEDGER_KEY]);
    }
  });

  test('abort-prepare removes exact pre-cutover fence and shadow planes idempotently', async () => {
    await seedPreparingFence();
    const wrongReceipt = join(tmp, 'abort-wrong-identity.json');
    const wrong = spawnSync(process.execPath, [
      '--preload', preload, runner, '--abort-prepare', '--target', 'clone', '--yes',
      '--expected-candidate-sha', 'b'.repeat(40), '--implementation-checksum', implementationSha,
      '--receipt', wrongReceipt,
    ], { cwd: repo, env: { ...process.env, DATABASE_URL, R1_MIGRATION_CLONE_ACK: '1', GBRAIN_HOME: brainHome }, encoding: 'utf8', timeout: 30_000 });
    expect(wrong.status).not.toBe(0);
    expect(isExactR1WriterFence(tables, await fenceRows())).toBe(true);

    const rollbackReceipt = join(tmp, 'abort-prepare-rollback.json');
    const rolledBack = runRunner(DATABASE_URL, rollbackReceipt, '--abort-prepare', { R1_TEST_FAIL_AFTER_ABORT_CLEANUP: '1' });
    expect(rolledBack.status).not.toBe(0);
    expect(String(rolledBack.stderr)).toContain('INJECTED_ABORT_CLEANUP_FAILURE');
    expect(isExactR1WriterFence(tables, await fenceRows())).toBe(true);
    const rollbackColumns = await sql.unsafe(`SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='embedding_r1_g768' ORDER BY table_name`) as Array<{ table_name: string }>;
    expect(rollbackColumns.map((row) => row.table_name)).toEqual(['content_chunks', 'facts']);
    expect((await sql.unsafe(`SELECT value FROM config WHERE key='avers.r1.writer_fence'`) as Array<{ value: string }>)[0]?.value).toBe('active');
    expect((await sql.unsafe(`SELECT count(*)::int AS n FROM config WHERE key='avers.r1.embedding_migration.state'`) as Array<{ n: number }>)[0]?.n).toBe(1);

    const receipt = join(tmp, 'abort-prepare.json');
    const aborted = runRunner(DATABASE_URL, receipt, '--abort-prepare');
    expect(aborted.status).toBe(0);
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
      status: 'prepare_aborted', previous_phase: 'preparing', writer_fence_active: false,
    });
    expect(await fenceRows()).toHaveLength(0);
    const columns = await sql.unsafe(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='embedding_r1_g768'`) as Array<{ table_name: string; column_name: string }>;
    expect(columns).toHaveLength(0);
    const markerRows = await sql.unsafe(`SELECT key,value FROM config WHERE key LIKE 'avers.r1.embedding_migration.%' ORDER BY key`) as Array<{ key: string; value: string }>;
    expect(markerRows.map((row) => row.key)).toEqual(['avers.r1.embedding_migration.aborted']);

    const idempotentReceipt = join(tmp, 'abort-prepare-idempotent.json');
    const idempotent = runRunner(DATABASE_URL, idempotentReceipt, '--abort-prepare');
    expect(idempotent.status).toBe(0);
    expect(JSON.parse(readFileSync(idempotentReceipt, 'utf8'))).toMatchObject({ status: 'prepare_already_aborted' });

    const corruptMarker = JSON.parse(markerRows[0]!.value);
    delete corruptMarker.pre_abort_state;
    await sql.unsafe("UPDATE config SET value=$1 WHERE key='avers.r1.embedding_migration.aborted'", [JSON.stringify(corruptMarker)]);
    const corruptReceipt = join(tmp, 'abort-prepare-corrupt-pre-state.json');
    const corrupt = runRunner(DATABASE_URL, corruptReceipt, '--abort-prepare');
    expect(corrupt.status).not.toBe(0);
    expect(String(corrupt.stderr)).toContain('audit pre-state is missing or invalid');

    await seedPreparingFence('prepared');
    const preparedReceipt = join(tmp, 'abort-prepared.json');
    const preparedAbort = runRunner(DATABASE_URL, preparedReceipt, '--abort-prepare');
    expect(preparedAbort.status).toBe(0);
    expect(JSON.parse(readFileSync(preparedReceipt, 'utf8'))).toMatchObject({ status: 'prepare_aborted', previous_phase: 'prepared' });
    expect(await fenceRows()).toHaveLength(0);
    const reservedIndexes = await sql.unsafe(`SELECT indexname FROM pg_indexes WHERE schemaname='public'
      AND indexname IN ('idx_chunks_embedding_r1_g768','idx_facts_embedding_r1_g768_hnsw')`) as Array<{ indexname: string }>;
    expect(reservedIndexes).toHaveLength(0);
  }, 60_000);

  test('cutover refuses missing or malformed prepared HNSW indexes before schema mutation', async () => {
    await seedPreparingFence('prepared');
    await sql.unsafe('DROP INDEX idx_chunks_embedding_r1_g768');
    const missingReceipt = join(tmp, 'cutover-missing-index.json');
    const missing = runRunner(DATABASE_URL, missingReceipt, '--cutover');
    expect(missing.status).not.toBe(0);
    expect(String(missing.stderr)).toContain('Unexpected HNSW index catalog for embedding_r1_g768');
    expect((await sql.unsafe(`SELECT format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname='content_chunks' AND a.attname='embedding'`) as Array<{ type: string }>)[0]?.type).toBe('vector(1280)');

    await cleanup();
    await seedPreparingFence('prepared');
    await sql.unsafe('DROP INDEX idx_chunks_embedding_r1_g768');
    await sql.unsafe('CREATE INDEX idx_chunks_embedding_r1_g768 ON content_chunks USING btree(id)');
    const wrongReceipt = join(tmp, 'cutover-wrong-index.json');
    const wrong = runRunner(DATABASE_URL, wrongReceipt, '--cutover');
    expect(wrong.status).not.toBe(0);
    expect(String(wrong.stderr)).toContain('Unexpected HNSW index catalog for embedding_r1_g768');
  }, 60_000);

  test('receipt collision and connection failure are classified before mutation', async () => {
    await cleanup();
    const collision = join(tmp, 'collision.json');
    writeFileSync(collision, '', { mode: 0o600 });
    const collided = runRunner(DATABASE_URL, collision, '--prepare');
    expect(collided.status).not.toBe(0);
    const markerCount = await sql.unsafe(
      `SELECT count(*)::int AS n FROM config WHERE key LIKE 'avers.r1.%'`,
    ) as Array<{ n: number }>;
    expect(Number(markerCount[0]?.n ?? -1)).toBe(0);
    expect((await fenceRows())).toHaveLength(0);

    const unavailable = new URL(DATABASE_URL);
    unavailable.hostname = '127.0.0.1';
    unavailable.port = '1';
    unavailable.pathname = '/gbrain_clone';
    const notStartedReceipt = join(tmp, 'not-started.json');
    const notStarted = runRunner(unavailable.toString(), notStartedReceipt, '--disable-fence');
    expect(notStarted.status).not.toBe(0);
    expect(JSON.parse(readFileSync(notStartedReceipt, 'utf8'))).toMatchObject({
      status: 'incomplete', outcome: 'operation_not_dispatched', mode: 'disable-fence',
    });

    const unknownReceipt = join(tmp, 'unknown.json');
    const unknown = runRunner(DATABASE_URL, unknownReceipt, '--disable-fence');
    expect(unknown.status).not.toBe(0);
    expect(JSON.parse(readFileSync(unknownReceipt, 'utf8'))).toMatchObject({
      status: 'incomplete', outcome: 'operation_outcome_unknown', mode: 'disable-fence',
    });
    expect((await fenceRows())).toHaveLength(0);
  }, 60_000);

  test('real catalog accepts only canonical enforcing function and triggers', async () => {
    await cleanup();
    for (const table of tables) await sql.unsafe(`CREATE TABLE ${table}(id bigint PRIMARY KEY)`);
    await sql.unsafe(buildWriterFenceSql(tables));
    expect(isExactR1WriterFence(tables, await fenceRows())).toBe(true);

    await sql.unsafe(`DROP TRIGGER avers_r1_writer_fence_r1_fence_pages ON r1_fence_pages`);
    await sql.unsafe(`CREATE TRIGGER avers_r1_writer_fence_r1_fence_pages
      BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON r1_fence_pages
      FOR EACH STATEMENT WHEN (false) EXECUTE FUNCTION avers_r1_writer_fence_guard()`);
    expect(isExactR1WriterFence(tables, await fenceRows())).toBe(false);

    await sql.unsafe(buildWriterFenceSql(tables));
    await sql.unsafe(`CREATE OR REPLACE FUNCTION avers_r1_writer_fence_guard() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END; $fn$`);
    expect(isExactR1WriterFence(tables, await fenceRows())).toBe(false);
  });

  test('exact production role graph permits only migrator to assume owner', async () => {
    const roleNames = ['gbrain_runtime', 'gbrain_migrator', 'gbrain_migration_owner'];
    const existing = await sql.unsafe('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname', [roleNames]) as Array<{ rolname: string }>;
    expect(existing).toEqual([]);
    const migratorPassword = randomBytes(32).toString('hex');
    const runtimePassword = randomBytes(32).toString('hex');
    const createdRoles: string[] = [];
    try {
      await sql.unsafe('CREATE ROLE gbrain_migration_owner NOLOGIN NOINHERIT NOBYPASSRLS');
      createdRoles.push('gbrain_migration_owner');
      await sql.unsafe(`CREATE ROLE gbrain_migrator LOGIN NOINHERIT NOBYPASSRLS PASSWORD '${migratorPassword}'`);
      createdRoles.push('gbrain_migrator');
      await sql.unsafe(`CREATE ROLE gbrain_runtime LOGIN NOINHERIT NOBYPASSRLS PASSWORD '${runtimePassword}'`);
      createdRoles.push('gbrain_runtime');
      await sql.unsafe('GRANT gbrain_migration_owner TO gbrain_migrator WITH INHERIT FALSE, SET TRUE');

      const migratorUrl = new URL(DATABASE_URL);
      migratorUrl.username = 'gbrain_migrator';
      migratorUrl.password = migratorPassword;
      expect(runRoleLoginProbe(migratorUrl.toString(), 'migrator')).toEqual({
        session_user: 'gbrain_migrator', current_user: 'gbrain_migration_owner', search_path: 'pg_catalog, public',
      });

      const runtimeUrl = new URL(DATABASE_URL);
      runtimeUrl.username = 'gbrain_runtime';
      runtimeUrl.password = runtimePassword;
      expect(runRoleLoginProbe(runtimeUrl.toString(), 'runtime')).toEqual({
        session_user: 'gbrain_runtime', current_user: 'gbrain_runtime',
        denied: ['gbrain_migration_owner', 'gbrain_migrator'],
      });
    } finally {
      for (const role of [...createdRoles].reverse()) await sql.unsafe(`DROP OWNED BY ${role}`);
      for (const role of [...createdRoles].reverse()) await sql.unsafe(`DROP ROLE ${role}`);
      const remaining = await sql.unsafe('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname', [roleNames]) as Array<{ rolname: string }>;
      expect(remaining).toEqual([]);
    }
  });

  test('role-separated fence rejects runtime even with GUC and advisory lock', async () => {
    const ownerRole = `g5_test_owner_${process.pid}`;
    const runtimeRole = `g5_test_runtime_${process.pid}`;
    const table = 'r1_fence_pages';
    const createdRoles: string[] = [];
    await cleanup();
    try {
      await sql.unsafe(`CREATE ROLE ${ownerRole} NOLOGIN NOBYPASSRLS`);
      createdRoles.push(ownerRole);
      await sql.unsafe(`CREATE ROLE ${runtimeRole} NOLOGIN NOBYPASSRLS`);
      createdRoles.push(runtimeRole);
      await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${ownerRole}`);
      await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await sql.unsafe(`SET ROLE ${ownerRole}`);
      await sql.unsafe(`CREATE TABLE ${table}(id bigint PRIMARY KEY)`);
      await sql.unsafe(buildWriterFenceSql([table]));
      await sql.unsafe('RESET ROLE');
      await sql.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ${table} TO ${runtimeRole}`);
      await sql.unsafe(`SET ROLE ${ownerRole}`);
      expect(isExactR1WriterFence([table], await fenceRows())).toBe(true);
      await sql.unsafe('RESET ROLE');

      await sql.unsafe(`SET ROLE ${runtimeRole}`);
      await sql.unsafe(`SET avers.r1_migration_runner='on'`);
      const lockAttempt = await sql.unsafe('SELECT pg_try_advisory_lock($1) AS ok', [R1_ADVISORY_LOCK_KEY]) as Array<{ ok: boolean }>;
      expect(lockAttempt[0]?.ok).toBe(true);
      const fencedInsert = await capturePostgresError(sql.unsafe(`INSERT INTO ${table}(id) VALUES (1)`));
      expect(fencedInsert).toMatchObject({ code: '55000' });
      expect(fencedInsert.message).toBe('AVERS_R1_WRITER_FENCE_ACTIVE');
      for (const operation of [
        () => sql.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER avers_r1_writer_fence_${table}`),
        () => sql.unsafe(`DROP TRIGGER avers_r1_writer_fence_${table} ON ${table}`),
        () => sql.unsafe(`CREATE OR REPLACE FUNCTION avers_r1_writer_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`),
      ]) {
        expect(await capturePostgresError(operation())).toMatchObject({ code: '42501' });
      }
      await sql.unsafe('SELECT pg_advisory_unlock($1)', [R1_ADVISORY_LOCK_KEY]);
      await sql.unsafe('RESET ROLE');

      await sql.unsafe(`SET ROLE ${ownerRole}`);
      await sql.unsafe(`INSERT INTO ${table}(id) VALUES (1)`);
      await sql.unsafe('RESET ROLE');
      const rows = await sql.unsafe(`SELECT id FROM ${table}`) as Array<{ id: number }>;
      expect(rows.map((row) => Number(row.id))).toEqual([1]);
    } finally {
      await sql.unsafe('RESET ROLE');
      await sql.unsafe('SELECT pg_advisory_unlock($1)', [R1_ADVISORY_LOCK_KEY]);
      await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
      await sql.unsafe('DROP FUNCTION IF EXISTS avers_r1_writer_fence_guard() CASCADE');
      for (const role of [...createdRoles].reverse()) await sql.unsafe(`DROP OWNED BY ${role}`);
      for (const role of [...createdRoles].reverse()) await sql.unsafe(`DROP ROLE ${role}`);
      const residue = await sql.unsafe(`SELECT
        to_regclass('public.r1_fence_pages') IS NOT NULL AS has_table,
        to_regprocedure('public.avers_r1_writer_fence_guard()') IS NOT NULL AS has_function,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])) AS has_role`, [[ownerRole, runtimeRole]]) as Array<{ has_table: boolean; has_function: boolean; has_role: boolean }>;
      expect(residue[0]).toEqual({ has_table: false, has_function: false, has_role: false });
    }
  });

  test('production disable path rolls back, classifies completed receipt failure, and succeeds atomically', async () => {
    await seedCompletedFence();
    const rollbackReceipt = join(tmp, 'rollback.json');
    const rollback = runRunner(DATABASE_URL, rollbackReceipt, '--disable-fence', {
      R1_TEST_FAIL_AFTER_FENCE_DROP: '1',
    });
    expect(rollback.status).not.toBe(0);
    expect(String(rollback.stderr)).toContain('INJECTED_POST_DROP_FAILURE');
    expect(JSON.parse(readFileSync(rollbackReceipt, 'utf8'))).toMatchObject({
      status: 'incomplete', outcome: 'operation_outcome_unknown', mode: 'disable-fence',
    });
    expect(isExactR1WriterFence(tables, await fenceRows())).toBe(true);
    expect((await sql.unsafe(`SELECT value FROM config WHERE key='avers.r1.writer_fence'`) as Array<{ value: string }>)[0]?.value).toBe('active');

    await seedCompletedFence();
    const completedReceipt = join(tmp, 'completed-receipt-failure.json');
    const completed = runRunner(DATABASE_URL, completedReceipt, '--disable-fence', {
      R1_TEST_FAIL_BEFORE_RECEIPT_FINALIZE: '1',
    });
    expect(completed.status).not.toBe(0);
    expect(String(completed.stderr)).toContain('INJECTED_RECEIPT_FINALIZE_FAILURE');
    expect(JSON.parse(readFileSync(completedReceipt, 'utf8'))).toMatchObject({
      status: 'incomplete', outcome: 'operation_completed', mode: 'disable-fence',
    });
    expect(await fenceRows()).toHaveLength(0);
    expect((await sql.unsafe(`SELECT value FROM config WHERE key='avers.r1.writer_fence'`) as Array<{ value: string }>)[0]?.value).toBe('disabled');

    await seedCompletedFence();
    const successReceipt = join(tmp, 'success.json');
    const success = runRunner(DATABASE_URL, successReceipt, '--disable-fence');
    expect(success.status).toBe(0);
    const durable = JSON.parse(readFileSync(successReceipt, 'utf8'));
    expect(durable).toMatchObject({
      status: 'writer_fence_disabled', writer_fence_tables: tables,
      writer_fence_active: false, writer_fence_trigger_count: 0,
    });
    expect(await fenceRows()).toHaveLength(0);
    const functionAfterSuccess = await sql.unsafe(
      `SELECT to_regprocedure('public.avers_r1_writer_fence_guard()') IS NOT NULL AS present`,
    ) as Array<{ present: boolean }>;
    expect(functionAfterSuccess[0]?.present).toBe(false);
    expect((await sql.unsafe(`SELECT value FROM config WHERE key='avers.r1.writer_fence'`) as Array<{ value: string }>)[0]?.value).toBe('disabled');
  }, 60_000);
});
