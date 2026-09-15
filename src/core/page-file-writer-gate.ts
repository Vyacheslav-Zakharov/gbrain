import type { BrainEngine } from './engine.ts';
import { resolve, dirname, basename, join, relative, isAbsolute } from 'node:path';
import { acquirePageFileLock, type PageFileLockOptions } from './page-file-lock.ts';
import { realpathSync } from 'node:fs';

/** Trusted host configuration, never caller/DB-controlled. All enrollment and
 * writers must use this same canonical root and stable external lock directory.
 * Nested roots, aliases and root remapping are operator-ineligible topology.
 */
export type PageFileCoordinationHost = Pick<PageFileLockOptions, 'root' | 'lockDirectory' | 'topology' | 'timeoutMs'>;

/** Hold root(shared) then path(exclusive), before checking enrollment and through
 * the entire awaited legacy DB+file mutation. This is not an enrolled CAS writer.
 * No host means disabled legacy compatibility, NOT concurrency protection.
 */
export async function withLegacyPageFileWrite<T>(
  engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string,
  filePath: string, mutate: () => T, host?: PageFileCoordinationHost,
): Promise<Awaited<T>> {
  if (!host) {
    await assertLegacyPageFileWriteAllowed(engine, sourceId, slug, filePath);
    return await mutate();
  }
  const root = realpathSync(host.root);
  const path = relative(root, physicalTarget(filePath));
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('page_file_path_outside_root');
  const lock = await acquirePageFileLock({ ...host, root, rootMode: 'shared', paths: [path] });
  if (!lock) throw new Error('page_file_gate_busy');
  try {
    if (realpathSync(host.root) !== root || relative(root, physicalTarget(filePath)) !== path) throw new Error('page_file_binding_changed');
    await assertLegacyPageFileWriteAllowed(engine, sourceId, slug, filePath);
    return await mutate();
  } finally { await lock.release(); }
}

// Resolve existing ancestors without creating anything. Only ENOENT means an
// absent path; EACCES, ELOOP and other observation failures remain fail-closed.
function physicalTarget(filePath: string): string {
  let current = resolve(filePath);
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error;
      suffix.unshift(basename(current));
      current = dirname(current);
    }
  }
}

/** Fail-closed bridge for legacy DB-first write-through, NOT a CAS protocol.
 * Enrolled pages always refuse, including pending recovery. Enrollment/activation
 * MUST remain disabled: an absence check cannot serialize concurrent enrollment.
 * Engine-level guards must independently reject the preceding DB-first mutation.
 */
export async function assertLegacyPageFileWriteAllowed(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  slug: string,
  filePath: string,
): Promise<void> {
  // Old schemas are supported only after a successful catalog probe. Never catch
  // query/permission/connection failures and reinterpret them as "not enrolled".
  const [schema] = await engine.executeRaw<{ present: boolean }>(
    `SELECT to_regclass('public.page_file_bindings') IS NOT NULL AS present`,
  );
  if (!schema || typeof schema.present !== 'boolean') throw new Error('page_file_gate_unavailable');
  if (!schema.present) return;
  const bindings = await engine.executeRaw<{ source_id: string }>(
    `SELECT source_id FROM public.page_file_bindings
      WHERE (source_id=$1 AND slug=$2) OR (canonical_root || '/' || relative_path) IN ($3,$4)`,
    [sourceId, slug, resolve(filePath), physicalTarget(filePath)],
  );
  if (bindings.length) throw new Error('page_file_unsupported_writer');
}
