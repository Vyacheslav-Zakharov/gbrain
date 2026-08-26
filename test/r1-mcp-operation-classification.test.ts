import { describe, expect, test } from 'bun:test';
import { operationsByName, resolveRequestedScope, sourceScopeOpts } from '../src/core/operations.ts';
import { summarizeMcpParams } from '../src/mcp/dispatch.ts';

const remoteCtx = {
  remote: true,
  sourceId: 'internal-it',
  auth: { allowedSources: ['internal-it'], writeSources: [] },
  engine: {},
  config: { engine: 'postgres' },
  logger: { info() {}, warn() {}, error() {} },
  dryRun: false,
};

describe('R1 changed MCP operation classification', () => {
  test('search and query are remote read operations with fail-closed source scoping', () => {
    for (const name of ['search', 'query']) {
      const op = operationsByName[name];
      expect(op).toBeTruthy();
      expect(op.scope).toBe('read');
      expect(op.mutating ?? false).toBe(false);
      expect(op.localOnly ?? false).toBe(false);
    }
    expect(sourceScopeOpts({ sourceId: 'internal-it', auth: { allowedSources: ['internal-it', 'shared'] } } as never))
      .toEqual({ sourceIds: ['internal-it', 'shared'] });
    expect(resolveRequestedScope({ remote: true, sourceId: 'internal-it', auth: { allowedSources: ['internal-it', 'shared'] } } as never, '__all__'))
      .toEqual({ sourceIds: ['internal-it', 'shared'] });
    expect(sourceScopeOpts({ remote: true, sourceId: 'internal-it', auth: { allowedSources: [] } } as never))
      .toEqual({ sourceId: 'internal-it' });
    expect(resolveRequestedScope({ remote: true, sourceId: 'internal-it', auth: { allowedSources: [] } } as never, '__all__'))
      .toEqual({ sourceId: 'internal-it' });
    expect(() => resolveRequestedScope({ remote: true, sourceId: 'internal-it', auth: { allowedSources: ['internal-it'] } } as never, 'foreign'))
      .toThrow("source 'foreign' is outside your granted sources");
  });

  test('actual read handlers forward grants and deny foreign query scope before engine access', async () => {
    let seenSearchOpts: Record<string, unknown> | undefined;
    const searchCtx = {
      ...remoteCtx,
      auth: { allowedSources: ['internal-it', 'shared'] },
      engine: {
        getConfig: async () => 'true',
        searchKeyword: async (_query: string, opts: Record<string, unknown>) => { seenSearchOpts = opts; return []; },
      },
    } as never;
    expect(await operationsByName.search.handler(searchCtx, { query: 'scope probe' })).toEqual([]);
    expect(seenSearchOpts).toMatchObject({ sourceIds: ['internal-it', 'shared'] });

    let emptyGrantOpts: Record<string, unknown> | undefined;
    const emptyGrantCtx = {
      ...remoteCtx,
      auth: { allowedSources: [] },
      engine: {
        getConfig: async () => 'true',
        searchKeyword: async (_query: string, opts: Record<string, unknown>) => { emptyGrantOpts = opts; return []; },
      },
    } as never;
    expect(await operationsByName.search.handler(emptyGrantCtx, { query: 'scope probe' })).toEqual([]);
    expect(emptyGrantOpts).toMatchObject({ sourceId: 'internal-it' });

    await expect(operationsByName.query.handler(remoteCtx as never, { query: 'scope probe', source_id: 'foreign' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('catalog upserts are admin mutations and reject every remote caller before DB access', async () => {
    const base = operationsByName.source_base_view_upsert;
    const transform = operationsByName.source_transform_view_upsert;
    for (const op of [base, transform]) {
      expect(op.scope).toBe('admin');
      expect(op.mutating).toBe(true);
    }
    expect(base.params.row_filter).toMatchObject({ type: 'array', items: { type: 'object' } });
    expect(transform.params.inputs).toMatchObject({ type: 'array', items: { type: 'object' } });

    await expect(base.handler(remoteCtx as never, {
      base_view_id: 'bv-test', connector_id: 'fake', object_name: 'vehicle', row_filter: [],
    })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(transform.handler(remoteCtx as never, {
      transform_view_id: 'tv-test', inputs: [], sql: 'SELECT 1', primary_key_field: 'id',
    })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('central MCP audit summaries expose declared shape, never submitted values', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['search', { query: 'private query', limit: 5 }],
      ['query', { query: 'private query', source_id: 'internal-it' }],
      ['source_base_view_upsert', { base_view_id: 'secret-id', connector_id: 'secret-connector', object_name: 'secret-object', row_filter: [{ field: 'secret' }] }],
      ['source_transform_view_upsert', { transform_view_id: 'secret-id', inputs: [{ base_view_id: 'secret-input' }], sql: 'SELECT secret', primary_key_field: 'id' }],
    ];
    for (const [name, params] of cases) {
      const summary = summarizeMcpParams(name, params);
      expect(summary).toMatchObject({ redacted: true, kind: 'object', unknown_key_count: 0 });
      const serialized = JSON.stringify(summary);
      for (const forbidden of ['private query', 'internal-it', 'secret-id', 'secret-connector', 'secret-object', 'secret-input', 'SELECT secret']) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });
});
