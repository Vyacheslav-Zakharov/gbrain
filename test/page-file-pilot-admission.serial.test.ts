import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, writeFileSync, rmSync, chmodSync, renameSync } from 'node:fs';
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
function fixture(sourceSet = false) {
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'pilot-test-')); cleanup.push(base);
  const put = (name: string, value: unknown) => { const p = join(base, name); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o400 }); return p; };
  const pin = (name: string) => { const path = join(base, name); mkdirSync(path, { mode: 0o700 }); const s = lstatSync(path, { bigint: true }); return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 }; };
  const manifest = { version: 1, deploymentId: 'pilot-example', brainId: '11111111-1111-4111-8111-111111111111', database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local', serviceUid: process.getuid!(), roots: [{ sourceId: 'source-example', mappingGeneration: '1', directory: pin('root'), journal: pin('journal') }], lock: pin('lock'), indexedRoots: [] };
  if (sourceSet) manifest.roots.push({ sourceId: 'second-source', mappingGeneration: '2', directory: pin('second-root'), journal: pin('second-journal') });
  const secret = 'postgres://adapter-example:***@example.invalid/db-example';
  const contract = { version: 1, manifestPath: put('host', manifest), credentialPath: put('credential', secret), credentialSha256: hash(secret), ordinaryRole: 'ordinary-example', sqlAuthority: { roles: { ordinary: 'ordinary-example', adapter: 'adapter-example', enrollment: 'enrollment-example' }, catalogPins: {} }, expected: { manifestSha256: hash(JSON.stringify(manifest)), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } };
  const bootstrapSha256 = hash(JSON.stringify(contract));
  const approval: any = sourceSet
    ? { version: 2, mode: 'production-pilot', bootstrapSha256, sources: ['source-example', 'second-source'] }
    : { version: 1, mode: 'production-pilot', bootstrapSha256, source: 'source-example', slug: 'page-example' };
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

// Explicit v2 source admission; the v1 single-page tests remain unchanged.
// Real file binding eligibility; enrollment catalog/SQL transport remain simulated.
test('source-wide admission resolves a second eligible enrolled page in the approved source', async () => {
  const f = fixture(true);
  const root = f.manifest.roots[0].directory.path;
  const slugs = ['page-example', 'second-page-example'];
  const sources = [{ id: 'source-example', local_path: root }];
  const paths = slugs.map((slug, i) => ({ pageId: String(i + 1), sourceId: 'source-example', sourcePath: `${slug}.md` }));
  const { resolveExistingPageFileBinding } = await import('../src/core/page-file-binding.ts');
  const bindings = new Map<string, { canonical_root: string; relative_path: string; binding_id: string }>();
  for (const [i, slug] of slugs.entries()) {
    writeFileSync(join(root, `${slug}.md`), `---\ntitle: ${slug}\ntype: note\n---\n\nFixture body.\n`);
    const observed = await resolveExistingPageFileBinding({ brainId: f.manifest.brainId,
      sourceId: 'source-example', slug, pageId: String(i + 1), sourcePath: `${slug}.md`,
      sources, otherPagePaths: paths, globalRepoPath: null, configGeneration: '1' });
    expect(observed.relativePath).toBe(`${slug}.md`);
    bindings.set(slug, { canonical_root: observed.canonicalRoot, relative_path: observed.relativePath, binding_id: `binding-${i + 1}` });
  }
  const engine = new PostgresEngine(); await engine.connect(config);
  try {
    engine.executeRaw = (async (sql: string, params: unknown[]) => {
      if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') return [];
      expect(sql).toBe('SELECT canonical_root,relative_path,binding_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2');
      expect(params[0]).toBe('source-example');
      const binding = bindings.get(params[1] as string);
      return binding ? [binding] : [];
    }) as any;
    const ctx = { engine, config: { engine: 'postgres' as const } };
    expect(await runtime.resolvePageFileRuntime(ctx, 'source-example', slugs[0]!)).toBeDefined();
    // A second eligible binding needs no new deployment approval.
    expect(await runtime.resolvePageFileRuntime(ctx, 'source-example', slugs[1]!)).toBeDefined();
    expect(await runtime.resolvePageFileRuntime(ctx, 'source-example', 'future-page')).toBeUndefined();
    writeFileSync(join(root, 'future-page.md'), '# Future page\n');
    paths.push({ pageId: '3', sourceId: 'source-example', sourcePath: 'future-page.md' });
    const future = await resolveExistingPageFileBinding({ brainId: f.manifest.brainId, sourceId: 'source-example',
      slug: 'future-page', pageId: '3', sourcePath: 'future-page.md', sources, otherPagePaths: paths, globalRepoPath: null, configGeneration: '1' });
    // Simulate separate enrollment after startup; resolution never enrolls.
    bindings.set('future-page', { canonical_root: future.canonicalRoot, relative_path: future.relativePath, binding_id: 'binding-3' });
    expect(await runtime.resolvePageFileRuntime(ctx, 'source-example', 'future-page')).toBeDefined();
  } finally { await engine.disconnect(); }
});

test('source-wide admission still denies an enrolled same-slug page in an unapproved source', async () => {
  const f = fixture(true); const engine = new PostgresEngine(); await engine.connect(config);
  try {
    engine.executeRaw = (async (sql: string, params: unknown[]) => {
      if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') return [];
      expect(sql).toBe('SELECT canonical_root,relative_path,binding_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2');
      expect(params).toEqual(['unapproved-source', 'page-example']);
      // Even a colliding catalog row must not borrow the approved source's root.
      return [{ canonical_root: f.manifest.roots[0].directory.path, relative_path: 'page-example.md', binding_id: 'foreign-binding' }];
    }) as any;
    await expect(runtime.resolvePageFileRuntime({ engine, config: { engine: 'postgres' as const } },
      'unapproved-source', 'page-example')).rejects.toThrow('page_file_pilot_target_unapproved');
  } finally { await engine.disconnect(); }
});

test('restored approval requires fresh admission rather than reviving retained authority', async () => {
  fixture();
  const loaded = load(anchor) as any;
  const { createPageFileAuthority } = await import('../src/core/page-file-authority.ts');
  const options = { mode: 'production-pilot' as const, admission: loaded.admission,
    revalidate: async () => loaded.revalidate(), credentialReference: 'fixture',
    resolveCredential: async () => 'postgres://adapter-example@example.invalid/db-example',
    expected: { role: 'adapter-example', database: 'db-example', ordinaryRole: 'ordinary-example' } };
  const authority = await createPageFileAuthority(options);
  const original = lstatSync(anchor.approvalPath, { bigint: true });
  const closedBefore = ended;
  try {
    await authority.revalidate();
    renameSync(anchor.approvalPath, anchor.approvalPath + '.revoked');
    await expect(authority.revalidate()).rejects.toMatchObject({ message: 'page_file_authority_unavailable' });
    renameSync(anchor.approvalPath + '.revoked', anchor.approvalPath);
    const restored = lstatSync(anchor.approvalPath, { bigint: true });
    expect(restored.ino).toBe(original.ino);
    expect(restored.ctimeNs).not.toBe(original.ctimeNs);
    expect(ended).toBe(closedBefore); // failed revalidation does not close the pool
    await expect(authority.revalidate()).rejects.toMatchObject({ message: 'page_file_authority_unavailable' });
    // Fresh connected startup independently reloads the unchanged digest pins;
    // never replace the retained authority's captured fingerprint.
    const openedBefore = opened;
    const fresh = new PostgresEngine();
    try {
      await fresh.connect(config);
      expect(opened).toBeGreaterThan(openedBefore);
      expect(await runtime.hasPageFileRuntimeCandidate(fresh)).toBe(true);
      await fresh.initSchema();
      await expect(authority.revalidate()).rejects.toMatchObject({ message: 'page_file_authority_unavailable' });
    } finally { await fresh.disconnect(); }
  } finally { await authority.close(); }
});

for (const defect of ['empty', 'duplicate', 'unknown', 'legacy-fields', 'wrong-version', 'wrong-bootstrap'] as const) {
  test(`v2 rejects ${defect} source approval before credential access`, async () => {
    const f = fixture(true); const before = opened; const value = { ...f.approval };
    if (defect === 'empty') value.sources = [];
    if (defect === 'duplicate') value.sources = ['source-example', 'source-example'];
    if (defect === 'unknown') value.sources = ['source-example', 'missing-source'];
    if (defect === 'legacy-fields') value.slug = 'page-example';
    if (defect === 'wrong-version') value.version = 1;
    if (defect === 'wrong-bootstrap') value.bootstrapSha256 = '0'.repeat(64);
    anchor.approvalPath = f.put('invalid-v2', value); anchor.approvalSha256 = hash(JSON.stringify(value));
    await expect(new PostgresEngine().connect(config)).rejects.toThrow('page_file_bootstrap_invalid');
    expect(opened).toBe(before);
  });
}

for (const defect of ['revoked', 'tampered', 'catalog'] as const) {
  test(`v2 retained runtime rejects ${defect} without ordinary fallback`, async () => {
    const f = fixture(true); const engine = new PostgresEngine(); await engine.connect(config);
    engine.executeRaw = (async () => { return [{ canonical_root: f.manifest.roots[0].directory.path, relative_path: 'page-example.md', binding_id: 'a' }]; }) as any;
    try {
      const ctx = { engine, config: { engine: 'postgres' as const } };
      const retained = (await runtime.resolvePageFileRuntime(ctx, 'source-example', 'page-example'))!;
      if (defect === 'revoked') rmSync(anchor.approvalPath);
      if (defect === 'tampered') { chmodSync(anchor.approvalPath, 0o600); writeFileSync(anchor.approvalPath, JSON.stringify({ ...f.approval, sources: ['second-source'] })); chmodSync(anchor.approvalPath, 0o400); }
      if (defect === 'catalog') catalogValid = false;
      await expect(runtime.resolvePageFileRuntime(ctx, 'source-example', 'page-example')).rejects.toThrow();
      await expect(Promise.resolve().then(() => retained.pages.get('source-example', 'page-example', () => {}))).rejects.toThrow();
      expect(await runtime.resolvePageFileRuntime(ctx, 'source-example', 'new-page').then(() => true, () => false)).toBe(false);
    } finally { await engine.disconnect(); }
  });
}

test('v2 capabilities cannot be serialized or interchanged even for identical bootstrap pins', async () => {
  fixture(true); const first = load(anchor) as any; const second = load(anchor) as any;
  expect(() => bootstrap.requirePageFilePilotAdmission(JSON.parse(JSON.stringify(first.admission)))).toThrow('page_file_pilot_approval_required');
  const scope = bootstrap.requirePageFilePilotAdmission(first.admission);
  expect(Object.isFrozen(scope)).toBe(true);
  expect(Object.isFrozen(scope.sources)).toBe(true);
  const before = opened;
  await expect(runtime.createPageFileRuntimeCandidate({ mode: 'production-pilot', engine: new PostgresEngine(), admission: first.admission,
    authority: { mode: 'production-pilot', admission: second.admission }, host: {} } as any)).rejects.toThrow('file_runtime_prerequisites_pending');
  expect(opened).toBe(before);
});

test('v2 resolves same slug independently across selected sources and rejects wrong root', async () => {
  const f = fixture(true); const engine = new PostgresEngine(); await engine.connect(config);
  let wrongRoot = false;
  engine.executeRaw = (async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SET TRANSACTION')) return [];
    const root = f.manifest.roots.find(r => r.sourceId === params[0])!;
    return [{ canonical_root: wrongRoot ? f.manifest.roots[0].directory.path : root.directory.path, relative_path: 'same.md', binding_id: String(params[0]) }];
  }) as any;
  try {
    const ctx = { engine, config: { engine: 'postgres' as const } };
    for (const source of f.approval.sources) expect(await runtime.resolvePageFileRuntime(ctx, source, 'same')).toBeDefined();
    wrongRoot = true;
    await expect(runtime.resolvePageFileRuntime(ctx, 'second-source', 'same')).rejects.toThrow('binding_changed');
  } finally { await engine.disconnect(); }
  await expect(runtime.resolvePageFileRuntime({ engine, config: { engine: 'postgres' } }, 'second-source', 'same')).rejects.toThrow('page_file_runtime_closed');
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
