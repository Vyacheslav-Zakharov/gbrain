import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PageFileDatabase } from '../../src/core/page-file-db.ts';
import { PageFileSync, pageFileSyncHost } from '../../src/core/page-file-sync.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { rawDigest } from '../../src/core/page-file-journal.ts';

// Hosted disposable adapter acceptance, NOT production operation-handler activation.
// Offline page-file-runtime/db suites separately exercise the actual handlers.
// Never use setupDB, the production resolver, session authorization, or fake SQL.
const databaseUrl = process.env.DATABASE_URL;
const required = process.env.REQUIRE_PAGE_FILE_CAS_POSTGRES === '1';
if (required && !databaseUrl) throw new Error('REQUIRE_PAGE_FILE_CAS_POSTGRES=1 requires DATABASE_URL');
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/gbrain_test' || url.search || url.hash
    || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1') {
    throw new Error('Requires explicitly disposable localhost /gbrain_test without URL overrides');
  }
}
const suite = databaseUrl ? describe : describe.skip;
const id = randomUUID().replaceAll('-', '').slice(0, 12);
const source = `file-cas-${id}`;
const adapterRole = `file_adapter_${id}`;
const legacyRole = `file_legacy_${id}`;
const engines: PostgresEngine[] = [];
const createdRoles: string[] = [];
const policyName = `file_fixture_${id}`;
const policyTables: string[] = [];
let admin: PostgresEngine, a: PostgresEngine, b: PostgresEngine, legacy: PostgresEngine;
let directory: string, root: string;
let schemaReady = false;
const validate = () => {};
const fields = (raw: string, slug: string) => {
  const p = parseMarkdown(raw, slug + '.md');
  return { type: p.type, title: p.title, compiled_truth: p.compiled_truth,
    timeline: p.timeline, frontmatter: JSON.parse(JSON.stringify(p.frontmatter)) };
};
function host(slug: string) {
  return { brainId: `disposable-${id}`, journalDirectory: join(directory, 'journal'),
    ...pageFileSyncHost({ root, paths: [slug + '.md'], lockDirectory: join(directory, 'locks'),
      topology: 'single-host-local', timeoutMs: 5000 }) };
}
const db = (engine: BrainEngine, slug: string) => new PageFileDatabase(engine, host(slug));
async function connect(url: string) {
  const engine = new PostgresEngine(); engines.push(engine);
  await engine.connect({ database_url: url, poolSize: 1 });
  const [identity] = await engine.executeRaw<{ database: string; version: string }>(
    'SELECT current_database() AS database, version() AS version');
  expect(identity.database).toBe('gbrain_test'); expect(identity.version).toContain('PostgreSQL');
  await engine.executeRaw("SET statement_timeout='15s'");
  await engine.executeRaw("SET lock_timeout='10s'");
  await engine.executeRaw("SET idle_in_transaction_session_timeout='20s'");
  return engine;
}
async function seed(slug: string, raw = 'Before') {
  await a.putPage(slug, { ...fields(raw, slug), page_kind: 'markdown' }, { sourceId: source });
  await a.addTag(slug, 'overlay', { sourceId: source });
  await writeFile(join(root, slug + '.md'), raw);
  await db(a, slug).enroll(source, slug);
  return db(a, slug).get(source, slug, validate);
}
function request(before: Awaited<ReturnType<PageFileDatabase['get']>>, raw: string) {
  return { operation_id: randomUUID(), expected_revision: before.revision,
    file_baseline: before.file.baseline, raw_markdown: raw, page: fields(raw, before.slug) };
}
async function snapshot(slug: string) {
  const [page] = await b.executeRaw<{ id: number; row: string }>(
    'SELECT id,to_jsonb(p)::text AS row FROM pages p WHERE source_id=$1 AND slug=$2', [source, slug]);
  const state: Record<string, unknown> = { page: page.row };
  for (const table of ['tags', 'content_chunks', 'page_versions', 'timeline_entries']) {
    state[table] = await b.executeRaw(`SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id=$1 ORDER BY to_jsonb(t)::text`, [page.id]);
  }
  state.binding = await b.executeRaw('SELECT to_jsonb(t)::text AS row FROM page_file_bindings t WHERE source_id=$1 AND slug=$2', [source, slug]);
  state.operations = await b.executeRaw('SELECT to_jsonb(o)::text AS row FROM page_file_operations o JOIN page_file_bindings f USING(binding_id) WHERE f.source_id=$1 AND f.slug=$2 ORDER BY o.operation_id', [source, slug]);
  return state;
}
// Fault injection only wraps the real transaction boundary; all SQL and COMMIT /
// ROLLBACK are executed by PostgresEngine on its independent physical connection.
function failCommit(engine: PostgresEngine, hook: (tx: BrainEngine) => Promise<void>): BrainEngine {
  const wrapper = Object.create(engine) as BrainEngine;
  wrapper.transaction = <T>(fn: (tx: BrainEngine) => Promise<T>) => engine.transaction(async tx => {
    const result = await fn(tx); await hook(tx); return result;
  });
  return wrapper;
}

