import { afterAll, beforeAll, beforeEach, afterEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPull } from '../src/commands/sources-harden.ts';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import ts from 'typescript';
import * as rootGate from '../src/core/page-file-root-gate.ts';

// Exercise the actual sync pull try/catch without importing CLI/provider state.
function syncPullBlock() {
  const source = readFileSync(new URL('../src/commands/sync.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('sync.ts', source, ts.ScriptTarget.Latest, true);
  let block = '';
  function visit(n: ts.Node) {
    if (ts.isTryStatement(n) && n.tryBlock.getText(ast).includes('pullRepo(repoPath')) block = n.getText(ast);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  if (!block) throw new Error('sync pull block missing');
  const code = ts.transpile(block.replaceAll("import('../core/git-remote.ts')", 'offlineGit').replaceAll("import('../core/page-file-root-gate.ts')", 'offlineGate'), { target: ts.ScriptTarget.ES2022 });
  let calls = 0;
  const run = new Function('engine', 'repoPath', 'offlineGit', 'offlineGate', 'withLegacyPageFileRootMutation', 'serr', '_t0', `return (async () => { ${code} })();`);
  return { calls: () => calls, run: () => run(engine, root, { pullRepo: (path: string, opts?: any) => {
    rootGate.assertPageFileRootPermit(path, opts?.rootPermit); calls++;
  } }, rootGate, rootGate.withLegacyPageFileRootMutation, () => {}, Date.now()) };
}
let db: PGlite;
let root: string;
const engine = { executeRaw: async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows } as BrainEngine;
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore','pipe','pipe'] }).toString().trim();
beforeAll(async () => { db = new PGlite(); await db.waitReady; });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-pull-caller-'));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'note.md'), 'original'); git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  // Dirty real git worktree: production pull must safely return without network.
  writeFileSync(join(root, 'note.md'), 'local edits');
  await db.exec('DROP TABLE IF EXISTS page_file_bindings; CREATE TABLE page_file_bindings(canonical_root text, relative_path text); DROP TABLE IF EXISTS sources; CREATE TABLE sources(id text, local_path text, config jsonb)');
  await db.query('INSERT INTO sources VALUES ($1,$2,NULL)', ['example', root]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
test('source pull preserves unenrolled legacy dirty-worktree success', async () => {
  await runPull(engine, ['example', '--branch', 'main']);
  expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('local edits');
});
test('source pull refuses enrolled root without touching its edits', async () => {
  await db.query('INSERT INTO page_file_bindings VALUES ($1,$2)', [root, 'note.md']);
  await expect(runPull(engine, ['example'])).rejects.toThrow('page_file_unsupported_root_writer');
  expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('local edits');
});
test('harden pulls unenrolled roots with the authoritative engine', async () => {
  const report = await hardenBrainRepo({ repoPath: root, sourceId: 'example', engine, dryRun: true, installCron: false, verify: false });
  expect(report.steps.find(s => s.step === 'pull')?.status).toBe('skipped');
});
test('harden reports enrolled pull refusal', async () => {
  await db.query('INSERT INTO page_file_bindings VALUES ($1,$2)', [root, 'note.md']);
  const report = await hardenBrainRepo({ repoPath: root, sourceId: 'example', engine, dryRun: true, installCron: false, verify: false });
  expect(report.steps.find(s => s.step === 'pull')?.detail).toContain('page_file_unsupported_root_writer');
  expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('local edits');
});
test('sync passes a live permit for an unenrolled root', async () => {
  const block = syncPullBlock(); await block.run(); expect(block.calls()).toBe(1);
});
test('sync does not downgrade enrolled root refusal into warn-and-continue', async () => {
  await db.query('INSERT INTO page_file_bindings VALUES ($1,$2)', [root, 'note.md']);
  const block = syncPullBlock();
  await expect(block.run()).rejects.toThrow('page_file_unsupported_root_writer');
  expect(block.calls()).toBe(0);
});
test('DB-free path cannot infer unenrolled status', async () => {
  await expect(runPull(null, ['--path', root])).rejects.toThrow('page_file_root_gate_unavailable');
});
