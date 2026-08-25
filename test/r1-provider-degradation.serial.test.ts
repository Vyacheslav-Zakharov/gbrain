import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { operationsByName } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('r1-fail-open-canary', {
    type: 'note',
    title: 'R1 Fail Open Canary',
    compiled_truth: 'R1 fail open canary proves lexical fallback when the embedding provider is unavailable.',
  });
  await engine.upsertChunks('r1-fail-open-canary', [{
    chunk_index: 0,
    chunk_text: 'R1 fail open canary proves lexical fallback when the embedding provider is unavailable.',
    chunk_source: 'compiled_truth',
    token_count: 14,
  }]);
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

afterAll(async () => {
  await engine.disconnect();
});

function configureFailingEmbed(error: Error): void {
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 1280,
    env: { ZEROENTROPY_API_KEY: 'test-only' },
  });
  __setEmbedTransportForTests(async () => {
    throw error;
  });
}

const cases: Array<{ name: string; error: Error; expectedReason: string }> = [
  { name: 'timeout', error: new Error('provider timeout after 100ms'), expectedReason: 'embedding_timeout' },
  { name: 'rate limit', error: new Error('HTTP 429 too many requests'), expectedReason: 'embedding_rate_limit' },
  { name: 'authentication', error: new Error('HTTP 401 invalid API key'), expectedReason: 'embedding_provider' },
  { name: 'malformed payload', error: new Error('malformed embedding response'), expectedReason: 'embedding_provider' },
  { name: 'connection refusal', error: new Error('ECONNREFUSED'), expectedReason: 'embedding_provider' },
];

describe('R1 provider-down emergency behavior', () => {
  for (const item of cases) {
    test(`${item.name}: returns lexical results and explicit degradation metadata`, async () => {
      configureFailingEmbed(item.error);
      let meta: HybridSearchMeta | undefined;

      const results = await hybridSearch(engine, 'R1 fail open canary', {
        limit: 5,
        expansion: false,
        relationalRetrieval: false,
        onMeta: (value) => { meta = value; },
      });

      expect(results.some((row) => row.slug === 'r1-fail-open-canary')).toBe(true);
      expect(meta?.vector_enabled).toBe(false);
      expect(meta?.arms).toMatchObject({
        status: 'degraded',
        used: 0,
        total: 1,
        failed: 1,
        original_failed: true,
      });
      expect(meta?.arms?.failure_reasons).toEqual({ [item.expectedReason]: 1 });
    });
  }

  for (const operationName of ['search', 'query'] as const) {
    test(`${operationName} operation publishes caller-visible FTS degradation`, async () => {
      configureFailingEmbed(new Error('HTTP 429 too many requests'));
      const ctx: any = {
        engine,
        config: { engine: 'pglite' as const, eval: { capture: false } },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: false,
        remote: true,
        sourceId: 'default',
        responseMeta: undefined,
      };
      const params = operationName === 'query'
        ? { query: 'R1 fail open canary', expand: false, use_cache: false, limit: 5 }
        : { query: 'R1 fail open canary', limit: 5 };

      const results = await operationsByName[operationName].handler(ctx as any, params);
      expect((results as Array<{ slug: string }>).some((row) => row.slug === 'r1-fail-open-canary')).toBe(true);
      expect(ctx.responseMeta).toEqual({
        search: {
          status: 'degraded',
          fallback: 'fts',
          reason: 'embedding_rate_limit',
          failure_reasons: { embedding_rate_limit: 1 },
          arms: { used: 0, total: 1, failed: 1 },
        },
      });
    });
  }
});
