import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { exerciseTagRevisionFence } from '../helpers/page-file-tag-fence.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { exerciseConnectedBootstrap, exerciseConnectedSourceBootstrap } from './helpers/helper-caller-bootstrap.ts';
import { pageFileSqlAuthorityQueries, verifyPageFileSqlAuthority, type PageFileSqlAuthorityExpectation } from '../../src/core/page-file-sql-authority.ts';

const url = process.env.DATABASE_URL;
if (process.env.REQUIRE_PAGE_FILE_FRESH_CATALOG_POSTGRES === '1' && (process.env.GITHUB_ACTIONS !== 'true'
  || process.env.REQUIRE_PAGE_FILE_SQL_AUTHORITY_POSTGRES !== '1'
  || process.env.REQUIRE_PAGE_FILE_UPGRADE_REPLAY_POSTGRES !== '1' || !url)) {
  throw new Error('fresh catalog acceptance requires explicit disposable hosted SQL authority and replay');
}
if (process.env.REQUIRE_PAGE_FILE_PILOT_POSTGRES === '1' && (process.env.GITHUB_ACTIONS !== 'true'
  || process.env.REQUIRE_PAGE_FILE_CONNECTED_POSTGRES !== '1' || !url)) {
  throw new Error('production-pilot acceptance requires explicit disposable hosted connected fixture');
}
if (process.env.REQUIRE_PAGE_FILE_UPGRADE_REPLAY_POSTGRES === '1' && process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('upgrade replay requires explicit disposable hosted acceptance');
}
if ((process.env.REQUIRE_PAGE_FILE_SQL_AUTHORITY_POSTGRES === '1'
  || process.env.REQUIRE_PAGE_FILE_UPGRADE_REPLAY_POSTGRES === '1') && !url) throw new Error('SQL authority acceptance requires DATABASE_URL');
if (url) {
  const u = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    || u.pathname !== '/gbrain_test' || u.search || u.hash || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1'
    || process.env.GBRAIN_DIRECT_DATABASE_URL) throw new Error('Requires disposable localhost /gbrain_test without overrides');
}
const suite = url ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const roles = { ordinary: `sql_ordinary_${suffix}`, adapter: `sql_adapter_${suffix}`, enrollment: `sql_enroll_${suffix}` };
const source = process.env.HELPER_CALLER_SOURCE === 'shared' ? 'shared' : 'internal-it', policy = `sql_fixture_${suffix}`;
const createdRoles: string[] = [], policyTables: string[] = [];
const pools = new Map<string, ReturnType<typeof postgres>>();
const loginUrls = new Map<string, string>();
const denied = { ok: false, code: 'page_file_sql_authority_invalid' } as const;
let admin: PostgresEngine;
let pinDirectory: string, pinFile: string, pinBytes: string;
let pins: Record<string, string>;
const expectation = (role: string): PageFileSqlAuthorityExpectation => ({ database: 'gbrain_test', role, roles, catalogPins: pins });

// Provisioning-only capture through the owner connection, BEFORE any principal
// connection or adversarial mutation. This is a disposable fixture baseline, NOT
// production pin approval or permission to auto-enroll observed runtime catalogs.
// Persist the external baseline; acceptance only reads it and never refreshes it.
async function captureFixturePins() {
  await admin.executeRaw('SET search_path=pg_catalog,public');
  const [identity] = await admin.executeRaw<{ role: string }>('SELECT current_user::text AS role');
  const definitions: Record<string, string> = {}, catalogPins: Record<string, string> = {};
  for (const probe of pageFileSqlAuthorityQueries({ ...expectation(roles.ordinary), catalogPins: {} }).filter(p => p.catalog)) {
    const rows = await admin.executeRaw<{ id: string; definition: string }>(probe.sql, [identity.role, 'gbrain_test']);
    expect(rows).toHaveLength(1); expect(rows[0].id).toBe(probe.id);
    expect(typeof rows[0].definition).toBe('string');
    definitions[probe.id] = rows[0].definition;
    catalogPins[probe.id] = createHash('sha256').update(rows[0].definition).digest('hex');
  }
  expect(Object.keys(catalogPins)).toHaveLength(12);
  const [server] = await admin.executeRaw('SELECT version() AS version');
  pinBytes = JSON.stringify({ scope: 'disposable-fixture-only-not-production-approved', server, roles, catalogPins, definitions }, null, 2) + '\n';
  writeFileSync(pinFile, pinBytes, { mode: 0o400, flag: 'wx' });
  pins = Object.freeze(JSON.parse(readFileSync(pinFile, 'utf8')).catalogPins);
}

