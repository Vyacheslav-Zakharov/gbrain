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

async function fixture(allowDatabaseOnly = false, allowLegacy = false) {
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
  ended = 0; statements = []; borrowHook = undefined;
  const runtime = await import('../src/core/page-file-runtime.ts');
  const { operationsByName } = await import('../src/core/operations.ts');
  const call = (name: string, params: any, context = ctx) => operationsByName[name].handler(context, params) as Promise<any>;
  return { base, host, manifest, ctx, authority, runtime, call, page, backing, ordinaryReads: () => ordinaryReads,
    cleanup: async () => { borrowHook = undefined; await backing.disconnect(); rmSync(base, { recursive: true, force: true }); } };
}

test('registered candidate legacy put holds manifest root and path across ordinary DB and file tail', async () => {
  const f = await fixture(false, true); let lifecycle: any;
  let release = () => {}; let spy: any;
  try {
    const root = f.manifest.roots[0].directory.path;
    await f.backing.putPage('ordinary', f.page);
    writeFileSync(join(root, 'ordinary.md'), 'Before');
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    const privateBefore = statements.length;
    let entered!: () => void;
    const ready = new Promise<void>(r => entered = r), barrier = new Promise<void>(r => release = r);
    const getTags = f.backing.getTags.bind(f.backing);
    spy = spyOn(f.ctx.engine, 'getTags').mockImplementation(async (slug: string, opts: any) => {
      if (slug === 'ordinary') { entered(); await barrier; }
      return getTags(slug, opts);
    });
    const writer = withEnv({ GBRAIN_HOME: f.base, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, VOYAGE_API_KEY: undefined }, () => f.call('put_page', { source_id: 'default', slug: 'ordinary', content: 'After' }, { ...f.ctx, remote: true }));
    try {
      await Promise.race([ready, writer.then(() => { throw new Error('missing file-tail barrier'); })]);
      expect((await f.backing.getPage('ordinary'))!.compiled_truth).toBe('After');
      expect(readFileSync(join(root, 'ordinary.md'), 'utf8')).toBe('Before');
      for (const options of [{ rootMode: 'exclusive' as const, paths: [] }, { rootMode: 'shared' as const, paths: ['ordinary.md'] }]) {
        const lock = await acquirePageFileLock({ root, lockDirectory: f.manifest.lock.path, topology: 'single-host-local', timeoutMs: 20, ...options });
        try { expect(lock).toBeNull(); } finally { await lock?.release(); }
      }
    } finally { release(); }
    const result = await writer;
    expect(result.write_through.written).toBe(true);
    expect(readFileSync(join(root, 'ordinary.md'), 'utf8')).toContain('After');
    expect(statements.length).toBe(privateBefore);
    await expect(f.call('put_page', { source_id: 'default', slug: 'example', content: 'Rejected' })).rejects.toThrow('page_file_unsupported_writer');
    expect((await f.backing.getPage('example'))!.compiled_truth).toBe('Before');
    expect(readFileSync(join(root, 'example.md'), 'utf8')).toBe('Before');
  } finally { release(); spy?.mockRestore(); await lifecycle?.close(); await f.cleanup(); }
}, 60000);

