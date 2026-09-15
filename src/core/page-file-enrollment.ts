import { assertPageFileRootClean } from './page-file-root-transition.ts';
import { realpath } from 'node:fs/promises';
import type { BrainEngine } from './engine.ts';
import { acquirePageFileLock } from './page-file-lock.ts';
import type { PageFileCoordinationHost } from './page-file-writer-gate.ts';

/** Internal explicit enrollment seam; does not enable any runtime mode.
 * Install AS the enrollment adapter's withLockedBinding, not around an adapter
 * that independently reacquires its shared root/path lock (flock is not reentrant):
 * new PageFileDatabase(engine, { brainId, journalDirectory,
 *   withLockedBinding: fn => withPageFileEnrollment(engine, source, host, fn) })
 *   .enroll(source, slug)
 * The callback must await the entire validation + binding transaction COMMIT.
 * Checked get/put must use a different adapter with the normal shared/path host.
 * Host is trusted server configuration; root authority is sources.local_path.
 * All root/source remapping writers must coordinate on this same native gate.
 */
export async function withPageFileEnrollment<T>(
  engine: Pick<BrainEngine, 'executeRaw'>,
  source: string,
  host: PageFileCoordinationHost,
  enrollAndCommit: () => Promise<T>,
): Promise<T> {
  const root = await realpath(host.root);
  const check = async () => {
    const [row] = await engine.executeRaw<{ local_path: string | null }>(
      'SELECT local_path FROM sources WHERE id=$1', [source]);
    if (!row?.local_path || await realpath(row.local_path) !== root || await realpath(host.root) !== root)
      throw new Error('page_file_binding_changed');
  };
  await check();
  // Exclusive ROOT, not shared root + page: serializes the legacy absence check
  // and unrelated-path root mutation as well as the binding insertion itself.
  const lock = await acquirePageFileLock({ ...host, root, rootMode: 'exclusive', paths: [] });
  if (!lock) throw new Error('page_file_gate_busy');
  try { await check(); assertPageFileRootClean({...host,root}); return await enrollAndCommit(); }
  finally { await lock.release(); }
}
