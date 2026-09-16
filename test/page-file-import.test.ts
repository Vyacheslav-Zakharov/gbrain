import { afterAll, beforeAll, beforeEach, test, expect, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { pageFileSyncHost, PageFileSync } from '../src/core/page-file-sync.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
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

async function fixture(run: (engine: PGLiteEngine, root: string, config: any) => Promise<void>) {

  const dir = await mkdtemp(join(tmpdir(), 'page-import-cas-'));
  try {

    const root = join(dir, 'source'); await mkdir(root); await mkdir(join(dir, 'journal'));
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await engine.putPage('example', { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} });
    await writeFile(join(root, 'example.md'), 'Before');
    const db = new PageFileDatabase(engine, { brainId: 'offline', journalDirectory: join(dir, 'journal'), ...pageFileSyncHost({ root, paths: ['example.md'], lockDirectory: join(dir, 'locks'), topology: 'single-host-local' }) });
    await db.enroll('default', 'example');
    await run(engine, root, { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local', brainId: 'offline', journalDirectory: join(dir, 'journal'), lockDirectory: join(dir, 'locks') } });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('trusted enrolled import validates unchanged bytes without touching revision', async () => {
  await fixture(async (engine, root, config) => {
    const before = await engine.executeRaw("SELECT write_revision FROM pages WHERE slug='example'");
    const result = await importFromFile(engine, join(root, 'example.md'), 'example.md', { config, noEmbed: true } as any);
    expect(result.status).toBe('skipped');
    expect(await engine.executeRaw("SELECT write_revision FROM pages WHERE slug='example'")).toEqual(before);
  });
});

test('trusted enrolled import projects edited raw markdown without inference or providers', async () => {
  await fixture(async (engine, root, config) => {
    const raw = '---\ntype: concept\ntitle: Edited\ncustom: preserved\n---\n\nExternal edit\n\n<!-- timeline -->\n\n- 2026-01-01: Authored event\n';
    await writeFile(join(root, 'example.md'), raw);
    const network = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('Provider/network forbidden'); }) as unknown as typeof fetch);
    let result;
    try {
      result = await importFromFile(engine, join(root, 'example.md'), 'example.md', { config });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);
    const page = (await engine.getPage('example', { sourceId: 'default' }))!;
    expect(page.title).toBe('Edited');
    expect(page.compiled_truth).toBe('External edit');
    expect(page.timeline).toContain('Authored event');
    expect(page.frontmatter.custom).toBe('preserved');
    expect(await readFile(join(root, 'example.md'), 'utf8')).toBe(raw);
    expect((await importFromFile(engine, join(root, 'example.md'), 'example.md', { config })).status).toBe('skipped');
  });
});

test('actual import rejects original baseline made stale before unchanged skip without recapture', async () => {
  await fixture(async (engine, root, config) => {
    const original = PageFileSync.prototype.capture;
    let captures = 0;
    const capture = spyOn(PageFileSync.prototype, 'capture').mockImplementation(async function(this: PageFileSync, source, slug) {
      const token = await original.call(this, source, slug);
      captures++;
      await writeFile(join(root, 'example.md'), 'New external bytes');
      return token;
    });
    try {
      await expect(importFromFile(engine, join(root, 'example.md'), 'example.md', { config })).rejects.toMatchObject({ code: 'stale_file_baseline', acknowledgeable: false });
      expect(captures).toBe(1);
      expect((await engine.getPage('example'))!.compiled_truth).toBe('Before');
      expect(await readFile(join(root, 'example.md'), 'utf8')).toBe('New external bytes');
    } finally { capture.mockRestore(); }
  });
});

test('enrolled import keeps production, wrong path and unsupported projections closed', async () => {
  await fixture(async (engine, root, config) => {
    const file = join(root, 'example.md');
    await expect(importFromFile(engine, file, 'example.md', { config: { ...config, page_file_runtime: { ...config.page_file_runtime, mode: 'production' } } })).rejects.toMatchObject({ code: 'file_runtime_prerequisites_pending' });
    await expect(importFromFile(engine, file, 'example.md', { config, forceRechunk: true })).rejects.toMatchObject({ acknowledgeable: false });
    // An equivalent configured parse is supported; it must remain a true no-op.
    const before = await engine.getPage('example');
    await expect(importFromFile(engine, file, 'example.md', { config, activePack: { page_types: [] } })).resolves.toMatchObject({ status: 'skipped', chunks: 0 });
    expect(await engine.getPage('example')).toEqual(before);
    expect(await readFile(file, 'utf8')).toBe('Before');
    await expect(importFromFile(engine, file, 'example.md', { config, inferFrontmatter: true })).rejects.toMatchObject({ acknowledgeable: false });
    await expect(importFromFile(engine, join(root, 'other.md'), 'example.md', { config })).rejects.toMatchObject({ code: 'binding_changed' });
  });
});

test('enrolled file import refuses before filesystem size skip and inference', async () => {
  await fixture(async (engine, root) => {
    await writeFile(join(root, 'example.md'), 'x'.repeat(5_000_001));
    await expect(importFromFile(engine, join(root, 'example.md'), 'example.md', { noEmbed: true, sourceId: 'default' })).rejects.toMatchObject({ name: 'PageFileSyncConflict', acknowledgeable: false });
    expect((await engine.getPage('example', { sourceId: 'default' }))!.compiled_truth).toBe('Before');
  });
});

test('enrolled content import cannot acknowledge an oversized early skip without an original file baseline', async () => {
  await fixture(async engine => {
    await expect(importFromContent(engine, 'example', 'Before', { noEmbed: true, sourceId: 'default' })).rejects.toMatchObject({ code: 'unsupported_import_file_baseline', acknowledgeable: false });
    // Arbitrary content cannot self-attest via a caller-supplied sourcePath.
    await expect(importFromContent(engine, 'example', 'Before', { noEmbed: true, sourceId: 'default', sourcePath: 'example.md', forceRechunk: true })).rejects.toMatchObject({ acknowledgeable: false });
    expect((await importFromContent(engine, 'example', 'x'.repeat(5_000_001), { noEmbed: true, sourceId: 'other-source' })).status).toBe('skipped');
    await expect(importFromContent(engine, 'example', 'x'.repeat(5_000_001), { noEmbed: true, sourceId: 'default' })).rejects.toMatchObject({ name: 'PageFileSyncConflict', acknowledgeable: false });
    expect((await engine.getPage('example', { sourceId: 'default' }))!.compiled_truth).toBe('Before');
  });
});
