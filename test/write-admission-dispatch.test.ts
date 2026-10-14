import { beforeAll, afterAll, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withExclusiveSourceWrites } from '../src/core/write-admission.ts';
import { execFileSync } from 'node:child_process';
import { putSourceIngestProfile } from '../src/core/source-ingest/store.ts';
import { runSourceIngestExecutor } from '../src/core/source-ingest/executor.ts';
import { admissionProfile } from './fixtures/write-admission-profile.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'admission-dispatch-'));
const shared = join(home, 'shared');
const other = join(home, 'other');
beforeAll(async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(shared); mkdirSync(other);
  execFileSync('/usr/bin/git', ['init', '-q', shared]);
  execFileSync('/usr/bin/git', ['init', '-q', other]);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1,$1,$2),($3,$3,$4)', ['shared', shared, 'other', other]);
  for (const source_id of ['shared', 'other']) await engine.putPage('notes/example', { title: 'Example', type: 'note', compiled_truth: 'Original', frontmatter: {} }, { sourceId: source_id });
  writeFileSync(join(shared, 'unchanged.md'), 'Manual content\n');
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('actual MCP dispatcher: rejected put has no DB/file effects; reads and other source work', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const before = await engine.executeRaw('SELECT * FROM pages ORDER BY id');
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(r => entered = r);
    const stop = new Promise<void>(r => release = r);
    const holder = withExclusiveSourceWrites(engine, ['shared'], async () => { entered(); await stop; });
    try {
      await ready;
      const { importFromContent } = await import('../src/core/import-file.ts');
      await expect(importFromContent(engine, 'notes/rejected-import', '# Not admitted', { sourceId: 'shared', noEmbed: true })).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
      const { runImport } = await import('../src/commands/import.ts');
      await expect(runImport(engine, [shared, '--no-embed'], { sourceId: 'shared' })).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
      const { performSync } = await import('../src/commands/sync.ts');
      await expect(performSync(engine, { repoPath: shared, sourceId: 'shared', noEmbed: true } as any)).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
      const rejected = await dispatchToolCall(engine, 'put_page', { slug: 'notes/example', content: '# Rejected', source_id: 'shared', permit: 'forged', exclusive: true }, { sourceId: 'shared' });
      expect(rejected.isError).toBe(true);
      expect(JSON.parse(rejected.content[0].text).error).toBe('source_write_busy');
      expect(await engine.executeRaw('SELECT * FROM pages ORDER BY id')).toEqual(before);
      expect(await engine.executeRaw('SELECT * FROM page_versions')).toEqual([]);
      expect(readFileSync(join(shared, 'unchanged.md'), 'utf8')).toBe('Manual content\n');
      const read = await dispatchToolCall(engine, 'get_page', { slug: 'notes/example' }, { sourceId: 'shared' });
      expect(read.isError).not.toBe(true);
      const otherWrite = await dispatchToolCall(engine, 'add_tag', { slug: 'notes/example', tag: 'available' }, { sourceId: 'other' });
      expect(otherWrite.isError).not.toBe(true);
      expect(await engine.getTags('notes/example', { sourceId: 'other' })).toContain('available');
    } finally { release(); await holder; }
    const accepted = await dispatchToolCall(engine, 'add_tag', { slug: 'notes/example', tag: 'after-release' }, { sourceId: 'shared' });
    expect(accepted.isError).not.toBe(true);
    expect(await engine.getTags('notes/example', { sourceId: 'shared' })).toContain('after-release');
  });
});

test('native executor rejects before ledger writes, then nests under exclusive through Git commit', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', shared, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Admission Test'); git('config', 'user.email', 'admission@example.test');
    git('add', 'unchanged.md'); git('commit', '-qm', 'seed');
    await putSourceIngestProfile(engine, admissionProfile, { createdBy: 'test', changeNote: 'admission fixture' });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(r => entered = r), stop = new Promise<void>(r => release = r);
    const holder = withExclusiveSourceWrites(engine, ['shared'], async () => { entered(); await stop; });
    const initialHead = git('rev-parse', 'HEAD');
    try {
      await ready;
      await expect(runSourceIngestExecutor(engine, { profile_id: admissionProfile.profile_id, no_embed: true })).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
      expect(await engine.executeRaw('SELECT * FROM source_ingest_run_items')).toEqual([]);
      expect(git('rev-parse', 'HEAD')).toBe(initialHead);
    } finally { release(); await holder; }
    await withExclusiveSourceWrites(engine, ['shared'], async () => {
      const result = await runSourceIngestExecutor(engine, { profile_id: admissionProfile.profile_id, no_embed: true, run_id: 'admission-nested' });
      expect(result.ok).toBe(true);
      expect(result.counts.written).toBeGreaterThan(0);
      expect(git('rev-parse', 'HEAD')).not.toBe(initialHead);
      expect(git('status', '--porcelain')).toBe('');
      expect(readFileSync(join(shared, 'unchanged.md'), 'utf8')).toBe('Manual content\n');
      // Native executor returned, but the runner still owns publication scope.
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/write-admission-holder.ts'), shared, 'shared'], { stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).not.toBe(0);
    });
  });
}, 60_000);
