import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Offline connected-boundary proof. Real bootstrap/files/host, PostgresEngine,
// runtime registration and authority; only discovery and SQL transport/catalog
// observation are simulated. Real PostgreSQL acceptance remains a hosted gate.
const cleanup: string[] = [];
let anchor: any, opened = 0, ended = 0, catalogValid = true;
const session = { unsafe: async () => [{ session_user: 'adapter-example', current_user: 'adapter-example', database_name: 'db-example', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }], release() {} };
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
  const secret = 'postgres://adapter-example:***@example.invalid/db-example';
  const contract = { version: 1, manifestPath: put('host', manifest), credentialPath: put('credential', secret), credentialSha256: hash(secret), ordinaryRole: 'ordinary-example', sqlAuthority: { roles: { ordinary: 'ordinary-example', adapter: 'adapter-example', enrollment: 'enrollment-example' }, catalogPins: {} }, expected: { manifestSha256: hash(JSON.stringify(manifest)), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } };
  const bootstrapSha256 = hash(JSON.stringify(contract));
  const approval = { version: 1, mode: 'production-pilot', bootstrapSha256, source: 'source-example', slug: 'page-example' };
  anchor = { mode: 'production-pilot', bootstrapPath: put('bootstrap', contract), bootstrapSha256, approvalPath: put('approval', approval), approvalSha256: hash(JSON.stringify(approval)) };
  return { put, approval, manifest, contract };
}

for (const defect of ['absent-approval', 'missing-file', 'bad-pin', 'wrong-bootstrap', 'wrong-mode', 'unknown-field', 'writable', 'foreign-source', 'indexed-approval'] as const) {
  test(`connected pilot refuses ${defect} before private credentials are opened`, async () => {
    const f = fixture(); const before = opened;
    if (defect === 'absent-approval') { delete anchor.approvalPath; delete anchor.approvalSha256; }
    if (defect === 'missing-file') rmSync(anchor.approvalPath);
    if (defect === 'bad-pin') anchor.approvalSha256 = '0'.repeat(64);
    if (defect === 'writable') chmodSync(anchor.approvalPath, 0o600);
    if (defect === 'indexed-approval') {
      anchor.approvalPath = join(f.manifest.roots[0].directory.path, 'approval');
      writeFileSync(anchor.approvalPath, JSON.stringify(f.approval), { mode: 0o400 });
    }
    if (['wrong-bootstrap', 'wrong-mode', 'unknown-field', 'foreign-source'].includes(defect)) {
      const value: any = { ...f.approval };
      if (defect === 'wrong-bootstrap') value.bootstrapSha256 = '0'.repeat(64);
      if (defect === 'wrong-mode') value.mode = 'offline-verification';
      if (defect === 'unknown-field') value.allowAll = true;
      if (defect === 'foreign-source') value.source = 'unapproved-source';
      anchor.approvalPath = f.put('bad-approval', value); anchor.approvalSha256 = hash(JSON.stringify(value));
    }
    const engine = new PostgresEngine();
    await expect(engine.connect(config)).rejects.toThrow('page_file_bootstrap_invalid');
    anchor = undefined; // rejected startup must never retry as disabled/ordinary
    await expect(engine.connect(config)).rejects.toThrow('page_file_bootstrap_invalid');
    expect(opened).toBe(before);
  });
}

test('connected absent anchor stays disabled despite config job or environment claims', async () => {
  const { withEnv } = await import('./helpers/with-env.ts');
  await withEnv({ GBRAIN_PAGE_FILE_MODE: 'production-pilot', GBRAIN_PAGE_FILE_APPROVED: 'true' }, async () => {
    const engine = new PostgresEngine();
    await engine.connect({ ...config, page_file_runtime: { mode: 'production-pilot', approval: true }, job: { approval: true } } as any);
    try {
      expect(await runtime.hasPageFileRuntimeCandidate(engine)).toBe(false);
      expect(await runtime.resolvePageFileRuntime({ engine, config: { engine: 'postgres' as const } }, 'source-example', 'page-example')).toBeUndefined();
      await expect(runtime.resolvePageFileRuntime({ engine, config: { page_file_runtime: { mode: 'production-pilot', approval: true } } as any }, 'source-example', 'page-example')).rejects.toThrow('file_runtime_prerequisites_pending');
      await expect(runtime.createPageFileRuntimeCandidate({ mode: 'production-pilot', engine, admission: { approved: true }, authority: { mode: 'production-pilot' }, host: {} } as any)).rejects.toThrow('page_file_pilot_approval_required');
    } finally { await engine.disconnect(); }
  });
});

