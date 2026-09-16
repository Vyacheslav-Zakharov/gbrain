import { afterAll, beforeAll, beforeEach, test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

test('source inventory churn preserves DB and sync binding identity', async () => {
  const { PageFileSync } = await import('../src/core/page-file-sync.ts');
  const dir = await mkdtemp(join(tmpdir(), 'mapping-cas-'));
  const root = join(dir, 'source'); await mkdir(root); await mkdir(join(dir, 'journal'));
  try {
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('other','Other',$1)", [join(dir, 'other')]);
    await engine.putPage('example', { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} });
    await writeFile(join(root, 'example.md'), 'Before');
    const host = { brainId: 'offline', mappingGeneration: '1', journalDirectory: join(dir, 'journal'), withLockedBinding: async <T>(fn: () => Promise<T>) => fn() };
    const db = new PageFileDatabase(engine, host); await db.enroll('default', 'example');
    const sync = new PageFileSync(engine, host); const baseline = await sync.capture('default', 'example');
    // Real SQL in reversed order, including inside transactions.
    const shuffled = (target: any): any => new Proxy(target, { get(t, key) {
      if (key === 'executeRaw') return (q: string, p?: any[]) => t.executeRaw(q === 'SELECT id, local_path FROM sources' ? q + ' ORDER BY id DESC' : q, p);
      if (key === 'transaction') return (fn: any) => t.transaction((tx: any) => fn(shuffled(tx)));
      const value = Reflect.get(t, key); return typeof value === 'function' ? value.bind(t) : value;
    } });
    expect((await new PageFileDatabase(shuffled(engine), { ...host }).get('default', 'example', () => {})).file.raw_markdown).toBe('Before');
    expect((await new PageFileSync(shuffled(engine), { ...host }).capture('default', 'example')).identity).toBe(baseline.identity);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='other'", [join(dir, 'changed')]);
    await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('added','Added',$1)", [join(dir, 'added')]);
    expect((await db.get('default', 'example', () => {})).file.raw_markdown).toBe('Before');
    expect((await sync.commit(baseline)).status).toBe('unchanged');
    for (const changedHost of [{ ...host, mappingGeneration: '2' }, { ...host, mappingGeneration: '' }]) {
      await expect(new PageFileDatabase(engine, changedHost).get('default', 'example', () => {})).rejects.toThrow();
      await expect(new PageFileSync(engine, changedHost).capture('default', 'example')).rejects.toThrow();
    }
    // Inventory validation is still global, independent of the per-source key.
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='other'", [root]);
    await expect(db.get('default', 'example', () => {})).rejects.toThrow('path_collision');
    await expect(sync.capture('default', 'example')).rejects.toThrow('path_collision');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='other'", [join(dir, 'changed')]);
    const { rename, symlink } = await import('node:fs/promises');
    await symlink(root, join(dir, 'alias'));
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='other'", [join(dir, 'alias')]);
    await expect(db.get('default', 'example', () => {})).rejects.toThrow('path_collision');
    await expect(sync.capture('default', 'example')).rejects.toThrow('path_collision');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='other'", [join(dir, 'changed')]);
    // Recreate an actual legacy digest, not a made-up malformed binding key.
    const { resolveExistingPageFileBinding } = await import('../src/core/page-file-binding.ts');
    const { rawDigest } = await import('../src/core/page-file-journal.ts');
    const sources = await engine.executeRaw<any>('SELECT id, local_path FROM sources');
    const [row] = await engine.executeRaw<any>("SELECT * FROM pages WHERE slug='example'");
    const globalRepoPath = await engine.getConfig('sync.repo_path');
    const legacy = await resolveExistingPageFileBinding({ brainId: host.brainId, sourceId: 'default', slug: 'example', pageId: String(row.id), sourcePath: row.source_path, sources, otherPagePaths: [], globalRepoPath,
      configGeneration: rawDigest(Buffer.from(JSON.stringify([sources, globalRepoPath]))) });
    const [saved] = await engine.executeRaw<any>('SELECT * FROM page_file_bindings');
    await engine.executeRaw('UPDATE page_file_bindings SET binding_key=$1', [legacy.bindingKey]);
    await expect(db.get('default', 'example', () => {})).rejects.toThrow('binding_changed');
    await expect(sync.capture('default', 'example')).rejects.toThrow('binding_changed');
    await expect(db.enroll('default', 'example', { pageId: String(row.id), revision: row.write_revision, canonicalRoot: root, relativePath: 'example.md', rawSha256: legacy.rawSha256 })).rejects.toThrow('page_file_enrollment_stale');
    expect((await engine.executeRaw<any>('SELECT binding_key FROM page_file_bindings'))[0].binding_key).toBe(legacy.bindingKey);
    await engine.executeRaw('UPDATE page_file_bindings SET binding_key=$1', [saved.binding_key]);
    // Same pathname and bytes, different root inode: no silent rebind.
    await rename(root, join(dir, 'old-root')); await mkdir(root); await writeFile(join(root, 'example.md'), 'Before');
    await expect(db.get('default', 'example', () => {})).rejects.toThrow('binding_changed');
    await expect(sync.capture('default', 'example')).rejects.toThrow('binding_changed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

 test('original sync baseline rejects after checked publish, even a prepared no-op; same canonical lock serves both adapters', async () => {
  const mod = await import('../src/core/page-file-sync.ts').catch(() => null);
  expect(mod).not.toBeNull();
  if (!mod) return;

  const dir = await mkdtemp(join(tmpdir(), 'sync-cas-')); const root = join(dir, 'source'); await mkdir(root); await mkdir(join(dir,'journal'));
  try {
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    const page = { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} };
    await engine.putPage('example', page); await writeFile(join(root, 'example.md'), 'Before');
    const host = { brainId: 'offline', journalDirectory: join(dir,'journal'), ...mod.pageFileSyncHost({ root, paths: ['example.md'], lockDirectory: join(dir,'locks'), topology: 'single-host-local' }) };
    const db = new PageFileDatabase(engine, host); await db.enroll('default','example');
    const sync = new mod.PageFileSync(engine, host);
    const baseline = await sync.capture('default', 'example');
    const current = await db.get('default','example', () => {});
    expect((await db.put('default','example', { operation_id: randomUUID(), expected_revision: current.revision, file_baseline: current.file.baseline, raw_markdown: 'After', page: {...page, compiled_truth: 'After'} }, () => {})).status).toBe('committed');
    await expect(sync.commit(baseline)).rejects.toMatchObject({ code: 'stale_file_baseline', acknowledgeable: false });
    expect(await readFile(join(root,'example.md'),'utf8')).toBe('After');
    expect((await engine.getPage('example'))!.compiled_truth).toBe('After');
    const fresh = await sync.capture('default','example');
    const beforeNoop = (await db.get('default','example', () => {})).revision;
    expect((await sync.commit(fresh)).status).toBe('unchanged');
    expect((await db.get('default','example', () => {})).revision).toBe(beforeNoop);
    await writeFile(join(root,'example.md'), 'File authored update');
    const dirty = await sync.capture('default','example');
    expect((await sync.commit(dirty)).status).toBe('committed');
    expect((await engine.getPage('example'))!.compiled_truth).toBe('File authored update');
    expect(await readFile(join(root,'example.md'),'utf8')).toBe('File authored update');
    expect((await db.get('default','example', () => {})).file.raw_markdown).toBe('File authored update');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
