import { test, expect, mock, beforeEach } from 'bun:test';

let starts = 0, closes = 0, connects = 0, ends = 0;
let startGate: Promise<void> = Promise.resolve();
let startFailure = false, closeFailure = false;
let checkGate: Promise<void> = Promise.resolve();
let checkFailure = false;
const pool: any = Object.assign(async () => [], { end: async () => {}, unsafe: async () => [] });
const actualDb = await import('../src/core/db.ts');
mock.module('../src/core/db.ts', () => ({ ...actualDb,
  connect: async () => { connects++; return true; }, getConnection: () => pool,
  disconnect: async () => { ends++; }, resolvePoolSize: () => 1,
}));
mock.module('../src/core/page-file-bootstrap.ts', () => ({
  loadPageFileStartupBootstrap: () => ({ status: 'offline-verification', async start() {
    starts++; await startGate;
    if (startFailure) throw new Error('validation refused');
    return { async revalidate() { await checkGate; if (checkFailure) throw new Error('revalidation refused'); }, async close() { closes++; if (closeFailure) throw new Error('shutdown refused'); } };
  } }),
}));
const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
const config = { database_url: 'postgres://example.invalid/example' };
beforeEach(() => { starts = closes = connects = ends = 0; startGate = checkGate = Promise.resolve(); startFailure = closeFailure = checkFailure = false; });

test('concurrent connects register once and shutdown waits for startup', async () => {
  let release!: () => void;
  startGate = new Promise(resolve => { release = resolve; });
  const engine = new PostgresEngine();
  const first = engine.connect(config), second = engine.connect(config);
  await new Promise(resolve => setTimeout(resolve, 20));
  const shutdown = engine.disconnect();
  release();
  await Promise.all([first, second, shutdown]);
  expect(starts).toBe(1);
  expect(connects).toBe(1);
  expect(closes).toBe(1);
  expect(ends).toBe(1);
});

test('failed startup closes ordinary pool and remains fail-closed on every retry', async () => {
  startFailure = true;
  const engine = new PostgresEngine();
  await expect(engine.connect(config)).rejects.toThrow('validation refused');
  expect(ends).toBe(1);
  startFailure = false;
  await expect(engine.connect(config)).rejects.toThrow('validation refused');
  await expect(engine.reconnect()).rejects.toThrow('validation refused');
  expect(() => engine.sql).toThrow('validation refused');
  expect(starts).toBe(1);
  expect(connects).toBe(1);
});

test('concurrent reconnect rejection is shared and shutdown waits for validation', async () => {
  const engine = new PostgresEngine();
  await engine.connect(config);
  let release!: () => void;
  checkGate = new Promise(resolve => { release = resolve; });
  checkFailure = true;
  const a = engine.reconnect(), b = engine.reconnect();
  const results = Promise.allSettled([a, b]);
  const shutdown = engine.disconnect();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(closes).toBe(0);
  release();
  expect((await results).map(r => r.status)).toEqual(['rejected', 'rejected']);
  await shutdown;
});

test('failed shutdown is sticky for connect reconnect and repeated disconnect', async () => {
  const engine = new PostgresEngine();
  await engine.connect(config);
  closeFailure = true;
  await expect(engine.disconnect()).rejects.toThrow('shutdown refused');
  closeFailure = false;
  await expect(engine.connect(config)).rejects.toThrow('shutdown refused');
  await expect(engine.reconnect()).rejects.toThrow('shutdown refused');
  await expect(engine.disconnect()).rejects.toThrow('shutdown refused');
  expect(closes).toBe(1);
  expect(ends).toBe(0);
});

test('reconnect after successful shutdown reconstructs protected singleton lifecycle', async () => {
  const engine = new PostgresEngine();
  await engine.connect(config);
  await engine.disconnect();
  await engine.reconnect();
  expect(starts).toBe(2);
  await engine.disconnect();
  expect(closes).toBe(2);
});
