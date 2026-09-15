import { assertPageFileRootClean } from './page-file-root-transition.ts';
import type { OperationContext } from './operations.ts';
import { PageFileDatabase } from './page-file-db.ts';
import { pageFileSyncHost, PageFileSync, PageFileSyncConflict } from './page-file-sync.ts';
import { isAbsolute, sep, resolve } from 'node:path';
import { withLegacyPageFileWrite } from './page-file-writer-gate.ts';
import { resolvePageFilePath } from './markdown.ts';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';

/** Server config only; never accepted from operation params or DB config_set.
 * Live activation is deliberately unavailable until the writer/PG gates pass.
 * Integration mode is limited to PGLite and temporary filesystem roots.
 */
export interface PageFileRuntimeConfig {
  mode: 'disabled' | 'isolated-integration' | 'production';
  topology: 'single-host-local';
  brainId: string;
  lockDirectory: string;
  journalDirectory: string;
}
/** Entire legacy operation owns the gate; its write-through tail deliberately
 * does not reacquire flock. Only trusted server config supplies lock identity. */
export async function withRuntimeLegacyPageWrite<T>(ctx: Pick<OperationContext, 'engine' | 'config'>, source: string, slug: string, mutate: () => Promise<T>): Promise<T> {
  const config = ctx.config.page_file_runtime;
  if (!config || config.mode === 'disabled') return mutate();
  if (config.mode !== 'isolated-integration') throw new PageFileSyncConflict('file_runtime_prerequisites_pending');
  if (ctx.engine.kind !== 'pglite' || config.topology !== 'single-host-local' || !config.brainId)
    throw new PageFileSyncConflict('unsupported_file_runtime');
  const [src] = await ctx.engine.executeRaw<{local_path:string|null}>('SELECT local_path FROM sources WHERE id=$1',[source]);
  const sourceRoot = src?.local_path || await ctx.engine.getConfig('sync.repo_path');
  if (!sourceRoot) return mutate();
  const root = await realpath(sourceRoot);
  const temporaryRoot = await realpath(tmpdir());
  for (const path of [root,config.lockDirectory,config.journalDirectory]) {
    if (!isAbsolute(path) || !path.startsWith(temporaryRoot + sep) || path.split(sep).some(p => p === '.' || p === '..'))
      throw new PageFileSyncConflict('integration_requires_temporary_paths');
  }
  const [page] = await ctx.engine.executeRaw<{source_path:string|null}>('SELECT source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL LIMIT 1',[source,slug]);
  const stored = page?.source_path?.trim();
  if (src?.local_path && stored && isAbsolute(stored)) throw new Error('page_file_path_outside_root');
  const filePath = src?.local_path ? resolve(root,stored || `${slug}.md`) : resolvePageFilePath(root,slug,source);
  return withLegacyPageFileWrite(ctx.engine,source,slug,filePath,mutate,{root,lockDirectory:config.lockDirectory,topology:config.topology,timeoutMs:1000});
}

/** Trusted server configuration shared by actual root pull callers. */
export async function resolvePageFileRootHost(ctx: { engine: { readonly kind?: string }; config: OperationContext['config'] | null }, sourceRoot: string) {
  const configured = ctx.config?.page_file_runtime;
  if (!configured || configured.mode === 'disabled') return undefined;
  const config = structuredClone(configured);
  if (config.mode !== 'isolated-integration') throw new PageFileSyncConflict('file_runtime_prerequisites_pending');
  if (ctx.engine.kind !== 'pglite' || config.topology !== 'single-host-local' || !config.brainId)
    throw new PageFileSyncConflict('unsupported_file_runtime');
  const root = await realpath(sourceRoot);
  const temporaryRoot = await realpath(tmpdir());
  for (const path of [root, config.lockDirectory, config.journalDirectory]) {
    if (!isAbsolute(path) || !path.startsWith(temporaryRoot + sep) || path.split(sep).some(p => p === '.' || p === '..'))
      throw new PageFileSyncConflict('integration_requires_temporary_paths');
  }
  return { root, lockDirectory: config.lockDirectory, topology: config.topology, timeoutMs: 1000 };
}

