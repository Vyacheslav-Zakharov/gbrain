import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, writeFileSync, rmSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Offline connected-boundary proof. Real bootstrap/files/host, PostgresEngine,
// runtime registration and authority; only discovery and SQL transport/catalog
// observation are simulated. Real PostgreSQL acceptance remains a hosted gate.
const cleanup: string[] = [];
let anchor: any, opened = 0, ended = 0, catalogValid = true;
let rows: any[] = [];
const session = { unsafe: async (sql: string) => {
 if (sql.includes('to_regclass')) return [{ present: true }];
 if (sql === 'SELECT * FROM public.page_file_bindings') return rows;
 if (sql.startsWith('UPDATE page_file_bindings')) { for (const row of rows) row.file_generation++; return []; }
 return [{ session_user: 'adapter-example', current_user: 'adapter-example', database_name: 'db-example', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }]; }, release() {} };
const pool: any = Object.assign(async () => [], { reserve: async () => session, unsafe: async () => [], begin: async (fn: any) => fn(pool), end: async () => { ended++; } });
mock.module('postgres', () => ({ default: Object.assign(() => { opened++; return pool; }, { BigInt: {} }) }));
const db = await import('../src/core/db.ts');
mock.module('../src/core/db.ts', () => ({ ...db, connect: async () => false, getConnection: () => pool, disconnect: async () => {} }));
mock.module('../src/core/page-file-sql-authority.ts', () => ({ verifyPageFileSqlAuthority: async () => ({ ok: catalogValid }) }));
const bootstrap = await import('../src/core/page-file-bootstrap.ts');
const load = bootstrap.loadPageFileBootstrap;
mock.module('../src/core/page-file-bootstrap.ts', () => ({ ...bootstrap, loadPageFileStartupBootstrap: () => load(anchor) }));
const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
const runtime = await import('../src/core/page-file-runtime.ts');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const config = { database_url: 'postgres://ordinary-example@example.invalid/db-example' };
afterEach(() => { anchor = undefined; catalogValid = true; for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'pilot-test-')); cleanup.push(base);
  const put = (name: string, value: unknown) => { const p = join(base, name); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o400 }); return p; };
  const pin = (name: string) => { const path = join(base, name); mkdirSync(path, { mode: 0o700 }); const s = lstatSync(path, { bigint: true }); return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 }; };
  const manifest = { version: 1, deploymentId: 'pilot-example', brainId: '11111111-1111-4111-8111-111111111111', database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local', serviceUid: process.getuid!(), roots: [{ sourceId: 'source-example', mappingGeneration: '1', directory: pin('root'), journal: pin('journal') }], lock: pin('lock'), indexedRoots: [] };
  manifest.roots.push({ sourceId: 'other-source', mappingGeneration: '1', directory: pin('other-root'), journal: pin('other-journal') });
  const secret = 'postgres://adapter-example:***@example.invalid/db-example';
  const contract = { version: 1, manifestPath: put('host', manifest), credentialPath: put('credential', secret), credentialSha256: hash(secret), ordinaryRole: 'ordinary-example', sqlAuthority: { roles: { ordinary: 'ordinary-example', adapter: 'adapter-example', enrollment: 'enrollment-example' }, catalogPins: {} }, expected: { manifestSha256: hash(JSON.stringify(manifest)), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } };
  const bootstrapSha256 = hash(JSON.stringify(contract));
  const approval = { version: 1, mode: 'production-pilot', bootstrapSha256, source: 'source-example', slug: 'page-example' };
  anchor = { mode: 'production-pilot', bootstrapPath: put('bootstrap', contract), bootstrapSha256, approvalPath: put('approval', approval), approvalSha256: hash(JSON.stringify(approval)) };
  return { put, approval, manifest, contract };
}
import { execFileSync } from 'node:child_process';
test('pilot does not grant private root service for another manifest source', async () => {
 const f = fixture(); const root = f.manifest.roots[1].directory.path;
 const engine = new PostgresEngine(); await engine.connect(config);
 engine.executeRaw = (async () => [{ local_path: root }]) as any;
 try {
  await expect(runtime.resolvePageFileRootHost({ engine, config: { engine: 'postgres' } }, root)).rejects.toThrow('page_file_pilot_target_unapproved');
 } finally { await engine.disconnect(); }
});
for (const operation of ['transition', 'reconcile'] as const) {
 test(`pilot root ${operation} refuses late mixed cohort without mutation`, async () => {
  const f = fixture(); const root = f.manifest.roots[0].directory.path;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  writeFileSync(join(root, 'page-example.md'), 'approved');
  writeFileSync(join(root, 'other.md'), 'unapproved');
  git('init', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  rows = [{ binding_id: 'a', source_id: 'source-example', slug: 'page-example', canonical_root: root, relative_path: 'page-example.md', pending_op_id: null, file_generation: 1 }];
  const engine = new PostgresEngine(); await engine.connect(config);
  engine.executeRaw = (async () => [{ local_path: root }]) as any;
  try {
   const host = (await runtime.resolvePageFileRootHost({ engine, config: { engine: 'postgres' } }, root))!;
   // Enrollment changes after resolution must be observed inside the root lock.
   rows.push({ ...rows[0], binding_id: 'b', slug: 'other', relative_path: 'other.md' });
   const marker = join(f.manifest.lock.path, hash(root + '\0ROOT') + '.dirty');
   if (operation === 'reconcile') writeFileSync(marker, 'original dirty marker');
   const snapshot = () => ({ rows: JSON.stringify(rows), files: ['page-example.md', 'other.md'].map(p => readFileSync(join(root, p), 'utf8')), git: git('rev-parse', 'HEAD') + git('status', '--porcelain'), journal: readdirSync(f.manifest.roots[0].journal.path), markers: readdirSync(f.manifest.lock.path).filter(p => p.includes('.dirty')).map(p => [p, readFileSync(join(f.manifest.lock.path, p), 'utf8')]) });
   writeFileSync(join(f.manifest.roots[0].journal.path, 'pending-intent'), 'retained journal evidence');
   const journalBefore = readFileSync(join(f.manifest.roots[0].journal.path, 'pending-intent'));
   const before = snapshot(); let called = false;
   await expect(operation === 'transition' ? host.transition!(async () => { called = true; }) : host.reconcile!()).rejects.toThrow('page_file_pilot_target_unapproved');
   expect(called).toBe(false); expect(snapshot()).toEqual(before);
   expect(readFileSync(join(f.manifest.roots[0].journal.path, 'pending-intent'))).toEqual(journalBefore);
  } finally { await engine.disconnect(); }
 });
}
test('approved-only pilot root retains transition and dirty reconciliation', async () => {
 const f = fixture(); const root = f.manifest.roots[0].directory.path;
 const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
 writeFileSync(join(root, 'page-example.md'), 'approved');
 git('init', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
 rows = [{ binding_id: 'a', source_id: 'source-example', slug: 'page-example', canonical_root: root, relative_path: 'page-example.md', pending_op_id: null, file_generation: 1 }];
 const engine = new PostgresEngine(); await engine.connect(config);
 engine.executeRaw = (async () => [{ local_path: root }]) as any;
 try {
  const host = (await runtime.resolvePageFileRootHost({ engine, config: { engine: 'postgres' } }, root))!;
  expect(await host.transition!(async () => 'approved')).toBe('approved');
  expect(rows[0].file_generation).toBe(2);
  const marker = join(f.manifest.lock.path, hash(root + '\0ROOT') + '.dirty');
  writeFileSync(marker, 'interrupted'); await host.reconcile!();
  expect(readdirSync(f.manifest.lock.path).filter(p => p.endsWith('.dirty'))).toEqual([]);
 } finally { await engine.disconnect(); }
});
