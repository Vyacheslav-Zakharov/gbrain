import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres, { type Sql } from 'postgres';
import {
  buildR1MigrationIdentity,
  buildWriterFenceSql,
  identityFingerprint,
  isExactR1WriterFence,
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
  await sql.unsafe(`DELETE FROM config WHERE key IN ('avers.r1.embedding_migration.state','avers.r1.embedding_migration.completed','avers.r1.writer_fence')`);
}

async function fenceRows(): Promise<R1WriterFenceRow[]> {
  return await sql.unsafe(
    `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS trigger,
            pn.nspname AS function_schema, p.proname AS function_name,
            pg_get_functiondef(p.oid) AS function_definition,
            p.provolatile AS function_volatility, p.prosecdef AS function_security_definer,
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
  mode: '--prepare' | '--disable-fence',
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

async function seedCompletedFence(): Promise<void> {
  await cleanup();
  await sql.unsafe('CREATE TABLE pages(id bigint PRIMARY KEY, embedding_signature text)');
  await sql.unsafe(`CREATE TABLE content_chunks(
    id bigint PRIMARY KEY, page_id bigint, chunk_text text NOT NULL, model text,
    embedding vector(768), embedding_ze_r0 vector(1280),
    embedding_image vector(1024), embedding_multimodal vector(1024)
  )`);
  await sql.unsafe('CREATE TABLE facts(id bigint PRIMARY KEY, embedding vector(768), embedding_ze_r0 vector(1280))');
  await sql.unsafe('CREATE TABLE query_cache(id bigint PRIMARY KEY, embedding vector(768), embedding_ze_r0 vector(1280))');
  await sql.unsafe('CREATE TABLE takes(id bigint PRIMARY KEY, embedding vector(1536))');
  await sql.unsafe('CREATE TABLE minion_jobs(id bigint PRIMARY KEY, status text, name text)');
  for (const table of tables) await sql.unsafe(`CREATE TABLE ${table}(id bigint PRIMARY KEY)`);
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
    reranker_model: 'voyage:rerank-2.5', content_primary_type: 'vector(768)',
    content_total: 1, content_populated: 1, facts_primary_type: 'vector(768)',
    facts_expected: 0, facts_populated: 0, query_cache_type: 'vector(768)',
    query_cache_rows: 0, takes_populated: 0, image_type: 'vector(1024)',
    multimodal_type: 'vector(1024)', false_target_signatures: 0,
    null_signatures_with_chunks: 0, active_embed_jobs: 0,
    custom_registry_columns: [], scalar_watermark: 140, vector_roundtrip_ok: true,
  };
  await sql.unsafe(buildWriterFenceSql(tables));
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2)', ['avers.r1.embedding_migration.state', JSON.stringify(state)]);
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2)', ['avers.r1.embedding_migration.completed', JSON.stringify({
    ...state, completed_at: '2026-08-27T00:02:00.000Z', file_config_sha256: fileConfigSha, completion,
  })]);
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
  test('receipt collision and connection failure are classified before mutation', async () => {
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
