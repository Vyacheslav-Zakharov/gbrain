import { test, expect, mock, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { acquirePageFileLock } from '../src/core/page-file-lock.ts';
import { withEnv } from './helpers/with-env.ts';

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

async function fixture(allowDatabaseOnly = false, allowLegacy = false) {
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'runtime-authority-'));
  const pin = (name: string) => {
    const path = join(base, name); mkdirSync(path, { mode: 0o700 });
    const s = lstatSync(path, { bigint: true });
    return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 as const };
  };
  const manifest = { version: 1 as const, deploymentId: 'deployment-example', brainId: randomUUID(), database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local' as const, serviceUid: process.getuid!(), roots: [{ sourceId: 'default', mappingGeneration: 'enrollment-pin', directory: pin('root'), journal: pin('journal') }], lock: pin('lock'), indexedRoots: [] };
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

  let ordinaryReads = 0;
  const engine: any = { kind: 'postgres', executeRaw: async (query: string, values?: unknown[]) => {
    ordinaryReads++;
    if (!query.startsWith('SELECT')) throw new Error('ordinary_write_forbidden');
    if (!allowLegacy && !query.startsWith('SELECT canonical_root,relative_path,binding_id FROM page_file_bindings')
      && !(allowDatabaseOnly && (query.startsWith('SELECT * FROM pages WHERE source_id = $1')
        || query === 'SELECT local_path FROM sources WHERE id = $1'))) throw new Error('ordinary_sql_forbidden');
    return backing.executeRaw(query, values);
  } };
  if (allowLegacy) Object.setPrototypeOf(engine, new Proxy(backing, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }));
  if (allowDatabaseOnly) engine.getConfig = (key: string) => backing.getConfig(key);
  const ctx: any = { engine, config: { engine: 'postgres', page_file_runtime: { mode: 'disabled' } }, remote: false, sourceId: 'default', dryRun: false };
  const authority = { mode: 'offline-verification' as const, credentialReference: 'offline-fixture', resolveCredential: async () => 'postgres://fixture.invalid/offline', expected: { role: manifest.adapterRole, database: manifest.database, ordinaryRole: 'ordinary-example' } };
  ended = 0; statements = []; borrowHook = undefined; commitHook = undefined;
  const runtime = await import('../src/core/page-file-runtime.ts');
  const { operationsByName } = await import('../src/core/operations.ts');
  const call = (name: string, params: any, context = ctx) => operationsByName[name].handler(context, params) as Promise<any>;
  return { base, host, manifest, ctx, authority, runtime, call, page, backing, ordinaryReads: () => ordinaryReads,
    cleanup: async () => { borrowHook = undefined; commitHook = undefined; await backing.disconnect(); rmSync(base, { recursive: true, force: true }); } };
}


