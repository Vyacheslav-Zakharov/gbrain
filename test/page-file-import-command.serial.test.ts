import { test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { pageFileSyncHost } from '../src/core/page-file-sync.ts';
import { runImport } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60000);
afterAll(async () => { await engine.disconnect(); });

test('actual mixed-root command imports enrolled edits despite checkpoint, and unrelated pages without providers or writeback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mixed-import-'));
  try {
    const root = join(home, 'source'); const journal = join(home, 'journal');
    await mkdir(root); await mkdir(journal); await mkdir(join(home, '.gbrain'));
    const config = { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local', brainId: 'offline', journalDirectory: journal, lockDirectory: join(home, 'locks') } };
    await writeFile(join(home, '.gbrain/config.json'), JSON.stringify(config));
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await engine.putPage('enrolled', { type: 'concept', title: 'Enrolled', compiled_truth: 'Before', timeline: '', frontmatter: {} });
    await writeFile(join(root, 'enrolled.md'), 'Before');
    const db = new PageFileDatabase(engine, { brainId: 'offline', journalDirectory: journal, ...pageFileSyncHost({ root, paths: ['enrolled.md'], lockDirectory: join(home, 'locks'), topology: 'single-host-local' }) });
    await db.enroll('default', 'enrolled');
    const raw = '---\ntype: concept\ntitle: Enrolled\n---\n\nEdited externally\n';
    const other = '---\ntype: concept\ntitle: Other\n---\n\nUnrelated content\n';
    await writeFile(join(root, 'enrolled.md'), raw);
    await writeFile(join(root, 'other.md'), other);
    await writeFile(join(home, '.gbrain/import-checkpoint.json'), JSON.stringify({ dir: root, completedPaths: ['enrolled.md'], timestamp: new Date().toISOString() }));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const network = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('network forbidden'); }) as unknown as typeof fetch);
      try {
        const result = await runImport(engine, [root, '--no-embed', '--workers', '1'], { sourceId: 'default' });
        expect(result.imported).toBe(2); expect(result.failures).toEqual([]);
        expect((await engine.getPage('enrolled'))!.compiled_truth).toBe('Edited externally');
        expect((await engine.getPage('other'))!.compiled_truth).toBe('Unrelated content');
        expect(await readFile(join(root, 'enrolled.md'), 'utf8')).toBe(raw);
        expect(await readFile(join(root, 'other.md'), 'utf8')).toBe(other);
        expect(network).not.toHaveBeenCalled();
        const checkpoint = JSON.stringify({ dir: root, completedPaths: ['enrolled.md'], timestamp: new Date().toISOString() });
        const cp = join(home, '.gbrain/import-checkpoint.json');
        await writeFile(cp, checkpoint);
        await engine.setConfig('sync.last_commit', 'held-bookmark');
        await engine.executeRaw("UPDATE page_file_bindings SET pending_op_id='00000000-0000-0000-0000-000000000001' WHERE slug='enrolled'");
        await expect(runImport(engine, [root, '--no-embed'], { sourceId: 'default' })).rejects.toMatchObject({ code: 'pending_recovery', acknowledgeable: false });
        expect(await readFile(cp, 'utf8')).toBe(checkpoint);
        await engine.executeRaw("UPDATE page_file_bindings SET pending_op_id=NULL WHERE slug='enrolled'");
        await rm(join(root, 'enrolled.md'));
        await expect(runImport(engine, [root, '--no-embed'], { sourceId: 'default' })).rejects.toMatchObject({ acknowledgeable: false });
        expect(await readFile(cp, 'utf8')).toBe(checkpoint);
        expect(await engine.getConfig('sync.last_commit')).toBe('held-bookmark');
        await writeFile(join(root, 'enrolled.md'), raw);
        await writeFile(join(home, '.gbrain/config.json'), JSON.stringify({ ...config, page_file_runtime: { ...config.page_file_runtime, mode: 'production' } }));
        await expect(runImport(engine, [root, '--no-embed'], { sourceId: 'default' })).rejects.toMatchObject({ code: 'file_runtime_prerequisites_pending', acknowledgeable: false });
        expect(await readFile(cp, 'utf8')).toBe(checkpoint);
        expect(network).not.toHaveBeenCalled();
      } finally { network.mockRestore(); }
    });
  } finally { await rm(home, { recursive: true, force: true }); }
}, 60000);
