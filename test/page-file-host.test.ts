import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, rmSync, renameSync, chmodSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { validatePageFileHostManifest } from '../src/core/page-file-host.ts';
const cleanup: string[] = [];
afterEach(() => { for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  // HOME may be isolated under /tmp, whose writable ancestor is correctly rejected.
  // Use a canonical checkout with policy-safe ancestors; never chmod shared parents.
  // mkdtemp creates a private disposable directory, removed by afterEach.
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'host-test-')); cleanup.push(base);
  const pin = (path: string) => {
    mkdirSync(path, { mode: 0o700 });
    const s = lstatSync(path, { bigint: true });
    return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: Number(s.mode & 0o7777n) };
  };
  const manifest = { version: 1, deploymentId: 'deployment-example', brainId: '11111111-1111-4111-8111-111111111111', database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local', serviceUid: process.getuid!(), roots: [{ sourceId: 'source-example', mappingGeneration: '1', directory: pin(join(base, 'root')), journal: pin(join(base, 'journal')) }], lock: pin(join(base, 'lock')), indexedRoots: [] as ReturnType<typeof pin>[] };
  return { base, manifest, pin };
}
function options(manifest: ReturnType<typeof fixture>['manifest']) {
  const manifestJson = JSON.stringify(manifest);
  return { mode: 'offline-verification' as const, manifestJson, expected: { manifestSha256: createHash('sha256').update(manifestJson).digest('hex'), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } };
}
test('refuses identity drift, malformed manifests and production activation', () => {
  const { manifest } = fixture();
  const good = options(manifest);
  for (const field of Object.keys(good.expected)) {
    expect(() => validatePageFileHostManifest({ ...good, expected: { ...good.expected, [field]: 'different' } })).toThrow();
  }
  expect(() => validatePageFileHostManifest({ ...good, mode: 'production' } as any)).toThrow('file_runtime_prerequisites_pending');
  for (const change of [{ version: 2 }, { topology: 'multi-host' }, { roots: [] }, { extra: true }, { brainId: 'host' }]) {
    expect(() => validatePageFileHostManifest(options({ ...manifest, ...change } as any))).toThrow();
  }
});
test('validates preexisting private canonical directory pins and ancestors without repair', () => {
  for (const field of ['dev', 'ino', 'uid', 'gid', 'mode', 'path'] as const) {
    const { manifest } = fixture();
    const pin = manifest.lock as any;
    pin[field] = field === 'path' ? pin.path + '/missing' : typeof pin[field] === 'number' ? pin[field] + 1 : String(BigInt(pin[field]) + 1n);
    expect(() => validatePageFileHostManifest(options(manifest))).toThrow();
    if (field === 'path') expect(existsSync(pin.path)).toBe(false);
  }
  const { base, manifest } = fixture();
  chmodSync(base, 0o777);
  expect(() => validatePageFileHostManifest(options(manifest))).toThrow();
  chmodSync(base, 0o700);
  const alias = join(base, 'alias'); symlinkSync(manifest.lock.path, alias);
  manifest.lock.path = alias;
  expect(() => validatePageFileHostManifest(options(manifest))).toThrow();
  manifest.lock.path = join(base, 'root') + '/../lock';
  expect(() => validatePageFileHostManifest(options(manifest))).toThrow();
});
test('rejects collisions across complete managed and indexed inventory', () => {
  for (const kind of ['managed', 'indexed', 'nested', 'alias', 'source', 'journal-device']) {
    const { manifest, pin, base } = fixture();
    if (kind === 'managed') manifest.lock = pin(join(manifest.roots[0].directory.path, 'lock'));
    if (kind === 'indexed') { const indexed = pin(join(base, 'indexed')); manifest.indexedRoots.push(indexed); manifest.roots[0].journal = pin(join(indexed.path, 'journal')); }
    if (kind === 'nested') manifest.roots.push({ ...manifest.roots[0], sourceId: 'second', directory: pin(join(manifest.roots[0].directory.path, 'nested')) });
    if (kind === 'alias') manifest.roots.push({ ...manifest.roots[0], sourceId: 'second' });
    if (kind === 'source') manifest.roots.push({ ...manifest.roots[0], directory: pin(join(base, 'second')) });
    if (kind === 'journal-device') manifest.roots[0].journal.dev = '999999999';
    expect(() => validatePageFileHostManifest(options(manifest))).toThrow();
  }
});
test('revalidation rejects replaced or missing directories and never repairs', () => {
  for (const target of ['lock', 'root', 'journal', 'ancestor', 'mode', 'missing']) {
    const { base, manifest } = fixture();
    const host = validatePageFileHostManifest(options(manifest)) as any;
    expect(typeof host.revalidate).toBe('function');
    expect(() => host.revalidate()).not.toThrow();
    const path = target === 'root' ? manifest.roots[0].directory.path : target === 'journal' ? manifest.roots[0].journal.path : manifest.lock.path;
    if (target === 'mode') chmodSync(path, 0o755);
    else if (target === 'ancestor') { renameSync(base, base + '-old'); cleanup.push(base + '-old'); mkdirSync(base, { mode: 0o700 }); }
    else { renameSync(path, path + '-old'); if (target !== 'missing') mkdirSync(path, { mode: 0o700 }); }
    expect(() => host.revalidate()).toThrow();
    if (target === 'missing') expect(existsSync(path)).toBe(false);
  }
});
test('rejects replaced ancestor even when pinned children are moved back intact', () => {
  const { base, manifest } = fixture();
  const host = validatePageFileHostManifest(options(manifest));
  renameSync(base, base + '-old'); cleanup.push(base + '-old');
  mkdirSync(base, { mode: 0o700 });
  for (const name of ['root', 'lock', 'journal']) renameSync(join(base + '-old', name), join(base, name));
  expect(() => host.revalidate()).toThrow();
});
test('captures a deeply immutable descriptor independently of caller mutation', async () => {
  const api = await import('../src/core/page-file-host.ts').catch(() => ({} as any));
  expect(typeof api.validatePageFileHostManifest).toBe('function');
  const { manifest } = fixture();
  const host = api.validatePageFileHostManifest(options(manifest));
  expect(host.manifest.brainId).toBe(manifest.brainId);
  expect(Object.isFrozen(host)).toBe(true);
  expect(Object.isFrozen(host.manifest.roots[0].directory)).toBe(true);
  manifest.roots[0].directory.path = '/bad';
  expect(host.manifest.roots[0].directory.path).not.toBe('/bad');
});
