// Serial: temporary file/env config and the real gateway's test transport are global.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigWithEngine, saveConfig, type GBrainConfig } from '../src/core/config.ts';
import { hybridSearch, hybridSearchCached } from '../src/core/search/hybrid.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const registry = {
  embedding: { provider: 'zeroentropyai:zembed-1', dimensions: 1280, type: 'vector' as const },
  embedding_g768: { provider: 'google:gemini-embedding-001', dimensions: 768, type: 'vector' as const },
};
const base: GBrainConfig = { engine: 'pglite', embedding_model: 'google:gemini-embedding-001', embedding_dimensions: 1280 };
let home: string;
let oldEnv: NodeJS.ProcessEnv;
let embeds: number[];
let vectors: any[];
let cacheReads: number;
beforeEach(() => {
  oldEnv = { ...process.env };
  home = mkdtempSync(join(tmpdir(), 'gbrain-f1-'));
  process.env.GBRAIN_HOME = home;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS']) delete process.env[key];
  saveConfig(base);
  embeds = []; vectors = []; cacheReads = 0;
  configureGateway({ embedding_model: base.embedding_model, embedding_dimensions: 1280, env: { GOOGLE_GENERATIVE_AI_API_KEY: 'synthetic' } });
  __setEmbedTransportForTests(async (args: any) => {
    const dims = args.providerOptions.google.outputDimensionality;
    embeds.push(dims);
    return { values: args.values, warnings: [], embeddings: args.values.map(() => Array(dims).fill(0.2)), usage: { tokens: 0 } };
  });
});
afterEach(() => {
  __setEmbedTransportForTests(null); resetGateway();
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  rmSync(home, { recursive: true, force: true });
});

function engineFor(failedKey?: string, registryValue = JSON.stringify(registry), selector = 'embedding_g768'): any {
  return {
    getConfig: async (key: string) => {
      if (key === failedKey) throw new Error(`authority unavailable: ${key}`);
      if (key === 'embedding_columns') return registryValue;
      if (key === 'search_embedding_column') return selector;
      return null;
    },
    searchKeyword: async () => [],
    searchVector: async (vector: Float32Array, opts: any) => { vectors.push({ dimensions: vector.length, column: opts.embeddingColumn }); return []; },
    executeRaw: async (sql: string) => { if (/query_cache/i.test(sql)) cacheReads++; return []; },
  };
}
const opts = { sourceId: 'default', limit: 2, expand: false, rerank: false, mode: 'fast' as const, relationalRetrieval: false };
for (const search of [hybridSearch, hybridSearchCached]) {
  for (const key of ['search_embedding_column', 'embedding_columns']) {
    test(`${search.name} rejects failed ${key} before embedding/vector/cache access`, async () => {
      // A registry failure must also protect an explicitly selected primary
      // whose real ZE1280 descriptor is only present in that failed registry.
      const selector = key === 'embedding_columns' ? 'embedding' : 'embedding_g768';
      // Match the reviewer's selector repro: only the selected Google768
      // column is registered, so fallback would reinterpret primary as Google1280.
      const dbRegistry = key === 'search_embedding_column'
        ? { embedding_g768: registry.embedding_g768 } : registry;
      await expect(search(engineFor(key, JSON.stringify(dbRegistry), selector), 'synthetic query', opts)).rejects.toThrow(`authority unavailable: ${key}`);
      expect(embeds).toEqual([]); expect(vectors).toEqual([]); expect(cacheReads).toBe(0);
    });
  }
  for (const malformed of ['{bad', '[]', 'null', '42']) {
    test(`${search.name} refuses malformed registry ${malformed} instead of reinterpreting primary`, async () => {
      await expect(search(engineFor(undefined, malformed, 'embedding'), 'synthetic query', opts)).rejects.toThrow('embedding_columns');
      expect(embeds).toEqual([]); expect(vectors).toEqual([]); expect(cacheReads).toBe(0);
    });
  }
  test(`${search.name} healthy DB-selected Google768 reaches actual vector arm`, async () => {
    await search(engineFor(), 'synthetic query', opts);
    expect(embeds).toEqual([768]);
    expect(vectors).toEqual([{ dimensions: 768, column: { name: 'embedding_g768', type: 'vector', dimensions: 768, embeddingModel: 'google:gemini-embedding-001' } }]);
  });
}
test('file selector/registry override unavailable DB values; env still overrides global model', async () => {
  saveConfig({ ...base, embedding_model: 'zeroentropyai:zembed-1', search_embedding_column: 'embedding_g768', embedding_columns: registry });
  process.env.GBRAIN_EMBEDDING_DIMENSIONS = '768';
  process.env.GBRAIN_EMBEDDING_MODEL = 'google:gemini-embedding-001';
  const merged = await loadConfigWithEngine({ getConfig: async () => { throw new Error('DB unavailable'); } });
  expect(merged?.search_embedding_column).toBe('embedding_g768');
  expect(merged?.embedding_columns).toEqual(registry);
  expect(merged?.embedding_dimensions).toBe(768);
  expect(merged?.embedding_model).toBe('google:gemini-embedding-001');
});
test('unrelated optional DB reads remain best effort', async () => {
  const merged = await loadConfigWithEngine({ getConfig: async (key) => {
    if (key === 'search_embedding_column') return 'embedding_g768';
    if (key === 'embedding_columns') return JSON.stringify(registry);
    throw new Error('optional unavailable');
  } }, base);
  expect(merged?.search_embedding_column).toBe('embedding_g768');
  expect(merged?.dream).toBeUndefined();
  expect(merged?.embedding_multimodal).toBeUndefined();
});
