import type { BrainEngine } from '../engine.ts';
import { hasPageFileRuntimeCandidate, resolvePageFileRootHost } from '../page-file-runtime.ts';
import { withLegacyPageFileWrite } from '../page-file-writer-gate.ts';
import { assertPageFileRootClean } from '../page-file-root-transition.ts';

/** Facts have no request config: authority comes only from the private engine
 * registration. The existing trusted root resolver supplies coordination, never
 * a DB-configured lock directory. Lock the actual facts path, not source_path.
 */
export async function withFactsFileWrite<T>(
  engine: BrainEngine, source: string, slug: string, root: string, filePath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  if (!await hasPageFileRuntimeCandidate(engine)) {
    return withLegacyPageFileWrite(engine, source, slug, filePath, mutate);
  }
  const context = { engine, config: null };
  const host = await resolvePageFileRootHost(context, root);
  if (!host) throw new Error('page_file_runtime_source_unavailable');
  return withLegacyPageFileWrite(engine, source, slug, filePath, async () => {
    // Re-resolve under the gate to revalidate private lifecycle, manifest pins
    // and source mapping. Resolving a host never acquires another flock.
    const current = await resolvePageFileRootHost(context, root);
    if (!current || current.root !== host.root || current.lockDirectory !== host.lockDirectory)
      throw new Error('page_file_binding_changed');
    assertPageFileRootClean(host);
    return mutate();
  }, host);
}
