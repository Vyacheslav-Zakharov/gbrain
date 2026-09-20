import { expect } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PostgresEngine } from '../../../src/core/postgres-engine.ts';

import { startHttpsGit } from './https-git.ts';

// Real child qualification. Never replace CLI, loader, engine or private pool.
export async function exerciseHelperCaller(f: {
  admin: PostgresEngine; engine: PostgresEngine; source: string;
  root: string; directory: string; ordinaryUrl: string;
}) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1') throw new Error('hosted disposable only');
  const adapter = join(import.meta.dir, 'helper-v7-pull-adapter.ts');
  expect(createHash('sha256').update(readFileSync(adapter)).digest('hex')).toBe('48f5d5adb636c8bade0e52d968eb0d103f9d042d0fb549d8669d4b8161b9d09e');
  const home = join(f.directory, 'helper-home'); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'postgres', database_url: f.ordinaryUrl, poolSize: 1 }), { flag: 'wx', mode: 0o600 });
  const env = { PATH: '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home, GBRAIN_DATABASE_URL: f.ordinaryUrl,
    GBRAIN_ALLOW_PRIVATE_REMOTES: '1', GIT_SSL_CAINFO: '', GIT_SSL_VERIFY: 'true', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', f.root, ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  const invoke = () => {
    // Coreutils timeout bounds the process group (including Git); no owner,
    // adapter or enrollment URL is placed in argv/environment/stdin.
    const child = spawnSync('/usr/bin/timeout', ['--signal=TERM', '--kill-after=5s', '30s', process.execPath,
      adapter, resolve(import.meta.dir, '../../..'), f.source, f.root],
    { cwd: home, env, encoding: 'utf8', timeout: 40_000, maxBuffer: 1024 * 1024 });
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull();
    expect(child.stdout + child.stderr).not.toContain(f.ordinaryUrl);
    expect([124, 137]).not.toContain(child.status);
    return child;
  };
  const snapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of ['sources', 'pages', 'page_file_bindings']) rows[table] = await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE ${table === 'sources' ? 'id' : 'source_id'}=$1 ORDER BY to_jsonb(t)::text`, [f.source]);
    for (const table of ['tags', 'page_versions', 'content_chunks', 'timeline_entries']) rows[table] = await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1) ORDER BY to_jsonb(t)::text`, [f.source]);
    rows.operations = await f.admin.executeRaw('SELECT to_jsonb(t)::text AS row FROM page_file_operations t WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1) ORDER BY operation_id', [f.source]);
    rows.config = await f.admin.executeRaw('SELECT to_jsonb(t)::text AS row FROM config t ORDER BY key');
    return { rows, head: git('rev-parse', 'HEAD'), index: readFileSync(join(f.root, '.git/index')),
      status: git('status', '--porcelain', '--untracked-files=all'), file: readFileSync(join(f.root, 'connected.md')) };
  };
  git('init', '-b', 'baseline'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null'); git('config', 'commit.gpgSign', 'false');
  git('add', 'connected.md'); git('commit', '-m', 'baseline');
  const raw = readFileSync(join(f.root, 'connected.md'));
  git('checkout', '-b', 'master'); writeFileSync(join(f.root, 'connected.md'), 'Synthetic incoming bytes\n');
  git('commit', '-am', 'incoming'); const incoming = git('rev-parse', 'HEAD'); git('checkout', 'baseline');
  const transport = await startHttpsGit(f.root);
  try {
  env.GIT_SSL_CAINFO = transport.ca;
  git('remote', 'add', f.source === 'shared' ? 'origin' : 'github', transport.url);
  const stable = await snapshot();
  await expect(f.engine.executeRaw('UPDATE page_file_bindings SET file_generation=file_generation+1 WHERE source_id=$1', [f.source])).rejects.toMatchObject({ code: '42501' });
  expect(await snapshot()).toEqual(stable);
  writeFileSync(join(f.root, 'connected.md'), 'Dirty authored bytes\r\n');
  const dirty = await snapshot();
  // Enrolled roots refuse before the helper's skipped_dirty callback is reached.
  expect(invoke().status).toBe(1); expect(await snapshot()).toEqual(dirty);
  writeFileSync(join(f.root, 'connected.md'), raw);
  try {
    await f.admin.executeRaw('UPDATE page_file_bindings SET pending_op_id=$1 WHERE source_id=$2', [randomUUID(), f.source]);
    const pending = await snapshot(); expect(invoke().status).toBe(1); expect(await snapshot()).toEqual(pending);
  } finally { await f.admin.executeRaw('UPDATE page_file_bindings SET pending_op_id=NULL WHERE source_id=$1', [f.source]); }
  const before = await snapshot();
  const [binding] = await f.admin.executeRaw<{ file_generation: string; indexed_raw_sha256: string }>('SELECT file_generation::text,indexed_raw_sha256 FROM page_file_bindings WHERE source_id=$1', [f.source]);
  const child = invoke();
  // Refusal cannot be mistaken for healthy actual-helper success.
  expect(child.status).toBe(0);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  expect(result.status).toBe('advanced'); expect(result.to).toBe(incoming);
  expect(git('rev-parse', 'HEAD')).toBe(incoming);
  expect(readFileSync(join(f.root, 'connected.md'), 'utf8')).toBe('Synthetic incoming bytes\n');
  const [afterBinding] = await f.admin.executeRaw<{ file_generation: string; indexed_raw_sha256: string; pending_op_id: string | null }>('SELECT file_generation::text,indexed_raw_sha256,pending_op_id FROM page_file_bindings WHERE source_id=$1', [f.source]);
  expect(BigInt(afterBinding.file_generation)).toBe(BigInt(binding.file_generation) + 1n);
  expect(afterBinding.indexed_raw_sha256).toBe(binding.indexed_raw_sha256); expect(afterBinding.pending_op_id).toBeNull();
  const after = await snapshot();
  for (const key of Object.keys(before.rows).filter(k => k !== 'page_file_bindings')) expect(after.rows[key]).toEqual(before.rows[key]);
  console.log('HELPER_CALLER: healthy FF and private generation; dirty/pending snapshots preserved');
  } finally { await transport.stop(); }
}
