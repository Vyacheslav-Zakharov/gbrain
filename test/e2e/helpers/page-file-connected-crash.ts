import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { PageFileJournal } from '../../../src/core/page-file-journal.ts';

// Include names, node types and exact bytes (including record.json), not UTF-8
// projections. Walking the whole root also observes withheld or extra evidence.
export function snapshotCrashJournal(path: string): unknown {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true };
    throw error;
  }
  if (stat.isSymbolicLink()) return { symlink: readlinkSync(path) };
  if (stat.isDirectory()) return { directory: readdirSync(path).sort().map(name => [name, snapshotCrashJournal(join(path, name))]) };
  if (stat.isFile()) return { hex: readFileSync(path).toString('hex') };
  throw new Error(`unexpected journal node: ${path}`);
}

// Each call is a fresh OS process, including every read and terminal replay.
// IPC marks an awaited durable boundary; timeouts are failure bounds, NOT sleeps.
async function child(input: Record<string, unknown>) {
  let receive!: (value: any) => void;
  const message = new Promise<any>(resolve => { receive = resolve; });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'page-file-crash-child.ts')], {
    env: process.env, stdout: 'ignore', stderr: 'inherit', ipc: receive,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  // The unchanged 15s budget covers send, IPC, validation AND process exit.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('crash child lifetime deadline 15s')), 15_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      proc.send(input);
      const result = await Promise.race([message,
        proc.exited.then(code => { throw new Error(`crash child exited before IPC: ${code}`); }),
      ]);
      if (input.boundary) {
        expect(result).toEqual({ boundary: input.boundary, pid: proc.pid });
        proc.kill('SIGKILL');
        await proc.exited;
        expect(proc.signalCode).toBe('SIGKILL');
      } else {
        expect(await proc.exited).toBe(0);
      }
      return result;
    })()]);
  } finally {
    clearTimeout(timer);
    // Validation, send, IPC and timeout failures all kill/reap. Cleanup has its
    // own shorter hard bound; a broken OS reaper must not hang fixture teardown.
    try {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await Promise.race([proc.exited, new Promise<never>((_, reject) => {
        reapTimer = setTimeout(() => reject(new Error('crash child SIGKILL reap deadline 1s')), 1_000);
      })]);
    } finally { clearTimeout(reapTimer); }
  }
}

/** Reuses the already enrolled actual connected fixture and its frozen pins.
 * Owner observes state only; child writes use ordinary bootstrap -> private CAS.
 * No schema, role, candidate, journal-record or operation-row fabrication. */
