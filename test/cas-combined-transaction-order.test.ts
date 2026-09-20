import { expect, test } from 'bun:test';
import { exerciseCombinedTransaction } from './e2e/helpers/cas-combined-transaction.ts';

// Offline orchestration proof only: no SQL driver, connection or database.
// A lost lease invalidates the facade immediately; settlement joins the callback.
function fixture() {
  let current: { active: boolean; joined: boolean } | undefined;
  const states: { active: boolean; joined: boolean }[] = [];
  const engine = {
    async executeRaw() { return [{ ok: 1 }]; },
    async transaction(fn: (tx: any) => Promise<any>) {
      const state = { active: true, joined: false };
      states.push(state); current = state;
      const guard = () => { if (!state.active) throw new Error('Transaction is no longer active'); };
      const tx: any = {};
      const sql = new Proxy(() => {}, {
        get(_target, key) {
          guard();
          if (key === 'unsafe') return () => ({ then(resolve: any, reject: any) {
            return Promise.resolve().then(() => { guard(); return []; }).then(resolve, reject);
          } });
          throw new Error(`${String(key)} is not supported`);
        },
      });
      Object.defineProperty(tx, 'sql', { get() { guard(); return sql; } });
      tx.executeRaw = async (query: string) => {
        guard();
        return query.includes('backend_start') ? [{ pid: 123, started: '2026-01-01 00:00:00+00' }] : [{ pid: 123 }];
      };
      tx.executeRawDirect = tx.executeRaw;
      for (const key of ['connectionManager','connect','disconnect','reconnect','initSchema','transaction','withReservedConnection']) {
        Object.defineProperty(tx, key, { get() { throw new Error(`${key} is not supported on a transaction facade`); } });
      }
      try { return await fn(tx); }
      finally { state.joined = true; state.active = false; }
    },
  };
  const admin = { async executeRaw(query: string, params: unknown[]) {
    expect(query).toContain('pg_terminate_backend');
    expect(query).toContain('backend_start=$3::text::timestamptz');
    expect(params).toEqual([123, 'ordinary_fixture', '2026-01-01 00:00:00+00']);
    expect(current?.joined).toBe(false);
    // Model asynchronous delivery of real connection loss, not outer settlement.
    queueMicrotask(() => { current!.active = false; });
    return [{ stopped: true }];
  } };
  return { engine, admin, states };
}

test('hosted backend-loss gate releases callback before awaiting joined transaction', async () => {
  const f = fixture();
  await exerciseCombinedTransaction(f.engine as any, f.admin as any, 'ordinary_fixture');
  expect(f.states).toHaveLength(3);
  expect(f.states.every(s => s.joined && !s.active)).toBe(true);
}, 15000);