test('connected admission preserves catalog refusal and revalidates revoked approval', async () => {
  fixture(); catalogValid = false;
  const refused = new PostgresEngine(); const before = opened;
  await expect(refused.connect(config)).rejects.toThrow('page_file_bootstrap_start_failed');
  expect(opened).toBe(before);
  catalogValid = true;
  const engine = new PostgresEngine(); await engine.connect(config);
  try {
    chmodSync(anchor.approvalPath, 0o600);
    await expect(runtime.hasPageFileRuntimeCandidate(engine)).rejects.toThrow('page_file_bootstrap_invalid');
    await expect(engine.reconnect()).rejects.toThrow('page_file_bootstrap_invalid');
  } finally { await engine.disconnect(); }
});


test('connected explicit protected pilot admits only the pinned page and retains schema guard', async () => {
  const f = fixture(); const engine = new PostgresEngine();
  await engine.connect(config);
  try {
    expect(await runtime.hasPageFileRuntimeCandidate(engine)).toBe(true);
    await engine.initSchema(); // must revalidate, never attempt release DDL
    engine.executeRaw = (async () => [{ canonical_root: f.manifest.roots[0].directory.path, relative_path: 'page-example.md', binding_id: 'fixture' }]) as any;
    const ctx = { engine, config: { engine: 'postgres' as const } };
    expect(await runtime.resolvePageFileRuntime(ctx, 'source-example', 'page-example')).toBeDefined();
    await expect(runtime.resolvePageFileRuntime(ctx, 'source-example', 'other-page')).rejects.toThrow('page_file_pilot_target_unapproved');
    await expect(runtime.resolvePageFileRuntime(ctx, 'other-source', 'page-example')).rejects.toThrow('page_file_pilot_target_unapproved');
    engine.executeRaw = (async () => []) as any;
    expect(await runtime.resolvePageFileRuntime(ctx, 'source-example', 'unenrolled-page')).toBeUndefined();
  } finally { await engine.disconnect(); }
  await expect(runtime.hasPageFileRuntimeCandidate(engine)).rejects.toThrow('page_file_runtime_closed');
});

test('production operator reuses exact approval and separate reviewed enrollment contract', async () => {
  const f = fixture();
  const reviewed = { hostManifestSha256: f.contract.expected.manifestSha256, source: f.approval.source, slug: f.approval.slug, pageId: '1', revision: 'reviewed-revision', canonicalRoot: f.manifest.roots[0].directory.path, relativePath: 'page-example.md', rawSha256: 'a'.repeat(64) };
  const secret = 'postgres://enrollment-example:***@example.invalid/db-example';
  const operatorContract = { version: 1, mode: 'production-pilot', bootstrap: anchor, enrollmentCredentialPath: f.put('enrollment', secret), enrollmentCredentialSha256: hash(secret), reviewedPath: f.put('reviewed', reviewed), reviewedSha256: hash(JSON.stringify(reviewed)) };
  const operatorPath = f.put('operator', operatorContract);
  const operatorAnchor = f.put('operator-anchor', { operatorPath, operatorSha256: hash(JSON.stringify(operatorContract)) });
  const { loadPageFileOperator } = await import('../src/commands/page-file-operator.ts');
  const operator = loadPageFileOperator({ remote: false }, operatorAnchor);
  operator.verifyStartup();
  const request = await operator.enrollment({ remote: false });
  expect(request.authority.mode).toBe('production-pilot');
  expect(request.reviewed).toEqual(reviewed);
  expect(await request.authority.resolveCredential(request.authority.credentialReference)).toBe(secret);
  // Deliberately wrong observed DB identity: reaching this check proves production
  // was not silently relabeled offline or refused by the obsolete mode guard.
  const { createPageFileEnrollmentAuthority } = await import('../src/core/page-file-authority.ts');
  await expect(createPageFileEnrollmentAuthority(request.authority)).rejects.toThrow('page_file_authority_identity_mismatch');
  const engine = new PostgresEngine(); await engine.connect(config);
  try {
    await expect(runtime.enrollPageFileRuntime({ engine, config: { engine: 'postgres' as const }, remote: false }, 'source-example', 'other-page', { ...request, reviewed: { ...reviewed, slug: 'other-page' } })).rejects.toThrow('page_file_pilot_target_unapproved');
  } finally { await engine.disconnect(); }
});