for (const state of ['closed', 'failed', 'host-drift', 'host-drift-under-lock', 'mapping-drift-under-lock', 'production'] as const) {
  test(`registered candidate legacy put rejects ${state} before ordinary mutation`, async () => {
    const f = await fixture(false, true); let lifecycle: any; let spy: any;
    try {
      const root = f.manifest.roots[0].directory.path;
      await f.backing.putPage('ordinary', f.page);
      writeFileSync(join(root, 'ordinary.md'), 'Before');
      const before = await f.backing.getPage('ordinary');
      const options = { mode: 'offline-verification' as const, engine: f.ctx.engine, host: f.host, authority: f.authority };
      if (state === 'failed') {
        await expect(f.runtime.createPageFileRuntimeCandidate({ ...options, authority: { ...f.authority, expected: { ...f.authority.expected, database: 'wrong-example' } } })).rejects.toThrow('page_file_runtime_identity_mismatch');
      } else lifecycle = await f.runtime.createPageFileRuntimeCandidate(options);
      if (state === 'closed') await lifecycle.close();
      if (state === 'host-drift') chmodSync(f.manifest.lock.path, 0o755);
      if (state === 'production') f.ctx.config.page_file_runtime.mode = 'production';
      if (state.endsWith('under-lock')) {
        let reads = 0;
        const executeRaw = f.ctx.engine.executeRaw.bind(f.ctx.engine);
        spy = spyOn(f.ctx.engine, 'executeRaw').mockImplementation(async (query: string, values: any) => {
          if (query === 'SELECT local_path FROM sources WHERE id=$1' && ++reads === 2) {
            if (state === 'host-drift-under-lock') chmodSync(f.manifest.lock.path, 0o755);
            else return [{ local_path: f.base }];
          }
          return executeRaw(query, values);
        });
      }
      const writes = spyOn(f.backing, 'putPage');
      try {
        const code = state.startsWith('host-drift') ? 'page_file_host_directory_drift'
          : state === 'production' ? 'file_runtime_prerequisites_pending'
          : state === 'mapping-drift-under-lock' ? 'binding_changed' : 'page_file_runtime_closed';
        await expect(f.call('put_page', { source_id: 'default', slug: 'ordinary', content: 'Rejected' })).rejects.toThrow(code);
        expect(writes).not.toHaveBeenCalled();
        expect(await f.backing.getPage('ordinary')).toEqual(before);
        expect(readFileSync(join(root, 'ordinary.md'), 'utf8')).toBe('Before');
      } finally { writes.mockRestore(); }
    } finally { spy?.mockRestore(); await lifecycle?.close(); await f.cleanup(); }
  }, 60000);
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


test('candidate never falls through to ordinary enrollment paths', async () => {
  const f = await fixture(); let lifecycle: any;
  try {
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });

    await expect(f.runtime.enrollPageFileRuntime(f.ctx, 'default', 'example')).rejects.toThrow('page_file_candidate_lifecycle_unavailable');
    expect(f.ordinaryReads()).toBe(0);
  } finally { await lifecycle?.close(); await f.cleanup(); }
}, 60000);


