import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  R1_LINEAGE,
  R1_OPERATION_ID,
  R1_TARGET_DIMENSIONS,
  R1_TARGET_MODEL,
  assertR1DatabaseTarget,
  buildR1MigrationIdentity,
  buildCutoverStatements,
  buildRollbackStatements,
  buildWriterFenceSql,
  parseR1MigrationArgs,
  parseR1EmbeddingRegistry,
  R1_WRITER_FENCE_TABLES,
  assertReadyForCutover,
  assertR1EnvTarget,
  assertR1CompletionReality,
  assertR1ZeroZeRuntimeConfig,
  assertR1RegistrySafeForPrepare,
  isExactR1WriterFence,
  resolveR1WriterFenceTables,
  resolveContentPlaneCounts,
  assertR1FenceDisableAuthority,
  identityFingerprint,
} from '../src/core/r1-governed-migration.ts';

describe('R1 governed embedding migration contract', () => {
  test('accepts exactly one explicit mode and bounded pacing', () => {
    expect(parseR1MigrationArgs(['--status'])).toMatchObject({ mode: 'status', batchSize: 64, paceMs: 0 });
    expect(parseR1MigrationArgs(['--prepare', '--yes', '--batch-size', '32', '--pace-ms', '25', '--stop-after-batches', '2'])).toMatchObject({
      mode: 'prepare', yes: true, batchSize: 32, paceMs: 25, stopAfterBatches: 2,
    });
    expect(() => parseR1MigrationArgs(['--prepare', '--cutover'])).toThrow('exactly one mode');
    expect(() => parseR1MigrationArgs(['--prepare', '--batch-size', '0'])).toThrow('--batch-size');
    expect(() => parseR1MigrationArgs(['--prepare', '--pace-ms', '-1'])).toThrow('--pace-ms');
    expect(() => parseR1MigrationArgs(['--prepare', '--target', 'production', '--stop-after-batches', '1'])).toThrow('clone-only');
  });

  test('requires explicit clone identity or separately guarded production acknowledgement', () => {
    expect(() => assertR1DatabaseTarget('postgresql://u:p@127.0.0.1:55439/gbrain_clone', 'clone', '1', undefined)).not.toThrow();
    expect(() => assertR1DatabaseTarget('postgresql://u:p@db.internal:5432/gbrain', 'clone', '1', undefined)).toThrow('loopback');
    expect(() => assertR1DatabaseTarget('postgresql://u:p@db.internal:5432/gbrain', 'production', undefined, undefined)).toThrow('production GO');
    expect(() => assertR1DatabaseTarget('postgresql://u:p@db.internal:5432/gbrain', 'production', undefined, 'G5-EXPLICIT-GO')).not.toThrow();
  });

  test('binds marker identity to lineage, operation, target, candidate, and implementation checksum', () => {
    const identity = buildR1MigrationIdentity('a'.repeat(40), 'b'.repeat(64));
    expect(identity).toEqual({
      lineage: R1_LINEAGE,
      operation_id: R1_OPERATION_ID,
      target_model: R1_TARGET_MODEL,
      target_dimensions: R1_TARGET_DIMENSIONS,
      candidate_sha: 'a'.repeat(40),
      implementation_checksum: 'b'.repeat(64),
    });
    expect(() => buildR1MigrationIdentity('short', 'b'.repeat(64))).toThrow('candidate SHA');
  });

  test('writer fence is fail closed and only the migration session can bypass it', () => {
    const sql = buildWriterFenceSql(['pages', 'content_chunks', 'facts']);
    expect(sql).toContain("current_setting('avers.r1_migration_runner', true)");
    expect(sql).toContain("RAISE EXCEPTION 'AVERS_R1_WRITER_FENCE_ACTIVE'");
    expect(sql).toContain('CREATE TRIGGER avers_r1_writer_fence_pages');
    expect(sql).toContain('CREATE TRIGGER avers_r1_writer_fence_content_chunks');
    expect(sql).toContain('CREATE TRIGGER avers_r1_writer_fence_facts');
  });

  test('cutover refuses incomplete shadow planes or an inactive writer fence', () => {
    const ready = {
      writer_fence_active: true,
      content_chunks: { total: 10, shadow_populated: 10, primary_type: 'vector(1280)', shadow_type: 'vector(768)' },
      facts: { total_populated: 3, shadow_populated: 3, primary_type: 'vector(1280)', shadow_type: 'vector(768)' },
      query_cache: { primary_type: 'vector(1280)' },
      takes: { total_populated: 0, primary_type: 'vector(1536)' },
    };
    expect(() => assertReadyForCutover(ready)).not.toThrow();
    expect(() => assertReadyForCutover({ ...ready, writer_fence_active: false })).toThrow('writer fence');
    expect(() => assertReadyForCutover({ ...ready, facts: { ...ready.facts, shadow_populated: 2 } })).toThrow('facts shadow');
    expect(() => assertReadyForCutover({ ...ready, takes: { ...ready.takes, total_populated: 1 } })).toThrow('takes.embedding');
  });

  test('cutover swaps both populated planes, purges cache, preserves rollback columns, and stamps target config', () => {
    const statements = buildCutoverStatements();
    const joined = statements.join('\n');
    expect(joined).toContain('ALTER TABLE content_chunks RENAME COLUMN embedding TO embedding_ze_r0');
    expect(joined).toContain('ALTER TABLE facts RENAME COLUMN embedding TO embedding_ze_r0');
    expect(joined).toContain('ALTER TABLE query_cache RENAME COLUMN embedding TO embedding_ze_r0');
    expect(joined).toContain('DELETE FROM query_cache');
    expect(joined).toContain("'google:gemini-embedding-001'");
    expect(joined).toContain("'768'");
    expect(R1_WRITER_FENCE_TABLES).toContain('source_ingest_runs');
    expect(R1_WRITER_FENCE_TABLES).toContain('take_proposals');
  });


  test('rollback restores ZE primary columns and config while retaining Google columns for evidence', () => {
    const joined = buildRollbackStatements('zeroentropyai:zembed-1', 1280, 'zeroentropyai:zerank-2', false).join('\n');
    expect(joined).toContain('ALTER TABLE content_chunks RENAME COLUMN embedding TO embedding_g768_r1');
    expect(joined).toContain('ALTER TABLE content_chunks RENAME COLUMN embedding_ze_r0 TO embedding');
    expect(joined).toContain('ALTER TABLE facts RENAME COLUMN embedding_ze_r0 TO embedding');
    expect(joined).toContain('ALTER TABLE query_cache RENAME COLUMN embedding_ze_r0 TO embedding');
    expect(joined).toContain("'zeroentropyai:zembed-1'");
    expect(joined).toContain("'1280'");
    expect(joined).toContain("'false'");
  });

  test('status preserves total chunk count before the shadow column exists', () => {
    expect(resolveContentPlaneCounts(null, undefined, 4746)).toEqual({ total: 4746, populated: 0 });
    expect(resolveContentPlaneCounts('vector(768)', { total: 4746, populated: 120 }, 4746)).toEqual({ total: 4746, populated: 120 });
  });

  test('refuses conflicting embedding environment before mutation', () => {
    expect(() => assertR1EnvTarget({ GBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1' }, 'target')).toThrow('conflicts');
    expect(() => assertR1EnvTarget({ GBRAIN_EMBEDDING_MODEL: 'google:gemini-embedding-001', GBRAIN_EMBEDDING_DIMENSIONS: '768' }, 'target')).not.toThrow();
    expect(() => assertR1EnvTarget({ GBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1', GBRAIN_EMBEDDING_DIMENSIONS: '1280' }, 'source', 'zeroentropyai:zembed-1', 1280)).not.toThrow();
  });

  test('completion is derived from database reality, signatures, registry, watermark, and smoke', () => {
    const good = {
      current_model: 'google:gemini-embedding-001', current_dimensions: 768, reranker_model: 'voyage:rerank-2.5',
      content_primary_type: 'vector(768)', content_total: 4746, content_populated: 4746,
      facts_primary_type: 'vector(768)', facts_expected: 68, facts_populated: 68,
      query_cache_type: 'vector(768)', query_cache_rows: 0,
      takes_populated: 0, image_type: 'vector(1024)', multimodal_type: 'vector(1024)',
      false_target_signatures: 0, null_signatures_with_chunks: 0,
      active_embed_jobs: 0, custom_registry_columns: [], scalar_watermark: 140,
      vector_roundtrip_ok: true,
    };
    expect(() => assertR1CompletionReality(good)).not.toThrow();
    expect(() => assertR1CompletionReality({ ...good, null_signatures_with_chunks: 1 })).toThrow('signature');
    expect(() => assertR1CompletionReality({ ...good, custom_registry_columns: ['embedding_legacy'] })).toThrow('registry');
    expect(() => assertR1CompletionReality({ ...good, reranker_model: 'zeroentropyai:zerank-2' })).toThrow('reranker');
    expect(() => assertR1CompletionReality({ ...good, scalar_watermark: 141 })).toThrow('watermark');
  });

  test('writer-fence lift requires exact completed migration identity and receipt', () => {
    const identity = buildR1MigrationIdentity('a'.repeat(40), 'b'.repeat(64));
    const fingerprint = identityFingerprint(identity);
    const completion = {
      current_model: R1_TARGET_MODEL, current_dimensions: R1_TARGET_DIMENSIONS, reranker_model: 'voyage:rerank-2.5',
      content_primary_type: 'vector(768)', content_total: 10, content_populated: 10,
      facts_primary_type: 'vector(768)', facts_expected: 3, facts_populated: 3,
      query_cache_type: 'vector(768)', query_cache_rows: 0, takes_populated: 0,
      image_type: 'vector(1024)', multimodal_type: 'vector(1024)', false_target_signatures: 0,
      null_signatures_with_chunks: 0, active_embed_jobs: 0, custom_registry_columns: [], scalar_watermark: 140,
      vector_roundtrip_ok: true,
    };
    const state = { identity, fingerprint, phase: 'completed', writer_fence_tables: [...R1_WRITER_FENCE_TABLES] };
    const completed = { ...state, completed_at: '2026-08-27T00:00:00.000Z', file_config_sha256: 'c'.repeat(64), completion };
    expect(() => assertR1FenceDisableAuthority(state, completed, {
      expectedCandidateSha: identity.candidate_sha,
      implementationChecksum: identity.implementation_checksum,
    })).not.toThrow();
    expect(() => assertR1FenceDisableAuthority({ ...state, phase: 'cutover' }, completed, {
      expectedCandidateSha: identity.candidate_sha, implementationChecksum: identity.implementation_checksum,
    })).toThrow('completed state');
    expect(() => assertR1FenceDisableAuthority(state, { ...completed, fingerprint: 'd'.repeat(64) }, {
      expectedCandidateSha: identity.candidate_sha, implementationChecksum: identity.implementation_checksum,
    })).toThrow('completion marker identity');
    expect(() => assertR1FenceDisableAuthority(state, completed, {
      expectedCandidateSha: 'e'.repeat(40), implementationChecksum: identity.implementation_checksum,
    })).toThrow('candidate SHA');
    expect(() => assertR1FenceDisableAuthority(state, completed, {
      expectedCandidateSha: identity.candidate_sha, implementationChecksum: 'f'.repeat(64),
    })).toThrow('implementation checksum');
    const alteredIdentity = { ...identity, lineage: 'foreign-lineage' };
    expect(() => assertR1FenceDisableAuthority({
      ...state, identity: alteredIdentity, fingerprint: identityFingerprint(alteredIdentity),
    }, {
      ...completed, identity: alteredIdentity, fingerprint: identityFingerprint(alteredIdentity),
    }, {
      expectedCandidateSha: identity.candidate_sha, implementationChecksum: identity.implementation_checksum,
    })).toThrow('canonical migration identity');
    expect(() => assertR1FenceDisableAuthority(state, completed, {
      expectedCandidateSha: identity.candidate_sha,
    })).toThrow('requires');
  });

  test('post-cutover runtime planes reject every effective ZE fallback or override', () => {
    const good = {
      db_embedding_model: R1_TARGET_MODEL,
      db_embedding_dimensions: R1_TARGET_DIMENSIONS,
      db_reranker_model: 'voyage:rerank-2.5',
      db_embedding_columns: undefined,
      file_embedding_model: undefined,
      file_embedding_dimensions: undefined,
      file_search_embedding_column: undefined,
      file_embedding_columns: undefined,
      file_provider_base_urls: undefined,
      env_embedding_model: undefined,
      env_embedding_dimensions: undefined,
    };
    expect(() => assertR1ZeroZeRuntimeConfig(good)).not.toThrow();
    expect(() => assertR1ZeroZeRuntimeConfig({ ...good, db_embedding_model: 'zeroentropyai:zembed-1' })).toThrow('DB embedding model');
    expect(() => assertR1ZeroZeRuntimeConfig({ ...good, file_embedding_model: 'zeroentropyai:zembed-1' })).toThrow('file embedding model');
    expect(() => assertR1ZeroZeRuntimeConfig({ ...good, env_embedding_model: 'zeroentropyai:zembed-1' })).toThrow('env embedding model');
    expect(() => assertR1ZeroZeRuntimeConfig({ ...good, db_reranker_model: 'zeroentropyai:zerank-2' })).toThrow('reranker');
    expect(() => assertR1ZeroZeRuntimeConfig({ ...good, db_reranker_model: 'cohere:rerank-v3.5' })).toThrow('reranker');
    expect(() => assertR1ZeroZeRuntimeConfig({
      ...good,
      db_embedding_columns: { embedding: { provider: 'zeroentropyai:zembed-1', dimensions: 1280, type: 'vector' as const } },
    })).toThrow('DB embedding registry');
    expect(() => assertR1ZeroZeRuntimeConfig({ ...good, file_provider_base_urls: { zeroentropyai: 'https://example.invalid' } })).toThrow('base URL');
    expect(() => assertR1ZeroZeRuntimeConfig({
      ...good,
      file_search_embedding_column: 'embedding_legacy',
      file_embedding_columns: { embedding_legacy: { provider: 'zeroentropyai:zembed-1', dimensions: 1280, type: 'vector' as const } },
    })).toThrow('custom embedding column');
  });

  test('prepare refuses any DB/file embedding registry before schema mutation', () => {
    expect(() => assertR1RegistrySafeForPrepare(undefined, undefined)).not.toThrow();
    expect(() => assertR1RegistrySafeForPrepare({ embedding: { provider: 'zeroentropyai:zembed-1' } }, undefined)).toThrow('DB embedding registry');
    expect(() => assertR1RegistrySafeForPrepare(undefined, { embedding_voyage: { provider: 'voyage:voyage-4' } })).toThrow('file embedding registry');
    expect(() => assertR1RegistrySafeForPrepare(undefined, undefined, 'embedding_legacy')).toThrow('DB selected embedding column');
    expect(() => assertR1RegistrySafeForPrepare(undefined, undefined, undefined, 'embedding_legacy')).toThrow('file selected embedding column');
  });

  test('registry parser rejects scalar, null, malformed and lossy legacy entries', () => {
    expect(parseR1EmbeddingRegistry(null)).toEqual({});
    expect(parseR1EmbeddingRegistry('{}')).toEqual({});
    expect(parseR1EmbeddingRegistry('["embedding_legacy"]')).toEqual({ embedding_legacy: {} });
    expect(parseR1EmbeddingRegistry('[{"column":"embedding_legacy","provider":"voyage:voyage-4","dimensions":768,"type":"vector"}]'))
      .toEqual({ embedding_legacy: { provider: 'voyage:voyage-4', dimensions: 768, type: 'vector' } });
    const prototypeKey = parseR1EmbeddingRegistry('{"__proto__":{"provider":"voyage:voyage-4","dimensions":768,"type":"vector"}}');
    expect(Object.hasOwn(prototypeKey, '__proto__')).toBe(true);
    expect(Object.keys(prototypeKey)).toEqual(['__proto__']);
    expect(() => assertR1RegistrySafeForPrepare(prototypeKey, undefined)).toThrow('DB embedding registry');
    for (const raw of [
      'null', '1', '"embedding"', '[null]', '[{}]', '["x","x"]', '{"Bad-Column":{}}',
      '{"embedding":null}', '{"embedding":{"dimensions":"768"}}',
      '{"embedding":{"provider":"voyage","dimensions":768,"type":"vector"}}',
      '{"embedding":{"provider":"voyage:voyage-4","dimensions":8193,"type":"vector"}}',
      '{"embedding":{"provider":"voyage:voyage-4","dimensions":768,"type":"cosine"}}',
      '{"embedding":{"provider":"voyage:v1","provider":"google:v2","dimensions":768,"type":"vector"}}',
      '{"embedding":{"provider":"voyage:v1","dimensions":768,"type":"vector"},"embedding":{"provider":"google:v2","dimensions":768,"type":"vector"}}',
    ]) {
      expect(() => parseR1EmbeddingRegistry(raw)).toThrow('embedding_columns');
    }
  });

  test('fixed runner pins advisory-lock ownership to every mutation transaction', () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/commands/r1-governed-migrate.ts'), 'utf8');
    expect(source).toContain('idle_timeout: 0');
    expect(source).toContain('max_lifetime: null');
    expect(source).toContain('pg_backend_pid()::int AS backend_pid, pg_try_advisory_lock($1) AS ok');
    expect(source).toContain("SELECT 1 FROM pg_locks");
    expect(source).toContain("locktype='advisory' AND granted");
    expect(source).toContain('classid::bigint=(($1::bigint >> 32) & 4294967295)');
    expect(source).toContain('objid::bigint=($1::bigint & 4294967295) AND objsubid=1');
    expect(source).toContain('rows[0]?.lock_held !== true');
    expect(source).toContain('CASE WHEN pg_backend_pid()=$2 THEN pg_advisory_unlock($1) ELSE false END');
    expect(source).toContain('async function withR1MutationTransaction(');
    expect(source).toContain("throw new Error('R1_ADVISORY_LOCK_LOST')");
    expect(source.match(/withR1MutationTransaction\(/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
    // Every data/schema/config mutation is routed through the one backend-PID checked seam.
    expect(source.match(/await sql\.begin\(/g)).toHaveLength(1);
    for (const signature of [
      'async function prepare(sql: Sql, args: R1MigrationArgs, lockBackendPid: number)',
      'async function cutover(sql: Sql, args: R1MigrationArgs, lockBackendPid: number)',
      'async function disableFence(sql: Sql, args: R1MigrationArgs, lockBackendPid: number)',
      'async function rollback(sql: Sql, args: R1MigrationArgs, lockBackendPid: number)',
    ]) expect(source).toContain(signature);
  });

  test('fixed runner checks file/env/base-url runtime planes before stamping completion', () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/commands/r1-governed-migrate.ts'), 'utf8');
    const cutoverSource = source.slice(source.indexOf('async function cutover('), source.indexOf('async function disableFence('));
    const disableSource = source.slice(source.indexOf('async function disableFence('), source.indexOf('async function assertRollbackReality('));
    const validation = cutoverSource.indexOf('validateR1CutoverRuntimePlanes(sql)');
    const transactionValidation = cutoverSource.indexOf('validateR1CutoverRuntimePlanes(lockedSql');
    const schemaCutover = cutoverSource.indexOf('buildCutoverStatements()');
    const completedMarker = cutoverSource.indexOf("state.phase = 'completed'");
    expect(source).toContain('loadConfigFileSnapshotStrict()');
    expect(source).not.toContain('loadConfigFileOnly()');
    expect(source).toContain("setConfig(lockedSql, 'embedding_columns', '{}')");
    expect(source.indexOf('validateR1CutoverRuntimePlanes(sql);')).toBeLessThan(source.indexOf('ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS'));
    expect(source).toContain('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    expect(cutoverSource.match(/LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE/g)).toHaveLength(2);
    expect(validation).toBeGreaterThan(0);
    expect(transactionValidation).toBeGreaterThan(validation);
    expect(transactionValidation).toBeLessThan(schemaCutover);
    expect(completedMarker).toBeGreaterThan(cutoverSource.lastIndexOf('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE'));
    expect(cutoverSource.indexOf('setConfig(lockedSql, R1_COMPLETED_KEY')).toBeGreaterThan(completedMarker);
    expect(cutoverSource).toContain('file_config_sha256: fileSha256');
    expect(source).toContain("db_embedding_model: await getConfig(sql, 'embedding_model')");
    expect(source).toContain("db_reranker_model: await getConfig(sql, 'search.reranker.model')");
    expect(source).toContain('await assertSourceDbIdentity(lockedSql, lockedStatus, state.from_model, state.from_dimensions)');
    expect(source).toContain("state.phase !== 'completed' && state.phase !== 'cutover'");
    expect(source).toContain('status.query_cache.primary_type');
    expect(source).toContain('await assertRollbackReality(lockedSql, state)');
    expect(source).toContain("DELETE FROM config WHERE key=$1', [R1_COMPLETED_KEY]");
    expect(source).toContain('rollback_file_config_sha256 = rollbackFileSha256');
    expect(source).toContain('const rollbackFileSha256 = validateR1RollbackRuntimePlanes(state)');
    expect(source.match(/validateR1RollbackRuntimePlanes\(state, rollbackFileSha256\)/g)).toHaveLength(2);
    expect(disableSource.indexOf('assertR1FenceDisableAuthority(state, completed, args)')).toBeGreaterThan(0);
    expect(disableSource.indexOf('const freshCompletion = await readCompletionReality(lockedSql)'))
      .toBeGreaterThan(disableSource.indexOf('assertR1FenceDisableAuthority(state, completed, args)'));
    expect(disableSource.indexOf("if (!status.writer_fence_active)"))
      .toBeGreaterThan(disableSource.indexOf('const freshCompletion = await readCompletionReality(lockedSql)'));
    expect(disableSource.indexOf('buildWriterFenceDropSql(stampedTables)'))
      .toBeGreaterThan(disableSource.indexOf("if (!status.writer_fence_active)"));
    expect(source).toContain("openSync(args.receipt, 'wx', 0o600)");
    expect(source.indexOf("openSync(args.receipt, 'wx', 0o600)")).toBeLessThan(source.indexOf('const sql = postgres(databaseUrl'));
    expect(source).toContain('writeSync(receiptFd, output');
    expect(source).toContain('fsyncSync(receiptFd)');
    expect(source).toContain("status: 'incomplete'");
    expect(source).toContain("'operation_not_dispatched'");
    expect(source).toContain("'operation_completed'");
    expect(source).toContain("'operation_outcome_unknown'");
  });

  test('writer manifest covers background job control as well as content planes', () => {
    expect(R1_WRITER_FENCE_TABLES).toContain('minion_jobs');
    expect(R1_WRITER_FENCE_TABLES).toContain('mcp_request_log');
  });

  test('writer fence is active only when every expected trigger is present and hardened', () => {
    const row = (table: string) => ({
      table, trigger: `avers_r1_writer_fence_${table}`, schema: 'public', function_schema: 'public', function_name: 'avers_r1_writer_fence_guard', enabled: 'O',
      function_volatility: 'v', function_security_definer: false,
      function_definition: `CREATE OR REPLACE FUNCTION public.avers_r1_writer_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN IF current_setting('avers.r1_migration_runner', true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'AVERS_R1_WRITER_FENCE_ACTIVE' USING ERRCODE = '55000'; END IF; RETURN NULL; END; $function$`,
      definition: `CREATE TRIGGER avers_r1_writer_fence_${table} BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION avers_r1_writer_fence_guard()`,
    });
    expect(isExactR1WriterFence(['pages', 'facts'], [row('pages'), row('facts')])).toBe(true);
    expect(isExactR1WriterFence([], [])).toBe(false);
    expect(isExactR1WriterFence(['pages', 'pages'], [row('pages')])).toBe(false);
    expect(isExactR1WriterFence(['pages', 'facts'], [row('pages')])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), enabled: 'D' }])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), function_name: 'other' }])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), function_schema: 'other' }])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), function_volatility: 's' }])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), function_security_definer: true }])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), function_definition: 'CREATE FUNCTION public.avers_r1_writer_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$' }])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{
      ...row('pages'),
      definition: `CREATE TRIGGER avers_r1_writer_fence_pages BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.pages FOR EACH STATEMENT WHEN (false) EXECUTE FUNCTION avers_r1_writer_fence_guard()`,
    }])).toBe(false);
  });

  test('writer fence marker table inventory rejects missing, empty, mixed, or duplicate lists', () => {
    expect(resolveR1WriterFenceTables({ writer_fence_tables: ['pages', 'facts'] })).toEqual(['pages', 'facts']);
    expect(resolveR1WriterFenceTables(null)).toEqual([]);
    expect(resolveR1WriterFenceTables({})).toEqual([]);
    expect(resolveR1WriterFenceTables({ writer_fence_tables: [] })).toEqual([]);
    expect(resolveR1WriterFenceTables({ writer_fence_tables: ['pages', 7] })).toEqual([]);
    expect(resolveR1WriterFenceTables({ writer_fence_tables: ['pages', 'pages'] })).toEqual([]);
  });

  test('dedicated destructive PostgreSQL regression refuses non-disposable targets before setup', () => {
    const { R1_FENCE_LIFT_TEST_ACK: _dropAck, ...env } = process.env;
    const result = spawnSync(process.execPath, [
      'test', resolve(import.meta.dir, 'e2e/r1-fence-lift-postgres.test.ts'), '--timeout=5000',
    ], {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...env, DATABASE_URL: 'postgresql://example:example@203.0.113.1/production' },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refuses non-disposable target');
  });

  test('cutover and rollback clear signatures for source-incomplete pages', () => {
    for (const joined of [
      buildCutoverStatements().join('\n'),
      buildRollbackStatements('zeroentropyai:zembed-1', 1280, 'zeroentropyai:zerank-2', false).join('\n'),
    ]) {
      expect(joined).toContain('CASE WHEN EXISTS');
      expect(joined).toContain('ELSE NULL END');
    }
  });
});
