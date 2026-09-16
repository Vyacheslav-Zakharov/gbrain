import { test, expect, mock, spyOn } from 'bun:test';
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

async function fixture() {
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'import-runtime-authority-'));
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
      && !query.startsWith('SELECT slug,canonical_root,relative_path FROM page_file_bindings')) throw new Error('ordinary_sql_forbidden');
    return backing.executeRaw(query, values);
  } };
  engine.getChunks = (slug: string, opts: any) => backing.getChunks(slug, opts);
  const ctx: any = { engine, config: { engine: 'postgres'}, remote: false, sourceId: 'default', dryRun: false };
  const authority = { mode: 'offline-verification' as const, credentialReference: 'offline-fixture', resolveCredential: async () => 'postgres://fixture.invalid/offline', expected: { role: manifest.adapterRole, database: manifest.database, ordinaryRole: 'ordinary-example' } };
  ended = 0; statements = []; borrowHook = undefined;
  const runtime = await import('../src/core/page-file-runtime.ts');
  return { base, host, manifest, ctx, authority, runtime, page, backing, ordinaryReads: () => ordinaryReads,
    cleanup: async () => { borrowHook = undefined; await backing.disconnect(); rmSync(base, { recursive: true, force: true }); } };
}

test('actual import uses registered private authority with normal config for external file change', async () => {
  const f = await fixture(); let lifecycle: any;
  const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider_forbidden'));
  try {
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    const { importFromFile } = await import('../src/core/import-file.ts');
    const path = join(f.manifest.roots[0].directory.path, 'example.md');
    writeFileSync(path, 'After external approval');
    const before = lstatSync(path, { bigint: true });
    const result = await importFromFile(f.ctx.engine, path, 'example.md', { config: f.ctx.config, sourceId: 'default' });
    expect(result.status).toBe('imported');
    expect((await f.backing.getPage('example'))!.compiled_truth).toBe('After external approval');
    expect(statements.some(q => q.includes('INSERT INTO page_file_write_authorizations'))).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('After external approval');
    const after = lstatSync(path, { bigint: true });
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
    expect(network).not.toHaveBeenCalled();
    expect((await importFromFile(f.ctx.engine, path, 'example.md', { config: f.ctx.config })).status).toBe('skipped');
  } finally { network.mockRestore(); await lifecycle?.close(); await f.cleanup(); }
}, 60000);

for (const state of ['stale', 'closed', 'failed', 'host-drift', 'host-drift-after-capture', 'production'] as const) {
  test(`actual import refuses ${state} without acknowledgment, providers or file writeback`, async () => {
    const f = await fixture(); let lifecycle: any;
    const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider_forbidden'));
    try {
      const options = { mode: 'offline-verification' as const, engine: f.ctx.engine, host: f.host, authority: f.authority };
      if (state === 'failed') {
        await expect(f.runtime.createPageFileRuntimeCandidate({ ...options, authority: { ...f.authority, expected: { ...f.authority.expected, database: 'wrong-example' } } })).rejects.toThrow('page_file_runtime_identity_mismatch');
      } else lifecycle = await f.runtime.createPageFileRuntimeCandidate(options);
      const path = join(f.manifest.roots[0].directory.path, 'example.md');
      writeFileSync(path, 'After external approval');
      const before = await f.backing.getPage('example');
      const bindings = await f.backing.executeRaw('SELECT * FROM page_file_bindings');
      if (state === 'closed') await lifecycle.close();
      if (state === 'host-drift') chmodSync(f.manifest.lock.path, 0o755);
      if (state === 'production') f.ctx.config.page_file_runtime = { mode: 'production' };
      let borrows = 0;
      borrowHook = () => {
        if (++borrows === 2) {
          if (state === 'stale') writeFileSync(path, 'Newer external edit');
          if (state === 'host-drift-after-capture') chmodSync(f.manifest.lock.path, 0o755);
        }
      };
      const { importFromFile } = await import('../src/core/import-file.ts');
      let error: any;
      try { await importFromFile(f.ctx.engine, path, 'example.md', { config: f.ctx.config }); }
      catch (caught) { error = caught; }
      const code = state === 'stale' ? 'stale_file_baseline' : state.startsWith('host-drift') ? 'page_file_host_directory_drift'
        : state === 'production' ? 'file_runtime_prerequisites_pending' : 'page_file_runtime_closed';
      expect(error?.code).toBe(code);
      expect(error?.acknowledgeable).toBe(false);
      expect(await f.backing.getPage('example')).toEqual(before);
      expect(await f.backing.executeRaw('SELECT * FROM page_file_bindings')).toEqual(bindings);
      expect(await f.backing.executeRaw('SELECT * FROM page_file_operations')).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe(state === 'stale' ? 'Newer external edit' : 'After external approval');
      expect(network).not.toHaveBeenCalled();
      expect(statements.some(q => q.includes('INSERT INTO page_file_write_authorizations'))).toBe(false);
    } finally { network.mockRestore(); await lifecycle?.close(); await f.cleanup(); }
  }, 60000);
}
