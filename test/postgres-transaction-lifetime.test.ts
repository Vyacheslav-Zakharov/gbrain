import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Offline transport only: real PostgresEngine.transaction/executeRaw callers.
// postgres 3.4.9 src/index.js:234-305 races scope(fn) with connection.onclose;
// the reserved scope keeps running after begin rejects. No database is opened.
function harness() {
  const death = deferred<never>();
  let closed = false;
  let closedCalls = 0;
  let txCalls = 0;
  let poolCalls = 0;
  let commits = 0;
  let rollbacks = 0;
  let callback: Promise<unknown> | undefined;
  const closedDriverError = new Error('closed reserved driver was invoked');
  const tx = { unsafe: async () => {
    txCalls++;
    if (closed) { closedCalls++; throw closedDriverError; }
    return [{ via: 'transaction' }];
  } };
  const pool = {
    unsafe: async () => { poolCalls++; return [{ via: 'pool' }]; },
    begin: (fn: (sql: typeof tx) => Promise<unknown>) => {
      callback = fn(tx);
      const scope = callback.then(value => { commits++; return value; }, error => {
        rollbacks++; throw error;
      });
      return Promise.race([scope, death.promise]).finally(() => { closed = true; });
    },
  };
  const engine = new PostgresEngine();
  Object.assign(engine, { _sql: pool, connectionManager: {
    peekReadPool: () => pool,
    isDualPoolActive: () => true,
    ddl: async () => { poolCalls++; return pool; },
  } });
  return { engine, death, closedDriverError, callback: () => callback!,
    counts: () => ({ closedCalls, txCalls, poolCalls, commits, rollbacks }) };
}

describe('PostgresEngine transaction lifetime (offline reserved-driver seam)', () => {
  test('driver death before callback resumes refuses late SQL without invoking closed driver', async () => {
    const h = harness();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const failure = new Error('original backend loss');
    const pending = h.engine.transaction(async tx => {
      await tx.executeRaw('SELECT active');
      entered.resolve();
      await resume.promise;
      return tx.executeRaw('SELECT late');
    });
    const observed = pending.catch(error => error);
    await entered.promise;
    h.death.reject(failure);
    expect(await observed).toBe(failure);
    resume.resolve();
    const callbackFailure = await h.callback().catch(error => error);
    // RED explicitly exposes the actual closed-driver call, not just a mismatch
    // in the simulated driver's error text.
    expect(h.counts().closedCalls).toBe(0);
    expect(callbackFailure).toBeInstanceOf(Error);
    expect((callbackFailure as Error).message).toBe('Transaction is no longer active');
    expect(h.counts().txCalls).toBe(1);
    expect(h.counts().poolCalls).toBe(0);
  });

  test('normal commit preserves result; retained raw and direct access cannot fall back', async () => {
    const h = harness();
    let retained!: BrainEngine;
    expect(await h.engine.transaction(async tx => {
      retained = tx;
      expect(await tx.executeRaw('SELECT active')).toEqual([{ via: 'transaction' }]);
      return 42;
    })).toBe(42);
    await expect(retained.executeRaw('SELECT late')).rejects.toThrow('Transaction is no longer active');
    await expect(retained.executeRawDirect('SELECT late direct')).rejects.toThrow('Transaction is no longer active');
    expect(h.counts()).toEqual({ closedCalls: 0, txCalls: 1, poolCalls: 0, commits: 1, rollbacks: 0 });
    expect(await h.engine.executeRaw('SELECT parent')).toEqual([{ via: 'pool' }]);
  });

  test('ordinary rollback preserves callback error and closes retained scope', async () => {
    const h = harness();
    let retained!: BrainEngine;
    const failure = new Error('callback failed');
    const result = h.engine.transaction(async tx => { retained = tx; throw failure; });
    expect(await result.catch(error => error)).toBe(failure);
    await expect(retained.executeRaw('SELECT late')).rejects.toThrow('Transaction is no longer active');
    expect(h.counts()).toEqual({ closedCalls: 0, txCalls: 0, poolCalls: 0, commits: 0, rollbacks: 1 });
  });
});
