import { beforeAll, afterAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import * as checked from '../src/core/embedding-checked-write.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
const vector = () => new Float32Array(1536).fill(0.25);
async function seed(slug: string) {
  await engine.putPage(slug, { title: 'Synthetic', type: 'note', compiled_truth: 'original' });
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'original', chunk_source: 'compiled_truth', language: 'typescript' }]);
  return engine.getChunks(slug);
}
test('CLI embedding result paths use the shared fence rather than content upserts', async () => {
  const source = await Bun.file(new URL('../src/commands/embed.ts', import.meta.url)).text();
  expect(source).not.toContain('engine.upsertChunks(slug, updated, opts)');
  expect(source).not.toContain('engine.upsertChunks(page.slug, updated, pageOpts)');
  expect(source).not.toContain('engine.upsertChunks(slug, merged,');
  expect(source.match(/commitCheckedEmbeddings\(engine,/g)?.length).toBe(3);
});

test('stale worker drops results after synthetic concurrent content replacement', async () => {
  await engine.executeRaw('DELETE FROM content_chunks');
  const slug = 'synthetic/worker';
  const chunks = await seed(slug);
  const result = await embedStaleForSource(engine, 'default', {
    concurrency: 1, embeddingSignature: 'synthetic:model:1536',
    embedFn: async () => {
      await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [chunks[0].page_id]);
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'new body', chunk_source: 'compiled_truth' }]);
      return [vector()];
    },
  });
  expect(result.embedded).toBe(0);
  expect((await engine.getChunks(slug))[0].embedded_at).toBeNull();
});

test('matching identities commit vectors and actual model atomically without erasing metadata', async () => {
  const slug = 'synthetic/current';
  const chunks = await seed(slug);
  expect(await checked.commitCheckedEmbeddings(engine, { slug, sourceId: 'default', chunks, embeddings: [vector()], signature: 'synthetic:model:1536' })).toBe(true);
  const [row] = await engine.executeRaw('SELECT cc.*, p.embedding_signature FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1', [slug]);
  expect(row.model).toBe('synthetic:model');
  expect(row.embedding_signature).toBe('synthetic:model:1536');
  expect(row.language).toBe('typescript');
  expect(row.embedded_at).not.toBeNull();
});

test('late results cannot overwrite replacement chunk identities or stamp provenance', async () => {
  const slug = 'synthetic/fence';
  const snapshot = await seed(slug);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [snapshot[0].page_id]);
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'replacement', chunk_source: 'compiled_truth' }]);
  expect(typeof checked.commitCheckedEmbeddings).toBe('function');
  expect(await checked.commitCheckedEmbeddings(engine, { slug, sourceId: 'default', chunks: snapshot, embeddings: [vector()], signature: 'synthetic:model:1536' })).toBe(false);
  const current = await engine.getChunks(slug);
  expect(current[0].chunk_text).toBe('replacement');
  expect(current[0].embedded_at).toBeNull();
  expect((await engine.executeRaw('SELECT embedding_signature FROM pages WHERE slug = $1', [slug]))[0].embedding_signature).toBeNull();
});