export async function exerciseConnectedCrash(f: {
  admin: PostgresEngine; source: string; root: string; journal: string;
  config: { database_url: string; poolSize: number };
}) {
  const target = join(f.root, 'connected.md');
  const invoke = (operation: string, request: any, extra = {}) => child({ config: f.config, source: f.source, operation, request, ...extra });
  const get = () => invoke('get_page_checked', { source_id: f.source, slug: 'connected' });
  const state = async () => {
    const rows: unknown[] = [];
    for (const table of ['pages', 'page_file_bindings']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE source_id=$1 ORDER BY to_jsonb(t)::text`, [f.source]));
    rows.push(await f.admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM page_file_operations t
      WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1) ORDER BY operation_id`, [f.source]));
    for (const table of ['page_versions', 'content_chunks']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1) ORDER BY to_jsonb(t)::text`, [f.source]));
    return { rows, raw: readFileSync(target).toString('hex'), journal: snapshotCrashJournal(f.journal) };
  };
  for (const boundary of ['journal', 'prepared', 'rename', 'commit'] as const) {
    const initial = await get(); expect(initial.error).toBeUndefined();
    const before = initial.result;
    const preoperation = await state();
    const raw = before.file.raw_markdown.replace(before.page.compiled_truth, `Crash ${boundary}`);
    const request = { source_id: f.source, slug: 'connected', operation_id: randomUUID(),
      expected_revision: before.revision, file_baseline: before.file.baseline,
      page: { ...before.page, compiled_truth: `Crash ${boundary}` }, raw_markdown: raw };
    await invoke('put_page_checked', request, { boundary });
    const evidence = await new PageFileJournal(f.journal).read(request.operation_id);
    expect(evidence.before.toString()).toBe(before.file.raw_markdown);
    expect(evidence.after.toString()).toBe(raw);
    const [binding] = await f.admin.executeRaw('SELECT pending_op_id,file_generation::text FROM page_file_bindings WHERE source_id=$1', [f.source]);
    const ops = await f.admin.executeRaw('SELECT state,revision FROM page_file_operations WHERE operation_id=$1', [request.operation_id]);
    expect(ops.map(row => row.state)).toEqual(boundary === 'journal' ? [] : [boundary === 'commit' ? 'committed' : 'prepared']);
    expect(binding.pending_op_id).toBe(boundary === 'prepared' || boundary === 'rename' ? request.operation_id : null);
    expect(binding.file_generation).toBe(String(BigInt(before.file.baseline.generation) + (boundary === 'commit' ? 1n : 0n)));
    expect(readFileSync(target, 'utf8')).toBe(boundary === 'rename' || boundary === 'commit' ? raw : before.file.raw_markdown);
    const frozen = await state();
    if (boundary !== 'commit') {
      // pages, versions and chunks must still be EXACTLY the pre-write baseline.
      for (const index of [0, 3, 4]) expect(frozen.rows[index]).toEqual(preoperation.rows[index]);
    }
    const restarted = await get();
    if (boundary === 'prepared' || boundary === 'rename') expect(restarted.error.message).toContain('pending_recovery');
    else expect(restarted.result.revision).toBe(boundary === 'commit' ? ops[0].revision : before.revision);
    expect(await state()).toEqual(frozen); // bootstrap/read MUST NOT publish or repair

    const recover = (action: string, extra = {}, change = {}) => invoke('recover_page_file_checked', { ...request, action, ...change }, extra);
    expect((await recover('resume-exact', { remote: true })).error.code).toBe('permission_denied');
    expect(await state()).toEqual(frozen);
    expect((await recover('resume-exact', {}, { file_baseline: { ...request.file_baseline, generation: '999999' } })).error).toBeDefined();
    expect(await state()).toEqual(frozen);

    if (boundary === 'prepared') {
      // Missing operation evidence (not the pinned directory) is preserved and
      // denied on a fresh bootstrap. Restore only the exact withheld evidence.
      const journal = join(f.journal, request.operation_id), withheld = journal + '.withheld';
      renameSync(journal, withheld);
      try {
        const missing = await state();
        expect(snapshotCrashJournal(journal)).toEqual({ absent: true });
        const withheldEvidence = snapshotCrashJournal(withheld);
        for (const action of ['resume-exact', 'abort']) {
          const denied = await recover(action);
          expect(denied.error.code).toBe('ENOENT');
          expect(denied.error.message).toContain('record.json');
          expect(await state()).toEqual(missing);
          expect(snapshotCrashJournal(journal)).toEqual({ absent: true });
          expect(snapshotCrashJournal(withheld)).toEqual(withheldEvidence);
        }
        const retry = await invoke('put_page_checked', request);
        expect(retry.error.code).toBe('ENOENT');
        expect(retry.error.message).toContain('record.json');
        expect(await state()).toEqual(missing);
      } finally { renameSync(withheld, journal); }
      expect(await state()).toEqual(frozen);
      writeFileSync(target, 'Unexpected third-party bytes');
      const unexpected = await state();
      for (const action of ['resume-exact', 'abort']) {
        expect((await recover(action)).result.status).toBe('conflict');
        expect(await state()).toEqual(unexpected);
      }
      // Operator restores exact observed before-image for this disposable case.
      writeFileSync(target, evidence.before);
      expect(await state()).toEqual(frozen);
      const aborted = await recover('abort'); expect(aborted.result.status).toBe('aborted');
      const terminal = await state();
      for (const index of [0, 3, 4]) expect(terminal.rows[index]).toEqual(preoperation.rows[index]);
      expect(terminal.raw).toEqual(preoperation.raw);
      expect(terminal.journal).toEqual(frozen.journal);
      expect((await recover('abort')).result).toEqual(aborted.result);
      expect(await state()).toEqual(terminal);
      expect((await recover('resume-exact')).result.status).toBe('aborted');
      expect(await state()).toEqual(terminal);
      expect((await invoke('put_page_checked', request)).result.status).toBe('conflict');
      expect(await state()).toEqual(terminal);
    } else {
      if (boundary === 'rename') {
        expect((await recover('abort')).result.status).toBe('conflict');
        expect(await state()).toEqual(frozen);
        expect((await invoke('put_page_checked', request)).result.status).toBe('pending_recovery');
        expect(await state()).toEqual(frozen);
      }
      const resumed = await recover('resume-exact'); expect(resumed.result.status).toBe('committed');
      const terminal = await state();
      expect(terminal.journal).toEqual(frozen.journal);
      expect((await recover('resume-exact')).result).toEqual(resumed.result);
      expect(await state()).toEqual(terminal);
      expect((await invoke('put_page_checked', request)).result).toEqual(resumed.result);
      expect(await state()).toEqual(terminal);
      expect((await get()).result.file.raw_markdown).toBe(raw);
    }
    const [finalBinding] = await f.admin.executeRaw('SELECT pending_op_id,file_generation::text FROM page_file_bindings WHERE source_id=$1', [f.source]);
    expect(finalBinding.pending_op_id).toBeNull();
    expect(finalBinding.file_generation).toBe(String(BigInt(before.file.baseline.generation) + (boundary === 'prepared' ? 0n : 1n)));
    const finalRead = await get(); expect(finalRead.error).toBeUndefined();
    if (boundary === 'prepared') expect(finalRead.result.revision).toBe(before.revision);
    else expect(finalRead.result.revision).not.toBe(before.revision);
    console.log(`PG_CONNECTED_CRASH: SIGKILL ${boundary}; fresh protected bootstrap; no auto-publish; exact authorized terminal replay`);
  }
}
