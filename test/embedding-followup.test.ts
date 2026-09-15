import { beforeAll, afterAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import * as fence from '../src/core/embedding-checked-write.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
test('initial creation refuses an old page baseline after revision change', async () => {
  await engine.putPage('followup/initial', { title: 'Old', type: 'note', compiled_truth: 'old' });
  expect(typeof fence.readEmbeddingBaseline).toBe('function');
  const baseline = await fence.readEmbeddingBaseline(engine, 'followup/initial', 'default');
  await engine.executeRaw("UPDATE pages SET compiled_truth = 'new', write_revision = gen_random_uuid() WHERE slug = $1", ['followup/initial']);
  const committed = await fence.withEmbeddingBaseline(engine, baseline!, async tx => {
    await tx.upsertChunks('followup/initial', [{ chunk_index: 0, chunk_text: 'old', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
  });
  expect(committed).toBe(false);
  expect(await engine.getChunks('followup/initial')).toEqual([]);
});