async function verify(login: string, expectedRole = login) {
  const session = await pools.get(login)!.reserve();
  try {
    await session.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await session.unsafe('SET LOCAL search_path=pg_catalog,public');
    await session.unsafe('SET LOCAL row_security=on');
    const [before] = await session.unsafe('SELECT pg_backend_pid() AS pid,session_user,current_user');
    expect(before.session_user).toBe(login); expect(before.current_user).toBe(login);
    let calls = 0;
    // Real postgres.js executes every actual generated SELECT. Driver failures
    // cannot become negative-test success: assert full query completion too.
    const result = await verifyPageFileSqlAuthority(async (sql, parameters) => {
      const rows = await session.unsafe(sql, parameters); calls++; return [...rows];
    }, expectation(expectedRole));
    expect(calls).toBe(pageFileSqlAuthorityQueries(expectation(expectedRole)).length);
    const [after] = await session.unsafe('SELECT pg_backend_pid() AS pid');
    expect(after.pid).toBe(before.pid);
    await session.unsafe('COMMIT');
    expect(readFileSync(pinFile, 'utf8')).toBe(pinBytes);
    return result;
  } finally { try { await session.unsafe('ROLLBACK'); } finally { session.release(); } }
}
async function allAccepted() {
  for (const role of Object.values(roles)) expect(await verify(role)).toEqual({ ok: true });
}
async function drift(apply: string, restore: string, role: string) {
  try {
    await admin.executeRaw(apply);
    expect(await verify(role)).toEqual(denied);
  } finally { await admin.executeRaw(restore); }
  // Exact original catalog pins plus exact privilege/membership checks must pass
  // after every committed mutation is restored, not only at suite teardown.
  await allAccepted();
}

