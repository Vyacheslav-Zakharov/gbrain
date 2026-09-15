import { beforeAll, afterAll, expect, test, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
let duringProvider: (texts: string[]) => Promise<void> = async () => {};
mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => { await duringProvider(texts); return texts.map(() => new Float32Array(1536).fill(0.2)); },
  currentEmbeddingSignature: () => 'synthetic:model:1536',
}));
mock.module('../src/core/embed-preflight.ts', () => ({ validateEmbeddingCreds: () => {} }));
const { runEmbedCore } = await import('../src/commands/embed.ts');
const { reembedPageWithContextualRetrieval } = await import('../src/core/contextual-retrieval-service.ts');
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); mock.restore(); });
test('CLI initial empty read cannot overwrite a concurrent winner', async () => {
  const slug = 'followup/cli';
  await engine.putPage(slug, { title: 'Initial', type: 'note', compiled_truth: 'old body' });
  let raced = false;
  const racingEngine = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'getChunks') return async (...args: Parameters<PGLiteEngine['getChunks']>) => {
        const chunks = await target.getChunks(...args);
        if (!raced && args[0] === slug) {
          raced = true;
          await target.executeRaw("UPDATE pages SET compiled_truth = 'winner', write_revision = gen_random_uuid() WHERE slug = $1", [slug]);
          await target.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'winner', chunk_source: 'compiled_truth', language: 'typescript' }]);
        }
        return chunks;
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  duringProvider = async texts => { expect(texts).toEqual(['winner']); };
  await runEmbedCore(racingEngine, { slug, sourceId: 'default' });
  const chunks = await engine.getChunks(slug);
  expect(chunks[0].chunk_text).toBe('winner');
  expect(chunks[0].language).toBe('typescript');
});

test('unchanged contextual page commits vectors without losing metadata', async () => {
  const slug = 'followup/current';
  await engine.putPage(slug, { title: 'Current', type: 'note', compiled_truth: 'body' });
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'body', chunk_source: 'compiled_truth', language: 'typescript' }]);
  duringProvider = async texts => { expect(texts[0]).toContain('Current'); };
  const result = await reembedPageWithContextualRetrieval({ engine, pageSlug: slug, sourceId: 'default', globalMode: 'title' });
  expect(result.kind).toBe('success');
  const [chunk] = await engine.getChunks(slug);
  expect(chunk.embedded_at).not.toBeNull();
  expect(chunk.chunk_text).toBe('body');
  expect(chunk.language).toBe('typescript');
});

for (const mode of ['none', 'title'] as const) test(`empty ${mode} state stamp rejects changed page`, async () => {
  const slug = `followup/empty-${mode}`;
  await engine.putPage(slug, { title: 'Before', type: 'note', compiled_truth: '' });
  const racingEngine = new Proxy(engine, { get(target, prop) {
    if (prop === 'executeRaw') return async (sql: string, params: unknown[]) => {
      const rows = await target.executeRaw(sql, params);
      if (sql.includes('FROM sources WHERE')) await target.executeRaw('UPDATE pages SET title = $1 WHERE slug = $2', ['After', slug]);
      return rows;
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await reembedPageWithContextualRetrieval({ engine: racingEngine, pageSlug: slug, sourceId: 'default', globalMode: mode });
  expect(result.kind).toBe('transient_error');
  expect((await engine.executeRaw('SELECT contextual_retrieval_mode FROM pages WHERE slug = $1', [slug]))[0].contextual_retrieval_mode).toBeNull();
});

test('title context changed during actual embedding input rejects late vectors and stamp', async () => {
  const slug = 'followup/context';
  await engine.putPage(slug, { title: 'Old title', type: 'note', compiled_truth: 'body' });
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'body', chunk_source: 'compiled_truth', language: 'typescript' }]);
  const original = await engine.getChunks(slug);
  duringProvider = async texts => {
    expect(texts[0]).toContain('Old title');
    expect(texts[0]).toContain('body');
    await engine.executeRaw('UPDATE pages SET title = $1, write_revision = gen_random_uuid() WHERE slug = $2', ['New title', slug]);
  };
  const result = await reembedPageWithContextualRetrieval({ engine, pageSlug: slug, sourceId: 'default', globalMode: 'title' });
  expect(result.kind).toBe('transient_error');
  const current = await engine.getChunks(slug);
  expect(current[0].id).toBe(original[0].id);
  expect(current[0].embedded_at).toBeNull();
  expect(current[0].language).toBe('typescript');
  expect((await engine.executeRaw('SELECT corpus_generation FROM pages WHERE slug = $1', [slug]))[0].corpus_generation).toBeNull();
});
