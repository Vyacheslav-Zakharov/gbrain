import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PostgresEngine } from '../../../src/core/postgres-engine.ts';

// One deadline covers startup, IPC AND normal exit/disconnect. SIGKILL cleanup
// itself is bounded; a hung child can never turn a passed IPC assertion green.
async function child(input: Record<string, unknown>) {
  let receive!: (value: any) => void;
  const message = new Promise<any>(resolve => { receive = resolve; });
  // Isolate the process group so deadline cleanup also kills Git descendants.
  const proc = Bun.spawn(['setsid', process.execPath, join(import.meta.dir, 'page-file-dirty-root-child.ts')], {
    env: { ...process.env, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdout: 'ignore', stderr: 'inherit', ipc: receive,
  });
  const kill = () => {
    try { process.kill(-proc.pid, 'SIGKILL'); }
    catch (error: any) { if (error.code !== 'ESRCH') throw error; if (proc.exitCode === null) proc.kill('SIGKILL'); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { kill(); reject(new Error('dirty-root child lifetime exceeded 20s')); }, 20_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      proc.send(input);
      const result = await Promise.race([message, proc.exited.then(code => { throw new Error(`dirty-root child exited before IPC: ${code}`); })]);
      if (input.boundary) {
        expect(result).toEqual({ boundary: input.boundary, pid: proc.pid });
        kill();
        await proc.exited;
        expect(proc.signalCode).toBe('SIGKILL');
      } else expect(await proc.exited).toBe(0);
      return result;
    })()]);
  } finally {
    clearTimeout(timer);
    kill(); // kill same-group descendants even if the direct child already exited
    // proc.exited reaps only our direct child; orphan reaping belongs to host PID 1.
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([proc.exited, new Promise<never>((_, reject) => {
      cleanup = setTimeout(() => reject(new Error('dirty-root child SIGKILL reap exceeded 5s')), 5_000);
    })]); } finally { clearTimeout(cleanup); }
  }
}

