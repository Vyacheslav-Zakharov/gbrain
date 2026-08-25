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
  resolveContentPlaneCounts,
} from '../src/core/r1-governed-migration.ts';

describe('R1 governed embedding migration contract', () => {
  test('accepts exactly one explicit mode and bounded pacing', () => {
    expect(parseR1MigrationArgs(['--status'])).toMatchObject({ mode: 'status', batchSize: 64, paceMs: 0 });
    expect(parseR1MigrationArgs(['--prepare', '--yes', '--batch-size', '32', '--pace-ms', '25'])).toMatchObject({
      mode: 'prepare', yes: true, batchSize: 32, paceMs: 25,
    });
    expect(() => parseR1MigrationArgs(['--prepare', '--cutover'])).toThrow('exactly one mode');
    expect(() => parseR1MigrationArgs(['--prepare', '--batch-size', '0'])).toThrow('--batch-size');
    expect(() => parseR1MigrationArgs(['--prepare', '--pace-ms', '-1'])).toThrow('--pace-ms');
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
});
