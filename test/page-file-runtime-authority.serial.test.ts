import { test, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';

// Offline transport bridge only: real authority/PostgresEngine/adapters/registry.
// PGLite is NOT evidence of PostgreSQL login, grants or RLS isolation.
let db: PGLiteEngine;
let ended = 0;
let statements: string[] = [];
let borrowHook: (() => void) | undefined;
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
  unsafe: async (query: string, values?: unknown[]) => { statements.push(query); return query.includes('session_user') ? [{ ...identity }] : db.executeRaw(query, values); },
  reserve: async () => { borrowHook?.(); return sql; }, release() {},
  begin: async (fn: (tx: any) => Promise<any>) => db.transaction(async tx => {
    const previous = db; db = tx as PGLiteEngine;
    try { return await fn(sql); } finally { db = previous; }
  }),
  end: async () => { ended++; },
});
mock.module('postgres', () => ({ default: Object.assign(() => sql, { BigInt: {} }) }));

async function fixture(allowDatabaseOnly = false) {
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'runtime-authority-'));
  const pin = (name: string) => {
    const path = join(base, name); mkdirSync(path, { mode: 0o700 });
    const s = lstatSync(path, { bigint: true });
    return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 as const };
  };
  const manifest = { version: 1 as const, deploymentId: 'deployment-example', brainId: randomUUID(), database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local' as const, serviceUid: process.getuid!(), roots: [{ sourceId: 'default', mappingGeneration: '1', directory: pin('root'), journal: pin('journal') }], lock: pin('lock'), indexedRoots: [] };
  const manifestJson = JSON.stringify(manifest);
  const host = { mode: 'offline-verification' as const, manifestJson, expected: { manifestSha256: createHash('sha256').update(manifestJson).digest('hex'), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } };
  db = new PGLiteEngine(); await db.connect({}); await db.initSchema();
  const backing = db;
  const root = manifest.roots[0];
  await db.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root.directory.path]);
  const page = { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} };
  await db.putPage('example', page); writeFileSync(join(root.directory.path, 'example.md'), 'Before');
  await new PageFileDatabase(db, { brainId: manifest.brainId, journalDirectory: root.journal.path, withLockedBinding: fn => fn() }).enroll('default', 'example');
  let ordinaryReads = 0;
  const engine: any = { kind: 'postgres', executeRaw: async (query: string, values?: unknown[]) => {
    ordinaryReads++;
    if (!query.startsWith('SELECT canonical_root,relative_path,binding_id FROM page_file_bindings')
      && !(allowDatabaseOnly && (query.startsWith('SELECT * FROM pages WHERE source_id = $1')
        || query === 'SELECT local_path FROM sources WHERE id = $1'))) throw new Error('ordinary_sql_forbidden');
    return backing.executeRaw(query, values);
  } };
  if (allowDatabaseOnly) engine.getConfig = (key: string) => backing.getConfig(key);
  const ctx: any = { engine, config: { engine: 'postgres', page_file_runtime: { mode: 'disabled' } }, remote: false, sourceId: 'default', dryRun: false };
  const authority = { mode: 'offline-verification' as const, credentialReference: 'offline-fixture', resolveCredential: async () => 'postgres://fixture.invalid/offline', expected: { role: manifest.adapterRole, database: manifest.database, ordinaryRole: 'ordinary-example' } };
  ended = 0; statements = []; borrowHook = undefined;
  const runtime = await import('../src/core/page-file-runtime.ts');
  const { operationsByName } = await import('../src/core/operations.ts');
  const call = (name: string, params: any, context = ctx) => operationsByName[name].handler(context, params) as Promise<any>;
  return { base, host, manifest, ctx, authority, runtime, call, page, ordinaryReads: () => ordinaryReads,
    cleanup: async () => { borrowHook = undefined; await backing.disconnect(); rmSync(base, { recursive: true, force: true }); } };
}

test('registered checked operations use the private shared candidate and close without ordinary fallback', async () => {
  const f = await fixture(); let lifecycle: any;
  try {
    expect(typeof (f.runtime as any).createPageFileRuntimeCandidate).toBe('function');
    lifecycle = await (f.runtime as any).createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    expect(Object.keys(lifecycle)).toEqual(['close']);
    expect(Object.keys(f.ctx.engine).sort()).toEqual(['executeRaw', 'kind']);
    const target = { source_id: 'default', slug: 'example' };
    const before = await f.call('get_page_checked', target);
    expect(before.persistence).toBe('file_and_database');
    const result = await f.call('put_page_checked', { ...target, expected_revision: before.revision, operation_id: randomUUID(), file_baseline: before.file.baseline, raw_markdown: 'After', page: { ...f.page, compiled_truth: 'After' } });
    expect(result.status).toBe('committed');
    expect(readFileSync(join(f.manifest.roots[0].directory.path, 'example.md'), 'utf8')).toBe('After');
    expect((await f.call('get_page_checked', target, { ...f.ctx })).page.compiled_truth).toBe('After');
    expect(statements.some(q => q.includes('INSERT INTO page_file_write_authorizations'))).toBe(true);
    await lifecycle.close(); await lifecycle.close();
    expect(ended).toBe(1);
    const reads = f.ordinaryReads();
    await expect(f.call('get_page_checked', target, { ...f.ctx })).rejects.toThrow('page_file_runtime_closed');
    expect(f.ordinaryReads()).toBe(reads);
  } finally { await lifecycle?.close(); await f.cleanup(); }
}, 60000);


