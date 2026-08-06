import { describe, expect, test } from 'bun:test';
import {
  makeQueryEmbedDeadline,
  makeQueryEmbedDeadlineAt,
  queryEmbedRetryBudgetMs,
  runQueryVariantArmsFailOpen,
  sameEmbeddingSpace,
} from '../../src/core/search/hybrid.ts';

describe('query expansion retry deadline', () => {
  test('never extends the original absolute deadline', () => {
    expect(queryEmbedRetryBudgetMs(10_000, 10_001)).toBe(0);
    expect(queryEmbedRetryBudgetMs(10_000, 9_500)).toBe(500);
    expect(queryEmbedRetryBudgetMs(10_000, 1_000)).toBe(2_000);
    expect(makeQueryEmbedDeadline(500, 0).minimumBudgetMs).toBe(0);
    const anchored = makeQueryEmbedDeadlineAt(10_000, 0);
    expect(anchored.deadlineAt).toBe(10_000);
    expect(anchored.minimumBudgetMs).toBe(0);
  });

  test('rejects precomputed vectors from a different same-dimensional model', () => {
    const base = {
      name: 'embedding',
      type: 'vector' as const,
      dimensions: 1536,
      embeddingModel: 'openai:model-a',
    };
    expect(sameEmbeddingSpace(base, { ...base })).toBe(true);
    expect(sameEmbeddingSpace(base, {
      ...base,
      embeddingModel: 'openai:model-b',
    })).toBe(false);
  });
});

describe('multi-query vector arms fail open independently', () => {
  test('keeps the original-query arm when one expanded arm rejects', async () => {
    const queries = ['original query', 'expanded one', 'expanded two'];

    const result = await runQueryVariantArmsFailOpen(queries, async (query) => {
      if (query === 'expanded one') throw new Error('provider rate limit');
      return {
        embedding: new Float32Array([query === 'original query' ? 1 : 2]),
        list: [{ slug: query, score: 1 }] as any[],
      };
    });

    expect(result.lists.map((list) => list[0]?.slug)).toEqual([
      'original query',
      'expanded two',
    ]);
    expect(result.originalEmbedding).toEqual(new Float32Array([1]));
    expect(result.failedArms).toBe(1);
    expect(result.retriedOriginal).toBe(false);
  });

  test('reports no original embedding when only expansion arms survive', async () => {
    const result = await runQueryVariantArmsFailOpen(
      ['original query', 'expanded one'],
      async (query) => {
        if (query === 'original query') throw new Error('original failed');
        return {
          embedding: new Float32Array([2]),
          list: [{ slug: query, score: 1 }] as any[],
        };
      },
    );

    expect(result.lists).toHaveLength(1);
    expect(result.lists[0][0]?.slug).toBe('expanded one');
    expect(result.originalEmbedding).toBeNull();
    expect(result.failedArms).toBe(1);
    expect(result.retriedOriginal).toBe(false);
  });

  test('returns an empty vector set only when every arm fails', async () => {
    const result = await runQueryVariantArmsFailOpen(
      ['original query', 'expanded one'],
      async () => { throw new Error('provider unavailable'); },
    );

    expect(result.lists).toEqual([]);
    expect(result.originalEmbedding).toBeNull();
    expect(result.failedArms).toBe(2);
    expect(result.retriedOriginal).toBe(true);
    expect(result.recoveredOriginal).toBe(false);
  });

  test('retries only the original query when every expanded arm rejects', async () => {
    let retryCalls = 0;
    const result = await runQueryVariantArmsFailOpen(
      ['original query', 'expanded one'],
      async () => { throw new Error('shared expansion deadline elapsed'); },
      async (query) => {
        retryCalls++;
        return {
          embedding: new Float32Array([1]),
          list: [{ slug: query, score: 1 }] as any[],
        };
      },
    );

    expect(retryCalls).toBe(1);
    expect(result.lists[0][0]?.slug).toBe('original query');
    expect(result.originalEmbedding).toEqual(new Float32Array([1]));
    expect(result.retriedOriginal).toBe(true);
    expect(result.recoveredOriginal).toBe(true);
  });

  test('retries the original when it failed and surviving expansions had zero hits', async () => {
    let retryCalls = 0;
    const result = await runQueryVariantArmsFailOpen(
      ['original query', 'expanded one'],
      async (query) => {
        if (query === 'original query') throw new Error('original timed out');
        return { embedding: new Float32Array([2]), list: [] };
      },
      async (query) => {
        retryCalls++;
        return {
          embedding: new Float32Array([1]),
          list: [{ slug: query, score: 1 }] as any[],
        };
      },
    );

    expect(retryCalls).toBe(1);
    expect(result.lists.flatMap((list) => list).map((row) => row.slug)).toEqual([
      'original query',
    ]);
    expect(result.recoveredOriginal).toBe(true);
  });
});
