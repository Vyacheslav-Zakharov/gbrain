import { AsyncLocalStorage } from 'node:async_hooks';
import { openSync, closeSync, realpathSync, constants, lstatSync, readFileSync, writeFileSync, fsyncSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from './engine.ts';

/** Local working-tree exclusion, not a distributed DB transaction or rollback.
 * Every admitted callback MUST await all of its mutations/children. Lock files
 * are permanent: unlinking one splits the kernel lock domain. No wire permit.
 */
export class WriteAdmissionError extends Error {
  readonly code = 'SOURCE_WRITE_BUSY';
  readonly retryable = true;
  constructor(message = 'Source writes are temporarily reserved; retry the entire operation.') {
    super(message);
    this.name = 'WriteAdmissionError';
  }
}
export interface WriteAdmissionOptions { timeoutMs?: number; repositoryPaths?: readonly string[] }
export interface ExclusiveWriteAdmissionOptions extends WriteAdmissionOptions { durable?: boolean }
type Grant = { exclusive: boolean; active: boolean };
const context = new AsyncLocalStorage<Map<string, Grant>>();
let native: Promise<(fd: number, operation: number) => number> | undefined;
async function flock() {
  if (process.platform !== 'linux') throw new Error('Native write admission requires Linux flock');
  return native ??= import('bun:ffi').then(({ dlopen, FFIType }) => {
    const lib = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    return lib.symbols.flock;
  });
}

/** null means a genuinely multi-source operation: admit every registered repo.
 * Always derive paths from the registry, never from remote request parameters.
 */
async function resources(engine: BrainEngine, sourceIds: readonly string[] | null, requireLocal = false, repositoryPaths: readonly string[] = []): Promise<string[]> {
  const rows = await engine.executeRaw<{ id: string; local_path: string | null }>(
    'SELECT id, local_path FROM sources',
  );
  const wanted = sourceIds === null ? null : new Set(sourceIds);
  if (requireLocal && sourceIds?.some(id => !rows.some(r => r.id === id && r.local_path))) {
    throw new Error('Exclusive admission requires registered local sources');
  }
  const paths = new Set<string>();
  const selected = wanted ? [...wanted].map(id => rows.find(r => r.id === id) ?? { id, local_path: null }) : rows;
  // Match write-through's host-repo fallback for sources without local_path.
  const fallback = selected.some(r => !r.local_path) ? await engine.getConfig?.('sync.repo_path') : null;
  for (const row of [...selected, ...repositoryPaths.map(local_path => ({ id: '', local_path }))]) {
    const localPath = row.local_path || fallback;
    if (!localPath) continue; // Truly DB-only: no filesystem publication target.
    const root = realpathSync(localPath);
    const git = spawnSync('/usr/bin/git', ['-C', root, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
    });
    if (git.error) throw git.error;
    if (git.status !== 0 && !git.stderr.includes('not a git repository')) throw new Error('Cannot resolve source Git lock domain');
    // Common dir coordinates aliases, nested source directories AND worktrees.
    const directory = git.status === 0 ? realpathSync(resolve(root, git.stdout.trim())) : root;
    paths.add(join(directory, '.gbrain-write-admission'));
  }
  return [...paths].sort();
}

async function admit<T>(engine: BrainEngine, sourceIds: readonly string[] | null,
  exclusive: boolean, callback: () => Promise<T>, options: ExclusiveWriteAdmissionOptions, recovery = false): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) {
    throw new Error('write admission timeoutMs must be between 0 and 300000');
  }
  const deadline = performance.now() + timeoutMs;
  const paths = await resources(engine, sourceIds, exclusive, options.repositoryPaths);
  const inherited = context.getStore();
  if (inherited) {
    if (recovery || options.durable) throw new WriteAdmissionError('Durable admission/recovery must be the outermost operation');
    if ([...inherited.values()].some(g => !g.active)) throw new WriteAdmissionError('Expired write admission context');
    if (paths.every(p => inherited.has(p) && (!exclusive || inherited.get(p)!.exclusive))) return callback();
    // No lock upgrades or scope expansion part-way through a mutation.
    throw new WriteAdmissionError('Nested mutation exceeds its admitted source/repository scope');
  }
  if (!paths.length) return callback();
  const lock = await flock();
  const fds: number[] = [];
  const gates: number[] = [];
  const grant: Grant = { exclusive, active: true };
  const acquire = async (path: string, mode: number) => {
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    fds.push(fd);
    while (lock(fd, mode | 4) !== 0) { // LOCK_NB; any error fails closed within deadline.
      if (performance.now() >= deadline) throw new WriteAdmissionError();
      await new Promise(r => setTimeout(r, Math.min(10, Math.max(1, deadline - performance.now()))));
    }
    return fd;
  };
  try {
    // Exclusive keeps the gate while draining + running; shared holds the gate
    // only through admission. Later readers of content don't use these locks.
    for (const p of paths) gates.push(await acquire(p + '.gate', exclusive ? 2 : 1));
    for (const p of paths) await acquire(p + '.writers', exclusive ? 2 : 1);
    const confirmed = await resources(engine, sourceIds, exclusive, options.repositoryPaths);
    if (JSON.stringify(confirmed) !== JSON.stringify(paths)) throw new WriteAdmissionError('Source repository binding changed; retry');
    if (!recovery && paths.some(p => markerExists(p + '.recovery'))) {
      throw new WriteAdmissionError('Source publication requires operator recovery; writes remain paused, reads are available');
    }
    if (options.durable) {
      const identity = JSON.stringify({ version: 1, run: randomUUID(), pid: process.pid,
        boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        process_stat: readFileSync('/proc/self/stat', 'utf8'), created_at: new Date().toISOString() });
      for (const p of paths) {
        const fd = openSync(p + '.recovery', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, identity); fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(p);
      }
    }
    if (!exclusive) for (const fd of gates) lock(fd, 8); // LOCK_UN
    const result = await context.run(new Map(paths.map(p => [p, grant])), callback);
    // Errors/crashes leave markers: a dead parent does not prove settled children.
    if (options.durable || recovery) for (const p of paths) {
      if (markerExists(p + '.recovery')) { unlinkSync(p + '.recovery'); syncDirectory(p); }
    }
    return result;
  } finally {
    grant.active = false;
    for (const fd of fds.reverse()) closeSync(fd);
  }
}

function markerExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function syncDirectory(path: string): void {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function withSourceWrites<T>(engine: BrainEngine, sourceIds: readonly string[] | null,
  callback: () => Promise<T>, options: WriteAdmissionOptions = {}): Promise<T> {
  return admit(engine, sourceIds, false, callback, options);
}

/** Trusted native callback API only. Never expose a request flag for this. */
export function withExclusiveSourceWrites<T>(engine: BrainEngine, sourceIds: readonly string[],
  callback: () => Promise<T>, options: ExclusiveWriteAdmissionOptions = {}): Promise<T> {
  if (!sourceIds.length) throw new Error('Exclusive admission requires explicit sources');
  return admit(engine, sourceIds, true, callback, options);
}

/** Trusted operator only. Prove prior children settled and reconcile uncertain
 * DB/Git results without reimport. Failure leaves markers; no automatic reap.
 */
export function recoverSourceWrites<T>(engine: BrainEngine, sourceIds: readonly string[],
  reconcile: () => Promise<T>, options: WriteAdmissionOptions = {}): Promise<T> {
  if (!sourceIds.length) throw new Error('Recovery requires explicit sources');
  return admit(engine, sourceIds, true, reconcile, options, true);
}
