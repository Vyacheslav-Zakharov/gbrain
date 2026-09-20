import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import postgres from 'postgres';
// Exercise pinned driver retirement semantics without ever connecting a socket.
// @ts-ignore internal pinned driver seam
import Connection from '../node_modules/postgres/src/connection.js';
// @ts-ignore internal pinned driver seam
import { Query } from '../node_modules/postgres/src/query.js';
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
function fixture(fail?: string, failure?: unknown) {
  const commands: string[] = []; let releases = 0; let ends = 0;
  const previous = () => {};
  const driver = Connection(postgres({ idle_timeout: 0, max_lifetime: 0 }).options);
  const driverEnd = driver.end, driverTerminate = driver.terminate;
  driver.reserved = Object.assign(() => {}, { release: true });
  const connection = Object.assign(driver, {
    end() { ends++; return driverEnd(); },
    terminate() { ends++; driverTerminate(); },
    onclose: previous as ((e: unknown) => void) | null,
  });

  const reserved = Object.assign(() => {}, {
    unsafe(text: string, _params?: unknown[], options?: any) {
      return new Query(text, [], (q: any) => {
        commands.push(text); options?.onexecute?.(connection);
        if (text === fail) q.reject(failure);
        else q.resolve(Object.assign([], { command: text }));
      }, () => {}, options);
    }, release() { releases++; },
  });
  const engine = new PostgresEngine();
  Object.assign(engine, { _sql: { reserve: async () => reserved,
    async begin(fn: any) {
      await reserved.unsafe('BEGIN');
      return Promise.race([Promise.resolve(fn(reserved)).then(async value => {
        await reserved.unsafe('COMMIT'); return value;
      }, async error => { await reserved.unsafe('ROLLBACK'); throw error; }),
      new Promise((_, reject) => { connection.onclose = reject; })]);
    },
  } });
  return { engine, connection, previous, commands, releases: () => releases, ends: () => ends,
    die(error: unknown) { connection.onclose?.(error); connection.onclose = null; } };
}
test('lost reservation expires immediately but joins callback before settlement and never cleans up reassigned connection', async () => {
  const h = fixture(), entered = gate(), resume = gate(), callbackJoined = gate(); let joined = false, settled = false;
  const loss = new Error('backend gone'); let late: unknown;
  const result = h.engine.transaction(async tx => {
    entered.resolve(); await resume.promise;
    try { await tx.executeRawDirect('late'); } catch (e) { late = e; }
    joined = true; callbackJoined.resolve(); return 1;
  }).catch(e => e).finally(() => settled = true);
  await entered.promise; h.die(loss);
  await new Promise<void>(resolve => setImmediate(resolve));
  const nextOwner = () => {}; h.connection.onclose = nextOwner;
  try {
    expect(settled).toBe(false);
    expect(joined).toBe(false);
  } finally {
    resume.resolve(); await callbackJoined.promise; await result;
  }
  expect(joined).toBe(true); expect((late as Error).message).toBe('Transaction is no longer active');
  expect(await result).toBe(loss);
  expect(h.commands).toEqual(['BEGIN']); expect(h.releases()).toBe(0);
  expect(h.connection.onclose).toBe(nextOwner);
});
test('normal rollback preserves callback identity and restores lease handler before release', async () => {
  const h = fixture(), failure = new Error('callback');
  expect(await h.engine.transaction(async () => { throw failure; }).catch(e => e)).toBe(failure);
  expect(h.commands).toEqual(['BEGIN', 'ROLLBACK']); expect(h.releases()).toBe(1);
  expect(h.connection.onclose).toBe(h.previous);
});
test('normal commit returns callback value and uses one reservation', async () => {
  const h = fixture(); expect(await h.engine.transaction(async tx => { await tx.executeRawDirect('work'); return 42; })).toBe(42);
  expect(h.commands).toEqual(['BEGIN', 'work', 'COMMIT']); expect(h.releases()).toBe(1);
});

