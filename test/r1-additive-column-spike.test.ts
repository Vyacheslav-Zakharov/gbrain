import { describe, expect, test } from 'bun:test';
import {
  assertCloneTarget,
  mergeRegistryEntry,
  parseSpikeArgs,
} from '../scripts/r1-additive-column-spike.ts';
import { isCacheSafe, resolveEmbeddingColumn } from '../src/core/search/embedding-column.ts';

describe('R1 additive-column spike safety', () => {
  test('accepts only loopback gbrain_clone targets with explicit acknowledgement', () => {
    expect(() => assertCloneTarget('postgresql://postgres:x@127.0.0.1:55439/gbrain_clone', '1')).not.toThrow();
    expect(() => assertCloneTarget('postgresql://postgres:x@localhost:55439/gbrain_clone', '1')).not.toThrow();
    expect(() => assertCloneTarget('postgresql://postgres:x@192.168.1.10:5432/gbrain_clone', '1')).toThrow(/loopback/i);
    expect(() => assertCloneTarget('postgresql://postgres:x@127.0.0.1:5432/gbrain', '1')).toThrow(/gbrain_clone/i);
    expect(() => assertCloneTarget('postgresql://postgres:x@127.0.0.1:55439/gbrain_clone', undefined)).toThrow(/acknowledgement/i);
  });

  test('merges the emergency registry entry without dropping existing columns', () => {
    const merged = mergeRegistryEntry(JSON.stringify({ existing: {
      provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector',
    } }));
    expect(merged.existing).toEqual({ provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector' });
    expect(merged.embedding_g768).toEqual({
      provider: 'google:gemini-embedding-001',
      dimensions: 768,
      type: 'vector',
    });
    const cfg = {
      engine: 'postgres' as const,
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      embedding_columns: merged as any,
    };
    const resolved = resolveEmbeddingColumn({ embeddingColumn: 'embedding_g768' }, cfg);
    expect(isCacheSafe(resolved, cfg)).toBe(false);
  });

  test('parses status, prepare, activate, and rollback as exclusive modes', () => {
    expect(parseSpikeArgs(['--status']).mode).toBe('status');
    expect(parseSpikeArgs(['--prepare', '--batch-size', '50']).batchSize).toBe(50);
    expect(parseSpikeArgs(['--activate']).mode).toBe('activate');
    expect(parseSpikeArgs(['--rollback']).mode).toBe('rollback');
    expect(() => parseSpikeArgs(['--status', '--prepare'])).toThrow(/exactly one mode/i);
  });
});
