import { test, expect, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { enrollPageFileRuntime } from '../src/core/page-file-runtime.ts';
import { withLegacyPageFileRootMutation } from '../src/core/page-file-root-gate.ts';
import { performSync } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

async function fixture(run: (engine: PGLiteEngine, root: string, home: string, config: any, git: (...args: string[]) => string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'frozen-sync-'));
  const root = join(home, 'source'); const engine = new PGLiteEngine();
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' }).toString().trim();
  try {
    await mkdir(root); await mkdir(join(home, 'journal')); await mkdir(join(home, '.gbrain'));
    const config = { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local', brainId: 'offline', lockDirectory: join(home, 'locks'), journalDirectory: join(home, 'journal') } };
    await writeFile(join(home, '.gbrain/config.json'), JSON.stringify(config));
    await engine.connect({}); await engine.initSchema();
    await engine.executeRaw("UPDATE sources SET local_path=$1, chunker_version=$2 WHERE id='default'", [root, String(CHUNKER_VERSION)]);
    await engine.putPage('example', { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} });
    await writeFile(join(root, 'example.md'), 'Before');
    await enrollPageFileRuntime({ engine, config: config as any, remote: false }, 'default', 'example');
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture');
    await engine.executeRaw("UPDATE sources SET last_commit=$1 WHERE id='default'", [git('rev-parse', 'HEAD')]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_AUTOSKIP_AFTER: '1' }, async () => {
      const network = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('network forbidden'); }) as unknown as typeof fetch);
      try { await run(engine, root, home, config, git); expect(network).not.toHaveBeenCalled(); } finally { network.mockRestore(); }
    });
  } finally { await engine.disconnect(); await rm(home, { recursive: true, force: true }); }
}

test('FR-003 cyclic frontmatter refuses incremental skipFailed and full sync without acknowledgement', async () => {
  await fixture(async (engine, root, home, config, git) => {
    const anchor = git('rev-parse', 'HEAD');
    const raw = '---\ntype: concept\ntitle: Example\nmeta: &self\n  child: *self\n---\n\nBody\n';
    await withLegacyPageFileRootMutation(engine, root, async () => {
      await writeFile(join(root, 'example.md'), raw); git('add', '.'); git('commit', '-m', 'cyclic fixture');
    }, { root, ...config.page_file_runtime });
    const before = await engine.getPage('example');
    const binding = await engine.executeRaw('SELECT * FROM page_file_bindings');
    for (const full of [false, true]) {
      for (const skipFailed of [true, false, false]) {
        await expect(performSync(engine, { repoPath: root, sourceId: 'default', full, noPull: true,
          noEmbed: true, noExtract: true, skipFailed })).rejects.toMatchObject({ code: 'unsupported_sync_projection', acknowledgeable: false });
        expect((await engine.executeRaw("SELECT last_commit FROM sources WHERE id='default'"))[0].last_commit).toBe(anchor);
        expect(existsSync(join(home, '.gbrain/sync-failures.jsonl'))).toBe(false);
        expect(await engine.getPage('example')).toEqual(before);
        expect(await engine.executeRaw('SELECT * FROM page_file_bindings')).toEqual(binding);
        expect(await readFile(join(root, 'example.md'), 'utf8')).toBe(raw);
      }
    }
  });
}, 60000);
