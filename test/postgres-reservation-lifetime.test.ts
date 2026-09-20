import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
function fixture(fail?: string, failure?: unknown) {
  const commands: string[] = []; let releases = 0; let ends = 0;
  const previous = () => {};
  const connection = { async end() { ends++; }, onclose: previous as ((e: unknown) => void) | null };
  const reserved = Object.assign(() => {}, {
    unsafe(text: string, _params?: unknown[], options?: any) {
      return { then(resolve: any, reject: any) { return Promise.resolve().then(() => {
        commands.push(text); options?.onexecute?.(connection);
        if (text === fail) throw failure;
        return Object.assign([], { command: text });
      }).then(resolve, reject); } };
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
test('lost reservation expires immediately, joins callback and never cleans up reassigned connection', async () => {
  const h = fixture(), entered = gate(), resume = gate(); let joined = false, settled = false;
  const loss = new Error('backend gone'); let late: unknown;
  const result = h.engine.transaction(async tx => {
    entered.resolve(); await resume.promise;
    try { await tx.executeRawDirect('late'); } catch (e) { late = e; }
    joined = true; return 1;
  }).catch(e => e).finally(() => settled = true);
  await entered.promise; h.die(loss); await Promise.resolve();
  expect(settled).toBe(false);
  const nextOwner = () => {}; h.connection.onclose = nextOwner;
  resume.resolve(); expect(await result).toBe(loss);
  expect(joined).toBe(true); expect((late as Error).message).toBe('Transaction is no longer active');
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
});
test('BEGIN ordinary error never invokes caller or rollback', async () => {
  const original = new Error('begin refused'), h = fixture('BEGIN', original); let calls = 0;
  expect(await h.engine.transaction(async () => { calls++; }).catch(e => e)).toBe(original);
  expect(calls).toBe(0); expect(h.commands).toEqual(['BEGIN']); expect(h.releases()).toBe(1);
});
