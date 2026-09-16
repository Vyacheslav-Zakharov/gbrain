import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { PageFileDatabase } from '../../src/core/page-file-db.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { createPageFileRuntimeCandidate } from '../../src/core/page-file-runtime.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { PageFileHostManifestOptions } from '../../src/core/page-file-host.ts';

// Same disposable DB/source-scoped RLS contracts as page-file-cas.test.ts.
// Actual postgres transport and registered handlers: no mock.module, setupDB,
// shared singleton pool, SET SESSION AUTHORIZATION, or production admission.
const databaseUrl = process.env.DATABASE_URL;
const required = process.env.REQUIRE_PAGE_FILE_RUNTIME_AUTHORITY_POSTGRES === '1';
if (required && !databaseUrl) throw new Error('REQUIRE_PAGE_FILE_RUNTIME_AUTHORITY_POSTGRES=1 requires DATABASE_URL');
if (databaseUrl) {
  const u = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(u.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    || u.pathname !== '/gbrain_test' || u.search || u.hash
    || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1'
    || process.env.GBRAIN_DIRECT_DATABASE_URL) {
    throw new Error('Requires disposable localhost /gbrain_test without direct-route or URL overrides');
  }
}
const suite = databaseUrl ? describe : describe.skip;
const id = randomUUID().replaceAll('-', '').slice(0, 12);
const source = `runtime-${id}`;
const ordinaryRole = `runtime_ordinary_${id}`;
const adapterRole = `runtime_adapter_${id}`;
const enrollmentRole = `runtime_enroll_${id}`;
const policy = `runtime_fixture_${id}`;
const engines: PostgresEngine[] = [];
const roles: string[] = [];
const policyTables: string[] = [];
const lifecycles: Awaited<ReturnType<typeof createPageFileRuntimeCandidate>>[] = [];
let admin: PostgresEngine, ordinary: PostgresEngine;
let directory: string, root: string, host: PageFileHostManifestOptions;
let adapterUrl: string, ordinaryUrl: string;
let schemaReady = false;
const page = (body: string) => {
  const parsed = parseMarkdown(body, 'example.md');
  return { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: JSON.parse(JSON.stringify(parsed.frontmatter)) };
};
async function connect(url: string) {
  const engine = new PostgresEngine(); engines.push(engine);
  await engine.connect({ database_url: url, poolSize: 1 });
  await engine.executeRaw("SET statement_timeout='15s'");
  await engine.executeRaw("SET lock_timeout='10s'");
  return engine;
}
function context(engine = ordinary): OperationContext {
  return { engine, config: { engine: 'postgres', page_file_runtime: { mode: 'disabled', topology: 'single-host-local', brainId: 'unused-disabled-fixture', lockDirectory: '', journalDirectory: '' } },
    logger: console, remote: false, sourceId: source, dryRun: false } as OperationContext;
}
const call = (name: string, params: Record<string, unknown>, ctx = context()) => operationsByName[name].handler(ctx, params) as Promise<any>;
const target = { source_id: source, slug: 'example' };
const authority = (url = adapterUrl) => ({ mode: 'offline-verification' as const,
  credentialReference: 'disposable-runtime-fixture', resolveCredential: async () => url,
  expected: { role: adapterRole, database: 'gbrain_test', ordinaryRole } });
async function install(engine = ordinary) {
  const lifecycle = await createPageFileRuntimeCandidate({ mode: 'offline-verification', engine, host, authority: authority() });
  lifecycles.push(lifecycle); return lifecycle;
}
async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const table of ['pages', 'page_file_bindings']) state[table] = await admin.executeRaw(
    `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE source_id=$1 ORDER BY to_jsonb(t)::text`, [source]);
  for (const table of ['tags', 'content_chunks', 'page_versions', 'timeline_entries', 'page_file_write_authorizations']) state[table] = await admin.executeRaw(
    `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1) ORDER BY to_jsonb(t)::text`, [source]);
  state.operations = await admin.executeRaw('SELECT to_jsonb(t)::text AS row FROM page_file_operations t WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1) ORDER BY operation_id', [source]);
  state.file = readFileSync(join(root, 'example.md'), 'utf8');
  return state;
}
async function adapterSessions() {
  return admin.executeRaw<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 ORDER BY pid', [adapterRole]);
}

