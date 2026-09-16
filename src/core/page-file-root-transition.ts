import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from './engine.ts';
import { acquirePageFileLock } from './page-file-lock.ts';
import type { PageFileCoordinationHost } from './page-file-writer-gate.ts';

type Engine = Pick<BrainEngine, 'executeRaw'>;
/** Trusted typed services only; never expose the private adapter engine. */
export interface PageFileRootHost extends PageFileCoordinationHost {
  revalidate?(): Promise<void>;
  authorizeBindings?(rows: readonly { source_id: string; slug: string }[]): void;
  transition?<T>(mutate: () => Promise<T>): Promise<T>;
  reconcile?(): Promise<void>;
}
type Binding = { binding_id:string; source_id:string; slug:string; canonical_root:string; relative_path:string; pending_op_id:string|null };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function marker(host: PageFileCoordinationHost) {
  return join(realpathSync(host.lockDirectory), digest(realpathSync(host.root) + '\0ROOT') + '.dirty');
}
function flushDirectory(host: PageFileCoordinationHost) {
  const fd = openSync(host.lockDirectory,'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableWrite(path:string, bytes:string, host:PageFileCoordinationHost) {
  const temp = path + '.tmp';
  const fd = openSync(temp,'w',0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp,path); flushDirectory(host);
}
/** Call INSIDE the shared root lock, before checked reads/writes, sync capture /
 * commit and enrollment. A missing coordination directory is not a clean root.
 * Never use this outside the gate as a replacement for writer serialization. */
export function assertPageFileRootClean(host: PageFileCoordinationHost): void {
  if (existsSync(marker(host))) throw Object.assign(new Error('page_file_root_sync_required'), {
    code: 'page_file_root_sync_required', acknowledgeable: false,
  });
}
async function bindings(engine:Engine, root:string):Promise<Binding[]> {
  const [schema] = await engine.executeRaw<{present:boolean}>("SELECT to_regclass('public.page_file_bindings') IS NOT NULL AS present");
  if (typeof schema?.present !== 'boolean') throw new Error('page_file_root_gate_unavailable');
  if (!schema.present) return [];
  const rows = await engine.executeRaw<Binding>('SELECT * FROM public.page_file_bindings');
  const affected:Binding[] = [];
  for (const b of rows) {
    const canonical = realpathSync(b.canonical_root);
    if (canonical === root) affected.push(b);
    else if (canonical.startsWith(root + '/') || root.startsWith(canonical + '/')) throw new Error('page_file_nested_root_unsupported');
  }
  if (affected.some(b=>b.pending_op_id)) throw new Error('pending_recovery');
  return affected;
}
function capture(rows:Binding[], root:string) {
  return rows.map(b => {
    const path = join(root,b.relative_path); const rel = relative(root,path);
    if (!rel || rel.startsWith('../') || isAbsolute(rel) || realpathSync(path) !== path) throw new Error('page_file_binding_changed');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('page_file_binding_changed');
    return {binding_id:b.binding_id, relative_path:b.relative_path, raw_sha256:digest(readFileSync(path))};
  });
}
function finish(rows:Binding[], root:string, host:PageFileCoordinationHost) {
  // Capture actual files, never infer success from Git's exit status. No DB
  // projection/index digest changes: ordinary sync must prove/index these bytes.
  const observations = capture(rows,root);
  durableWrite(marker(host)+'.observed',JSON.stringify({root,observations}),host);
  unlinkSync(marker(host)); flushDirectory(host);
}
/** INTERNAL locked seam: caller already owns exclusive root through callback.
 * Sole GBrain writer only. Callback must be awaited and preserve dirty/conflicting
 * files (no reset/clean/autostash). Generated helpers that bypass this gate must
 * be drained/replaced before activation. Root replacement/remapping is excluded.
 * Failure leaves a durable dirty marker; NEVER rollback authored files or journals.
 */
export async function transitionPageFileRoot<T>(engine:Engine, host:PageFileRootHost, mutate:()=>Promise<T>):Promise<T> {
  await host.revalidate?.();
  const root = realpathSync(host.root);
  assertPageFileRootClean(host);
  const rows = await bindings(engine,root);
  // Caller holds exclusive root; approve every affected binding before mutation.
  host.authorizeBindings?.(rows);
  if (!rows.length) return mutate();
  // Validate before mutation, including deletion/alias and dirty worktree policy.
  capture(rows,root);
  const status = execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'});
  if (status.length) throw new Error('page_file_root_worktree_dirty');
  durableWrite(marker(host),JSON.stringify({root,state:'mutating'}),host);
  // Invalidate previously captured sync/checked baselines, including Git ABA.
  // This is NOT indexed completion and never alters pending/journal authority.
  await engine.executeRaw('UPDATE page_file_bindings SET file_generation=file_generation+1 WHERE canonical_root=$1',[root]);
  const result = await mutate();
  await host.revalidate?.();
  if (realpathSync(host.root) !== root) throw new Error('page_file_binding_changed');
  const current = await bindings(engine,root);
  host.authorizeBindings?.(current);
  finish(current,root,host);
  return result;
}
/** Recovery classifies actual current files under the same exclusive gate, does
 * not rerun Git, change its index, clear pending ops, or overwrite any file. */
export async function reconcilePageFileRootTransition(engine:Engine, host:PageFileRootHost):Promise<void> {
  if (host.reconcile) return host.reconcile();
  await host.revalidate?.();
  const lock = await acquirePageFileLock({...host,rootMode:'exclusive',paths:[]});
  if (!lock) throw new Error('page_file_root_gate_unavailable');
  try {
    await host.revalidate?.();
    const root = realpathSync(host.root);
    if (!existsSync(marker(host))) return;
    const rows = await bindings(engine,root);
    host.authorizeBindings?.(rows);
    finish(rows,root,host);
  } finally { await lock.release(); }
}
