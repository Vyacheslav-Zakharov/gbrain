/**
 * PR3 read-redaction operation guards for get_links/get_backlinks.
 *
 * These tests sit above the engine: remote scalar callers must be promoted to
 * sourceIds[] and cross_source_edges config must be read from DB config, not only
 * passed as direct engine opts.
 */

import { describe, test, expect } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function makeCtx(): { ctx: OperationContext; calls: Array<{ op: string; slug: string; opts: any }> } {
  const calls: Array<{ op: string; slug: string; opts: any }> = [];
  const engine = {
    getConfig: async (key: string) => {
      if (key === 'cross_source_edges.enabled') return 'true';
      if (key === 'cross_source_edges.policy.default') return 'locked-stub';
      return null;
    },
    listConfigKeys: async (prefix: string) => {
      expect(prefix).toBe('cross_source_edges.policy.');
      return ['cross_source_edges.policy.default'];
    },
    getLinks: async (slug: string, opts: any) => {
      calls.push({ op: 'getLinks', slug, opts });
      return [{ from_slug: slug, to_slug: null, link_type: 'mentions', context: null, locked: true }];
    },
    getBacklinks: async (slug: string, opts: any) => {
      calls.push({ op: 'getBacklinks', slug, opts });
      return [{ from_slug: null, to_slug: slug, link_type: 'mentions', context: null, locked: true }];
    },
  } as unknown as BrainEngine;

  const ctx = {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: true,
    sourceId: 'beta',
  } as unknown as OperationContext;

  return { ctx, calls };
}

describe('link read operations — DB-configured cross-source read redaction', () => {
  test('get_links remote scalar scope uses DB config and calls engine sourceIds[] redaction path', async () => {
    const { ctx, calls } = makeCtx();

    const result = await operationsByName.get_links.handler(ctx, { slug: 'fed/doc' });

    expect(result).toEqual([{ from_slug: 'fed/doc', to_slug: null, link_type: 'mentions', context: null, locked: true }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: 'getLinks', slug: 'fed/doc' });
    expect(calls[0].opts).toEqual({
      sourceIds: ['beta'],
      crossSourceEdges: {
        enabled: true,
        policy: { defaultPolicy: 'hidden', bySource: { default: 'locked-stub' } },
      },
    });
  });

  test('get_backlinks remote scalar scope uses DB config and calls engine sourceIds[] redaction path', async () => {
    const { ctx, calls } = makeCtx();

    const result = await operationsByName.get_backlinks.handler(ctx, { slug: 'fed/doc' });

    expect(result).toEqual([{ from_slug: null, to_slug: 'fed/doc', link_type: 'mentions', context: null, locked: true }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: 'getBacklinks', slug: 'fed/doc' });
    expect(calls[0].opts).toEqual({
      sourceIds: ['beta'],
      crossSourceEdges: {
        enabled: true,
        policy: { defaultPolicy: 'hidden', bySource: { default: 'locked-stub' } },
      },
    });
  });
});
