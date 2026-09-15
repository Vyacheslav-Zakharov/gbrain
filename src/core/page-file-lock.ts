/** Linux/Bun local advisory coordination. All writers must use the SAME stable
 * lockDirectory outside source checkouts. Never remove/replace its lock files.
 * Independent open file descriptions make flock an in-process mutex too: no
 * PID/TTL lease, subprocess lock holder, or orphan cleanup protocol is involved.
 * Caller holds these locks before DB locks and releases DB locks first.
 * Eligibility is an OPERATOR prerequisite: Linux glibc + Bun, one host/mount
 * namespace and canonical root per source, local filesystem with flock support,
 * one trusted non-replaced lock directory shared by every cooperating writer.
 * This module does not discover NFS, independent checkouts, bind-mount aliases,
 * symlink/hardlink page aliases, or root configuration changes. Binding validation
 * must exclude those before entry and revalidate after acquiring the gate.
 * No external-editor protection or fairness/reentrant acquisition is promised.
 */
import { constants, openSync, closeSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dlopen, FFIType } from 'bun:ffi';

export interface PageFileLockOptions {
  root: string;
  /** Trusted, persistent, host-wide directory outside all mutable roots. */
  lockDirectory: string;
  topology: 'single-host-local';
  paths?: readonly string[];
  rootMode?: 'shared' | 'exclusive';
  timeoutMs?: number;
}
export interface PageFileLockHandle { release(): Promise<void> }
let native: ReturnType<typeof loadNative> | undefined;
function loadNative() {
  if (process.platform !== 'linux') throw new Error('unsupported_page_file_lock_platform');
  return dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Null means contention. Other failures throw; no fallback to stealable leases. */
export async function acquirePageFileLock(options: PageFileLockOptions): Promise<PageFileLockHandle | null> {
  if (options.topology !== 'single-host-local') throw new Error('unsupported_page_file_lock_topology');
  for (const path of options.paths ?? []) {
    if (!path || path.includes('\0') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new Error('noncanonical_page_file_lock_path');
    }
  }
  const timeout = options.timeoutMs ?? 0;
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('invalid_page_file_lock_timeout');
  native ??= loadNative();
  const root = realpathSync(options.root);
  mkdirSync(options.lockDirectory, { recursive: true, mode: 0o700 });
  const directory = realpathSync(options.lockDirectory);
  if (directory === root || directory.startsWith(root + '/')) throw new Error('lock_directory_must_be_outside_root');
  const start = performance.now();
  const held: number[] = [];
  const release = async () => { while (held.length) closeSync(held.pop()!); };
  try {
    const keys: [string, number][] = [[root + '\0ROOT', options.rootMode === 'exclusive' ? 2 : 1],
      ...[...new Set(options.paths ?? [])].sort().map(path => [root + '\0PATH\0' + path, 2] as [string, number])];
    for (const [key, mode] of keys) {
      const fd = openSync(join(directory, digest(key) + '.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | 524288 /* Linux O_CLOEXEC */, 0o600);
      held.push(fd);
      const deadline = start + timeout;
      while (native.symbols.flock(fd, mode | 4) !== 0) {
        if (performance.now() >= deadline) { await release(); return null; }
        await new Promise(r => setTimeout(r, Math.min(10, deadline - performance.now())));
      }
    }
    return { release };
  } catch (error) { await release(); throw error; }
}
