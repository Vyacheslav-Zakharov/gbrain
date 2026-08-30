import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

function harness(options: { failRollback?: boolean } = {}) {
  const calls: Array<{ scope: 'reserved' | 'tx'; sql: string; params: unknown[] | undefined }> = [];
  let released = 0;
  let began = 0;
  let rolledBack = 0;
  let inTransaction = false;

  const reserved = {
    unsafe: async (sql: string, params?: unknown[]) => {
      const scope = inTransaction ? 'tx' as const : 'reserved' as const;
      calls.push({ scope, sql, params });
      if (sql === 'BEGIN') {
        began += 1;
        inTransaction = true;
        return [];
      }
      if (sql === 'COMMIT') {
        inTransaction = false;
        return [];
      }
      if (sql === 'ROLLBACK') {
        rolledBack += 1;
        if (options.failRollback) throw new Error('rollback failed');
        inTransaction = false;
        return [];
      }
      return [{ scope: inTransaction ? 'tx' : 'reserved' }];
    },
    release: () => { released += 1; },
  };
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = {
    reserve: async () => reserved,
  };
  return { engine, calls, counts: () => ({ released, began, rolledBack }) };
}

describe('PostgresEngine reserved transaction contract', () => {
  test('transactionRaw uses only runtime-supported reserved unsafe/release methods', async () => {
    const h = harness();
    const result = await h.engine.withReservedConnection(async connection => {
      const outside = await connection.executeRaw<{ scope: string }>('SELECT outside', [1]);
      const inside = await connection.transactionRaw(async tx => tx.executeRaw<{ scope: string }>('SELECT inside', [2]));
      return { outside, inside };
    });

    expect(result).toEqual({ outside: [{ scope: 'reserved' }], inside: [{ scope: 'tx' }] });
    expect(h.calls).toEqual([
      { scope: 'reserved', sql: 'SELECT outside', params: [1] },
      { scope: 'reserved', sql: 'BEGIN', params: undefined },
      { scope: 'tx', sql: 'SELECT inside', params: [2] },
      { scope: 'tx', sql: 'COMMIT', params: undefined },
    ]);
    expect(h.counts()).toEqual({ released: 1, began: 1, rolledBack: 0 });
  });

  test('transactionRaw rolls back callback failure and releases only after certain cleanup', async () => {
    const h = harness();
    const sentinel = new Error('sentinel');
    await expect(h.engine.withReservedConnection(connection => connection.transactionRaw(async tx => {
      await tx.executeRaw('UPDATE tentative');
      throw sentinel;
    }))).rejects.toBe(sentinel);
    expect(h.counts()).toEqual({ released: 1, began: 1, rolledBack: 1 });
  });

  test('nested transactionRaw fails through both tx and captured outer handles', async () => {
    for (const useOuter of [false, true]) {
      const h = harness();
      await expect(h.engine.withReservedConnection(connection => connection.transactionRaw(async tx => {
        const nested = useOuter ? connection : tx;
        await nested.transactionRaw(async () => 'forbidden');
      }))).rejects.toThrow('Nested or concurrent transactionRaw is not supported');
      expect(h.counts()).toEqual({ released: 1, began: 1, rolledBack: 1 });
    }
  });

  test('rollback uncertainty poisons the reserved client instead of returning it to the pool', async () => {
    const h = harness({ failRollback: true });
    await expect(h.engine.withReservedConnection(connection => connection.transactionRaw(async () => {
      throw new Error('work failed');
    }))).rejects.toThrow('Reserved transaction rollback failed');
    expect(h.counts()).toEqual({ released: 0, began: 1, rolledBack: 1 });
  });
});
