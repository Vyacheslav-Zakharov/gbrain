import { test, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquirePageFileLock } from '../src/core/page-file-lock.ts';

// Offline transport bridge only: real authority/PostgresEngine/adapters/registry.
// Real PGLite table grants below; NOT PostgreSQL login or RLS isolation proof.
let db: PGLiteEngine;
let ended = 0;
let statements: string[] = [];
let borrowHook: (() => void) | undefined;
let commitHook: (() => Promise<void>) | undefined;
const identity = { session_user: 'adapter-example', current_user: 'adapter-example', database_name: 'db-example', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false };
const sql: any = Object.assign((parts: TemplateStringsArray, ...values: any[]) => {
  const fragment = { parts, values, then(resolve: any, reject: any) {
    const params: unknown[] = [];
    const render = (f: { parts: TemplateStringsArray; values: any[] }): string => f.parts.reduce((q, part, i) => {
      if (!i) return part;
      const value = f.values[i - 1];
      return q + (value?.parts ? render(value) : (params.push(value), `$${params.length}`)) + part;
    }, '');
    const query = render(fragment); statements.push(query);
    return db.executeRaw(query, params).then(resolve, reject);
  } };
  return fragment;
}, {
  unsafe: async (query: string, values?: unknown[]) => { statements.push(query); if (query === 'COMMIT') await commitHook?.(); return query.includes('session_user') ? [{ ...identity }] : db.executeRaw(query, values); },
  reserve: async () => { borrowHook?.(); return sql; }, release() {},
  begin: async (fn: (tx: any) => Promise<any>) => db.transaction(async tx => {
    const previous = db; db = tx as PGLiteEngine;
    try { return await fn(sql); } finally { db = previous; }
  }),
  end: async () => { ended++; },
});
// Real PGLite privilege checks, not a SQL-string mock denylist. Identity/login
// remains the offline bridge above; this does not claim real-PG login/RLS proof.
async function enrollmentQuery(q: string, v?: unknown[]) {
  if (q === 'ROLLBACK') { const result = await sql.unsafe(q, v); await db.executeRaw('RESET ROLE'); return result; }
  await db.executeRaw('SET ROLE enrollment_fixture');
  try { return await sql.unsafe(q, v); }
  finally { await db.executeRaw('RESET ROLE').catch(() => {}); } // aborted tx resets after ROLLBACK
}
mock.module('postgres', () => ({ default: Object.assign((url: string) => { const role = url.includes('enrollment') ? 'enrollment-example' : 'adapter-example'; return { reserve: async () => { borrowHook?.(); return Object.assign((...args: any[]) => sql(...args), { unsafe: (q: string, v?: unknown[]) => q.includes('session_user') ? Promise.resolve([{ ...identity, session_user: role, current_user: role }]) : role === 'enrollment-example' ? enrollmentQuery(q,v) : sql.unsafe(q,v), release() {} }); }, end: sql.end }; }, { BigInt: {} }) }));

