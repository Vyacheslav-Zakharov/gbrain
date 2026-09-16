import { test, expect, mock } from 'bun:test';

let starts = 0, closes = 0, checks = 0, failClose = false;
mock.module('../src/core/page-file-bootstrap.ts', () => ({
  loadPageFileStartupBootstrap() { return { status: 'offline-verification', async start() {
    starts++; return { async revalidate() { checks++; }, async close() { closes++; if (failClose) throw new Error('shutdown refused'); } };
  } }; },
}));
const pool: any = Object.assign(async () => [], { end: async () => {}, unsafe: async () => [] });
const actualDb = await import('../src/core/db.ts');
mock.module('../src/core/db.ts', () => ({ ...actualDb, connect: async () => false, getConnection: () => pool, disconnect: async () => {}, resolvePoolSize: () => 1 }));
const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
test('actual singleton connect/reconnect/disconnect awaits protected lifecycle and refuses failed shutdown', async () => {
  const engine = new PostgresEngine();
  await engine.connect({ database_url: 'postgres://example.invalid/example' });
  expect(starts).toBe(1);
  await engine.initSchema(); // protected lifecycle must not run release DDL
  await engine.reconnect();
  expect(checks).toBeGreaterThan(0);
  failClose = true;
  await expect(engine.disconnect()).rejects.toThrow('shutdown refused');
  expect(closes).toBe(1);
});
