import { expect } from 'bun:test';
import type { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../../src/core/engine.ts';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(p: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout>; try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('combined lifetime deadline')), 10000); })]); } finally { clearTimeout(timer!); } }
// Actual postgres.js and PostgresEngine: no transport substitution or mocks.
export async function exerciseCombinedTransaction(engine: PostgresEngine, admin: PostgresEngine, role: string) {
  let retained!: BrainEngine;
  let lazy: any;
  expect(await engine.transaction(async tx => {
    retained = tx;
    const [a] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const [b] = await tx.executeRawDirect<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(a.pid).toBe(b.pid);
    for (const key of ['connectionManager','connect','disconnect','reconnect','initSchema','transaction','withReservedConnection']) {
      expect(() => (tx as any)[key]).toThrow('not supported on a transaction facade');
    }
    const sql = (tx as any).sql;
    for (const key of ['reserve','begin','end','notify','file']) expect(() => sql[key]).toThrow('not supported');
    lazy = sql.unsafe('SELECT 123 AS late');
    return 42;
  })).toBe(42);
  await expect(retained.executeRaw('SELECT 1')).rejects.toThrow('Transaction is no longer active');
  await expect(retained.executeRawDirect('SELECT 1')).rejects.toThrow('Transaction is no longer active');
  await expect(Promise.resolve(lazy)).rejects.toThrow('Transaction is no longer active');
  const original = new Error('synthetic callback rollback');
  expect(await engine.transaction(async tx => { retained = tx; await tx.executeRaw('SELECT 1'); throw original; }).catch(e => e)).toBe(original);
  await expect(retained.executeRaw('SELECT 1')).rejects.toThrow('Transaction is no longer active');
  const entered = deferred<{ pid: number; started: string }>();
  const release = deferred<void>(); const joined = deferred<void>();
  let lateError: unknown;
  const running = engine.transaction(async tx => {
    try {
      const [identity] = await tx.executeRaw<{ pid: number; started: string }>("SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()");
      entered.resolve(identity); await release.promise;
      try { await tx.executeRawDirect('SELECT 1'); } catch (e) { lateError = e; throw e; }
    } finally { joined.resolve(); }
  });
  const settled = running.then(() => ({ ok: true }), error => ({ ok: false, error }));
  try {
    const identity = await bounded(entered.promise);
    const rows = await admin.executeRaw<{ stopped: boolean }>(`SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE pid=$1 AND usename=$2 AND datname=current_database() AND backend_start=$3::text::timestamptz`, [identity.pid, role, identity.started]);
    expect(rows).toEqual([{ stopped: true }]);
    expect((await bounded(settled)).ok).toBe(false);
  } finally { release.resolve(); await bounded(joined.promise); }
  expect(lateError).toBeInstanceOf(Error);
  expect((lateError as Error).message).toBe('Transaction is no longer active');
  expect((await engine.executeRaw<{ ok: number }>('SELECT 1 AS ok'))[0].ok).toBe(1);
  console.log('CAS_COMBINED: real transaction success rollback same-session direct routing retained lazy denial and backend-loss callback joined');
}