test('explicit candidate enrollment checks reviewed baseline and holds exclusive root through commit without business writes', async () => {
  const f = await fixture(false, true); let lifecycle: any;
  try {
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    const [before] = await db.executeRaw<any>("SELECT * FROM pages WHERE slug='example'");
    const root = f.manifest.roots[0].directory.path;
    const reviewed = { hostManifestSha256: f.host.expected.manifestSha256, source: 'default', slug: 'example', pageId: String(before.id), revision: before.write_revision, canonicalRoot: root, relativePath: 'example.md', rawSha256: createHash('sha256').update('Before').digest('hex') };
    const enrollment = { ...f.authority, adapterRole: f.manifest.adapterRole, credentialReference: 'enrollment-fixture', resolveCredential: async () => 'postgres://enrollment.invalid/offline', expected: { ...f.authority.expected, role: 'enrollment-example' } };
    const request = { reviewed, authority: enrollment };
    expect(await f.runtime.resolvePageFileRuntime(f.ctx, 'default', 'example')).toBeUndefined();
    let commits = 0;
    commitHook = async () => {
      // Shared-root path writers (put/recovery/sync/legacy put) and exclusive
      // root writers (another enrollment/pull) both remain excluded at COMMIT.
      for (const rootMode of ['shared', 'exclusive'] as const) {
        const lock = await acquirePageFileLock({ root, lockDirectory: f.manifest.lock.path, topology: 'single-host-local', rootMode, paths: rootMode === 'shared' ? ['example.md'] : [], timeoutMs: 20 });
        try { expect(lock).toBeNull(); } finally { await lock?.release(); }
      }
      const pageLock = statements.lastIndexOf('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE');
      const bindingRead = statements.lastIndexOf('SELECT * FROM page_file_bindings WHERE source_id=$1 AND slug=$2');
      expect(pageLock).toBeGreaterThan(statements.lastIndexOf('BEGIN'));
      expect(bindingRead).toBeGreaterThan(pageLock);
      commits++;
    };
    const result = await f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', request);
    expect(result.status).toBe('enrolled');
    expect(commits).toBe(1);
    expect(result.binding_id).toBeString();
    expect(await db.executeRaw("SELECT * FROM pages WHERE slug='example'")).toEqual([before]);
    expect(readFileSync(join(root, 'example.md'), 'utf8')).toBe('Before');
    expect(statements.filter(q => /^(INSERT|UPDATE|DELETE)/i.test(q.trim())).every(q => q.includes('INSERT INTO page_file_bindings'))).toBe(true);
    const services = await f.runtime.resolvePageFileRuntime(f.ctx, 'default', 'example');
    expect((await services!.pages.get('default', 'example', () => {})).file.raw_markdown).toBe('Before');
    const bindings = await db.executeRaw('SELECT * FROM page_file_bindings');
    const repeated = await f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', request);
    expect(repeated).toEqual({ ...result, status: 'already_enrolled' });
    expect(await db.executeRaw('SELECT * FROM page_file_bindings')).toEqual(bindings);
    // A prior supported writer's generation advance cannot become an idempotent
    // repeat, even with the same current bytes/revision. Simulate its durable row.
    await db.executeRaw('UPDATE page_file_bindings SET file_generation=1');
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', request)).rejects.toThrow('page_file_enrollment_stale');
    await db.executeRaw('UPDATE page_file_bindings SET file_generation=0');
    for (const remote of [true, undefined]) {
      await expect(f.runtime.enrollPageFileRuntime({ ...f.ctx, remote }, 'default', 'example', request)).rejects.toThrow('permission_denied');
    }
    for (const field of ['hostManifestSha256', 'source', 'slug', 'pageId', 'revision', 'canonicalRoot', 'relativePath', 'rawSha256']) {
      await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', { ...request, reviewed: { ...reviewed, [field]: 'stale' } })).rejects.toThrow('page_file_enrollment_stale');
    }
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', { ...request, authority: { ...enrollment, expected: { ...enrollment.expected, ordinaryRole: 'unreviewed-ordinary' } } })).rejects.toThrow('page_file_runtime_identity_mismatch');
    borrowHook = () => chmodSync(f.manifest.lock.path, 0o755);
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', request)).rejects.toThrow('page_file_host_directory_drift');
    borrowHook = undefined; chmodSync(f.manifest.lock.path, 0o700);
    writeFileSync(join(root, 'example.md'), 'Changed');
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example', request)).rejects.toThrow('page_file_enrollment_stale');
    writeFileSync(join(root, 'example.md'), 'Before');
    expect(await db.executeRaw('SELECT * FROM page_file_bindings')).toEqual(bindings);
    expect(await db.executeRaw("SELECT * FROM pages WHERE slug='example'")).toEqual([before]);
    expect(await db.executeRaw('SELECT * FROM page_file_operations')).toEqual([]);
    expect(await db.executeRaw('SELECT * FROM page_file_write_authorizations')).toEqual([]);
  } finally { await lifecycle?.close(); await f.cleanup(); }
}, 60000);
