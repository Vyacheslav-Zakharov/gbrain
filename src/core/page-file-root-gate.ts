import { resolve, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { BrainEngine } from './engine.ts';
import { acquirePageFileLock } from './page-file-lock.ts';
import type { PageFileCoordinationHost } from './page-file-writer-gate.ts';
import { transitionPageFileRoot } from './page-file-root-transition.ts';

export class PageFileRootGateError extends Error {
  constructor(public readonly code: 'page_file_root_gate_unavailable' | 'page_file_unsupported_root_writer') {
    super(code); this.name = 'PageFileRootGateError';
  }
}
export interface PageFileRootPermit { readonly root: string }
const permits = new WeakSet<PageFileRootPermit>();
function physicalRoot(path: string): string {
  let current = resolve(path); const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error;
      suffix.unshift(basename(current)); current = dirname(current);
    }
  }
}
const contains = (root: string, path: string) => path === root || path.startsWith(root === '/' ? '/' : root + '/');
/** With a host, hold the canonical root exclusively across both the catalog
 * check and awaited mutation. Enrollment must take this SAME exclusive lock.
 * Without a host this remains a disabled-mode compatibility preflight only.
 * The engine must own all enrollments for the root. Root remapping and nested
 * independently coordinated roots are unsupported topology.
 * With a trusted coordination host, Git mutation uses durable root dirty state
 * and observed-byte capture, never an indexed-projection acknowledgement.
 * Callers must install assertPageFileRootClean in checked/sync/enrollment hosts
 * before enabling this seam; see page-file-root-transition.ts. No-host calls
 * remain fail-closed on enrolled roots and are not a production coordination path.
 */
export async function withLegacyPageFileRootMutation<T>(
  engine: Pick<BrainEngine, 'executeRaw'>, root: string,
  mutate: (permit: PageFileRootPermit) => T,
  host?: PageFileCoordinationHost,
): Promise<Awaited<T>> {
  if (host) {
    const canonical = realpathSync(host.root);
    if (realpathSync(root) !== canonical) throw new PageFileRootGateError('page_file_root_gate_unavailable');
    const lock = await acquirePageFileLock({ ...host, root: canonical, rootMode: 'exclusive', paths: [] });
    if (!lock) throw new PageFileRootGateError('page_file_root_gate_unavailable');
    try {
      if (realpathSync(root) !== canonical || realpathSync(host.root) !== canonical) throw new PageFileRootGateError('page_file_root_gate_unavailable');
      return await transitionPageFileRoot(engine, { ...host, root: canonical }, async () => {
        const permit = Object.freeze({ root: resolve(root) }); permits.add(permit);
        try { return await mutate(permit); } finally { permits.delete(permit); }
      });
    } finally { await lock.release(); }
  }
  const lexical = resolve(root); const physical = physicalRoot(root);
  const [schema] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('public.page_file_bindings') IS NOT NULL AS present");
  if (!schema || typeof schema.present !== 'boolean') throw new PageFileRootGateError('page_file_root_gate_unavailable');
  if (schema.present) {
    const bindings = await engine.executeRaw<{ canonical_root: string; relative_path: string }>('SELECT canonical_root, relative_path FROM public.page_file_bindings');
    for (const b of bindings) {
      const file = join(b.canonical_root, b.relative_path);
      if ([lexical, physical].some(r => contains(r, file) || contains(r, physicalRoot(file)))) {
        throw new PageFileRootGateError('page_file_unsupported_root_writer');
      }
    }
  }
  const permit = Object.freeze({ root: lexical }); permits.add(permit);
  try { return await mutate(permit); } finally { permits.delete(permit); }
}
export function assertPageFileRootPermit(root: string, permit?: PageFileRootPermit): void {
  if (!permit || !permits.has(permit) || permit.root !== resolve(root)) {
    throw new PageFileRootGateError('page_file_root_gate_unavailable');
  }
}