export async function exerciseConnectedDirtyRoot(f: {
  admin: PostgresEngine; source: string; root: string; journal: string; lock: string;
  config: { database_url: string; poolSize: number };
}) {
  const invoke = (extra: Record<string, unknown>) => child({ config: f.config, source: f.source, ...extra });
  const target = { source_id: f.source, slug: 'connected' };
  const get = () => invoke({ operation: 'get_page_checked', request: target });
  const git = (...args: string[]) => execFileSync('git', ['-C', f.root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 10_000, stdio: 'pipe',
  }).toString().trim();
  const tree = (directory: string): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) for (const [path, bytes] of Object.entries(tree(join(directory, entry.name)))) files[entry.name + '/' + path] = bytes;
      else files[entry.name] = readFileSync(join(directory, entry.name)).toString('base64');
    }
    return files;
  };
  const db = async () => {
    const rows: unknown[] = [];
    for (const table of ['pages', 'page_file_bindings']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE source_id=$1 ORDER BY to_jsonb(t)::text`, [f.source]));
    rows.push(await f.admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM page_file_operations t
      WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1) ORDER BY operation_id`, [f.source]));
    for (const table of ['page_versions', 'content_chunks']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1) ORDER BY to_jsonb(t)::text`, [f.source]));
    return rows;
  };
  console.log('PG_CONNECTED_DIRTY_ROOT_PHASE: initial-read');
  const before = (await get()).result;
  expect(before).toBeDefined();
  const request = { ...target, operation_id: randomUUID(), expected_revision: before.revision,
    file_baseline: before.file.baseline, page: { ...before.page, compiled_truth: 'Unchosen page intent' },
    raw_markdown: before.file.raw_markdown.replace(before.page.compiled_truth, 'Unchosen page intent') };
  // Genuine pre-prepare page intent, not a fabricated pending_op_id or journal.
  console.log('PG_CONNECTED_DIRTY_ROOT_PHASE: intent-crash');
  await invoke({ operation: 'put_page_checked', request, boundary: 'intent' });
  const intent = tree(f.journal);
  expect(Object.keys(intent).some(path => path.startsWith(request.operation_id + '/'))).toBe(true);
  const beforeDb = await db();
  console.log('PG_CONNECTED_DIRTY_ROOT_PHASE: git-fixture');
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-m', 'before interrupted root');
  git('checkout', '-b', 'incoming');
  const incoming = before.file.raw_markdown.replace(before.page.compiled_truth, 'Git authored bytes');
  writeFileSync(join(f.root, 'connected.md'), incoming);
  writeFileSync(join(f.root, 'unrelated.md'), 'Preserve unrelated Git bytes\n');
  git('add', '.'); git('commit', '-m', 'incoming root');
  const incomingHead = git('rev-parse', 'HEAD');
  git('checkout', 'main'); git('remote', 'add', 'origin', f.root);
  console.log('PG_CONNECTED_DIRTY_ROOT_PHASE: pull-crash');
  await invoke({ action: 'pull', boundary: 'dirty-root' });
  const marker = join(f.lock, createHash('sha256').update(f.root + '\0ROOT').digest('hex') + '.dirty');
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ root: f.root, state: 'mutating' });
  expect(existsSync(marker + '.observed')).toBe(false);
  expect(git('rev-parse', 'HEAD')).toBe(incomingHead);
  expect(readFileSync(join(f.root, 'connected.md'), 'utf8')).toBe(incoming);
  const [binding] = await f.admin.executeRaw('SELECT pending_op_id,file_generation::text FROM page_file_bindings WHERE source_id=$1', [f.source]);
  expect(binding.pending_op_id).toBeNull();
  expect(binding.file_generation).toBe(String(BigInt(before.file.baseline.generation) + 1n));
  const frozenDb = await db();
  // The only DB change permitted by Git is baseline invalidation, not indexing.
  expect(frozenDb.filter((_, i) => i !== 1)).toEqual(beforeDb.filter((_, i) => i !== 1));
  const normalizeBindings = (rows: unknown) => (rows as { row: string }[]).map(({ row }) => {
    const binding = JSON.parse(row); delete binding.file_generation; return binding;
  });
  expect(normalizeBindings(frozenDb[1])).toEqual(normalizeBindings(beforeDb[1]));
  const frozen = { root: tree(f.root), journal: tree(f.journal), dirty: readFileSync(marker, 'utf8') };
  expect(frozen.journal).toEqual(intent);
  const unchanged = async () => {
    expect(await db()).toEqual(frozenDb);
    expect(tree(f.root)).toEqual(frozen.root); // includes index, refs, reflogs, FETCH_HEAD
    expect(tree(f.journal)).toEqual(intent);
  };
  expect((await get()).error.message).toContain('page_file_root_sync_required');
  expect((await invoke({ operation: 'put_page_checked', request })).error.message).toContain('page_file_root_sync_required');
  expect((await invoke({ action: 'pull' })).error.message).toContain('page_file_root_sync_required');
  expect((await invoke({ action: 'reconcile', approved: false })).error.message).toContain('root_recovery_approval_required');
  await unchanged();
  expect(readFileSync(marker, 'utf8')).toBe(frozen.dirty);
  expect((await invoke({ action: 'reconcile', approved: true })).result).toEqual({ ok: true });
  expect(existsSync(marker)).toBe(false);
  const observed = JSON.parse(readFileSync(marker + '.observed', 'utf8'));
  expect(observed.root).toBe(f.root);
  expect(observed.observations).toEqual([{ binding_id: before.file.baseline.binding_id,
    relative_path: 'connected.md', raw_sha256: createHash('sha256').update(incoming).digest('hex') }]);
  await unchanged();
  expect((await get()).error.message).toBe('sync_required');
  await unchanged();
  // Classification did not choose DB, Git, or orphan page intent as a winner.
  // Repeating explicit reconciliation must also avoid Git and DB publication.
  expect((await invoke({ action: 'reconcile', approved: true })).result).toEqual({ ok: true });
  await unchanged();
  console.log('PG_CONNECTED_DIRTY_ROOT: SIGKILL after Git before reconciliation; fresh protected bootstrap denies writes; explicit reconciliation preserves DB files Git and page intent; no automatic winner');
}