async function fixture(candidateScope: Scope = ['default'], requestScope: Scope = ['default']) {
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'source-runtime-enrollment-'));
  const pin = (name: string) => {
    const path = join(base, name); mkdirSync(path, { mode: 0o700 });
    const s = lstatSync(path, { bigint: true });
    return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 as const };
  };
  const manifest = { version: 1 as const, deploymentId: 'deployment-example', brainId: randomUUID(), database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local' as const, serviceUid: process.getuid!(), roots: [{ sourceId: 'default', mappingGeneration: 'enrollment-pin', directory: pin('root'), journal: pin('journal') }], lock: pin('lock'), indexedRoots: [] };
  manifest.roots.push({ sourceId: 'foreign', mappingGeneration: 'foreign-pin', directory: pin('foreign-root'), journal: pin('foreign-journal') });
  const manifestJson = JSON.stringify(manifest);
  const host = { mode: 'offline-verification' as const, manifestJson, expected: { manifestSha256: createHash('sha256').update(manifestJson).digest('hex'), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } };
  db = new PGLiteEngine(); await db.connect({}); await db.initSchema();
  const backing = db;
  await db.executeRaw('CREATE ROLE enrollment_fixture NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
  await db.executeRaw('GRANT USAGE ON SCHEMA public TO enrollment_fixture');
  await db.executeRaw('GRANT SELECT ON sources,pages,page_file_bindings,config,tags TO enrollment_fixture');
  await db.executeRaw('GRANT UPDATE(id) ON sources,pages TO enrollment_fixture');
  await db.executeRaw('GRANT INSERT ON page_file_bindings TO enrollment_fixture');
  // Even an empty SELECT FOR UPDATE must fail: enrollment has no binding UPDATE.
  await expect(enrollmentQuery('SELECT * FROM page_file_bindings FOR UPDATE')).rejects.toThrow('permission denied');
  await expect(enrollmentQuery('UPDATE page_file_bindings SET pending_op_id=NULL')).rejects.toThrow('permission denied');
  const root = manifest.roots[0];
  await db.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root.directory.path]);
  const page = { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} };
  await db.putPage('example', page); writeFileSync(join(root.directory.path, 'example.md'), 'Before');

  const engine: any = new Proxy(backing, { get(target, key) {
    if (key === 'kind') return 'postgres';
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const ctx: any = { engine, config: { engine: 'postgres', page_file_runtime: { mode: 'disabled' } }, remote: false, sourceId: 'default', dryRun: false };
  const authority = { mode: 'offline-verification' as const, credentialReference: 'offline-fixture', resolveCredential: async () => 'postgres://fixture.invalid/offline', expected: { role: manifest.adapterRole, database: manifest.database, ordinaryRole: 'ordinary-example' } };
  ended = 0; statements = []; borrowHook = undefined; commitHook = undefined;
  const runtime = await import('../src/core/page-file-runtime.ts');
  const put = (name: string, value: unknown) => { const path = join(base, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o400 }); return path; };
  const secret = 'postgres://adapter.invalid/offline';
  const contract = { version: 1, manifestPath: put('manifest', manifest), credentialPath: put('adapter-credential', secret), credentialSha256: hash(secret), ordinaryRole: 'ordinary-example',
    sqlAuthority: { roles: { ordinary: 'ordinary-example', adapter: 'adapter-example', enrollment: 'enrollment-example' }, catalogPins: {} }, expected: host.expected };
  const bootstrapSha256 = hash(JSON.stringify(contract));
  const bootstrapPath = put('bootstrap', contract);
  const admission = (name: string, scope: Scope) => {
    const approval = Array.isArray(scope) ? { version: 2, mode: 'production-pilot', bootstrapSha256, sources: scope }
      : { version: 1, mode: 'production-pilot', bootstrapSha256, ...scope };
    const anchor = { mode: 'production-pilot' as const, bootstrapPath, bootstrapSha256, approvalPath: put(name, approval), approvalSha256: hash(JSON.stringify(approval)) };
    const loaded = bootstrap.loadPageFileBootstrap(anchor);
    if (loaded.status !== 'production-pilot') throw new Error('fixture admission missing');
    return { loaded, anchor };
  };
  const candidate = admission('candidate-approval', candidateScope), requestAdmission = admission('request-approval', requestScope);
  const lifecycle = await runtime.createPageFileRuntimeCandidate({ mode: 'production-pilot', engine, admission: candidate.loaded.admission,
    host: { ...host, mode: 'production-pilot' }, authority: { ...authority, mode: 'production-pilot', admission: candidate.loaded.admission, revalidate: async () => candidate.loaded.revalidate() } });
  const request = async (source = 'default', slug = 'example') => {
    const [row] = await backing.executeRaw<any>('SELECT * FROM pages WHERE source_id=$1 AND slug=$2', [source, slug]);
    const root = manifest.roots.find(r => r.sourceId === source)!;
    return { reviewed: { hostManifestSha256: host.expected.manifestSha256, source, slug, pageId: String(row.id), revision: row.write_revision,
      canonicalRoot: root.directory.path, relativePath: `${slug}.md`, rawSha256: hash('Before') },
      authority: { ...authority, mode: 'production-pilot' as const, admission: requestAdmission.loaded.admission, revalidate: async () => requestAdmission.loaded.revalidate(),
        adapterRole: manifest.adapterRole, credentialReference: 'enrollment-fixture', resolveCredential: async () => 'postgres://enrollment.invalid/offline', expected: { ...authority.expected, role: 'enrollment-example' } } };
  };
  const addPage = async (source: string, slug: string) => {
    const { parseMarkdown } = await import('../src/core/markdown.ts');
    const parsed = parseMarkdown('Before', `${slug}.md`);
    await backing.putPage(slug, { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter }, { sourceId: source });
    writeFileSync(join(manifest.roots.find(r => r.sourceId === source)!.directory.path, `${slug}.md`), 'Before');
  };
  await backing.executeRaw("INSERT INTO sources(id,name,local_path) VALUES ('foreign','Foreign',$1)", [manifest.roots[1].directory.path]);
  return { base, host, manifest, ctx, runtime, backing, lifecycle, request, addPage, put, candidate, requestAdmission,
    cleanup: async () => { borrowHook = undefined; commitHook = undefined; await lifecycle.close(); await backing.disconnect(); rmSync(base, { recursive: true, force: true }); } };
}


type Scope = string[] | { source: string; slug: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bootstrap = await import('../src/core/page-file-bootstrap.ts');
let startupAnchor: any;
const loadBootstrap = bootstrap.loadPageFileBootstrap;
// Fixed-path discovery and SQL catalog observation only are simulated; runtime,
// admission, operator, authority, DB enrollment and filesystem locks are real.
mock.module('../src/core/page-file-bootstrap.ts', () => ({ ...bootstrap, loadPageFileStartupBootstrap: () => loadBootstrap(startupAnchor) }));
mock.module('../src/core/page-file-sql-authority.ts', () => ({ verifyPageFileSqlAuthority: async () => ({ ok: true }) }));

test('v2 actual runtime enrolls sibling and future pages with two independent source admissions', async () => {
  const f = await fixture();
  try {
    expect(f.candidate.loaded.admission).not.toBe(f.requestAdmission.loaded.admission);
    await f.addPage('default', 'sibling');
    const before = await db.executeRaw('SELECT * FROM pages ORDER BY id');
    const root = f.manifest.roots[0].directory.path;
    let commits = 0;
    commitHook = async () => {
      for (const rootMode of ['shared', 'exclusive'] as const) {
        const lock = await acquirePageFileLock({ root, lockDirectory: f.manifest.lock.path, topology: 'single-host-local', rootMode, paths: rootMode === 'shared' ? ['example.md'] : [], timeoutMs: 20 });
        try { expect(lock).toBeNull(); } finally { await lock?.release(); }
      }
      expect(statements.lastIndexOf('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE')).toBeGreaterThan(statements.lastIndexOf('BEGIN'));
      commits++;
    };
    for (const slug of ['example', 'sibling']) {
      expect((await f.runtime.enrollPageFileRuntime(f.ctx, 'default', slug, await f.request('default', slug))).status).toBe('enrolled');
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe('Before');
    }
    expect(await db.executeRaw('SELECT * FROM pages ORDER BY id')).toEqual(before);
    await f.addPage('default', 'future');
    expect((await f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'future', await f.request('default', 'future'))).status).toBe('enrolled');
    expect(commits).toBe(3);
    expect(await db.executeRaw('SELECT slug FROM page_file_bindings ORDER BY slug')).toEqual([{slug:'example'},{slug:'future'},{slug:'sibling'}]);
    expect(await db.executeRaw('SELECT * FROM page_file_operations')).toEqual([]);
    expect(await db.executeRaw('SELECT * FROM page_file_write_authorizations')).toEqual([]);
  } finally { await f.cleanup(); }
}, 60000);

for (const [label, candidateScope, requestScope, source] of [
  ['candidate denies despite request approval', ['default'], ['foreign'], 'foreign'],
  ['request denies despite candidate approval', ['default'], ['foreign'], 'default'],
  ['both deny foreign source', ['default'], ['default'], 'foreign'],
  ['v1 candidate denies sibling', {source:'default',slug:'example'}, ['default'], 'default'],
  ['v1 request denies sibling', ['default'], {source:'default',slug:'example'}, 'default'],
] as [string, Scope, Scope, string][]) {
  test(label, async () => {
    const f = await fixture(candidateScope, requestScope);
    try {
      await f.addPage(source, 'sibling');
      const before = await db.executeRaw('SELECT * FROM pages ORDER BY id');
      let credentials = 0;
      const request = await f.request(source, 'sibling');
      request.authority.resolveCredential = async () => { credentials++; return 'postgres://enrollment.invalid/offline'; };
      await expect(f.runtime.enrollPageFileRuntime(f.ctx, source, 'sibling', request)).rejects.toThrow('page_file_pilot_target_unapproved');
      expect(credentials).toBe(0);
      expect(await db.executeRaw('SELECT * FROM page_file_bindings')).toEqual([]);
      expect(await db.executeRaw('SELECT * FROM pages ORDER BY id')).toEqual(before);
    } finally { await f.cleanup(); }
  }, 60000);
}

test('v1 actual enrollment still permits its exact pinned page', async () => {
  const f = await fixture({source:'default',slug:'example'}, {source:'default',slug:'example'});
  try {
    expect((await f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', await f.request())).status).toBe('enrolled');
  } finally { await f.cleanup(); }
}, 60000);

test('v2 actual enrollment retains local, reviewed identity, source mapping and host guards', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    for (const remote of [true, undefined])
      await expect(f.runtime.enrollPageFileRuntime({...f.ctx, remote}, 'default', 'example', request)).rejects.toThrow('permission_denied');
    for (const field of ['hostManifestSha256','source','slug','pageId','revision','canonicalRoot','relativePath','rawSha256'])
      await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', {...request,reviewed:{...request.reviewed,[field]:'stale'}})).rejects.toThrow('page_file_enrollment_stale');
    for (const field of ['ordinaryRole','database'])
      await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', {...request,authority:{...request.authority,expected:{...request.authority.expected,[field]:'wrong'}}})).rejects.toThrow('page_file_runtime_identity_mismatch');
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', {...request,authority:{...request.authority,adapterRole:'wrong'}})).rejects.toThrow('page_file_runtime_identity_mismatch');
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', {...request,authority:{...request.authority,admission:{}}})).rejects.toThrow('page_file_pilot_approval_required');
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', {...request,authority:{...request.authority,mode:'offline-verification'}})).rejects.toThrow('page_file_pilot_target_unapproved');
    await db.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [f.manifest.roots[1].directory.path]);
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', request)).rejects.toThrow('binding_changed');
    await db.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [f.manifest.roots[0].directory.path]);
    borrowHook = () => chmodSync(f.manifest.lock.path, 0o755);
    // Production admission revalidation sanitizes host drift at the private
    // authority boundary; no SQL enrollment may occur after the failed borrow.
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', request)).rejects.toThrow('page_file_authority_unavailable');
    borrowHook = undefined; chmodSync(f.manifest.lock.path, 0o700);
    expect(await db.executeRaw('SELECT * FROM page_file_bindings')).toEqual([]);
  } finally { await f.cleanup(); }
}, 60000);

