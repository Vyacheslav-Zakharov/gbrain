import { test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { pageFileSyncHost } from '../src/core/page-file-sync.ts';
import { runImport } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadActivePack, _resetPackCacheForTests } from '../src/core/schema-pack/index.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60000);
afterAll(async () => { await engine.disconnect(); });

test('actual mixed-root import accepts equivalent packs but refuses divergent enrolled projections without acknowledging or mutating them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mixed-import-'));
  try {
    const root = join(home, 'source'); const journal = join(home, 'journal');
    await mkdir(root); await mkdir(journal); await mkdir(join(home, '.gbrain'));
    const packName = 'import-command-pack';
    const packDir = join(home, '.gbrain/schema-packs', packName);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify({
      api_version: 'gbrain-schema-pack-v1', name: packName, version: '1.0.0',
      description: 'Offline command projection fixture', extends: null,
      page_types: [{ name: 'note', primitive: 'concept', path_prefixes: ['enrolled'], aliases: [] }],
      link_types: [],
    }));
    const config = { engine: 'pglite', schema_pack: packName, page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local', brainId: 'offline', journalDirectory: journal, lockDirectory: join(home, 'locks') } } as const;
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
    await withEnv({ HOME: home, GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      _resetPackCacheForTests();
      const pack = await loadActivePack({ cfg: config, remote: false, sourceId: 'default' });
      expect(pack.manifest.name).toBe(packName);
      // Explicit type keeps this custom pack equivalent for the successful edit.
      const parseOpts = { validate: true, expectedSlug: 'enrolled' };
      expect(parseMarkdown(raw, 'enrolled.md', { ...parseOpts, activePack: pack.manifest }))
        .toEqual(parseMarkdown(raw, 'enrolled.md', parseOpts));
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
        // Without the explicit type the same installed pack infers a different
        // projection. The actual command must propagate the nonacknowledgeable
        // refusal, not import canonically or turn it into a skip-failed entry.
        const divergent = '---\ntitle: Enrolled\n---\n\nMust remain unimported\n';
        expect(parseMarkdown(divergent, 'enrolled.md', { ...parseOpts, activePack: pack.manifest }).type).toBe('note');
        expect(parseMarkdown(divergent, 'enrolled.md', parseOpts).type).toBe('concept');
        await writeFile(join(root, 'enrolled.md'), divergent);
        const pageBefore = await engine.getPage('enrolled');
        const chunksBefore = await engine.getChunks('enrolled');
        const bindingsBefore = await engine.executeRaw('SELECT * FROM page_file_bindings');
        const operationsBefore = await engine.executeRaw('SELECT * FROM page_file_operations');
        await expect(runImport(engine, [root, '--no-embed', '--workers', '1'], { sourceId: 'default' }))
          .rejects.toMatchObject({ code: 'unsupported_sync_projection', acknowledgeable: false });
        expect(await readFile(join(root, 'enrolled.md'), 'utf8')).toBe(divergent);
        expect(await readFile(join(root, 'other.md'), 'utf8')).toBe(other);
        expect(await engine.getPage('enrolled')).toEqual(pageBefore);
        expect(await engine.getChunks('enrolled')).toEqual(chunksBefore);
        expect(await engine.executeRaw('SELECT * FROM page_file_bindings')).toEqual(bindingsBefore);
        expect(await engine.executeRaw('SELECT * FROM page_file_operations')).toEqual(operationsBefore);
        expect(await readFile(cp, 'utf8')).toBe(checkpoint);
        expect(await engine.getConfig('sync.last_commit')).toBe('held-bookmark');
        expect(network).not.toHaveBeenCalled();
        await writeFile(join(root, 'enrolled.md'), raw);
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
  } finally {
    _resetPackCacheForTests();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
