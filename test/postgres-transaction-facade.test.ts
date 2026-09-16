import { expect, test } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
// Real installed lazy Query implementation, simulated transport; never opens a DB.
// @ts-ignore postgres does not publish types for its internal Query class
import { Query } from '../node_modules/postgres/src/query.js';

// Actual postgres factories, with only begin simulated. Constructing these values
// never dispatches a Query or opens a database connection.
for (const name of ['sql', 'unsafe', 'json', 'typed'] as const) {
  for (const expired of [false, true]) {
    test(`native nonthenable identity: ${name}, ${expired ? 'expired' : 'active'} facade`, async () => {
      const native = postgres({ max: 1, connect_timeout: 1 });
      const engine = new PostgresEngine();
      Object.assign(engine, { _sql: { begin: (fn: any) => fn(native) } });
      const original = name === 'sql' ? native : native[name];
      const identity = async (value: any) => {
        expect('then' in value).toBe(false);
        expect(value.then).toBeUndefined();
        expect(await Promise.resolve(value)).toBe(value);
        expect(await value).toBe(value);
        expect(await (async () => value)()).toBe(value);
      };
      const invoke = (value: any) => name === 'sql' ? value`SELECT never_dispatched`
        : name === 'unsafe' ? value('SELECT never_dispatched')
        : name === 'json' ? value({ value: 1 }) : value(1, 23);
      let retained: any;
      try {
        await identity(original);
        const returned = await engine.transaction(async scope => {
          const sql = (scope as PostgresEngine).sql;
          retained = name === 'sql' ? sql : sql[name];
          expect(retained === original).toBe(false);
          if (!expired) {
            await identity(retained);
            for (const key of ['constructor', 'call', 'apply', 'bind']) {
              expect(() => Reflect.get(retained, key)).toThrow('not supported');
            }
            expect(invoke(retained)).toBeDefined();
          }
          // Actual async-return/outer transaction assimilation, not an envelope.
          return retained;
        });
        expect(returned === retained).toBe(true);
        if (expired) await identity(retained);
        expect(() => invoke(retained)).toThrow('Transaction is no longer active');
        expect(() => Reflect.apply(retained, native, [])).toThrow('Transaction is no longer active');
      } finally {
        await native.end();
      }
    });
  }
}

function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness() {
  const death = gate<never>(), entered = gate<void>(), select = gate<any[]>();
  let updates = 0, calls = 0, managers = 0, parents = 0;
  let callback!: Promise<unknown>;
  const handler = (q: any) => {
    calls++;
    if (String(q.strings[0]).includes('UPDATE')) updates++;
    if (String(q.strings[0]).includes('SELECT resolved_at')) {
      entered.resolve(); select.promise.then(q.resolve, q.reject);
    } else q.resolve([]);
  };
  const tx = Object.assign((s: TemplateStringsArray) => new Query(s, [], handler, () => {}), {
    unsafe(s: string) { expect(this).toBe(tx); return new Query([s], [], handler, () => {}); },
    json: (x: unknown) => x,
    typed: Object.assign((x: unknown) => x, { bigint: (x: unknown) => x }),
    notify: () => { parents++; },
  });
  const pool = { unsafe: async () => { parents++; return []; }, begin: (fn: any) => {
    callback = fn(tx); return Promise.race([callback, death.promise]);
  } };
  const engine = new PostgresEngine();
  Object.assign(engine, { _sql: pool, connectionManager: {
    peekReadPool: () => { managers++; return pool; },
    ddl: async () => { managers++; throw new Error('DDL pool accessed'); },
  } });
  return { engine, entered, select, death, callback: () => callback,
    counts: () => ({ updates, calls, managers, parents }) };
}

test('actual resolveTake: delayed SELECT then expiry issues zero UPDATE calls; concurrent parent remains usable', async () => {
  const h = harness();
  const original = new Error('backend lost');
  const result = h.engine.transaction(tx => tx.resolveTake(1, 1, { quality: 'correct', resolvedBy: 'review' } as any)).catch(e => e);
  await h.entered.promise;
  await h.engine.executeRaw('parent concurrently');
  h.death.reject(original);
  expect(await result).toBe(original);
  h.select.resolve([{ resolved_at: null }]);
  const error = await h.callback().catch(e => e);
  expect(h.counts().updates).toBe(0);
  expect((error as Error).message).toBe('Transaction is no longer active');
  expect(h.counts().parents).toBe(1);
});

test('retained initSchema refuses before any manager access', async () => {
  const h = harness(); let retained!: PostgresEngine;
  await h.engine.transaction(async tx => { retained = tx as PostgresEngine; });
  const error = await Promise.resolve().then(() => retained.initSchema()).catch(e => e);
  expect(h.counts().managers).toBe(0);
  expect(error.message).toContain('not supported');
});

test('cached tagged SQL, unsafe, typed helper and lazy derived query expire at invocation/dispatch', async () => {
  const h = harness(); let sql: any, unsafe: any, typed: any, lazy: any;
  await h.engine.transaction(async scope => {
    sql = (scope as PostgresEngine).sql; unsafe = sql.unsafe; typed = sql.typed.bigint;
    await scope.executeRaw('SELECT active');
    await scope.executeRawDirect('SELECT direct');
    lazy = sql`SELECT delayed`.values().simple();
    expect(typed(3)).toBe(3);
  });
  expect(() => sql`UPDATE cached`).toThrow('Transaction is no longer active');
  expect(() => unsafe('UPDATE cached')).toThrow('Transaction is no longer active');
  expect(() => typed(4)).toThrow('Transaction is no longer active');
  await expect(Promise.resolve(lazy)).rejects.toThrow('Transaction is no longer active');
  expect(h.counts()).toEqual({ updates: 0, calls: 2, managers: 0, parents: 0 });
});

test('active facade denies lifecycle, DDL, manager and SQL pool escapes before access', async () => {
  const h = harness();
  await h.engine.transaction(async scope => {
    const tx = scope as PostgresEngine;
    for (const key of ['connect', 'disconnect', 'reconnect', 'initSchema', 'transaction', 'withReservedConnection', 'connectionManager']) {
      expect(() => Reflect.get(tx, key)).toThrow('not supported');
    }
    for (const key of ['notify', 'file', 'savepoint', 'prepare', 'begin', 'reserve', 'end', 'listen']) {
      expect(() => Reflect.get(tx.sql, key)).toThrow('not supported');
    }
  });
  expect(h.counts().managers).toBe(0);
  expect(h.counts().parents).toBe(0);
});