test('protected source operator reaches real runtime enrollment and verifies existing bindings', async () => {
  const f = await fixture();
  try {
    startupAnchor = f.candidate.anchor;
    const { loadPageFileOperator, runPageFileOperator } = await import('../src/commands/page-file-operator.ts');
    const secret = 'postgres://enrollment.invalid/offline';
    const contract = {version:2,mode:'production-pilot',bootstrap:f.candidate.anchor,sourceIds:['default'],
      enrollmentCredentialPath:f.put('enrollment-credential',secret),enrollmentCredentialSha256:hash(secret)};
    const anchor = f.put('operator-anchor', {operatorPath:f.put('operator',contract),operatorSha256:hash(JSON.stringify(contract))});
    const operator = loadPageFileOperator(f.ctx, anchor);
    await f.addPage('default','sibling');
    const before = await db.executeRaw('SELECT * FROM pages ORDER BY id');
    const inventory: any = await runPageFileOperator(f.ctx,operator,'inventory',{source:'default',limit:1});
    expect(inventory.items).toEqual([{source:'default',slug:'example',status:'pending_enrollment',reason:'checked_enrollment_required'}]);
    expect(await db.executeRaw('SELECT * FROM page_file_bindings')).toEqual([]);
    const first: any = await runPageFileOperator(f.ctx,operator,'reconcile',{source:'default',limit:1});
    expect(first.items).toEqual([{source:'default',slug:'example',status:'enrolled'}]);
    expect(first.nextCursor).toBeString();
    const second: any = await runPageFileOperator(f.ctx,operator,'reconcile',{source:'default',limit:1,cursor:first.nextCursor});
    expect(second.items).toEqual([{source:'default',slug:'sibling',status:'enrolled'}]);
    expect(second.nextCursor).toBeNull();
    expect(await db.executeRaw('SELECT * FROM pages ORDER BY id')).toEqual(before);
    const bindings = await db.executeRaw('SELECT * FROM page_file_bindings ORDER BY slug');
    const again: any = await runPageFileOperator(f.ctx,operator,'reconcile',{source:'default',limit:2});
    expect(again.items.map((item: any) => item.status)).toEqual(['verified','verified']);
    expect(await db.executeRaw('SELECT * FROM page_file_bindings ORDER BY slug')).toEqual(bindings);
    await f.addPage('default','early-future');
    const future: any = await runPageFileOperator(f.ctx,operator,'reconcile',{source:'default',limit:3});
    expect(future.items).toEqual([{source:'default',slug:'early-future',status:'enrolled'},{source:'default',slug:'example',status:'verified'},{source:'default',slug:'sibling',status:'verified'}]);
    expect(future.nextCursor).toBeNull();
  } finally { startupAnchor = undefined; await f.cleanup(); }
}, 60000);
