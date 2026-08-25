import { describe, expect, test } from 'bun:test';
import { applyContextResponseMeta } from '../../src/mcp/dispatch.ts';
import { shouldStoreSearchCache } from '../../src/core/search/hybrid.ts';
import {
  formatChunksForCaller,
  publishQueryArmsResponseMeta,
} from '../../src/core/operations.ts';

describe('caller-visible query arm degradation', () => {
  test('publishes MCP _meta without changing the SearchResult[] body', () => {
    const ctx = { responseMeta: undefined } as any;
    publishQueryArmsResponseMeta(ctx, {
      vector_enabled: true,
      detail_resolved: null,
      expansion_applied: true,
      arms: {
        status: 'degraded',
        used: 1,
        total: 3,
        failed: 2,
        failure_reasons: { embedding_timeout: 2 },
      },
    });

    const out = applyContextResponseMeta(
      { content: [{ type: 'text', text: '[{"slug":"kept"}]' }] },
      ctx,
    );
    expect(out.content[0].text).toBe('[{"slug":"kept"}]');
    expect(out._meta).toEqual({
      search: {
        status: 'degraded',
        reason: 'embedding_timeout',
        failure_reasons: { embedding_timeout: 2 },
        arms: { used: 1, total: 3, failed: 2 },
      },
    });
  });

  test('publishes an explicit FTS fallback and reason for a failed single arm', () => {
    const ctx = { responseMeta: undefined } as any;
    publishQueryArmsResponseMeta(ctx, {
      vector_enabled: false,
      detail_resolved: null,
      expansion_applied: false,
      arms: {
        status: 'degraded',
        used: 0,
        total: 1,
        failed: 1,
        original_failed: true,
        failure_reasons: { embedding_rate_limit: 1 },
      },
    });
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

  test('does not add caller metadata for a fully successful arm run', () => {
    const ctx = { responseMeta: undefined } as any;
    publishQueryArmsResponseMeta(ctx, {
      vector_enabled: true,
      detail_resolved: null,
      expansion_applied: true,
      arms: { status: 'ok', used: 3, total: 3, failed: 0, failure_reasons: {} },
    });
    expect(ctx.responseMeta).toBeUndefined();
  });
  test('does not write degraded fresh results into semantic cache', () => {
    expect(shouldStoreSearchCache({
      vector_enabled: true,
      detail_resolved: null,
      expansion_applied: true,
      arms: {
        status: 'degraded',
        used: 1,
        total: 3,
        failed: 2,
        failure_reasons: { embedding_timeout: 2 },
      },
    })).toBe(false);
    expect(shouldStoreSearchCache({
      vector_enabled: true,
      detail_resolved: null,
      expansion_applied: true,
      arms: { status: 'ok', used: 3, total: 3, failed: 0, failure_reasons: {} },
    })).toBe(true);
  });
});

describe('get_chunks embedding availability contract', () => {
  test('omits the intentionally withheld vector and exposes has_embedding', () => {
    const [row] = formatChunksForCaller([{
      id: 1,
      page_id: 2,
      source_id: 'shared',
      chunk_index: 0,
      chunk_text: 'body',
      chunk_source: 'compiled_truth',
      embedding: null,
      has_embedding: true,
      model: 'provider:model',
      token_count: 1,
      embedded_at: new Date('2026-08-06T00:00:00Z'),
      language: null,
      symbol_name: null,
      symbol_type: null,
      start_line: null,
      end_line: null,
      parent_symbol_path: null,
      doc_comment: null,
      symbol_name_qualified: null,
    } as any]);

    expect('embedding' in row).toBe(false);
    expect(row.has_embedding).toBe(true);
  });

  test('reports false when the database row has no vector', () => {
    const [row] = formatChunksForCaller([{
      id: 1,
      page_id: 2,
      chunk_index: 0,
      chunk_text: 'body',
      chunk_source: 'compiled_truth',
      embedding: null,
      has_embedding: false,
      model: null,
      token_count: null,
      embedded_at: null,
      language: null,
      symbol_name: null,
      symbol_type: null,
      start_line: null,
      end_line: null,
      parent_symbol_path: null,
      doc_comment: null,
      symbol_name_qualified: null,
    } as any]);
    expect(row.has_embedding).toBe(false);
  });
});
