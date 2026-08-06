/**
 * Source-aware MCP page resolution/chunk reads.
 *
 * Regression: federated OAuth callers were able to find a page in `shared`
 * through query/get_page, but `get_chunks` silently used scalar ctx.sourceId
 * (usually the personal source) and returned []. `resolve_slugs` was unscoped,
 * and none of these read operations exposed an explicit source_id selector.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('personal', 'personal', '/tmp/personal') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('shared', 'shared', '/tmp/shared') ON CONFLICT (id) DO NOTHING`);

  await engine.putPage('people/alice', {
    type: 'person',
    title: 'Alice personal',
    compiled_truth: 'Personal Alice.',
    frontmatter: { type: 'person' },
  }, { sourceId: 'personal' });
  await engine.putPage('people/alice', {
    type: 'person',
    title: 'Alice shared',
    compiled_truth: 'Shared Alice.',
    frontmatter: { type: 'person' },
  }, { sourceId: 'shared' });
  await engine.putPage('people/bob', {
    type: 'person',
    title: 'Bob shared',
    compiled_truth: 'Shared Bob.',
    frontmatter: { type: 'person' },
  }, { sourceId: 'shared' });

  await engine.upsertChunks('people/alice', [{
    chunk_index: 0,
    chunk_text: 'Personal Alice chunk.',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'personal' });
  await engine.upsertChunks('people/alice', [{
    chunk_index: 0,
    chunk_text: 'Shared Alice chunk.',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'shared' });
});

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'personal',
    auth: {
      token: 'test',
      clientId: 'test',
      scopes: ['read'],
      allowedSources: ['personal', 'shared'],
    } as any,
    ...overrides,
  };
}

describe('source-aware page/chunk MCP operations', () => {
  test('get_page, get_chunks, and resolve_slugs expose source_id', () => {
    for (const name of ['get_page', 'get_chunks', 'resolve_slugs']) {
      expect(operationsByName[name].params.source_id).toMatchObject({ type: 'string', required: false });
    }
  });

  test('get_page explicit source_id selects the requested same-slug page', async () => {
    const page = await operationsByName.get_page.handler(ctx(), {
      slug: 'people/alice',
      source_id: 'shared',
    }) as any;
    expect(page.source_id).toBe('shared');
    expect(page.compiled_truth).toBe('Shared Alice.');
  });

  test('get_chunks uses the full federated read grant when source_id is omitted', async () => {
    const chunks = await operationsByName.get_chunks.handler(ctx(), {
      slug: 'people/alice',
    }) as any[];
    expect(chunks.map((chunk) => [chunk.source_id, chunk.chunk_text])).toEqual([
      ['personal', 'Personal Alice chunk.'],
      ['shared', 'Shared Alice chunk.'],
    ]);
  });

  test('empty sourceIds uses the scalar sourceId instead of becoming match-nothing', async () => {
    const chunks = await engine.getChunks('people/alice', { sourceId: 'shared', sourceIds: [] });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.source_id).toBe('shared');
  });

  test('get_chunks explicit source_id returns only that source', async () => {
    const chunks = await operationsByName.get_chunks.handler(ctx(), {
      slug: 'people/alice',
      source_id: 'shared',
    }) as any[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].source_id).toBe('shared');
    expect(chunks[0].chunk_text).toBe('Shared Alice chunk.');
  });

  test('resolve_slugs is scoped by default and supports explicit source_id', async () => {
    const personalOnly = ctx({
      auth: {
        token: 'test', clientId: 'test', scopes: ['read'], allowedSources: ['personal'],
      } as any,
    });
    expect(await operationsByName.resolve_slugs.handler(personalOnly, { partial: 'bob' })).toEqual([]);
    expect(await operationsByName.resolve_slugs.handler(ctx(), { partial: 'bob', source_id: 'shared' })).toEqual(['people/bob']);
  });

  test('explicit source_id outside the OAuth grant is rejected', async () => {
    const restricted = ctx({
      auth: {
        token: 'test', clientId: 'test', scopes: ['read'], allowedSources: ['personal'],
      } as any,
    });
    await expect(operationsByName.get_chunks.handler(restricted, {
      slug: 'people/alice',
      source_id: 'shared',
    })).rejects.toBeInstanceOf(OperationError);
  });
});