suite('registered runtime authority — disposable real PostgreSQL, production disabled', () => {
  beforeAll(async () => {
    admin = await connect(databaseUrl!); await admin.initSchema(); schemaReady = true;
    // /tmp is intentionally forbidden by host ancestor validation. Use an owned
    // private child of the checkout, never chmod ancestors to bypass the gate.
    directory = mkdtempSync(join(realpathSync(import.meta.dir), 'runtime-pg-'));
    const pin = (name: string) => {
      const path = join(directory, name); mkdirSync(path, { mode: 0o700 });
      const s = lstatSync(path, { bigint: true });
      return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 as const };
    };
    const manifest = { version: 1 as const, deploymentId: `fixture-${id}`, brainId: randomUUID(),
      database: 'gbrain_test', adapterRole, generation: '1', topology: 'single-host-local' as const,
      serviceUid: process.getuid!(), roots: [{ sourceId: source, mappingGeneration: '1', directory: pin('root'), journal: pin('journal') }],
      lock: pin('lock'), indexedRoots: [] };
    root = manifest.roots[0].directory.path;
    const manifestJson = JSON.stringify(manifest);
    host = { mode: 'offline-verification', manifestJson, expected: {
      manifestSha256: createHash('sha256').update(manifestJson).digest('hex'), deploymentId: manifest.deploymentId,
      brainId: manifest.brainId, database: manifest.database, adapterRole, generation: '1' } };
    await admin.executeRaw("INSERT INTO sources(id,name,local_path,config,archived) VALUES($1,$1,$2,'{}'::jsonb,false)", [source, root]);
    // Enrollment is fixture preparation, not a request-path authority shortcut.
    await admin.putPage('example', { ...page('Before'), page_kind: 'markdown' }, { sourceId: source });
    await admin.addTag('example', 'overlay', { sourceId: source });
    writeFileSync(join(root, 'example.md'), 'Before');
    const urls: string[] = [];
    for (const role of [ordinaryRole, adapterRole, enrollmentRole]) {
      const password = randomUUID().replaceAll('-', '');
      await admin.executeRaw(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`); roles.push(role);
      await admin.executeRaw(`ALTER ROLE ${role} SET statement_timeout='15s'`);
      await admin.executeRaw(`ALTER ROLE ${role} SET lock_timeout='10s'`);
      await admin.executeRaw(`GRANT CONNECT ON DATABASE gbrain_test TO ${role}`);
      await admin.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      // Explicit table allowlist, not ALL TABLES or owner credentials.
      await admin.executeRaw(`GRANT SELECT ON sources,pages,page_file_bindings,config TO ${role}`);
      if (role === adapterRole) {
        await admin.executeRaw(`GRANT UPDATE ON pages TO ${role}`);
        await admin.executeRaw(`GRANT SELECT ON tags,timeline_entries TO ${role}`);
        await admin.executeRaw(`GRANT SELECT,INSERT,UPDATE,DELETE ON content_chunks TO ${role}`);
        await admin.executeRaw(`GRANT SELECT,INSERT ON page_versions TO ${role}`);
        await admin.executeRaw(`GRANT UPDATE(pending_op_id,indexed_raw_sha256,file_generation) ON page_file_bindings TO ${role}`);
        await admin.executeRaw(`GRANT SELECT,INSERT,UPDATE ON page_file_operations TO ${role}`);
        await admin.executeRaw(`GRANT SELECT,INSERT,DELETE ON page_file_write_authorizations TO ${role}`);
        await admin.executeRaw(`GRANT SELECT ON code_edges_chunk,code_edges_symbol TO ${role}`);
        // SELECT FOR SHARE requires UPDATE privilege on at least one column.
        await admin.executeRaw(`GRANT UPDATE(id) ON sources TO ${role}`);
        for (const table of ['content_chunks', 'page_versions', 'timeline_entries']) {
          const [sequence] = await admin.executeRaw<{ name: string | null }>("SELECT pg_get_serial_sequence($1,'id') AS name", ['public.' + table]);
          if (sequence.name) await admin.executeRaw(`GRANT USAGE,SELECT ON SEQUENCE ${sequence.name} TO ${role}`);
        }
      }
      if (role === enrollmentRole) {
        await admin.executeRaw(`GRANT UPDATE(id) ON sources,pages TO ${role}`);
        await admin.executeRaw(`GRANT INSERT ON page_file_bindings TO ${role}`);
        await admin.executeRaw(`GRANT SELECT ON tags TO ${role}`);
      }
      const url = new URL(databaseUrl!); url.username = role; url.password = password; urls.push(url.toString());
    }
    [ordinaryUrl, adapterUrl] = urls;
    const ownPage = `page_id IN (SELECT id FROM public.pages WHERE source_id='${source}')`;
    const ownBinding = `binding_id IN (SELECT binding_id FROM public.page_file_bindings WHERE source_id='${source}')`;
    const policies: [string, string, string, 'ALL' | 'SELECT'][] = [
      ['sources', `id='${source}'`, `${ordinaryRole},${adapterRole},${enrollmentRole}`, 'ALL'],
      ['pages', `source_id='${source}'`, `${ordinaryRole},${adapterRole},${enrollmentRole}`, 'ALL'],
      ['page_file_bindings', `source_id='${source}' AND ${ownPage}`, `${ordinaryRole},${adapterRole},${enrollmentRole}`, 'ALL'],
      ['tags', ownPage, `${adapterRole},${enrollmentRole}`, 'SELECT'],
      ...['content_chunks', 'page_versions', 'timeline_entries'].map(t => [t, ownPage, adapterRole, 'ALL'] as [string, string, string, 'ALL']),
      ['page_file_operations', ownBinding, adapterRole, 'ALL'], ['page_file_write_authorizations', ownPage, adapterRole, 'ALL'],
      ['config', "key='sync.repo_path'", `${ordinaryRole},${adapterRole},${enrollmentRole}`, 'SELECT'],
      ['code_edges_chunk', 'from_chunk_id IN (SELECT id FROM public.content_chunks) OR to_chunk_id IN (SELECT id FROM public.content_chunks)', adapterRole, 'SELECT'],
      ['code_edges_symbol', 'from_chunk_id IN (SELECT id FROM public.content_chunks)', adapterRole, 'SELECT'],
    ];
    for (const [table, predicate, role, command] of policies) {
      await admin.executeRaw(`CREATE POLICY ${policy} ON public.${table} FOR ${command} TO ${role} USING (${predicate})${command === 'ALL' ? ` WITH CHECK (${predicate})` : ''}`);
      policyTables.push(table);
    }
    // Separate fixture enrollment identity has the same source/config visibility
    // as the runtime, so legacy config-generation hashing is not masked by owner
    // visibility of unrelated sources. It has no capability/operation privileges.
    const enrollment = await connect(urls[2]);
    await new PageFileDatabase(enrollment, { brainId: manifest.brainId, journalDirectory: manifest.roots[0].journal.path,
      withLockedBinding: fn => fn() }).enroll(source, 'example');
    await enrollment.disconnect();
    ordinary = await connect(ordinaryUrl);
    const [identity] = await ordinary.executeRaw('SELECT session_user,current_user,current_database() AS database,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(identity).toEqual({ session_user: ordinaryRole, current_user: ordinaryRole, database: 'gbrain_test', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    for (const role of roles) {
      expect(await admin.executeRaw('SELECT c.oid FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=$1', [role])).toEqual([]);
    }
    await expect(ordinary.executeRaw(`SET ROLE ${adapterRole}`)).rejects.toMatchObject({ code: '42501' });
    for (const table of ['sources', 'pages', 'page_file_bindings']) {
      expect((await ordinary.executeRaw<{ active: boolean }>('SELECT row_security_active($1::regclass) AS active', ['public.' + table]))[0].active).toBe(true);
    }
    expect(await ordinary.executeRaw("SELECT id FROM sources WHERE id='default'")).toEqual([]);
  }, 120_000);

  afterAll(async () => {
    try {
      for (const lifecycle of lifecycles) await lifecycle.close();
      if (admin) expect(await adapterSessions()).toEqual([]);
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
        for (const table of policyTables) await admin.executeRaw(`DROP POLICY ${policy} ON public.${table}`);
        for (const role of roles) { await admin.executeRaw(`DROP OWNED BY ${role}`); await admin.executeRaw(`DROP ROLE ${role}`); }
        if (admin) {
          expect(await admin.executeRaw('SELECT rolname FROM pg_roles WHERE rolname IN ($1,$2,$3)', [ordinaryRole, adapterRole, enrollmentRole])).toEqual([]);
          expect(await admin.executeRaw('SELECT policyname FROM pg_policies WHERE policyname=$1', [policy])).toEqual([]);
        }
      } finally { if (admin) await admin.disconnect(); if (directory) rmSync(directory, { recursive: true, force: true }); }
    }
  }, 30_000);

  test('registered get/put use independent private adapter pool; ordinary cannot mint capability; close tombstones shared contexts', async () => {
    const lifecycle = await install();
    try {
    expect(Object.keys(lifecycle)).toEqual(['close']);
    const sessions = await adapterSessions(); expect(sessions).toHaveLength(1);
    const [ordinaryPid] = await ordinary.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(sessions[0].pid).not.toBe(ordinaryPid.pid);
    const before = await call('get_page_checked', target);
    expect(before.persistence).toBe('file_and_database');
    const stable = await snapshot();
    await expect(ordinary.executeRaw('INSERT INTO page_file_write_authorizations(transaction_id,page_id,operation_id,expected_revision) SELECT txid_current(),id,$1,write_revision FROM pages WHERE source_id=$2', [randomUUID(), source])).rejects.toMatchObject({ code: '42501' });
    await expect(ordinary.executeRaw('UPDATE pages SET compiled_truth=$1 WHERE source_id=$2', ['Forbidden', source])).rejects.toMatchObject({ code: '42501' });
    expect(await snapshot()).toEqual(stable);
    const request = { ...target, operation_id: randomUUID(), expected_revision: before.revision,
      file_baseline: before.file.baseline, raw_markdown: 'After', page: page('After') };
    expect((await call('put_page_checked', request)).status).toBe('committed');
    const after = await call('get_page_checked', target, { ...context() });
    expect(after.page.compiled_truth).toBe('After'); expect(after.revision).not.toBe(before.revision);
    expect(readFileSync(join(root, 'example.md'), 'utf8')).toBe('After');
    const final = await snapshot();
    expect(final.page_versions).toHaveLength(1); expect(final.operations).toHaveLength(1);
    expect(final.page_file_write_authorizations).toEqual([]);
    expect(await admin.getTags('example', { sourceId: source })).toEqual(['overlay']);
    expect((await call('put_page_checked', request)).status).toBe('committed');
    await expect(call('put_page_checked', { ...request, operation_id: randomUUID(), raw_markdown: 'Stale', page: page('Stale') })).rejects.toThrow('precondition_failed');
    expect(await snapshot()).toEqual(final);
    await lifecycle.close(); await lifecycle.close();
    expect(await adapterSessions()).toEqual([]);
    // Both registered handlers must hit the tombstone, never ordinary fallback.
    for (const name of ['get_page_checked', 'put_page_checked']) await expect(call(name, name === 'get_page_checked' ? target : request, { ...context() })).rejects.toThrow('page_file_runtime_closed');
    expect(await ordinary.executeRaw('SELECT 1 AS alive')).toEqual([{ alive: 1 }]);
    expect(await snapshot()).toEqual(final);
    console.log('PG_RUNTIME_AUTHORITY: registered get/put, separate login/PID, ordinary SQLSTATE 42501, CAS replay/stale, close verified');
    } finally { await lifecycle.close(); }
  }, 60_000);

  test('real login identity mismatch closes failed adapter pool and denies registered fallback', async () => {
    const engine = await connect(ordinaryUrl);
    const stable = await snapshot();
    const ordinarySessions = () => admin.executeRaw('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 ORDER BY pid', [ordinaryRole]);
    const sessionsBefore = await ordinarySessions();
    // Host/expected identity agree; actual PostgreSQL login does not. This must
    // reach the driver's session_user check, not fail a mocked/preflight compare.
    await expect(createPageFileRuntimeCandidate({ mode: 'offline-verification', engine, host, authority: authority(ordinaryUrl) })).rejects.toThrow('page_file_authority_identity_mismatch');
    expect(await ordinarySessions()).toEqual(sessionsBefore);
    await expect(call('get_page_checked', target, context(engine))).rejects.toThrow('page_file_runtime_closed');
    await expect(call('get_page_checked', { ...target, slug: 'missing' }, context(engine))).rejects.toThrow('page_file_runtime_closed');
    expect(await adapterSessions()).toEqual([]);
    expect(await snapshot()).toEqual(stable);
    console.log('PG_RUNTIME_AUTHORITY: actual login mismatch denied; failed candidate has no ordinary fallback');
  }, 30_000);

  test('production mode is still refused before credential resolution', async () => {
    const engine = await connect(ordinaryUrl); let resolved = false;
    await expect(createPageFileRuntimeCandidate({ mode: 'offline-verification', engine, host,
      authority: { ...authority(), mode: 'production', resolveCredential: async () => { resolved = true; return adapterUrl; } },
    })).rejects.toThrow('file_runtime_prerequisites_pending');
    expect(resolved).toBe(false);
    await expect(call('get_page_checked', target, { ...context(engine), config: { ...context(engine).config,
      page_file_runtime: { ...context(engine).config.page_file_runtime!, mode: 'production' } } })).rejects.toThrow('file_runtime_prerequisites_pending');
  }, 30_000);
});