suite('file-backed CAS — real PostgreSQL + real temporary filesystem', () => {
  beforeAll(async () => {
    admin = await connect(databaseUrl!);
    await admin.initSchema(); // actual canonical migrated engine, no hand-built DDL
    for (const table of ['page_file_bindings', 'page_file_operations', 'page_file_write_authorizations']) {
      const [r] = await admin.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + table]);
      expect(r.present).toBe(true);
    }
    schemaReady = true;
    directory = await mkdtemp(join(tmpdir(), 'pg-file-cas-'));
    root = join(directory, 'source');
    await mkdir(root); await mkdir(join(directory, 'journal'), { mode: 0o700 });
    await admin.executeRaw("INSERT INTO sources(id,name,local_path,config,archived) VALUES($1,$1,$2,'{}'::jsonb,false)", [source, root]);
    const urls: string[] = [];
    for (const role of [adapterRole, legacyRole]) {
      const password = randomUUID().replaceAll('-', '');
      // Identifiers/password are generated here from fixed ASCII prefixes + hex.
      await admin.executeRaw(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      createdRoles.push(role);
      await admin.executeRaw(`GRANT CONNECT ON DATABASE gbrain_test TO ${role}`);
      await admin.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await admin.executeRaw(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await admin.executeRaw(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      if (role === legacyRole) await admin.executeRaw(`REVOKE ALL ON page_file_bindings,page_file_operations,page_file_write_authorizations FROM ${role}`);
      const url = new URL(databaseUrl!); url.username = role; url.password = password; urls.push(url.toString());
    }
    // Canonical PostgreSQL bootstrap deliberately enables RLS with no policies
    // (schema.sql): table GRANTs alone do not authorize these real logins.
    // Disposable fixture grants only, not a production role topology. Keep RLS
    // enabled and all canonical fences intact; authorize this run's source only.
    // All interpolated identifiers/literals below are fixed names or generated hex.
    const ownPage = `page_id IN (SELECT id FROM public.pages WHERE source_id='${source}')`;
    const ownBinding = `binding_id IN (SELECT binding_id FROM public.page_file_bindings WHERE source_id='${source}')`;
    const policies: [string, string, string, 'ALL' | 'SELECT'][] = [
      ['sources', `id='${source}'`, `${adapterRole},${legacyRole}`, 'ALL'],
      ['pages', `source_id='${source}'`, `${adapterRole},${legacyRole}`, 'ALL'],
      ...['tags', 'content_chunks', 'page_versions', 'timeline_entries'].map(table =>
        [table, ownPage, `${adapterRole},${legacyRole}`, 'ALL'] as [string, string, string, 'ALL']),
      ['page_file_bindings', `source_id='${source}' AND ${ownPage}`, adapterRole, 'ALL'],
      ['page_file_operations', ownBinding, adapterRole, 'ALL'],
      ['page_file_write_authorizations', ownPage, adapterRole, 'ALL'],
      ['config', "key='sync.repo_path'", adapterRole, 'SELECT'],
      // The checked store's code-edge exclusion must see fixture-linked edges,
      // including cross-source incoming edges; don't mask that safety query.
      ['code_edges_chunk', `from_chunk_id IN (SELECT id FROM public.content_chunks) OR to_chunk_id IN (SELECT id FROM public.content_chunks)`, adapterRole, 'SELECT'],
      ['code_edges_symbol', `from_chunk_id IN (SELECT id FROM public.content_chunks)`, adapterRole, 'SELECT'],
    ];
    for (const [table, predicate, roles, command] of policies) {
      await admin.executeRaw(`CREATE POLICY ${policyName} ON public.${table} FOR ${command} TO ${roles}
        USING (${predicate})${command === 'ALL' ? ` WITH CHECK (${predicate})` : ''}`);
      policyTables.push(table);
    }
    a = await connect(urls[0]); b = await connect(urls[0]); legacy = await connect(urls[1]);
    const pids = [];
    for (const [engine, role] of [[a, adapterRole], [b, adapterRole], [legacy, legacyRole]] as const) {
      const [r] = await engine.executeRaw<{ session: string; current: string; super: boolean; bypass: boolean; pid: number }>(
        'SELECT session_user AS session,current_user AS current,rolsuper AS super,rolbypassrls AS bypass,pg_backend_pid() AS pid FROM pg_roles WHERE rolname=current_user');
      expect(r).toMatchObject({ session: role, current: role, super: false, bypass: false }); pids.push(r.pid);
      await expect(engine.executeRaw(`SET ROLE ${role === legacyRole ? adapterRole : legacyRole}`)).rejects.toMatchObject({ code: '42501' });
      for (const table of policyTables) {
        const [rls] = await engine.executeRaw<{ active: boolean }>('SELECT row_security_active($1::regclass) AS active', ['public.' + table]);
        expect(rls.active).toBe(true); // catches ownership/bypass/RLS-disable shortcuts
      }
      expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).toEqual([{ id: source }]);
      expect(await engine.executeRaw("SELECT id FROM sources WHERE id='default'")).toEqual([]);
      await expect(engine.putPage(`rls-denied-${id}`, fields('Forbidden', 'denied'), { sourceId: 'default' }))
        .rejects.toMatchObject({ code: '42501' });
    }
    expect(await admin.executeRaw("SELECT id FROM sources WHERE id='default'")).toEqual([{ id: 'default' }]);
    expect(await admin.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', ['default', `rls-denied-${id}`])).toEqual([]);
    expect(new Set(pids).size).toBe(3);
    console.log('PG_FILE_CAS_IDENTITY: independent non-superuser adapter/legacy logins; migrated disposable gbrain_test');
  }, 120_000);

  afterAll(async () => {
    try {
      // Drop only random fixture rows, in FK/fence-safe order; never reset schema.
      if (schemaReady) {
        await admin.executeRaw('DELETE FROM page_file_write_authorizations WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [source]);
        await admin.executeRaw('DELETE FROM page_file_operations WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1)', [source]);
        await admin.executeRaw('DELETE FROM page_file_bindings WHERE source_id=$1', [source]);
        await admin.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
        expect(await admin.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).toEqual([]);
      }
    } finally {
      try {
        await Promise.all(engines.filter(e => e !== admin).map(e => e.disconnect()));
        for (const table of policyTables) await admin.executeRaw(`DROP POLICY ${policyName} ON public.${table}`);
        if (admin) expect(await admin.executeRaw('SELECT policyname FROM pg_policies WHERE schemaname=$1 AND policyname=$2', ['public', policyName])).toEqual([]);
        for (const role of createdRoles) {
          await admin.executeRaw(`DROP OWNED BY ${role}`);
          await admin.executeRaw(`DROP ROLE ${role}`);
        }
        if (admin) expect(await admin.executeRaw('SELECT rolname FROM pg_roles WHERE rolname IN ($1,$2)', [adapterRole,legacyRole])).toEqual([]);
      } finally {
        if (admin) await admin.disconnect();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test('same baseline race has exactly one durable winner; stale loser has no derivative or receipt writes', async () => {
    const slug = 'race'; const before = await seed(slug);
    const requests = [request(before, 'Writer A'), request(before, 'Writer B')];
    const results = await Promise.allSettled([db(a, slug).put(source,slug,requests[0],validate), db(b,slug).put(source,slug,requests[1],validate)]);
    const winners = results.flatMap((r,i) => r.status === 'fulfilled' && r.value.status === 'committed' ? [i] : []);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    const loser = results[1-winner];
    if (loser.status === 'fulfilled') expect(loser.value.status).toBe('conflict');
    else expect(String(loser.reason)).toContain('precondition_failed');
    const current = await db(b,slug).get(source,slug,validate);
    expect(current.file.raw_markdown).toBe(requests[winner].raw_markdown);
    expect(await readFile(join(root,slug+'.md'))).toEqual(Buffer.from(requests[winner].raw_markdown));
    expect(current.revision).not.toBe(before.revision);
    expect(current.file.baseline.generation).not.toBe(before.file.baseline.generation);
    expect(current.file.baseline.raw_sha256).toBe(rawDigest(Buffer.from(requests[winner].raw_markdown)));
    expect(await b.getTags(slug,{sourceId:source})).toEqual(['overlay']);
    const stable = await snapshot(slug);
    expect(stable.page_versions).toHaveLength(1); expect(stable.operations).toHaveLength(1);
    expect((await b.getChunks(slug,{sourceId:source})).map(c => c.chunk_text)).toEqual([requests[winner].raw_markdown]);
    expect((await db(a,slug).put(source,slug,requests[winner],validate)).status).toBe('committed');
    await expect(db(a,slug).put(source,slug,request(before,'Stale retry'),validate)).rejects.toThrow('precondition_failed');
    expect(await snapshot(slug)).toEqual(stable);
  }, 30_000);

  test('captured import baseline is stale after CAS; fresh sync preserves bytes and advances revision once', async () => {
    const slug = 'sync'; const before = await seed(slug);
    const sync = new PageFileSync(b,host(slug)); const stale = await sync.capture(source,slug);
    expect((await db(a,slug).put(source,slug,request(before,'Checked'),validate)).status).toBe('committed');
    const stable = await snapshot(slug);
    await expect(sync.commit(stale)).rejects.toMatchObject({code:'stale_file_baseline',acknowledgeable:false});
    expect(await snapshot(slug)).toEqual(stable);
    expect(await readFile(join(root,slug+'.md'),'utf8')).toBe('Checked');
    await writeFile(join(root,slug+'.md'),'Authored import');
    await expect(db(a,slug).get(source,slug,validate)).rejects.toThrow('sync_required');
    const authored = await sync.capture(source,slug);
    expect((await sync.commit(authored)).status).toBe('committed');
    const current = await db(a,slug).get(source,slug,validate);
    expect(current.page.compiled_truth).toBe('Authored import');
    expect(await readFile(join(root,slug+'.md'),'utf8')).toBe('Authored import');
    expect(await b.getTags(slug,{sourceId:source})).toEqual(['overlay']);
    expect((await sync.commit(await sync.capture(source,slug))).status).toBe('unchanged');
    expect((await db(a,slug).get(source,slug,validate)).revision).toBe(current.revision);
  }, 30_000);

  test('legacy login cannot forge capability, bypass trigger, mutate tags or retarget root', async () => {
    const slug = 'roles'; const before = await seed(slug); const stable = await snapshot(slug);
    await expect(legacy.executeRaw('INSERT INTO page_file_write_authorizations VALUES(txid_current(),1,$1,$2)', [randomUUID(),randomUUID()])).rejects.toMatchObject({code:'42501'});
    await expect(legacy.executeRaw('ALTER TABLE pages DISABLE TRIGGER ALL')).rejects.toMatchObject({code:'42501'});
    for (const action of [() => legacy.addTag(slug,'forged',{sourceId:source}),
      () => legacy.removeTag(slug,'overlay',{sourceId:source}),
      () => legacy.putPage(slug,fields('Bypass',slug),{sourceId:source}),
      () => legacy.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1',[source,join(directory,'retarget')])]) {
      await expect(action()).rejects.toThrow('file_page_fenced');
    }
    expect(await snapshot(slug)).toEqual(stable);
    expect((await db(a,slug).get(source,slug,validate)).revision).toBe(before.revision);
    expect(await readFile(join(root,slug+'.md'),'utf8')).toBe('Before');
  }, 30_000);

  test('post-rename DB failure rolls back projection, keeps pending evidence, and exact recovery commits once', async () => {
    const slug = 'rename-rollback'; const before = await seed(slug); const stable = await snapshot(slug);
    const approved = request(before,'Approved after');
    const failing = failCommit(a, async tx => {
      const [r] = await tx.executeRaw<{body:string}>('SELECT compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2',[source,slug]);
      if (r.body === 'Approved after') throw new Error('fixture commit rollback after rename');
    });
    expect((await db(failing,slug).put(source,slug,approved,validate)).status).toBe('pending_recovery');
    const pending = await snapshot(slug);
    for (const key of ['page','tags','content_chunks','page_versions','timeline_entries']) expect(pending[key]).toEqual(stable[key]);
    expect(await readFile(join(root,slug+'.md'),'utf8')).toBe('Approved after');
    await expect(db(b,slug).get(source,slug,validate)).rejects.toThrow('pending_recovery');
    const [operation] = await b.executeRaw<{state:string;pending:string}>('SELECT o.state,f.pending_op_id AS pending FROM page_file_operations o JOIN page_file_bindings f USING(binding_id) WHERE o.operation_id=$1',[approved.operation_id]);
    expect(operation).toEqual({state:'prepared',pending:approved.operation_id});
    expect(await b.executeRaw('SELECT * FROM page_file_write_authorizations')).toEqual([]);
    const recovered = await db(b,slug).recover(source,slug,{...approved,action:'resume-exact'},validate);
    expect(recovered.status).toBe('committed');
    const final = await snapshot(slug);
    expect(final.page_versions).toHaveLength(1); expect(final.operations).toHaveLength(1);
    expect((await db(a,slug).get(source,slug,validate)).page.compiled_truth).toBe('Approved after');
    expect((await db(b,slug).recover(source,slug,{...approved,action:'resume-exact'},validate)).status).toBe('committed');
    expect(await snapshot(slug)).toEqual(final);
  }, 30_000);

  test('real sync transaction rollback restores revision, derivatives, binding and receipts without changing authored file', async () => {
    const slug = 'rollback'; await seed(slug); const stable = await snapshot(slug);
    await writeFile(join(root,slug+'.md'),'Authored after');
    const injected = new Error('fixture rollback after real projection update');
    const failing = failCommit(a, async tx => {
      const [r] = await tx.executeRaw<{body:string}>('SELECT compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2',[source,slug]);
      if (r.body === 'Authored after') { expect(await snapshot(slug)).toEqual(stable); throw injected; }
    });
    const sync = new PageFileSync(failing,host(slug)); const baseline = await sync.capture(source,slug);
    await expect(sync.commit(baseline)).rejects.toBe(injected);
    expect(await snapshot(slug)).toEqual(stable);
    expect(await readFile(join(root,slug+'.md'),'utf8')).toBe('Authored after');
    expect(await b.executeRaw('SELECT * FROM page_file_write_authorizations')).toEqual([]);
    const retry = new PageFileSync(b,host(slug));
    expect((await retry.commit(await retry.capture(source,slug))).status).toBe('committed');
  }, 30_000);
});
