import { afterEach, expect, test, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, rmSync, chmodSync, symlinkSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
const api = () => import('../src/core/page-file-bootstrap.ts').catch(() => ({} as any));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'bootstrap-test-')); cleanup.push(base);
  const pin = (name: string) => {
    const path = join(base, name); mkdirSync(path, { mode: 0o700 });
    const s = lstatSync(path, { bigint: true });
    return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 };
  };
  const manifest = { version: 1, deploymentId: 'deployment-example', brainId: '11111111-1111-4111-8111-111111111111', database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local', serviceUid: process.getuid!(), roots: [{ sourceId: 'source-example', mappingGeneration: '1', directory: pin('root'), journal: pin('journal') }], lock: pin('lock'), indexedRoots: [] };
  const manifestJson = JSON.stringify(manifest);
  const secret = 'postgres://adapter-example:***@example.invalid/db-example';
  const put = (name: string, text: string) => { const path = join(base, name); writeFileSync(path, text, { mode: 0o400 }); return path; };
  const contract = { sqlAuthority: { roles: { ordinary: 'ordinary-example', adapter: 'adapter-example', enrollment: 'enrollment-example' }, catalogPins: {} }, version: 1, manifestPath: put('manifest.json', manifestJson), expected: { manifestSha256: hash(manifestJson), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation }, ordinaryRole: 'ordinary-example', credentialSha256: hash(secret), credentialPath: put('credential', secret) };
  const bootstrapJson = JSON.stringify(contract);
  const anchor = { mode: 'offline-verification' as const, bootstrapPath: put('bootstrap.json', bootstrapJson), bootstrapSha256: hash(bootstrapJson) };
  return { base, manifest, contract, anchor, secret, put };
}

test('protected files reconstruct an immutable redacted contract and detect drift', async () => {
  const { loadPageFileBootstrap } = await api();
  const f = fixture();
  const first = loadPageFileBootstrap(f.anchor);
  const second = loadPageFileBootstrap(JSON.parse(JSON.stringify(f.anchor)));
  expect(first.contract).toEqual(second.contract);
  expect(Object.isFrozen(first.contract.expected)).toBe(true);
  expect(JSON.stringify(first)).not.toContain(f.secret);
  expect(() => first.revalidate()).not.toThrow();
  chmodSync(f.contract.manifestPath, 0o600);
  expect(() => first.revalidate()).toThrow('page_file_bootstrap_invalid');
});

test('default disabled; rejects payload authority and production mode', async () => {
  const mod = await api(); expect(typeof mod.loadPageFileBootstrap).toBe('function');
  const disabled = mod.loadPageFileBootstrap();
  expect(disabled.status).toBe('disabled');
  expect(await disabled.start({})).toBeUndefined();
  expect(() => mod.loadPageFileBootstrap({ mode: 'production' })).toThrow('page_file_bootstrap_invalid');
  expect(() => mod.loadPageFileBootstrap({ mode: 'offline-verification', config: { page_file_runtime: {} } })).toThrow('page_file_bootstrap_invalid');
});

for (const target of ['bootstrap', 'manifest', 'credential'] as const) {
  for (const defect of ['missing', 'symlink', 'writable', 'content', 'replacement', 'owner'] as const) {
    test(`${target} refuses ${defect} without repair or secret disclosure`, async () => {
      const { loadPageFileBootstrap } = await api();
      const f = fixture();
      const loaded = loadPageFileBootstrap(f.anchor);
      const path = target === 'bootstrap' ? f.anchor.bootstrapPath : target === 'manifest' ? f.contract.manifestPath : f.contract.credentialPath;
      if (defect === 'missing') rmSync(path);
      if (defect === 'symlink') { renameSync(path, path + '-old'); symlinkSync(path + '-old', path); }
      if (defect === 'writable') chmodSync(path, target === 'credential' ? 0o666 : 0o600);
      if (defect === 'content') { chmodSync(path, 0o600); writeFileSync(path, f.secret + '-drift'); chmodSync(path, 0o400); }
      if (defect === 'replacement') { renameSync(path, path + '-old'); writeFileSync(path, '{}', { mode: 0o400 }); }
      // A forged uid in the manifest is checked by the shared host validator.
      if (defect === 'owner') {
        f.manifest.serviceUid++;
        chmodSync(f.contract.manifestPath, 0o600);
        writeFileSync(f.contract.manifestPath, JSON.stringify(f.manifest));
        chmodSync(f.contract.manifestPath, 0o400);
      }
      expect(() => loaded.revalidate()).toThrow('page_file_bootstrap_invalid');
      expect(() => loadPageFileBootstrap(f.anchor)).toThrow('page_file_bootstrap_invalid');
      try { loaded.revalidate(); } catch (error) {
        expect(String(error)).not.toContain(f.secret);
        expect((error as Error).cause).toBeUndefined();
      }
    });
  }
}