test('registered DB-only read remains eligible with a healthy candidate and denies closed fallback', async () => {
  const f = await fixture(true); let lifecycle: any;
  try {
    await db.executeRaw("INSERT INTO sources (id, name) VALUES ('db-only', 'Database only')");
    await db.putPage('ordinary', f.page, { sourceId: 'db-only' });
    const target = { source_id: 'db-only', slug: 'ordinary' };
    const before = await f.call('get_page_checked', target);
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    const privateReads = statements.length;
    expect(await f.call('get_page_checked', target)).toEqual(before);
    expect(before.persistence).toBe('database_only');
    expect(statements.length).toBe(privateReads);
    // A manifest source without a binding still goes through DB-only eligibility.
    await db.putPage('unenrolled', f.page);
    await expect(f.call('get_page_checked', { source_id: 'default', slug: 'unenrolled' })).rejects.toThrow('database-only markdown page');
    const remote = { ...f.ctx, remote: true, auth: { allowedSources: ['db-only'], sourceId: 'db-only' } };
    expect((await f.call('get_page_checked', target, remote)).persistence).toBe('database_only');
    await expect(f.call('get_page_checked', target, { ...remote, auth: { allowedSources: ['default'] } })).rejects.toThrow('Source is outside your grant');
    await db.executeRaw("UPDATE pages SET source_path='ordinary.md' WHERE source_id='db-only'");
    await expect(f.call('get_page_checked', target)).rejects.toThrow('database-only markdown page');
    await db.executeRaw("UPDATE pages SET source_path=NULL, compiled_truth=$1 WHERE source_id='db-only'", [
      '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Secret example | fact | 1 | private | high | | | | |\n<!--- gbrain:facts:end -->',
    ]);
    await expect(f.call('get_page_checked', target, remote)).rejects.toThrow('privacy redaction');
    await lifecycle.close();
    const reads = f.ordinaryReads();
    await expect(f.call('get_page_checked', target)).rejects.toThrow('page_file_runtime_closed');
    expect(f.ordinaryReads()).toBe(reads);
  } finally { await lifecycle?.close(); await f.cleanup(); }
}, 60000);

test('failed candidate denies registered DB-only read before ordinary fallback', async () => {
  const f = await fixture(true);
  try {
    await db.executeRaw("INSERT INTO sources (id, name) VALUES ('db-only', 'Database only')");
    await db.putPage('ordinary', f.page, { sourceId: 'db-only' });
    const target = { source_id: 'db-only', slug: 'ordinary' };
    expect((await f.call('get_page_checked', target)).persistence).toBe('database_only');
    await expect(f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host,
      authority: { ...f.authority, expected: { ...f.authority.expected, database: 'wrong-example' } },
    })).rejects.toThrow('page_file_runtime_identity_mismatch');
    const reads = f.ordinaryReads();
    await expect(f.call('get_page_checked', target)).rejects.toThrow('page_file_runtime_closed');
    expect(f.ordinaryReads()).toBe(reads);
  } finally { await f.cleanup(); }
}, 60000);

test('registered read revalidates host after resolution and session borrow under coordination', async () => {
  const f = await fixture(); let lifecycle: any;
  try {
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    borrowHook = () => chmodSync(f.manifest.roots[0].journal.path, 0o755);
    const before = statements.length;
    await expect(f.call('get_page_checked', { source_id: 'default', slug: 'example' })).rejects.toThrow('page_file_host_directory_drift');
    expect(statements.slice(before).some(q => q.includes('SELECT * FROM page_file_bindings'))).toBe(false);
    expect(readFileSync(join(f.manifest.roots[0].directory.path, 'example.md'), 'utf8')).toBe('Before');
  } finally { await lifecycle?.close(); await f.cleanup(); }
}, 60000);


test('candidate never falls through to ordinary legacy, root or enrollment paths', async () => {
  const f = await fixture(); let lifecycle: any;
  try {
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    let mutated = false;
    await expect(f.runtime.withRuntimeLegacyPageWrite(f.ctx, 'default', 'example', async () => { mutated = true; })).rejects.toThrow('page_file_candidate_lifecycle_unavailable');
    await expect(f.runtime.resolvePageFileRootHost(f.ctx, f.manifest.roots[0].directory.path)).rejects.toThrow('page_file_candidate_lifecycle_unavailable');
    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example')).rejects.toThrow('page_file_candidate_lifecycle_unavailable');
    expect(mutated).toBe(false);
    expect(f.ordinaryReads()).toBe(0);
  } finally { await lifecycle?.close(); await f.cleanup(); }
}, 60000);
