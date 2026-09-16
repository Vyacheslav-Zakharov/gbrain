import type { BrainEngine } from '../engine.ts';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { withFactsFileWrite } from '../facts/with-file-write.ts';
import { hasPageFileRuntimeCandidate, resolvePageFileRootHost } from '../page-file-runtime.ts';
import { assertLegacyPageFileWriteAllowed } from '../page-file-writer-gate.ts';
import { acquirePageFileLock } from '../page-file-lock.ts';
import { assertPageFileRootClean } from '../page-file-root-transition.ts';

type Target = { sourceId: string; slug: string; filePath: string };

/** One whole mutation; never nest per-target gates (flock is not reentrant).
 * Single targets reuse the established trusted-engine host gate. Multiple
 * targets acquire root(shared) once and all deduplicated sorted path locks
 * through the native coordinator, then preflight EVERY endpoint before writes.
 */
export async function withCycleFileWrites<T>(
  engine: BrainEngine, root: string, targets: readonly Target[], mutate: () => Promise<T>,
): Promise<T> {
  if (!targets.length) throw new Error('page_file_gate_unavailable');
  if (targets.length === 1) {
    const target = targets[0];
    return withFactsFileWrite(engine, target.sourceId, target.slug, root, target.filePath, mutate);
  }
  const preflight = async () => {
    try {
      for (const target of targets)
        await assertLegacyPageFileWriteAllowed(engine, target.sourceId, target.slug, target.filePath);
    } catch (cause) {
      const code = cause instanceof Error && cause.message.startsWith('page_file_')
        ? cause.message : 'page_file_gate_unavailable';
      throw Object.assign(new Error(code, { cause }), { code });
    }
  };
  if (!await hasPageFileRuntimeCandidate(engine)) {
    await preflight();
    return mutate();
  }
  const context = { engine, config: null };
  const host = await resolvePageFileRootHost(context, root);
  if (!host) throw new Error('page_file_runtime_source_unavailable');
  const canonicalRoot = realpathSync(host.root);
  const paths = targets.map(target => {
    const path = relative(canonicalRoot, physicalTarget(target.filePath));
    if (!path || path === '..' || path.startsWith('../') || isAbsolute(path))
      throw new Error('page_file_path_outside_root');
    return path;
  });
  const lock = await acquirePageFileLock({ ...host, root: canonicalRoot, rootMode: 'shared', paths });
  if (!lock) throw new Error('page_file_gate_busy');
  try {
    const current = await resolvePageFileRootHost(context, root);
    if (!current || current.root !== host.root || current.lockDirectory !== host.lockDirectory
      || realpathSync(host.root) !== canonicalRoot
      || targets.some((target, i) => relative(canonicalRoot, physicalTarget(target.filePath)) !== paths[i]))
      throw new Error('page_file_binding_changed');
    assertPageFileRootClean(host);
    await preflight();
    return await mutate();
  } finally { await lock.release(); }
}

// Resolve without mkdir: refusal must precede even canonical materialization.
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
