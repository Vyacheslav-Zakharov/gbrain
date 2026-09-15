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