test('candidate actual source pull uses private generation authority under exclusive root and preserves independent roots', async () => {
  const f = await fixture(false, true); let lifecycle: any;
  const root = f.manifest.roots[0].directory.path;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' }).toString().trim();
  const init = (cwd: string) => { git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'Test'); git(cwd, 'config', 'user.email', 'test@example.invalid'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'before'); git(cwd, 'checkout', '-b', 'incoming'); writeFileSync(join(cwd, 'example.md'), 'Pulled'); git(cwd, 'commit', '-am', 'incoming'); git(cwd, 'checkout', 'main'); git(cwd, 'remote', 'add', 'origin', cwd); };
  try {
    init(root);
    const ordinary = f.ctx.engine.executeRaw.bind(f.ctx.engine);
    f.ctx.engine.executeRaw = async (query: string, values?: unknown[]) => {
      if (/UPDATE\s+(?:public\.)?page_file_bindings/i.test(query)) throw new Error('ordinary_binding_update_denied');
      return ordinary(query, values);
    };
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    const { runPull } = await import('../src/commands/sources-harden.ts');
    await expect(f.ctx.engine.executeRaw('UPDATE page_file_bindings SET file_generation=file_generation+1')).rejects.toThrow('ordinary_binding_update_denied');
    await withEnv({ GBRAIN_HOME: f.base, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      const [before] = await f.backing.executeRaw<any>('SELECT file_generation FROM page_file_bindings');
      await runPull(f.ctx.engine, ['default', '--branch', 'incoming']);
      expect(readFileSync(join(root, 'example.md'), 'utf8')).toBe('Pulled');
      const [after] = await f.backing.executeRaw<any>('SELECT file_generation FROM page_file_bindings');
      expect(BigInt(after.file_generation)).toBe(BigInt(before.file_generation) + 1n);
      expect((await f.backing.getPage('example'))!.compiled_truth).toBe('Before');
      expect(statements.some(q => q.includes('UPDATE page_file_bindings SET file_generation'))).toBe(true);
      const host = (await f.runtime.resolvePageFileRootHost(f.ctx, root))!;
      const { withLegacyPageFileRootMutation } = await import('../src/core/page-file-root-gate.ts');
      await withLegacyPageFileRootMutation(f.ctx.engine, root, async () => {
        const lock = await acquirePageFileLock({ root, lockDirectory: f.manifest.lock.path, topology: 'single-host-local', rootMode: 'shared', paths: [], timeoutMs: 20 });
        try { expect(lock).toBeNull(); } finally { await lock?.release(); }
      }, host);
      await expect(withLegacyPageFileRootMutation(f.ctx.engine, root, async () => { throw new Error('interrupted'); }, host)).rejects.toThrow('interrupted');
      await expect(runPull(f.ctx.engine, ['default', '--branch', 'incoming'])).rejects.toThrow('page_file_root_sync_required');
      await expect(runPull(f.ctx.engine, ['default', '--recover-root'])).rejects.toThrow('root_recovery_approval_required');
      await runPull(f.ctx.engine, ['default', '--recover-root', '--yes']);
      expect(readFileSync(join(root, 'example.md'), 'utf8')).toBe('Pulled');
      writeFileSync(join(root, 'example.md'), 'Dirty authored bytes');
      await expect(runPull(f.ctx.engine, ['default', '--branch', 'incoming'])).rejects.toThrow('page_file_root_worktree_dirty');
      expect(readFileSync(join(root, 'example.md'), 'utf8')).toBe('Dirty authored bytes');
      await f.backing.executeRaw("UPDATE page_file_bindings SET pending_op_id='00000000-0000-0000-0000-000000000001'");
      await expect(runPull(f.ctx.engine, ['default', '--branch', 'incoming'])).rejects.toThrow('pending_recovery');
      expect(readFileSync(join(root, 'example.md'), 'utf8')).toBe('Dirty authored bytes');
      const independent = join(f.base, 'independent'); mkdirSync(independent); writeFileSync(join(independent, 'example.md'), 'Before'); init(independent);
      await f.backing.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('independent','Independent',$1)", [independent]);
      await runPull(f.ctx.engine, ['independent', '--branch', 'incoming']);
      expect(readFileSync(join(independent, 'example.md'), 'utf8')).toBe('Pulled');
    });
  } finally { await lifecycle?.close(); await f.cleanup(); }
}, 60000);


test('candidate root refuses post-borrow host drift before mutation or reconciliation', async () => {
  const f = await fixture(false, true); let lifecycle: any;
  try {
    const directory = f.manifest.roots[0].directory.path;
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    lifecycle = await f.runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine: f.ctx.engine, host: f.host, authority: f.authority });
    const root = f.manifest.roots[0].directory.path;
    const host = (await f.runtime.resolvePageFileRootHost(f.ctx, root))!;
    const { withLegacyPageFileRootMutation } = await import('../src/core/page-file-root-gate.ts');
    const { reconcilePageFileRootTransition } = await import('../src/core/page-file-root-transition.ts');
    let mutated = false;
    borrowHook = () => chmodSync(f.manifest.lock.path, 0o755);
    await expect(withLegacyPageFileRootMutation(f.ctx.engine, root, async () => { mutated = true; }, host)).rejects.toThrow('page_file_host_directory_drift');
    expect(mutated).toBe(false);
    chmodSync(f.manifest.lock.path, 0o700);
    const marker = join(f.manifest.lock.path, createHash('sha256').update(root + '\0ROOT').digest('hex') + '.dirty');
    writeFileSync(marker, 'uncertain');
    await expect(reconcilePageFileRootTransition(f.ctx.engine, host)).rejects.toThrow('page_file_host_directory_drift');
    expect(readFileSync(marker, 'utf8')).toBe('uncertain');
  } finally { borrowHook = undefined; chmodSync(f.manifest.lock.path, 0o700); await lifecycle?.close(); await f.cleanup(); }
}, 60000);