test('offline fixture ordinary graph grants and endpoint/origin policy stay narrow', () => {
  const fixture = readFileSync(import.meta.path, 'utf8').split(/\n  beforeAll\(async \(\) => \{/)[1].split(/\n  afterAll\(async \(\) => \{/)[0];
  expect(fixture).toContain('GRANT SELECT,INSERT,DELETE,UPDATE(context,origin_field) ON public.links TO ${role}');
  expect(fixture).toContain("pg_get_serial_sequence('public.links','id')");
  expect(fixture).toContain('GRANT USAGE ON SEQUENCE ${linkSequence.name} TO ${role}');
  expect(fixture).toContain("['links', ownLink, roles.ordinary, 'ALL']");
  expect(fixture).toContain("from_page_id IN (${ownPages}) AND to_page_id IN (${ownPages}) AND (origin_page_id IS NULL OR origin_page_id IN (${ownPages}))");
  const adapter = fixture.split('if (role === roles.adapter)')[1].split('if (role === roles.adapter)')[0];
  expect(adapter).not.toContain('public.links');
});

test('offline fixture aliases are ordinary-only, source scoped and outside protected inventory', () => {
  const fixture = readFileSync(import.meta.path, 'utf8').split(/\n  beforeAll\(async \(\) => \{/)[1].split(/\n  afterAll\(async \(\) => \{/)[0];
  const ordinary = fixture.split('if (role === roles.ordinary)')[1].split('if (role === roles.adapter)')[0];
  expect(ordinary).toContain('GRANT SELECT,INSERT,DELETE ON public.page_aliases TO ${role}');
  expect(ordinary).toContain("pg_get_serial_sequence('public.page_aliases','id')");
  expect(ordinary).toContain('GRANT USAGE ON SEQUENCE ${aliasSequence.name} TO ${role}');
  expect(fixture).toContain("['page_aliases', `source_id='${source}'`, roles.ordinary, 'ALL']");
  expect(fixture.split('if (role === roles.adapter)')[1]).not.toContain('public.page_aliases');
  expect(fixture.split('if (role === roles.enrollment)')[1]).not.toContain('GRANT SELECT,INSERT,DELETE ON public.page_aliases');
  const probes = pageFileSqlAuthorityQueries({ ...expectation(roles.ordinary), catalogPins: {} });
  expect(probes.filter(p => p.catalog)).toHaveLength(12);
  expect(probes.some(p => p.id.includes('page_aliases'))).toBe(false);
});

suite('SQL authority — real PostgreSQL with external fixture pins', () => {
  beforeAll(async () => {
    pinDirectory = process.env.PAGE_FILE_SQL_EVIDENCE_DIR || mkdtempSync(join(tmpdir(), 'sql-authority-'));
    mkdirSync(pinDirectory, { recursive: true }); pinFile = join(pinDirectory, `fixture-catalog-${suffix}.json`);
    admin = new PostgresEngine();
    await admin.connect({ database_url: url!, poolSize: 1 });
    await admin.executeRaw("SET statement_timeout='15s'");
    await admin.executeRaw("SET lock_timeout='10s'");
    if (process.env.REQUIRE_PAGE_FILE_FRESH_CATALOG_POSTGRES === '1') {
      // Fail on any prior application bootstrap; never warm the DB before pins.
      const [relations] = await admin.executeRaw<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'`);
      expect(relations.count).toBe(0);
      const [functions] = await admin.executeRaw<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN
          ('bump_page_generation_fn','bump_page_generation_clock_fn','update_chunk_search_vector')`);
      expect(functions.count).toBe(0);
      console.log('PG_SQL_AUTHORITY_FRESH: empty public catalog verified before first initSchema');
    }
    await admin.initSchema();

    for (const role of Object.values(roles)) {
      const password = randomUUID().replaceAll('-', '');
      await admin.executeRaw(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      createdRoles.push(role);
      await admin.executeRaw(`ALTER ROLE ${role} SET statement_timeout='15s'`);
      await admin.executeRaw(`ALTER ROLE ${role} SET lock_timeout='10s'`);
      await admin.executeRaw(`GRANT CONNECT ON DATABASE gbrain_test TO ${role}`);
      await admin.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await admin.executeRaw(`GRANT SELECT ON sources,pages,page_file_bindings,config TO ${role}`);
      if (role === roles.ordinary) {
        // Existing v110 alias projection: DELETE + INSERT, never private CAS.
        await admin.executeRaw(`GRANT SELECT,INSERT,DELETE ON public.page_aliases TO ${role}`);
        const [aliasSequence] = await admin.executeRaw<{ name: string }>("SELECT pg_get_serial_sequence('public.page_aliases','id') AS name");
        expect(aliasSequence.name).toBeString();
        await admin.executeRaw(`GRANT USAGE ON SEQUENCE ${aliasSequence.name} TO ${role}`);
        // Existing ordinary graph reconciliation, NOT adapter/page-CAS authority.
        await admin.executeRaw(`GRANT SELECT,INSERT,DELETE,UPDATE(context,origin_field) ON public.links TO ${role}`);
        const [linkSequence] = await admin.executeRaw<{ name: string }>("SELECT pg_get_serial_sequence('public.links','id') AS name");
        expect(linkSequence.name).toBeString();
        await admin.executeRaw(`GRANT USAGE ON SEQUENCE ${linkSequence.name} TO ${role}`);
        await admin.executeRaw(`GRANT SELECT,INSERT,UPDATE,DELETE ON sources,pages,config,tags,timeline_entries,content_chunks,page_versions,code_edges_chunk,code_edges_symbol TO ${role}`);
        await admin.executeRaw(`GRANT USAGE ON SEQUENCE page_generation_clock_seq TO ${role}`);
        for (const table of ['pages','tags','content_chunks','page_versions','timeline_entries','code_edges_chunk','code_edges_symbol']) {
          const [sequence] = await admin.executeRaw<{ name: string }>("SELECT pg_get_serial_sequence($1,'id') AS name", ['public.' + table]);
          expect(sequence.name).toBeString();
          await admin.executeRaw(`GRANT USAGE,SELECT ON SEQUENCE ${sequence.name} TO ${role}`);
        }
      }
      if (role === roles.adapter) {
        for (const grant of [
          'UPDATE ON pages', 'USAGE ON SEQUENCE page_generation_clock_seq',
          'SELECT ON tags,timeline_entries,code_edges_chunk,code_edges_symbol', 'INSERT ON tags',
          'SELECT,INSERT,UPDATE,DELETE ON content_chunks', 'SELECT,INSERT ON page_versions',
          'UPDATE(pending_op_id,indexed_raw_sha256,file_generation) ON page_file_bindings',
          'SELECT,INSERT,UPDATE ON page_file_operations', 'SELECT,INSERT,DELETE ON page_file_write_authorizations',
          'UPDATE(id) ON sources',
        ]) await admin.executeRaw(`GRANT ${grant} TO ${role}`);
        for (const table of ['content_chunks', 'page_versions', 'timeline_entries']) {
          const [sequence] = await admin.executeRaw<{ name: string }>("SELECT pg_get_serial_sequence($1,'id') AS name", ['public.' + table]);
          expect(sequence.name).toBeString();
          await admin.executeRaw(`GRANT USAGE,SELECT ON SEQUENCE ${sequence.name} TO ${role}`);
        }
      }
      if (role === roles.adapter) {
        const [sequence] = await admin.executeRaw<{ name: string }>("SELECT pg_get_serial_sequence('public.tags','id') AS name");
        expect(sequence.name).toBeString();
        await admin.executeRaw(`GRANT USAGE ON SEQUENCE ${sequence.name} TO ${role}`);
      }
      if (role === roles.enrollment) {
        await admin.executeRaw(`GRANT UPDATE(id) ON sources,pages TO ${role}`);
        await admin.executeRaw(`GRANT INSERT ON page_file_bindings TO ${role}`);
        await admin.executeRaw(`GRANT SELECT ON tags TO ${role}`);
      }
      const login = new URL(url!); login.username = role; login.password = password; loginUrls.set(role, login.toString());
    }
    const all = Object.values(roles).join(','), ownPage = `page_id IN (SELECT id FROM public.pages WHERE source_id='${source}')`;
    const ownPages = `SELECT id FROM public.pages WHERE source_id='${source}'`;
    const ownLink = `from_page_id IN (${ownPages}) AND to_page_id IN (${ownPages}) AND (origin_page_id IS NULL OR origin_page_id IN (${ownPages}))`;
    const ownBinding = `binding_id IN (SELECT binding_id FROM public.page_file_bindings WHERE source_id='${source}')`;
    const policies: [string, string, string, string][] = [
      ['sources', `id='${source}'`, all, 'ALL'], ['pages', `source_id='${source}'`, all, 'ALL'],
      ['page_file_bindings', `source_id='${source}' AND ${ownPage}`, all, 'ALL'],
      ['tags', ownPage, roles.ordinary, 'ALL'],
      ['links', ownLink, roles.ordinary, 'ALL'],
      ['page_aliases', `source_id='${source}'`, roles.ordinary, 'ALL'],
      ...['content_chunks', 'page_versions', 'timeline_entries'].map(t => [t, ownPage, `${roles.ordinary},${roles.adapter}`, 'ALL'] as [string,string,string,string]),
      ['page_file_operations', ownBinding, roles.adapter, 'ALL'], ['page_file_write_authorizations', ownPage, roles.adapter, 'ALL'],
      ['config', "key='sync.repo_path'", all, 'ALL'],
      ['code_edges_chunk', 'from_chunk_id IN (SELECT id FROM public.content_chunks) OR to_chunk_id IN (SELECT id FROM public.content_chunks)', `${roles.ordinary},${roles.adapter}`, 'ALL'],
      ['code_edges_symbol', 'from_chunk_id IN (SELECT id FROM public.content_chunks)', `${roles.ordinary},${roles.adapter}`, 'ALL'],
    ];
    for (const [table, predicate, principal, command] of policies) {
      await admin.executeRaw(`CREATE POLICY ${policy} ON public.${table} FOR ${command} TO ${principal} USING (${predicate})${command === 'ALL' ? ` WITH CHECK (${predicate})` : ''}`);
      policyTables.push(table);
    }
    // Separate adapter INSERT WITH CHECK; no adapter UPDATE/DELETE policy.
    await admin.executeRaw(`CREATE POLICY ${policy}_tags_read ON public.tags FOR SELECT TO ${roles.adapter},${roles.enrollment} USING (${ownPage})`);
    await admin.executeRaw(`CREATE POLICY ${policy}_tags_add ON public.tags FOR INSERT TO ${roles.adapter} WITH CHECK (${ownPage})`);
    await captureFixturePins();
    for (const [role, login] of loginUrls) pools.set(role, postgres(login, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} }));
  }, 120_000);

  afterAll(async () => {
    try {
      await Promise.all([...pools.values()].map(pool => pool.end({ timeout: 5 })));
      await admin.executeRaw('DELETE FROM page_file_write_authorizations WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [source]);
      await admin.executeRaw('DELETE FROM page_file_operations WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1)', [source]);
      await admin.executeRaw('DELETE FROM page_file_bindings WHERE source_id=$1', [source]);
      await admin.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
      // page_aliases deliberately has no FK/cascade to sources/pages.
      await admin.executeRaw('DELETE FROM page_aliases WHERE source_id=$1', [source]);
      await admin.executeRaw(`DROP POLICY IF EXISTS ${policy}_tags_read ON public.tags`);
      await admin.executeRaw(`DROP POLICY IF EXISTS ${policy}_tags_add ON public.tags`);
      for (const table of policyTables) await admin.executeRaw(`DROP POLICY ${policy} ON public.${table}`);
      for (const role of createdRoles) { await admin.executeRaw(`DROP OWNED BY ${role}`); await admin.executeRaw(`DROP ROLE ${role}`); }
      if (admin) {
        expect(await admin.executeRaw('SELECT rolname FROM pg_roles WHERE rolname IN ($1,$2,$3)', Object.values(roles))).toEqual([]);
        expect(await admin.executeRaw('SELECT policyname FROM pg_policies WHERE policyname=$1', [policy])).toEqual([]);
      }
    } finally {
      if (admin) await admin.disconnect();
      if (pinDirectory && !process.env.PAGE_FILE_SQL_EVIDENCE_DIR) rmSync(pinDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  test('combined real PostgreSQL protected lifecycle and transaction lifetime', async () => {
    await allAccepted();
    const before = await admin.executeRaw("SELECT to_regclass('public.markdown_projection_policy')::text AS policy");
    if (before[0].policy) expect(await admin.executeRaw('SELECT * FROM public.markdown_projection_policy')).toEqual([]);
    await exerciseConnectedBootstrap({ admin, source, roles, loginUrls, pins });
    await allAccepted();
    expect(await admin.executeRaw("SELECT to_regclass('public.markdown_projection_policy')::text AS policy")).toEqual(before);
    if (before[0].policy) expect(await admin.executeRaw('SELECT * FROM public.markdown_projection_policy')).toEqual([]);
    console.log('CAS_COMBINED: Markdown remains unconfigured; protected lifecycle performs no projection activation or schema self-heal');
  }, 180_000);
});
