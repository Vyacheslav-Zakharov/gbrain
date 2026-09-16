import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { enrollPageFileRuntime, resolvePageFileRuntime } from '../src/core/page-file-runtime.ts';
import { withLegacyPageFileRootMutation } from '../src/core/page-file-root-gate.ts';
import { PageFileJournal } from '../src/core/page-file-journal.ts';

// Actual registered methods and actual SQL; no fake refusal or runtime adapter.
// Offline proof of refusal ordering, NOT connected-Postgres/SIGKILL acceptance.
test('dirty root stale intent refuses without changing DB files Git or orphan journal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dirty-refusal-'));
  const root = join(home, 'source'); const journal = join(home, 'journal');
  mkdirSync(root); mkdirSync(journal);
  const engine = new PGLiteEngine();
  const prepare = PageFileJournal.prototype.prepare;
  const tree = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? Object.entries(tree(join(dir, e.name))).map(([p, b]) => [e.name + '/' + p, b])
      : [[e.name, readFileSync(join(dir, e.name)).toString('base64')]]));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 10000, stdio: 'pipe',
  });
  try {
    const config: any = { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local',
      brainId: 'offline-dirty-refusal', lockDirectory: join(home, 'locks'), journalDirectory: journal } };
    await engine.connect({}); await engine.initSchema();
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    const page = { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} };
    await engine.putPage('example', page); writeFileSync(join(root, 'example.md'), 'Before');
    const ctx: any = { engine, config, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } };
    await enrollPageFileRuntime(ctx, 'default', 'example');
    const call = (name: string, p: any) => operationsByName[name].handler(ctx, p) as Promise<any>;
    const target = { source_id: 'default', slug: 'example' };
    const before = await call('get_page_checked', target);
    const request = { ...target, operation_id: randomUUID(), expected_revision: before.revision,
      file_baseline: before.file.baseline, page: { ...page, compiled_truth: 'Unchosen' }, raw_markdown: 'Unchosen' };
    PageFileJournal.prototype.prepare = async function (...args) {
      await prepare.apply(this, args); throw new Error('test-stop-after-real-journal');
    };
    await expect(call('put_page_checked', request)).rejects.toThrow('test-stop-after-real-journal');
    PageFileJournal.prototype.prepare = prepare;
    const intent = tree(journal);
    expect(Object.keys(intent).some(p => p.startsWith(request.operation_id + '/'))).toBe(true);
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.'); git('commit', '-m', 'before');
    const host = { root, lockDirectory: config.page_file_runtime.lockDirectory, topology: 'single-host-local' as const };
    await expect(withLegacyPageFileRootMutation(engine, root, () => {
      writeFileSync(join(root, 'example.md'), 'Git authored bytes');
      writeFileSync(join(root, 'unrelated.md'), 'Preserve unrelated bytes');
      git('add', '.'); git('commit', '-m', 'incoming');
      throw new Error('test-stop-after-real-git');
    }, host)).rejects.toThrow('test-stop-after-real-git');
    const [binding] = await engine.executeRaw<any>('SELECT pending_op_id,file_generation::text FROM page_file_bindings');
    expect(binding.pending_op_id).toBeNull();
    expect(binding.file_generation).toBe(String(BigInt(before.file.baseline.generation) + 1n));
    const db = async () => {
      const rows = [];
      for (const table of ['pages', 'page_file_bindings', 'page_file_operations', 'page_versions', 'content_chunks', 'page_file_write_authorizations'])
        rows.push(await engine.executeRaw(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`));
      return rows;
    };
    const frozen = { db: await db(), root: tree(root), journal: tree(journal), locks: tree(host.lockDirectory) };
    expect(frozen.journal).toEqual(intent);
    const unchanged = async () => {
      expect(await db()).toEqual(frozen.db); expect(tree(root)).toEqual(frozen.root);
      expect(tree(journal)).toEqual(intent); expect(tree(host.lockDirectory)).toEqual(frozen.locks);
    };
    await expect(call('get_page_checked', target)).rejects.toMatchObject({ message: 'page_file_root_sync_required', code: 'page_file_root_sync_required', acknowledgeable: false });
    await unchanged();
    // The stale-generation check runs before the guarded replacement path.
    await expect(call('put_page_checked', request)).rejects.toThrow(/^precondition_failed$/);
    await unchanged();
    const runtime = (await resolvePageFileRuntime(ctx, 'default', 'example'))!;
    await expect(runtime.sync.capture('default', 'example')).rejects.toMatchObject({ code: 'page_file_root_sync_required', acknowledgeable: false });
    await unchanged();
  } finally {
    PageFileJournal.prototype.prepare = prepare;
    await engine.disconnect(); rmSync(home, { recursive: true, force: true });
  }
}, 60000);