test('external anchor prevents self-repinning, ignores caller mutation, refuses writable ancestors', async () => {
  const { loadPageFileBootstrap } = await api();
  const f = fixture(); const loaded = loadPageFileBootstrap(f.anchor);
  f.anchor.bootstrapSha256 = '0'.repeat(64);
  expect(() => loaded.revalidate()).not.toThrow();
  expect(() => loadPageFileBootstrap(f.anchor)).toThrow('page_file_bootstrap_invalid');
  chmodSync(f.base, 0o777);
  expect(() => loaded.revalidate()).toThrow('page_file_bootstrap_invalid');
  chmodSync(f.base, 0o700);
});

test('lifecycle delegates to private candidate, reconstructs identically and closes once', async () => {
  const f = fixture(); const calls: any[] = []; let closes = 0;
  // Serial quarantine: isolate the DB boundary only; file/host checks are real.
  mock.module('../src/core/page-file-runtime.ts', () => ({
    async createPageFileRuntimeCandidate(options: any) {
      expect(await options.authority.resolveCredential(options.authority.credentialReference)).toBe(f.secret);
      await expect(options.authority.resolveCredential('/untrusted')).rejects.toThrow('page_file_bootstrap_invalid');
      calls.push(options);
      return { async close() { closes++; } };
    },
  }));
  try {
    const { loadPageFileBootstrap } = await api();
    for (const engine of [{ kind: 'postgres' }, { kind: 'postgres' }]) {
      const loader = loadPageFileBootstrap(JSON.parse(JSON.stringify(f.anchor)));
      const lifecycle = await loader.start(engine);
      expect(JSON.stringify(lifecycle)).not.toContain(f.secret);
      await Promise.all([lifecycle.close(), lifecycle.close()]);
    }
    expect(closes).toBe(2);
    expect(calls[0].host).toEqual(calls[1].host);
    expect(calls[0].authority.expected).toEqual(calls[1].authority.expected);
    expect(calls[0].engine).not.toBe(calls[1].engine);
    chmodSync(f.contract.credentialPath, 0o644);
    await expect(calls[0].authority.resolveCredential(f.contract.credentialPath)).rejects.toThrow('page_file_bootstrap_invalid');
  } finally { mock.restore(); }
});

test('candidate and shutdown errors are redacted without ordinary fallback', async () => {
  const f = fixture(); let calls = 0;
  mock.module('../src/core/page-file-runtime.ts', () => ({ async createPageFileRuntimeCandidate() {
    calls++;
    if (calls === 1) throw new Error(f.secret);
    return { async close() { throw new Error(f.secret); } };
  } }));
  try {
    const { loadPageFileBootstrap } = await api();
    const loader = loadPageFileBootstrap(f.anchor);
    await expect(loader.start({})).rejects.toThrow('page_file_bootstrap_start_failed');
    const lifecycle = await loader.start({});
    await expect(lifecycle.close()).rejects.toThrow('page_file_bootstrap_shutdown_failed');
    expect(calls).toBe(2);
  } finally { mock.restore(); }
});


test('protected file validation is retained on every authority borrow', async () => {
  const f = fixture(); let captured: any;
  mock.module('../src/core/page-file-runtime.ts', () => ({ async createPageFileRuntimeCandidate(options: any) {
    captured = options; return { async close() {} };
  } }));
  const { loadPageFileBootstrap } = await api();
  await loadPageFileBootstrap(f.anchor).start({} as any);
  expect(typeof captured.authority.revalidate).toBe('function');
  chmodSync(f.anchor.bootstrapPath, 0o600);
  await expect(captured.authority.revalidate()).rejects.toThrow('page_file_bootstrap_invalid');
});

test('bootstrap and credential evidence cannot live in indexed content', async () => {
  const { loadPageFileBootstrap } = await api();
  const f = fixture();
  const path = join(f.manifest.roots[0].directory.path, 'credential');
  renameSync(f.contract.credentialPath, path);
  f.contract.credentialPath = path;
  chmodSync(f.anchor.bootstrapPath, 0o600);
  const bytes = JSON.stringify(f.contract);
  writeFileSync(f.anchor.bootstrapPath, bytes); chmodSync(f.anchor.bootstrapPath, 0o400);
  f.anchor.bootstrapSha256 = hash(bytes);
  expect(() => loadPageFileBootstrap(f.anchor)).toThrow('page_file_bootstrap_invalid');
});
