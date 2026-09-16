// Offline only: postgres is replaced before importing the actual hosted fixture.
import { test, expect, mock, afterAll } from 'bun:test';
const envKeys = ['GITHUB_ACTIONS', 'MARKDOWN_PROJECTION_DISPOSABLE', 'MARKDOWN_PROJECTION_ADMIN_URL', 'MARKDOWN_PROJECTION_PHASE', 'MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP', 'DATABASE_URL', 'PGOPTIONS'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
afterAll(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  mock.restore();
});
let attempts = 0;
let factory: (args: any) => any = () => { throw new Error('OFFLINE_CLIENT_SENTINEL'); };
mock.module('postgres', () => ({ default: (args: any) => { attempts++; return factory(args); } }));
const base = 'postgres://postgres@127.0.0.1:5432/postgres';
const invalid = [
  ...['database=postgres','search_path=evil','options=-c%20search_path=evil','statement_timeout=0','lock_timeout=0','connect_timeout=0','user=other','host=remote'].map(q => `${base}?${q}`),
  `${base}?`, `${base}#`, `${base}#options`,
  'http://postgres@127.0.0.1:5432/postgres',
  'postgres://postgres@127.0.0.1,localhost:5432/postgres',
  'postgres://postgres@127.0.0.1:5432/postgres/other',
  'postgres://postgres@127.0.0.1/postgres',
  'postgres://postgres@127.0.0.1:5432/%70ostgres',
];
for (const [i, url] of invalid.entries()) test(`reject endpoint ${i} before client creation`, async () => {
  process.env.GITHUB_ACTIONS = 'true';
  process.env.MARKDOWN_PROJECTION_DISPOSABLE = 'CREATE_AND_DROP_DATABASE';
  process.env.MARKDOWN_PROJECTION_ADMIN_URL = url;
  delete process.env.DATABASE_URL;
  attempts = 0;
  let error: unknown;
  try { await import(`./markdown-projection-hosted-acceptance.ts?offline=${i}`); } catch (e) { error = e; }
  expect(error).toBeDefined();
  expect(attempts).toBe(0);
});
test('reject inherited PostgreSQL options before client creation', async () => {
  process.env.MARKDOWN_PROJECTION_ADMIN_URL = base;
  process.env.PGOPTIONS = '-c search_path=evil -c statement_timeout=0';
  attempts = 0;
  try {
    try { await import('./markdown-projection-hosted-acceptance.ts?inherited=options'); } catch {}
    expect(attempts).toBe(0);
  } finally { delete process.env.PGOPTIONS; }
});
for (const [i, ip] of [undefined, '', '172.18.0.2/32', '172.18.0.2,172.18.0.3', '172.18.0.2\n', 'localhost'].entries()) test(`reject missing/ambiguous service IP ${i}`, async () => {
  process.env.MARKDOWN_PROJECTION_ADMIN_URL = base;
  if (ip === undefined) delete process.env.MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP;
  else process.env.MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP = ip;
  attempts = 0;
  let error: any;
  try { await import(`./markdown-projection-hosted-acceptance.ts?badip=${i}`); } catch (e) { error = e; }
  expect(error?.message).toContain('expected service IP');
  expect(attempts).toBe(0);
});
for (const mismatch of ['database', 'username', 'address', 'port', 'none']) test(`identity fence / cleanup: ${mismatch}`, async () => {
  const events: string[] = [];
  const argsSeen: any[] = [];
  process.env.MARKDOWN_PROJECTION_ADMIN_URL = base;
  process.env.MARKDOWN_PROJECTION_PHASE = 'red';
  process.env.MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP = '172.18.0.2';
  factory = (args: any) => {
    argsSeen.push(args);
    const index = argsSeen.length;
    const client: any = async (sql: TemplateStringsArray) => {
      if (sql.join('').includes('current_database()')) {
        events.push(`verify ${index}`);
        expect(sql.join('')).toContain('host(inet_server_addr())');
        const row: any = { database: args.database, username: args.username, address: '172.18.0.2', port: 5432 };
        if (index === 2 && mismatch !== 'none') row[mismatch] = mismatch === 'address' ? '172.18.0.3' : 'WRONG';
        return [row];
      }
      return [{ name: null }]; // exact hosted RED table probe
    };
    client.unsafe = async (sql: string) => { events.push(sql.startsWith('CREATE DATABASE') ? 'create' : sql.startsWith('DROP DATABASE') ? 'drop' : 'schema'); };
    client.end = async () => { events.push(`close ${index}`); if (index === 2) throw new Error('injected close failure'); };
    return client;
  };
  let error: any;
  try { await import(`./markdown-projection-hosted-acceptance.ts?identity=${mismatch}`); } catch (e) { error = e; }
  expect(error?.code).toBe('ERR_ASSERTION');
  expect(events).toContain('close 2');
  expect(events).toContain('close 3');
  expect(events).toContain('drop');
  expect(events).toContain('close 1');
  expect(argsSeen[1].database).toMatch(/^mp_accept_[0-9a-f]{16}$/);
  expect(argsSeen[1].host).toBe('127.0.0.1');
  expect(argsSeen[1].connection).toEqual({ statement_timeout: 5000, lock_timeout: 1500, idle_in_transaction_session_timeout: 10000, search_path: 'public' });
  if (mismatch === 'none') {
    expect(error.message).toContain('atomic obligation table missing');
    expect(error.actual).toBe(null);
    expect(error.expected).toBe('markdown_projection_obligations');
    expect(events.indexOf('schema')).toBeGreaterThan(events.indexOf('verify 3'));
  } else {
    expect(events).not.toContain('schema');
    if (mismatch === 'address') expect(error.message).toContain('wrong server address');
  }
});
