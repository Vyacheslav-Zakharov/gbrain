import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { enrollPageFileRuntime } from '../src/core/page-file-runtime.ts';
import { runPull } from '../src/commands/sources-harden.ts';
import { installDirtyRootBoundary } from './e2e/helpers/page-file-dirty-root-boundary.ts';
import { withEnv } from './helpers/with-env.ts';

// Same delegated interception as hosted child, actual caller/SQL/Git. Offline
// throw substitutes for parking/SIGKILL only; not connected-Postgres acceptance.
test('dirty-root child boundary interrupts actual source pull after Git before finish', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dirty-pull-'));
  const root = join(home, 'source');
  const engine = new PGLiteEngine();
  let restore = () => {};
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 10000, stdio: 'pipe',
  }).toString().trim();
  try {
    mkdirSync(root); mkdirSync(join(home, 'journal')); mkdirSync(join(home, '.gbrain'));
    const config: any = { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local',
      brainId: 'offline-dirty-pull', lockDirectory: join(home, 'locks'), journalDirectory: join(home, 'journal') } };
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
    await engine.connect({}); await engine.initSchema();
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await engine.putPage('example', { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} });
    writeFileSync(join(root, 'example.md'), 'Before');
    await enrollPageFileRuntime({ engine, config, remote: false } as any, 'default', 'example');
    const [before] = await engine.executeRaw<any>('SELECT file_generation::text FROM page_file_bindings');
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.'); git('commit', '-m', 'before');
    git('checkout', '-b', 'incoming'); writeFileSync(join(root, 'example.md'), 'Pulled');
    writeFileSync(join(root, 'unrelated.md'), 'Unrelated'); git('add', '.'); git('commit', '-m', 'incoming');
    const incoming = git('rev-parse', 'HEAD'); git('checkout', 'main'); git('remote', 'add', 'origin', root);
    let stopped = 0;
    restore = installDirtyRootBoundary(PGLiteEngine.prototype, async () => { stopped++; throw new Error('test-dirty-root-boundary'); });
    await withEnv({ GBRAIN_HOME: home, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      await expect(runPull(engine, ['default', '--branch', 'incoming'])).rejects.toThrow('test-dirty-root-boundary');
    });
    expect(stopped).toBe(1);
    expect(git('rev-parse', 'HEAD')).toBe(incoming);
    expect(readFileSync(join(root, 'example.md'), 'utf8')).toBe('Pulled');
    expect(readFileSync(join(root, 'unrelated.md'), 'utf8')).toBe('Unrelated');
    expect((await engine.getPage('example'))!.compiled_truth).toBe('Before');
    const [after] = await engine.executeRaw<any>('SELECT file_generation::text,pending_op_id FROM page_file_bindings');
    expect(after.file_generation).toBe(String(BigInt(before.file_generation) + 1n));
    expect(after.pending_op_id).toBeNull();
    const markers = readdirSync(config.page_file_runtime.lockDirectory);
    expect(markers.filter(p => p.endsWith('.dirty'))).toHaveLength(1);
    expect(markers.filter(p => p.endsWith('.observed'))).toHaveLength(0);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      await expect(runPull(engine, ['default', '--branch', 'incoming'])).rejects.toThrow('page_file_root_sync_required');
    });
  } finally { restore(); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }
}, 60000);
