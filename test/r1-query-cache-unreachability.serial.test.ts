import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildCutoverStatements, R1_TARGET_DIMENSIONS, R1_TARGET_MODEL } from '../src/core/r1-governed-migration.ts';
import { SemanticQueryCache } from '../src/core/search/query-cache.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ embedding_model: 'zeroentropyai:zembed-1', embedding_dimensions: 1280, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('R1 query-cache old-space isolation', () => {
  test('old-provider rows remain unreachable when purge is deliberately skipped', async () => {
    const before = new SemanticQueryCache(engine);
    const oldVector = new Float32Array(1280);
    oldVector[0] = 1;
    await before.store('old-provider-query', oldVector, [], {} as never, { knobsHash: 'v13-ze' });
    expect((await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM query_cache'))[0]?.n).toBe(1);

    const queryCacheCutoverWithoutPurge = buildCutoverStatements().filter((statement) =>
      statement.includes('query_cache') && statement !== 'DELETE FROM query_cache',
    );
    for (const statement of queryCacheCutoverWithoutPurge) await engine.executeRaw(statement);

    const retained = await engine.executeRaw<{ rows: number; old_vectors: number; new_vectors: number }>(
      `SELECT COUNT(*)::int AS rows,
              COUNT(embedding_ze_r0)::int AS old_vectors,
              COUNT(embedding)::int AS new_vectors
         FROM query_cache`,
    );
    expect(retained[0]).toEqual({ rows: 1, old_vectors: 1, new_vectors: 0 });

    configureGateway({ embedding_model: R1_TARGET_MODEL, embedding_dimensions: R1_TARGET_DIMENSIONS, env: {} });
    const after = new SemanticQueryCache(engine);
    const targetVector = new Float32Array(R1_TARGET_DIMENSIONS);
    targetVector[0] = 1;
    await after.store('target-provider-query', targetVector, [], {} as never, { knobsHash: 'v14-google' });
    expect(await after.lookup(targetVector, { knobsHash: 'v14-google' })).toMatchObject({ hit: true, results: [] });
    expect(await after.lookup(targetVector, { knobsHash: 'v13-ze' })).toEqual({ hit: false });
  });
});