/** Explicit trusted local lifecycle, never implicit enrollment on read/write. */
export async function enrollPageFileRuntime(ctx: Pick<OperationContext, 'engine' | 'config' | 'remote'>, source: string, slug: string) {
  if (ctx.remote !== false) throw new PageFileSyncConflict('permission_denied');
  const configured = ctx.config.page_file_runtime;
  if (!configured || configured.mode === 'disabled') throw new PageFileSyncConflict('file_runtime_unavailable');
  const config = structuredClone(configured);
  if (config.mode !== 'isolated-integration') throw new PageFileSyncConflict('file_runtime_prerequisites_pending');
  if (ctx.engine.kind !== 'pglite' || config.topology !== 'single-host-local' || !config.brainId)
    throw new PageFileSyncConflict('unsupported_file_runtime');
  const [src] = await ctx.engine.executeRaw<{local_path:string|null}>('SELECT local_path FROM sources WHERE id=$1',[source]);
  if (!src?.local_path) throw new PageFileSyncConflict('source_root_required');
  const root = await realpath(src.local_path);
  const temporaryRoot = await realpath(tmpdir());
  for (const path of [root,config.lockDirectory,config.journalDirectory]) {
    if (!isAbsolute(path) || !path.startsWith(temporaryRoot + sep) || path.split(sep).some(p => p === '.' || p === '..'))
      throw new PageFileSyncConflict('integration_requires_temporary_paths');
  }
  const { withPageFileEnrollment } = await import('./page-file-enrollment.ts');
  const host = {root,lockDirectory:config.lockDirectory,topology:config.topology,timeoutMs:1000};
  return new PageFileDatabase(ctx.engine, {brainId:config.brainId,journalDirectory:config.journalDirectory,
    withLockedBinding: fn => withPageFileEnrollment(ctx.engine,source,host,fn),
  }).enroll(source,slug);
}

export async function resolvePageFileRuntime(ctx: Pick<OperationContext, 'engine' | 'config'>, source: string, slug: string) {
  const configured = ctx.config.page_file_runtime;
  if (!configured || configured.mode === 'disabled') return undefined;
  const config = structuredClone(configured);
  if (config.mode !== 'isolated-integration') throw new PageFileSyncConflict('file_runtime_prerequisites_pending');
  if (ctx.engine.kind !== 'pglite' || config.topology !== 'single-host-local' || !config.brainId)
    throw new PageFileSyncConflict('unsupported_file_runtime');
  const [binding] = await ctx.engine.executeRaw<{canonical_root:string;relative_path:string;binding_id:string}>(
    'SELECT canonical_root,relative_path,binding_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2', [source,slug]);
  // No implicit enrollment; database-only pages retain the existing operation.
  if (!binding) return undefined;
  const root = await realpath(binding.canonical_root);
  const temporaryRoot = await realpath(tmpdir());
  for (const path of [root,config.lockDirectory,config.journalDirectory]) {
    if (!isAbsolute(path) || !path.startsWith(temporaryRoot + sep) || path.split(sep).some(p => p === '.' || p === '..'))
      throw new PageFileSyncConflict('integration_requires_temporary_paths');
  }
  const host = { brainId:config.brainId,journalDirectory:config.journalDirectory,
    ...pageFileSyncHost({root,paths:[binding.relative_path],lockDirectory:config.lockDirectory,topology:config.topology,timeoutMs:1000}) };
  const guardedHost = { ...host, async withLockedBinding<T>(fn:()=>Promise<T>):Promise<T> {
    return host.withLockedBinding(async () => {
      assertPageFileRootClean({root,lockDirectory:config.lockDirectory,topology:config.topology});
      const [current] = await ctx.engine.executeRaw<{canonical_root:string;relative_path:string;binding_id:string}>(
        'SELECT canonical_root,relative_path,binding_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2',[source,slug]);
      if (!current || current.binding_id !== binding.binding_id || current.canonical_root !== binding.canonical_root || current.relative_path !== binding.relative_path)
        throw new PageFileSyncConflict('binding_changed');
      return fn();
    });
  } };
  return { pages:new PageFileDatabase(ctx.engine,guardedHost), sync:new PageFileSync(ctx.engine,guardedHost) };
}
