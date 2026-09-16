import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { exerciseTagRevisionFence } from '../helpers/page-file-tag-fence.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { exerciseConnectedBootstrap, exerciseConnectedSourceBootstrap } from './helpers/page-file-connected-bootstrap.ts';
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
const source = `sql-fixture-${suffix}`, policy = `sql_fixture_${suffix}`;
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

  test('ordinary, adapter and enrollment logins execute every SQL probe and accept original fixture pins', async () => {
    await allAccepted(); console.log('PG_SQL_AUTHORITY: all three actual logins accepted; every SQL probe executed');
  }, 60_000);
  (process.env.REQUIRE_PAGE_FILE_CONNECTED_POSTGRES === '1' ? test : test.skip)('actual connected engine loads protected fixed anchor and revalidates every borrow', async () => {
    await exerciseConnectedBootstrap({ admin, source, roles, loginUrls, pins });
    await allAccepted();
  }, 120_000);
  (process.env.REQUIRE_PAGE_FILE_PILOT_POSTGRES === '1' ? test : test.skip)('actual production-pilot admission binds explicit page approval and revocation on disposable PostgreSQL', async () => {
    await exerciseConnectedBootstrap({ admin, source, roles, loginUrls, pins, mode: 'production-pilot' });
    await allAccepted();
  }, 120_000);
  (process.env.REQUIRE_PAGE_FILE_PILOT_POSTGRES === '1' ? test : test.skip)('actual production-source v2 executable enrollment preserves ordinary writer compatibility on disposable PostgreSQL', async () => {
    await exerciseConnectedSourceBootstrap({ admin, source, roles, loginUrls, pins });
    await allAccepted();
  }, 120_000);
  test('mixed writer executes legacy DML but enrolled authored state and authority stay fenced', async () => {
    const ordinary = pools.get(roles.ordinary)!;
    await ordinary.unsafe('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, `/fixture/${suffix}`]);
    const [protectedPage] = await ordinary.unsafe("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,'protected','note','Protected','Before') RETURNING id", [source]);
    const [legacy] = await ordinary.unsafe("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,'legacy','note','Legacy','Before') RETURNING id", [source]);
    await ordinary.unsafe("INSERT INTO content_chunks(page_id,chunk_index,chunk_text) VALUES($1,0,'Before')", [protectedPage.id]);
    // Operator acceptance uses a separate actual login, never a worker credential.
    await pools.get(roles.enrollment)!.unsafe(`INSERT INTO page_file_bindings(source_id,slug,page_id,binding_key,canonical_root,relative_path,indexed_raw_sha256)
      VALUES($1,'protected',$2,'fixture',$3,'protected.md',$4)`, [source, protectedPage.id, `/fixture/${suffix}`, 'a'.repeat(64)]);
    await allAccepted();
    const snapshot = async () => {
      const rows: unknown[] = [];
      for (const table of ['sources','pages','page_file_bindings','content_chunks']) {
        const predicate = table === 'sources' ? 'id=$1' : table === 'content_chunks'
          ? 'page_id IN (SELECT id FROM pages WHERE source_id=$1)' : 'source_id=$1';
        rows.push(await admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE ${predicate} ORDER BY to_jsonb(t)::text`, [source]));
      }
      rows.push(await admin.executeRaw("SELECT to_jsonb(t)::text AS row FROM config t WHERE key='sync.repo_path'"));
      return rows;
    };
    // Existing writes remain real writes, including sequence-backed INSERTs.
    await ordinary.unsafe("UPDATE pages SET compiled_truth='After' WHERE id=$1", [legacy.id]);
    expect((await ordinary.unsafe('SELECT compiled_truth FROM pages WHERE id=$1', [legacy.id]))[0].compiled_truth).toBe('After');
    await ordinary.unsafe("INSERT INTO content_chunks(page_id,chunk_index,chunk_text) VALUES($1,0,'Legacy')", [legacy.id]);
    await ordinary.unsafe("UPDATE content_chunks SET chunk_text='Updated' WHERE page_id=$1", [legacy.id]);
    await ordinary.unsafe('DELETE FROM content_chunks WHERE page_id=$1', [legacy.id]);
    await ordinary.unsafe("INSERT INTO tags(page_id,tag) VALUES($1,'legacy-tag')", [legacy.id]);
    await ordinary.unsafe("UPDATE tags SET tag='updated-tag' WHERE page_id=$1", [legacy.id]);
    await ordinary.unsafe('DELETE FROM tags WHERE page_id=$1', [legacy.id]);
    expect(await ordinary.unsafe("SELECT id FROM sources WHERE id='default'")).toHaveLength(0);
    await ordinary.unsafe('DELETE FROM pages WHERE id=$1', [legacy.id]);
    expect(await ordinary.unsafe('SELECT id FROM pages WHERE id=$1', [legacy.id])).toHaveLength(0);
    if (process.env.REQUIRE_PAGE_FILE_UPGRADE_REPLAY_POSTGRES === '1') {
      const { exerciseAlreadyV142Replay } = await import('./helpers/page-file-upgrade-replay.ts');
      await exerciseAlreadyV142Replay({ admin, source, allAccepted });
    }
    const before = await snapshot();
    // postgres.js Query is a lazy Promise subclass. Bun's rejects matcher can
    // observe it without invoking .then(), so explicitly start every denied
    // statement; otherwise the matcher waits forever on an unexecuted query.
    for (const sql of [
      "UPDATE pages SET compiled_truth='Forbidden' WHERE id=$1",
      "UPDATE pages SET slug='moved' WHERE id=$1",
      "UPDATE pages SET source_path='moved.md' WHERE id=$1",
      'UPDATE pages SET deleted_at=now() WHERE id=$1',
      'DELETE FROM pages WHERE id=$1',
      "INSERT INTO content_chunks(page_id,chunk_index,chunk_text) VALUES($1,1,'Forbidden')",
      "UPDATE content_chunks SET chunk_text='Forbidden' WHERE page_id=$1",
      'DELETE FROM content_chunks WHERE page_id=$1',
    ]) {
      await expect(ordinary.unsafe(sql, [protectedPage.id]).execute()).rejects.toMatchObject({ code: 'P0001' });
      expect(await snapshot()).toEqual(before);
    }
    for (const sql of ["UPDATE sources SET local_path='/forbidden' WHERE id=$1", 'DELETE FROM sources WHERE id=$1']) {
      await expect(ordinary.unsafe(sql, [source]).execute()).rejects.toMatchObject({ code: 'P0001' });
      expect(await snapshot()).toEqual(before);
    }
    await expect(ordinary.unsafe("INSERT INTO config(key,value) VALUES('sync.repo_path','\"/forbidden\"') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value").execute()).rejects.toMatchObject({ code: 'P0001' });
    for (const sql of [
      'UPDATE page_file_bindings SET file_generation=file_generation+1',
      'DELETE FROM page_file_bindings',
      'INSERT INTO page_file_bindings(source_id) VALUES(NULL)',
      'INSERT INTO page_file_operations(operation_id) VALUES(NULL)',
      'INSERT INTO page_file_write_authorizations(transaction_id) VALUES(1)',
      'TRUNCATE pages', `SET ROLE ${roles.adapter}`, `SET ROLE ${roles.enrollment}`,
      'ALTER TABLE pages DISABLE TRIGGER aa_file_page_write_fence',
    ]) await expect(ordinary.unsafe(sql).execute()).rejects.toMatchObject({ code: '42501' });
    expect(await snapshot()).toEqual(before);
    await allAccepted();
    console.log('PG_SQL_AUTHORITY: mixed ordinary DML accepted; enrolled page chunk root and capability fences preserved');
  }, 60_000);
  test('ordinary ingest graph uses actual login; endpoint/origin RLS and private-role denials preserve state', async () => {
    const { projectContentImportCodeRefs } = await import('../../src/core/import-file.ts');
    const { slugifyCodePath } = await import('../../src/core/sync.ts');
    const ordinary = pools.get(roles.ordinary)!;
    const engine = new PostgresEngine();
    const foreignSource = source + '-graph-foreign';
    const guideSlug = 'graph-guide', codeSlug = slugifyCodePath('src/fixture.ts');
    const scope = { fromSourceId: source, toSourceId: source, originSourceId: source };
    const snapshot = async () => {
      const rows: unknown[] = [];
      // Includes authored/private authority state: graph work must not mutate it.
      for (const table of ['links', 'pages', 'tags', 'content_chunks', 'page_file_bindings', 'page_file_operations', 'page_file_write_authorizations']) {
        rows.push(await admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`));
      }
      return rows;
    };
    try {
      await engine.connect({ database_url: loginUrls.get(roles.ordinary)!, poolSize: 1 });
      const [identity] = await engine.executeRaw('SELECT session_user,current_user');
      expect(identity).toEqual({ session_user: roles.ordinary, current_user: roles.ordinary });
      const own = await ordinary.unsafe("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,$2,'note','Guide','Before'),($1,$3,'code','Code','Before') RETURNING id,slug", [source, guideSlug, codeSlug]);
      const guide = own.find(p => p.slug === guideSlug)!, code = own.find(p => p.slug === codeSlug)!;
      await admin.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [foreignSource]);
      // Same slugs in another source expose accidental bare-slug fan-out.
      const foreign = await admin.executeRaw<{ id: number; slug: string }>("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,$2,'note','Foreign','Before'),($1,$3,'code','Foreign code','Before') RETURNING id,slug", [foreignSource, guideSlug, codeSlug]);
      const foreignGuide = foreign.find(p => p.slug === guideSlug)!;
      const [sequence] = await admin.executeRaw<{ name: string }>("SELECT pg_get_serial_sequence('public.links','id') AS name");
      for (const role of Object.values(roles)) {
        const [rights] = await pools.get(role)!.unsafe<Record<string, boolean>[]>(`SELECT has_table_privilege(current_user,'public.links','SELECT') AS read,
          has_table_privilege(current_user,'public.links','INSERT') AS add,
          has_table_privilege(current_user,'public.links','DELETE') AS remove,
          has_table_privilege(current_user,'public.links','UPDATE') AS wide_update,
          has_column_privilege(current_user,'public.links','context','UPDATE') AS context_update,
          has_column_privilege(current_user,'public.links','origin_field','UPDATE') AS field_update,
          has_sequence_privilege(current_user,$1,'USAGE') AS sequence_usage,
          has_sequence_privilege(current_user,$1,'SELECT') AS sequence_read,
          has_sequence_privilege(current_user,$1,'UPDATE') AS sequence_update,
          row_security_active('public.links') AS rls`, [sequence.name]);
        const allowed = role === roles.ordinary;
        expect({ ...rights }).toEqual({ read: allowed, add: allowed, remove: allowed, wide_update: false,
          context_update: allowed, field_update: allowed, sequence_usage: allowed, sequence_read: false, sequence_update: false, rls: true });
      }
      const authoredBefore = (await snapshot()).slice(1);
      // Real ingestion projection calls real PostgresEngine.addLink, not a mock.
      // Its best-effort catches must not hide privilege failures: assert both rows.
      await projectContentImportCodeRefs(engine, guideSlug, source, { compiled_truth: 'See src/fixture.ts:42', timeline: '' });
      type GraphRow = { from_page_id: number; to_page_id: number; origin_page_id: number; link_type: string };
      const links = await ordinary.unsafe<GraphRow[]>('SELECT from_page_id,to_page_id,origin_page_id,link_type FROM links WHERE origin_page_id=$1 ORDER BY link_type', [guide.id]);
      expect([...links]).toEqual([
        { from_page_id: code.id, to_page_id: guide.id, origin_page_id: guide.id, link_type: 'documented_by' },
        { from_page_id: guide.id, to_page_id: code.id, origin_page_id: guide.id, link_type: 'documents' },
      ]);
      expect(await admin.executeRaw<GraphRow>(`SELECT from_page_id,to_page_id,origin_page_id,link_type FROM links
        WHERE from_page_id IN (SELECT id FROM pages WHERE source_id IN ($1,$2)) ORDER BY link_type`, [source, foreignSource])).toEqual([...links]);
      await engine.addLink(guideSlug, codeSlug, 'Updated', 'documents', 'markdown', guideSlug, 'timeline', scope);
      expect([...await ordinary.unsafe<{ context: string; origin_field: string }[]>("SELECT context,origin_field FROM links WHERE from_page_id=$1 AND link_type='documents'", [guide.id])]).toEqual([{ context: 'Updated', origin_field: 'timeline' }]);
      // Null origin remains valid for existing manual/markdown callers.
      await engine.addLink(guideSlug, codeSlug, 'Manual', 'mentions', 'manual', undefined, undefined, scope);
      expect(await ordinary.unsafe('SELECT id FROM links WHERE from_page_id=$1 AND origin_page_id IS NULL', [guide.id])).toHaveLength(1);
      expect((await snapshot()).slice(1)).toEqual(authoredBefore);
      const before = await snapshot();
      for (const ids of [[foreignGuide.id, code.id, guide.id], [guide.id, foreignGuide.id, guide.id], [guide.id, code.id, foreignGuide.id]]) {
        await expect(ordinary.unsafe("INSERT INTO links(from_page_id,to_page_id,origin_page_id,link_type,link_source) VALUES($1,$2,$3,'denied','manual')", ids).execute()).rejects.toMatchObject({ code: '42501' });
        expect(await snapshot()).toEqual(before);
      }
      await expect(engine.addLink(guideSlug, codeSlug, 'Denied', 'documents', 'markdown', guideSlug, 'compiled_truth', { ...scope, toSourceId: foreignSource })).rejects.toThrow('not found');
      expect(await snapshot()).toEqual(before);
      for (const column of ['from_page_id', 'to_page_id', 'origin_page_id', 'link_type', 'link_source', 'id', 'link_kind', 'resolution_type', 'created_at']) {
        await expect(ordinary.unsafe(`UPDATE links SET ${column}=${column} WHERE from_page_id=$1`, [guide.id]).execute()).rejects.toMatchObject({ code: '42501' });
        expect(await snapshot()).toEqual(before);
      }
      for (const role of [roles.adapter, roles.enrollment]) {
        for (const sql of ['SELECT * FROM links', "INSERT INTO links(from_page_id,to_page_id) SELECT id,id FROM pages LIMIT 1", "UPDATE links SET context='Denied'", 'DELETE FROM links']) {
          await expect(pools.get(role)!.unsafe(sql).execute()).rejects.toMatchObject({ code: '42501' });
          expect(await snapshot()).toEqual(before);
        }
      }
      // Owner seeds each distinct foreign boundary; RLS hides it for SELECT,
      // UPDATE and DELETE even when the endpoint IDs are already known.
      for (const ids of [[foreignGuide.id, code.id, guide.id], [guide.id, foreignGuide.id, guide.id], [guide.id, code.id, foreignGuide.id]]) {
        const [hidden] = await admin.executeRaw<{ id: number }>("INSERT INTO links(from_page_id,to_page_id,origin_page_id,link_type,link_source) VALUES($1,$2,$3,'hidden','manual') RETURNING id", ids);
        const hiddenBefore = await snapshot();
        expect(await ordinary.unsafe('SELECT id FROM links WHERE id=$1', [hidden.id])).toHaveLength(0);
        expect(await ordinary.unsafe("UPDATE links SET context='Denied',origin_field='Denied' WHERE id=$1 RETURNING id", [hidden.id])).toHaveLength(0);
        expect(await snapshot()).toEqual(hiddenBefore);
        expect(await ordinary.unsafe('DELETE FROM links WHERE id=$1 RETURNING id', [hidden.id])).toHaveLength(0);
        expect(await snapshot()).toEqual(hiddenBefore);
        await admin.executeRaw('DELETE FROM links WHERE id=$1', [hidden.id]);
      }
      expect(await ordinary.unsafe('DELETE FROM links WHERE from_page_id IN ($1,$2) RETURNING id', [guide.id, code.id])).toHaveLength(3);
      expect(await ordinary.unsafe('SELECT id FROM links WHERE from_page_id IN ($1,$2)', [guide.id, code.id])).toHaveLength(0);
      expect((await snapshot()).slice(1)).toEqual(authoredBefore);
      await allAccepted();
      console.log('PG_SQL_AUTHORITY: ordinary ingest addLink/upsert/delete; exact graph grants; endpoint/origin and private-role denials preserve state');
    } finally {
      await engine.disconnect();
      await admin.executeRaw('DELETE FROM sources WHERE id=$1', [foreignSource]);
      await ordinary.unsafe('DELETE FROM pages WHERE source_id=$1 AND slug IN ($2,$3)', [source, guideSlug, codeSlug]);
    }
  }, 60_000);
  test('ordinary alias projection replaces and clears; cross-source and private-role denials preserve rows', async () => {
    const engine = new PostgresEngine();
    const ordinary = pools.get(roles.ordinary)!;
    const slug = 'alias-fixture', foreignSource = source + '-alias-foreign';
    const snapshot = () => admin.executeRaw('SELECT * FROM page_aliases WHERE source_id IN ($1,$2) ORDER BY id', [source, foreignSource]);
    try {
      await engine.connect({ database_url: loginUrls.get(roles.ordinary)!, poolSize: 1 });
      const [sequence] = await admin.executeRaw<{ name: string }>("SELECT pg_get_serial_sequence('public.page_aliases','id') AS name");
      for (const role of Object.values(roles)) {
        const [rights] = await pools.get(role)!.unsafe<Record<string, boolean>[]>(`SELECT
          has_table_privilege(current_user,'public.page_aliases','SELECT') AS read,
          has_table_privilege(current_user,'public.page_aliases','INSERT') AS add,
          has_table_privilege(current_user,'public.page_aliases','DELETE') AS remove,
          has_table_privilege(current_user,'public.page_aliases','UPDATE') AS update,
          has_table_privilege(current_user,'public.page_aliases','TRUNCATE') AS truncate,
          has_table_privilege(current_user,'public.page_aliases','REFERENCES') AS reference,
          has_table_privilege(current_user,'public.page_aliases','TRIGGER') AS trigger,
          has_sequence_privilege(current_user,$1,'USAGE') AS sequence_usage,
          has_sequence_privilege(current_user,$1,'SELECT') AS sequence_read,
          has_sequence_privilege(current_user,$1,'UPDATE') AS sequence_update,
          row_security_active('public.page_aliases') AS rls`, [sequence.name]);
        const allowed = role === roles.ordinary;
        expect({ ...rights }).toEqual({ read: allowed, add: allowed, remove: allowed, update: false,
          truncate: false, reference: false, trigger: false, sequence_usage: allowed,
          sequence_read: false, sequence_update: false, rls: true });
        // No column UPDATE/REFERENCES back door or grant options.
        expect([...await pools.get(role)!.unsafe(`SELECT attname FROM pg_attribute
          WHERE attrelid='public.page_aliases'::regclass AND attnum>0 AND NOT attisdropped AND (
          has_column_privilege(current_user,attrelid,attnum,'UPDATE') OR
          has_column_privilege(current_user,attrelid,attnum,'REFERENCES') OR
          has_column_privilege(current_user,attrelid,attnum,'SELECT WITH GRANT OPTION') OR
          has_column_privilege(current_user,attrelid,attnum,'INSERT WITH GRANT OPTION'))`)]).toEqual([]);
      }
      await engine.setPageAliases(slug, source, ['first', 'first']);
      expect([...await ordinary.unsafe<{ alias_norm: string }[]>('SELECT alias_norm FROM page_aliases WHERE source_id=$1 AND slug=$2', [source, slug])]).toEqual([{ alias_norm: 'first' }]);
      await engine.setPageAliases(slug, source, ['replacement']);
      expect([...await ordinary.unsafe<{ alias_norm: string }[]>('SELECT alias_norm FROM page_aliases WHERE source_id=$1 AND slug=$2', [source, slug])]).toEqual([{ alias_norm: 'replacement' }]);
      // No FK is required by the existing alias table; use the same slug in a
      // foreign source to prove the source policy rather than a FK rejection.
      await admin.executeRaw('INSERT INTO page_aliases(source_id,alias_norm,slug) VALUES($1,$2,$3)', [foreignSource, 'hidden', slug]);
      const before = await snapshot();
      expect([...await ordinary.unsafe('SELECT * FROM page_aliases WHERE source_id=$1', [foreignSource])]).toEqual([]);
      expect([...await ordinary.unsafe('DELETE FROM page_aliases WHERE source_id=$1 RETURNING id', [foreignSource])]).toEqual([]);
      await expect(engine.setPageAliases(slug, foreignSource, ['denied'])).rejects.toMatchObject({ code: '42501' });
      await expect(ordinary.unsafe('UPDATE page_aliases SET alias_norm=alias_norm').execute()).rejects.toMatchObject({ code: '42501' });
      expect(await snapshot()).toEqual(before);
      for (const role of [roles.adapter, roles.enrollment]) {
        for (const sql of ['SELECT * FROM page_aliases', "INSERT INTO page_aliases(source_id,alias_norm,slug) VALUES($1,'denied','alias-fixture')",
          'UPDATE page_aliases SET alias_norm=alias_norm', 'DELETE FROM page_aliases']) {
          await expect(pools.get(role)!.unsafe(sql, sql.includes('$1') ? [source] : []).execute()).rejects.toMatchObject({ code: '42501' });
          expect(await snapshot()).toEqual(before);
        }
      }
      await engine.setPageAliases(slug, source, []);
      expect([...await ordinary.unsafe('SELECT * FROM page_aliases WHERE source_id=$1 AND slug=$2', [source, slug])]).toEqual([]);
      expect((await snapshot()).filter(row => row.source_id === foreignSource)).toEqual(before.filter(row => row.source_id === foreignSource));
      await allAccepted(); // original protected pins, never refreshed for aliases
      console.log('PG_SQL_AUTHORITY: ordinary alias replace/clear; exact grants; source RLS and private-role denials preserve rows');
    } finally {
      await engine.disconnect();
      await admin.executeRaw('DELETE FROM page_aliases WHERE source_id IN ($1,$2) AND slug=$3', [source, foreignSource, slug]);
    }
  });

  test('candidate adapter add-only tags retain RLS, exact grants and per-statement revision fence', async () => {
    const adapter = pools.get(roles.adapter)!;
    const [page] = await adapter.unsafe("SELECT id FROM pages WHERE source_id=$1 AND slug='protected'", [source]);
    expect(page).toBeDefined();
    const before = await admin.executeRaw('SELECT to_jsonb(p)::text AS row FROM pages p WHERE id=$1', [page.id]);
    const session = await adapter.reserve();
    try {
      await session.unsafe('BEGIN');
      await exerciseTagRevisionFence(async (sql, params = []) => [...await session.unsafe(sql, params)], page.id);
    } finally { try { await session.unsafe('ROLLBACK'); } finally { session.release(); } }
    expect(await admin.executeRaw('SELECT to_jsonb(p)::text AS row FROM pages p WHERE id=$1', [page.id])).toEqual(before);
    expect(await adapter.unsafe('SELECT tag FROM tags WHERE page_id=$1', [page.id])).toHaveLength(0);
    expect(await adapter.unsafe('SELECT * FROM page_file_write_authorizations WHERE page_id=$1', [page.id])).toHaveLength(0);
    for (const sql of ["UPDATE tags SET tag='denied' WHERE page_id=$1", 'DELETE FROM tags WHERE page_id=$1']) {
      await expect(adapter.unsafe(sql, [page.id]).execute()).rejects.toMatchObject({ code: '42501' });
    }
    await expect(pools.get(roles.ordinary)!.unsafe("INSERT INTO tags(page_id,tag) VALUES($1,'ordinary-denied')", [page.id]).execute()).rejects.toMatchObject({ code: 'P0001' });
    const foreignSource = source + '-foreign';
    try {
      await admin.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [foreignSource]);
      const [foreign] = await admin.executeRaw<{ id: number }>("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,'foreign','note','Foreign','Before') RETURNING id", [foreignSource]);
      const foreignBefore = await admin.executeRaw('SELECT to_jsonb(p)::text AS row FROM pages p WHERE id=$1', [foreign.id]);
      expect(await adapter.unsafe('SELECT id FROM pages WHERE id=$1', [foreign.id])).toHaveLength(0);
      await expect(adapter.unsafe("INSERT INTO tags(page_id,tag) VALUES($1,'cross-source-denied')", [foreign.id]).execute()).rejects.toMatchObject({ code: '42501' });
      expect(await admin.executeRaw('SELECT tag FROM tags WHERE page_id=$1', [foreign.id])).toEqual([]);
      expect(await admin.executeRaw('SELECT to_jsonb(p)::text AS row FROM pages p WHERE id=$1', [foreign.id])).toEqual(foreignBefore);
    } finally { await admin.executeRaw('DELETE FROM sources WHERE id=$1', [foreignSource]); }
    await allAccepted();
    console.log('PG_SQL_AUTHORITY: candidate add-only tags; missing/stale/conflict token, UPDATE/DELETE denial and cross-source RLS verified');
  }, 60_000);
  test('candidate tag privilege and INSERT policy drift fail closed against frozen pins', async () => {
    const [sequence] = await admin.executeRaw<{ name: string }>("SELECT pg_get_serial_sequence('public.tags','id') AS name");
    await drift(`REVOKE INSERT ON tags FROM ${roles.adapter}`, `GRANT INSERT ON tags TO ${roles.adapter}`, roles.adapter);
    await drift(`REVOKE USAGE ON SEQUENCE ${sequence.name} FROM ${roles.adapter}`, `GRANT USAGE ON SEQUENCE ${sequence.name} TO ${roles.adapter}`, roles.adapter);
    for (const privilege of ['UPDATE', 'DELETE']) await drift(`GRANT ${privilege} ON tags TO ${roles.adapter}`, `REVOKE ${privilege} ON tags FROM ${roles.adapter}`, roles.adapter);
    for (const privilege of ['SELECT', 'UPDATE']) await drift(`GRANT ${privilege} ON SEQUENCE ${sequence.name} TO ${roles.adapter}`, `REVOKE ${privilege} ON SEQUENCE ${sequence.name} FROM ${roles.adapter}`, roles.adapter);
    await drift(`ALTER POLICY ${policy}_tags_add ON tags WITH CHECK (true)`, `ALTER POLICY ${policy}_tags_add ON tags WITH CHECK (page_id IN (SELECT id FROM public.pages WHERE source_id='${source}'))`, roles.adapter);
    await drift('ALTER TABLE tags DISABLE TRIGGER tag_page_write_revision_trg', 'ALTER TABLE tags ENABLE TRIGGER tag_page_write_revision_trg', roles.adapter);
  }, 120_000);
  test('wrong actual login fails closed without changing pins', async () => {
    expect(await verify(roles.ordinary, roles.adapter)).toEqual(denied);
    await allAccepted(); console.log('PG_SQL_AUTHORITY: wrong login rejected and baseline preserved');
  }, 60_000);
  test('NOINHERIT membership is rejected and revoked', async () => {
    await drift(`GRANT ${roles.adapter} TO ${roles.ordinary}`, `REVOKE ${roles.adapter} FROM ${roles.ordinary}`, roles.ordinary);
    console.log('PG_SQL_AUTHORITY: membership drift rejected and restored');
  }, 60_000);
  test('direct table, column and grant-option widening are rejected and revoked', async () => {
    await drift(`GRANT INSERT ON page_file_write_authorizations TO ${roles.ordinary}`, `REVOKE INSERT ON page_file_write_authorizations FROM ${roles.ordinary}`, roles.ordinary);
    await drift('GRANT INSERT ON page_file_bindings TO PUBLIC', 'REVOKE INSERT ON page_file_bindings FROM PUBLIC', roles.ordinary);
    await drift(`GRANT UPDATE(canonical_root) ON page_file_bindings TO ${roles.adapter}`, `REVOKE UPDATE(canonical_root) ON page_file_bindings FROM ${roles.adapter}`, roles.adapter);
    await drift(`GRANT SELECT ON pages TO ${roles.enrollment} WITH GRANT OPTION`, `REVOKE GRANT OPTION FOR SELECT ON pages FROM ${roles.enrollment}`, roles.enrollment);
    console.log('PG_SQL_AUTHORITY: table column grant-option drift rejected and restored');
  }, 60_000);
  test('disabled trigger and enabled trigger definition drift reject frozen external pins', async () => {
    await drift('ALTER TABLE public.pages DISABLE TRIGGER aa_file_page_write_fence', 'ALTER TABLE public.pages ENABLE TRIGGER aa_file_page_write_fence', roles.adapter);
    // ALWAYS remains enabled and satisfies the named-trigger structural check;
    // only comparison with the externally frozen catalog definition rejects it.
    await drift('ALTER TABLE public.pages ENABLE ALWAYS TRIGGER aa_file_page_write_fence', 'ALTER TABLE public.pages ENABLE TRIGGER aa_file_page_write_fence', roles.adapter);
    console.log('PG_SQL_AUTHORITY: disabled and enabled trigger drift rejected and restored');
  }, 60_000);
});