for (const phase of ['BEGIN', 'work', 'COMMIT']) test(`fatal ${phase} before socket close never rolls back or releases`, async () => {
  const failure = Object.assign(new Error('fatal'), { severity: 'FATAL', code: '57P01' });
  const h = fixture(phase, failure);
  expect(await h.engine.transaction(async tx => { await tx.executeRaw('work'); }).catch(e => e)).toBe(failure);
  expect(h.commands.includes('ROLLBACK')).toBe(false); expect(h.releases()).toBe(0);
});
test('rollback failure retires session and preserves callback error', async () => {
  const h = fixture('ROLLBACK', new Error('cleanup')), original = new Error('callback');
  expect(await h.engine.transaction(async () => { throw original; }).catch(e => e)).toBe(original);
  expect(h.ends()).toBe(1); expect(h.releases()).toBe(0);
  // Real pinned Connection.execute must be fenced after retirement, before
  // any pool close/reassignment event; there is no socket in this fixture.
  let retiredError: any;
  h.connection.execute({ reserve: true, reject(e: unknown) { retiredError = e; } });
  expect(retiredError.code).toBe('CONNECTION_DESTROYED');
});
test('healthy lease rolls back unrelated callback ECONNRESET', async () => {
  const h = fixture(), failure = Object.assign(new Error('HTTP reset'), { code: 'ECONNRESET' });
  expect(await h.engine.transaction(async () => { throw failure; }).catch(e => e)).toBe(failure);
  expect(h.commands).toEqual(['BEGIN', 'ROLLBACK']);
  expect(h.releases()).toBe(1); expect(h.ends()).toBe(0);
});
for (const phase of ['COMMIT', 'ROLLBACK']) test(`queued ${phase} is cancelled on close without later dispatch`, async () => {
  const privateQueue: any[] = [], sent: any[] = [], commands: string[] = [];
  const queued = gate(), occupied = gate(); let full = false, releases = 0;
  const loss = new Error('socket closed'), original = new Error('callback failed');
  const connection: any = { onclose: null, terminate() { throw new Error('must not retire next owner'); } };
  // Mirrors reserve() index.js:203-231: full goes to private queue;
  // socket close rejects sent only and clears the reservation, not its queue.
  const reserved = Object.assign(() => {}, {
    unsafe(text: string, _params?: unknown[], options?: any) {
      return new Query(text, [], (q: any) => {
        if (full) { privateQueue.push(q); queued.resolve(); return; }
        commands.push(text); options?.onexecute?.(connection);
        if (text === 'in flight') { full = true; sent.push(q); occupied.resolve(); }
        else q.resolve(Object.assign([], { command: text }));
      }, () => {}, options);
    }, release() { releases++; },
  });
  const engine = new PostgresEngine(); Object.assign(engine, { _sql: { reserve: async () => reserved } });
  let work!: Promise<unknown>;
  const result = engine.transaction(async tx => {
    work = tx.executeRawDirect('in flight').catch(e => e);
    await occupied.promise;
    if (phase === 'ROLLBACK') throw original;
    return 42;
  }).catch(e => e);
  await queued.promise;
  expect(privateQueue).toHaveLength(1);
  for (const q of sent) q.reject(loss);
  connection.onclose?.(loss); connection.onclose = null;
  const nextOwner = () => {}; connection.onclose = nextOwner;
  expect(await result).toBe(phase === 'ROLLBACK' ? original : loss);
  expect(await work).toBe(loss);
  expect(privateQueue[0].cancelled).toBe(true);
  // Exercise the real pinned execute cancellation gate, not a mock branch.
  const driver = Connection(postgres({ idle_timeout: 0, max_lifetime: 0 }).options);
  expect(driver.execute(privateQueue[0])).toBeUndefined();
  expect(privateQueue[0].state).toBeNull();
  expect(commands).toEqual(['BEGIN', 'in flight']);
  expect(releases).toBe(0); expect(connection.onclose).toBe(nextOwner);
});

test('BEGIN ordinary error never invokes caller or rollback', async () => {
  const original = new Error('begin refused'), h = fixture('BEGIN', original); let calls = 0;
  expect(await h.engine.transaction(async () => { calls++; }).catch(e => e)).toBe(original);
  expect(calls).toBe(0); expect(h.commands).toEqual(['BEGIN']); expect(h.releases()).toBe(1);
});
