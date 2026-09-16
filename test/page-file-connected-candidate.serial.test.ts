import { test, expect, mock, beforeEach } from 'bun:test';
// Real PostgresEngine -> runtime private registration -> authority lifecycle.
// Only fixed-anchor discovery, host manifest IO and postgres transport replaced.
let opened = 0, ended = 0, badIdentity = false, failEnd = false;
const session = { unsafe: async () => [{ session_user: 'adapter', current_user: 'adapter', database_name: 'fixture', rolsuper: badIdentity, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }], release() {} };
const pool: any = Object.assign(async () => [], { reserve: async () => session, unsafe: async () => [], end: async () => { ended++; if (failEnd) throw new Error('private close secret'); } });
mock.module('postgres', () => ({ default: Object.assign(() => { opened++; return pool; }, { BigInt: {} }) }));
const db = await import('../src/core/db.ts');
mock.module('../src/core/db.ts', () => ({ ...db, connect: async () => false, getConnection: () => pool, disconnect: async () => {} }));
mock.module('../src/core/page-file-host.ts', () => ({ validatePageFileHostManifest: () => ({ manifest: { database: 'fixture', adapterRole: 'adapter', brainId: 'fixture', topology: 'single-host-local', lock: { path: '/tmp/unused-connected-lock' }, roots: [{ sourceId: 'fixture', mappingGeneration: '1', directory: { path: '/tmp/unused-connected-root' }, journal: { path: '/tmp/unused-connected-journal' } }] }, revalidate() {} }) }));
const runtime = await import('../src/core/page-file-runtime.ts');
const options = (engine: any): any => ({ mode: 'offline-verification', engine, host: {}, authority: { mode: 'offline-verification', credentialReference: 'fixture', resolveCredential: async () => 'postgres://adapter:***@example.invalid/fixture', expected: { role: 'adapter', ordinaryRole: 'ordinary', database: 'fixture' } } });
mock.module('../src/core/page-file-bootstrap.ts', () => ({ loadPageFileStartupBootstrap: () => ({ status: 'offline-verification', start: (engine: any) => runtime.createPageFileRuntimeCandidate(options(engine)) }) }));
const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
const config = { database_url: 'postgres://ordinary@example.invalid/fixture' };
beforeEach(() => { opened = ended = 0; badIdentity = failEnd = false; });
test('connected concurrent startup has one actual private authority and successful restart', async () => {
  const engine = new PostgresEngine();
  await Promise.all([engine.connect(config), engine.connect(config)]);
  expect(opened).toBe(1);
  expect(await runtime.hasPageFileRuntimeCandidate(engine)).toBe(true);
  await expect(runtime.createPageFileRuntimeCandidate(options(engine))).rejects.toThrow('already_registered');
  await Promise.all([engine.disconnect(), engine.disconnect()]);
  expect(ended).toBe(1);
  await expect(runtime.hasPageFileRuntimeCandidate(engine)).rejects.toThrow('runtime_closed');
  await engine.connect(config);
  expect(opened).toBe(2);
  await engine.disconnect();
  expect(ended).toBe(2);
});
test('connected validation failure closes candidate pool and never resets tombstone', async () => {
  badIdentity = true;
  const engine = new PostgresEngine();
  await expect(engine.connect(config)).rejects.toThrow('identity_mismatch');
  expect(opened).toBe(1); expect(ended).toBe(1);
  await expect(runtime.hasPageFileRuntimeCandidate(engine)).rejects.toThrow('runtime_closed');
  badIdentity = false;
  await expect(engine.connect(config)).rejects.toThrow('identity_mismatch');
  await expect(engine.reconnect()).rejects.toThrow('identity_mismatch');
  await expect(runtime.createPageFileRuntimeCandidate(options(engine))).rejects.toThrow('already_registered');
  expect(opened).toBe(1);
});
test('connected retained runtime rejects after disconnect without a database fallback', async () => {
  const engine = new PostgresEngine();
  await engine.connect(config);
  let queries = 0;
  // Only the binding lookup is fixture data; resolveCandidate, its returned
  // pages.get method, and the engine's disconnect lifecycle are real.
  engine.executeRaw = (async () => {
    queries++;
    return [{ canonical_root: '/tmp/unused-connected-root', relative_path: 'connected.md', binding_id: 'fixture' }];
  }) as typeof engine.executeRaw;
  const ctx = { engine, config: { engine: 'postgres' as const } };
  const retained = (await runtime.resolvePageFileRuntime(ctx, 'fixture', 'connected'))!;
  expect(retained).toBeDefined();
  await engine.disconnect();
  const before = queries;
  await expect(Promise.resolve().then(() => retained.pages.get('fixture', 'connected', () => {}))).rejects.toThrow('page_file_runtime_closed');
  await expect(runtime.resolvePageFileRuntime(ctx, 'fixture', 'connected')).rejects.toThrow('page_file_runtime_closed');
  expect(queries).toBe(before);
  expect(opened).toBe(1); expect(ended).toBe(1);
});

test('connected failed private close stays closed and cannot re-register', async () => {
  const engine = new PostgresEngine(); await engine.connect(config);
  failEnd = true;
  await expect(engine.disconnect()).rejects.toThrow();
  failEnd = false;
  await expect(engine.disconnect()).rejects.toThrow();
  await expect(engine.connect(config)).rejects.toThrow();
  await expect(engine.reconnect()).rejects.toThrow();
  await expect(runtime.hasPageFileRuntimeCandidate(engine)).rejects.toThrow('runtime_closed');
  await expect(runtime.createPageFileRuntimeCandidate(options(engine))).rejects.toThrow('already_registered');
  expect(opened).toBe(1); expect(ended).toBe(1);
});
