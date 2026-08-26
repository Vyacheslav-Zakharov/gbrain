import { describe, expect, test } from 'bun:test';
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
  R1_WRITER_FENCE_TABLES,
  assertReadyForCutover,
  assertR1EnvTarget,
  assertR1CompletionReality,
  isExactR1WriterFence,
  resolveR1WriterFenceTables,
  resolveContentPlaneCounts,
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
      current_model: 'google:gemini-embedding-001', current_dimensions: 768,
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
    expect(() => assertR1CompletionReality({ ...good, custom_registry_columns: ['embedding_other'] })).toThrow('registry');
    expect(() => assertR1CompletionReality({ ...good, scalar_watermark: 141 })).toThrow('watermark');
  });

  test('writer manifest covers background job control as well as content planes', () => {
    expect(R1_WRITER_FENCE_TABLES).toContain('minion_jobs');
    expect(R1_WRITER_FENCE_TABLES).toContain('mcp_request_log');
  });

  test('writer fence is active only when every expected trigger is present and hardened', () => {
    const row = (table: string) => ({
      table, trigger: `avers_r1_writer_fence_${table}`, schema: 'public', function_schema: 'public', function_name: 'avers_r1_writer_fence_guard', enabled: 'O',
      definition: `CREATE TRIGGER avers_r1_writer_fence_${table} BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION avers_r1_writer_fence_guard()`,
    });
    expect(isExactR1WriterFence(['pages', 'facts'], [row('pages'), row('facts')])).toBe(true);
    expect(isExactR1WriterFence([], [])).toBe(false);
    expect(isExactR1WriterFence(['pages', 'pages'], [row('pages')])).toBe(false);
    expect(isExactR1WriterFence(['pages', 'facts'], [row('pages')])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), enabled: 'D' }])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), function_name: 'other' }])).toBe(false);
    expect(isExactR1WriterFence(['pages'], [{ ...row('pages'), function_schema: 'other' }])).toBe(false);
  });

  test('writer fence marker table inventory rejects missing, empty, mixed, or duplicate lists', () => {
    expect(resolveR1WriterFenceTables({ writer_fence_tables: ['pages', 'facts'] })).toEqual(['pages', 'facts']);
    expect(resolveR1WriterFenceTables(null)).toEqual([]);
    expect(resolveR1WriterFenceTables({})).toEqual([]);
    expect(resolveR1WriterFenceTables({ writer_fence_tables: [] })).toEqual([]);
    expect(resolveR1WriterFenceTables({ writer_fence_tables: ['pages', 7] })).toEqual([]);
    expect(resolveR1WriterFenceTables({ writer_fence_tables: ['pages', 'pages'] })).toEqual([]);
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
