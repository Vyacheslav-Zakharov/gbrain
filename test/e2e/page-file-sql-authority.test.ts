import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { exerciseConnectedBootstrap } from './helpers/page-file-connected-bootstrap.ts';
import { pageFileSqlAuthorityQueries, verifyPageFileSqlAuthority, type PageFileSqlAuthorityExpectation } from '../../src/core/page-file-sql-authority.ts';

const url = process.env.DATABASE_URL;
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

suite('SQL authority — real PostgreSQL with external fixture pins', () => {
  beforeAll(async () => {
    pinDirectory = process.env.PAGE_FILE_SQL_EVIDENCE_DIR || mkdtempSync(join(tmpdir(), 'sql-authority-'));
    mkdirSync(pinDirectory, { recursive: true }); pinFile = join(pinDirectory, `fixture-catalog-${suffix}.json`);
    admin = new PostgresEngine();
    await admin.connect({ database_url: url!, poolSize: 1 });
    await admin.executeRaw("SET statement_timeout='15s'");
    await admin.executeRaw("SET lock_timeout='10s'");
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
          'SELECT ON tags,timeline_entries,code_edges_chunk,code_edges_symbol',
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
      if (role === roles.enrollment) {
        await admin.executeRaw(`GRANT UPDATE(id) ON sources,pages TO ${role}`);
        await admin.executeRaw(`GRANT INSERT ON page_file_bindings TO ${role}`);
        await admin.executeRaw(`GRANT SELECT ON tags TO ${role}`);
      }
      const login = new URL(url!); login.username = role; login.password = password; loginUrls.set(role, login.toString());
    }
    const all = Object.values(roles).join(','), ownPage = `page_id IN (SELECT id FROM public.pages WHERE source_id='${source}')`;
    const ownBinding = `binding_id IN (SELECT binding_id FROM public.page_file_bindings WHERE source_id='${source}')`;
    const policies: [string, string, string, string][] = [
      ['sources', `id='${source}'`, all, 'ALL'], ['pages', `source_id='${source}'`, all, 'ALL'],
      ['page_file_bindings', `source_id='${source}' AND ${ownPage}`, all, 'ALL'],
      ['tags', ownPage, all, 'ALL'],
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
