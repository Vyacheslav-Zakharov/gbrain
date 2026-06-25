/**
 * PR3 read-redaction operation guards for get_links/get_backlinks.
 *
 * These tests sit above the engine: remote scalar callers must be promoted to
 * sourceIds[] and cross_source_edges config must be read from DB config, not only
 * passed as direct engine opts. The same operation surface also covers the
 * cross-source add_link schema/authority boundary used by remote MCP clients.
 */

import { describe, test, expect } from 'bun:test';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
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

function makeAddLinkCtx(): { ctx: OperationContext; calls: Array<{ args: any[] }> } {
  const calls: Array<{ args: any[] }> = [];
  const engine = {
    addLink: async (...args: any[]) => {
      calls.push({ args });
    },
  } as unknown as BrainEngine;

  const ctx = {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: true,
    sourceId: 'beta',
    auth: {
      token: 'test',
      clientId: 'client',
      scopes: ['write'],
      sourceId: 'beta',
      allowedSources: ['beta', 'shared'],
      writeSources: ['beta'],
    },
  } as unknown as OperationContext;

  return { ctx, calls };
}

function makeListPagesCtx(): { ctx: OperationContext; calls: any[] } {
  const calls: any[] = [];
  const engine = {
    listPages: async (opts: any) => {
      calls.push(opts);
      return [
        { slug: 'a', type: 'note', title: 'A', updated_at: '2026-01-01T00:00:00Z' },
      ];
    },
  } as unknown as BrainEngine;

  const ctx = {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: true,
    sourceId: 'beta',
    auth: {
      token: 'test',
      clientId: 'client',
      scopes: ['read'],
      sourceId: 'beta',
      allowedSources: ['beta', 'shared'],
    },
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

describe('add_link operation — cross-source authority boundary', () => {
  test('schema exposes source-qualified endpoints', () => {
    expect(operationsByName.add_link.params.from_source_id).toBeTruthy();
    expect(operationsByName.add_link.params.to_source_id).toBeTruthy();
  });

  test('remote caller may write from write source to readable target source', async () => {
    const { ctx, calls } = makeAddLinkCtx();

    await operationsByName.add_link.handler(ctx, {
      from: 'meetings/demo',
      to: 'projects/ai-protocol',
      link_type: 'discusses',
      context: 'pilot',
      from_source_id: 'beta',
      to_source_id: 'shared',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 7)).toEqual([
      'meetings/demo',
      'projects/ai-protocol',
      'pilot',
      'discusses',
      'manual',
      undefined,
      undefined,
    ]);
    expect(calls[0].args[7]).toEqual({ fromSourceId: 'beta', toSourceId: 'shared', originSourceId: 'beta' });
  });

  test('remote caller cannot write from read-only source', async () => {
    const { ctx } = makeAddLinkCtx();

    try {
      await operationsByName.add_link.handler(ctx, {
        from: 'projects/ai-protocol',
        to: 'meetings/demo',
        link_type: 'discusses',
        from_source_id: 'shared',
        to_source_id: 'beta',
      });
      throw new Error('expected add_link to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(OperationError);
      expect((err as OperationError).code).toBe('permission_denied');
      expect((err as Error).message).toBe('page not found or not accessible');
    }
  });
});

describe('list_pages operation — explicit source_id scope', () => {
  test('schema exposes source_id filter', () => {
    expect(operationsByName.list_pages.params.source_id).toBeTruthy();
  });

  test('remote caller requesting a granted source gets scalar sourceId filter, not full federated view', async () => {
    const { ctx, calls } = makeListPagesCtx();

    await operationsByName.list_pages.handler(ctx, { source_id: 'shared', limit: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sourceId: 'shared', limit: 1 });
    expect(calls[0].sourceIds).toBeUndefined();
  });

  test('remote caller requesting an out-of-grant source is denied', async () => {
    const { ctx } = makeListPagesCtx();

    try {
      await operationsByName.list_pages.handler(ctx, { source_id: 'internal-hr', limit: 1 });
      throw new Error('expected list_pages to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(OperationError);
      expect((err as OperationError).code).toBe('permission_denied');
    }
  });
});
