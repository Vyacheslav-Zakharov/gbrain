import { assertPageFileRootClean } from './page-file-root-transition.ts';
import { acquirePageFileLock } from './page-file-lock.ts';
import type { OperationContext } from './operations.ts';
import { PageFileDatabase } from './page-file-db.ts';
import { pageFileSyncHost, PageFileSync, PageFileSyncConflict } from './page-file-sync.ts';
import { isAbsolute, sep, resolve } from 'node:path';
import { withLegacyPageFileWrite } from './page-file-writer-gate.ts';
import { resolvePageFilePath } from './markdown.ts';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';

import { createPageFileAuthority, type PageFileAuthorityOptions } from './page-file-authority.ts';
import { validatePageFileHostManifest, type PageFileHostManifestOptions } from './page-file-host.ts';
import type { BrainEngine } from './engine.ts';

type Candidate = {
  ready: Promise<{ host: ReturnType<typeof validatePageFileHostManifest>; authority: Awaited<ReturnType<typeof createPageFileAuthority>> }>;
  closed: boolean;
};
// Trusted bootstrap association, never a config/operation field. Tombstones stay
// associated after close/failure so requests cannot fall through to ordinary SQL.
const candidates = new WeakMap<object, Candidate>();

/** Import routing probes the private registration, not a public config flag.
 * Tombstones and host drift must refuse before any legacy import fallback. */
export async function hasPageFileRuntimeCandidate(engine: BrainEngine): Promise<boolean> {
  const candidate = candidates.get(engine);
  if (!candidate) return false;
  if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
  const { host } = await candidate.ready;
  if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
  host.revalidate();
  return true;
}

/** Disabled-candidate integration only. No production caller installs this.
 * The lifecycle owner must await close before disconnecting its ordinary engine.
 * All request contexts sharing that engine share this one private authority.
 */
export async function createPageFileRuntimeCandidate(options: {
  mode: 'offline-verification'; engine: BrainEngine;
  host: PageFileHostManifestOptions; authority: PageFileAuthorityOptions;
}) {
  if (options.mode !== 'offline-verification' || options.authority.mode !== 'offline-verification')
    throw new PageFileSyncConflict('file_runtime_prerequisites_pending');
  if (candidates.has(options.engine)) throw new PageFileSyncConflict('page_file_runtime_already_registered');
  const candidate: Candidate = { closed: false, ready: Promise.resolve().then(async () => {
    const host = validatePageFileHostManifest(options.host);
    if (options.engine.kind !== 'postgres' || host.manifest.database !== options.authority.expected.database
      || host.manifest.adapterRole !== options.authority.expected.role)
      throw new PageFileSyncConflict('page_file_runtime_identity_mismatch');
    const authority = await createPageFileAuthority(options.authority);
    return { host, authority };
  }) };
  candidates.set(options.engine, candidate);
  try { await candidate.ready; } catch (error) { candidate.closed = true; throw error; }
  let closing: Promise<void> | undefined;
  return Object.freeze({ close(): Promise<void> {
    candidate.closed = true;
    return closing ??= candidate.ready.then(({ authority }) => authority.close());
  } });
}

async function resolveCandidate(candidate: Candidate, engine: BrainEngine, source: string, slug: string) {
  if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
  const { host, authority } = await candidate.ready;
  if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
  host.revalidate();
  const [binding] = await engine.executeRaw<{ canonical_root: string; relative_path: string; binding_id: string }>(
    'SELECT canonical_root,relative_path,binding_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2', [source, slug]);
  if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
  // Absence permits only the checked operation's existing DB-only eligibility
  // and privacy checks, never implicit enrollment or an enrolled-page fallback.
  if (!binding) return undefined;
  const root = host.manifest.roots.find(r => r.sourceId === source);
  if (!root) throw new PageFileSyncConflict('page_file_runtime_source_unavailable');
  if (binding.canonical_root !== root.directory.path) throw new PageFileSyncConflict('binding_changed');
  const coordination = { root: root.directory.path, paths: [binding.relative_path], lockDirectory: host.manifest.lock.path,
    topology: host.manifest.topology, timeoutMs: 1000 };
  const lockHost = pageFileSyncHost(coordination);
  const targetHost = { brainId: host.manifest.brainId, journalDirectory: root.journal.path,
    async withLockedBinding<T>(fn: () => Promise<T>): Promise<T> {
      // Refuse missing/replaced directories before the integration lock helper
      // can create them; repeat under the lock through adapter completion.
      host.revalidate();
      return lockHost.withLockedBinding(async () => {
        if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
        host.revalidate();
        assertPageFileRootClean(coordination);
        const [current] = await engine.executeRaw<typeof binding>(
          'SELECT canonical_root,relative_path,binding_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2', [source, slug]);
        if (!current || current.binding_id !== binding.binding_id || current.canonical_root !== binding.canonical_root
          || current.relative_path !== binding.relative_path) throw new PageFileSyncConflict('binding_changed');
        host.revalidate();
        return fn();
      });
    } };
  const bound = (validate: (row: Record<string, any>) => void) => authority.forPage({ source, slug, host: targetHost, validate });
  const checkTarget = (s: string, p: string) => {
    if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
    if (s !== source || p !== slug) throw new PageFileSyncConflict('binding_changed');
  };
  const pages: Pick<PageFileDatabase, 'get' | 'put' | 'recover'> = Object.freeze({
    get: (s, p, validate) => { checkTarget(s, p); return bound(validate).pages.get(); },
    put: (s, p, request, validate) => { checkTarget(s, p); return bound(validate).pages.put(request as import('./page-file-authority.ts').PageFileAuthorityWrite); },
    recover: (s, p, request, validate) => { checkTarget(s, p); return bound(validate).pages.recover(request as import('./page-file-authority.ts').PageFileAuthorityWrite & { action: 'resume-exact' | 'abort' }); },
  });
  const service = bound(() => {});
  const sync: Pick<PageFileSync, 'capture' | 'commit'> = Object.freeze({
    capture: (s, p) => { checkTarget(s, p); return service.sync.capture(); },
    commit: baseline => { checkTarget(baseline.source, baseline.slug); return service.sync.commit(baseline); },
  });
  return { pages, sync };
}

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
  if (config?.mode === 'production') throw new PageFileSyncConflict('file_runtime_prerequisites_pending');
  const candidate = candidates.get(ctx.engine);
  if (candidate) {
    if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
    const { host } = await candidate.ready;
    const validate = () => {
      if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
      host.revalidate();
    };
    validate();
    const root = host.manifest.roots.find(r => r.sourceId === source);
    if (!root) throw new PageFileSyncConflict('page_file_runtime_source_unavailable');
    const target = async () => {
      const [src] = await ctx.engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [source]);
      if (src?.local_path !== root.directory.path) throw new PageFileSyncConflict('binding_changed');
      const [page] = await ctx.engine.executeRaw<{ source_path: string | null }>('SELECT source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL LIMIT 1', [source, slug]);
      const stored = page?.source_path?.trim();
      if (stored && isAbsolute(stored)) throw new Error('page_file_path_outside_root');
      return resolve(root.directory.path, stored || `${slug}.md`);
    };
    const filePath = await target();
    validate();
    const coordination = { root: root.directory.path, lockDirectory: host.manifest.lock.path, topology: host.manifest.topology, timeoutMs: 1000 };
    // Ordinary engine only. The existing gate checks enrollment/collisions under
    // root(shared)+path(exclusive), held until the registered DB+file tail ends.
    return withLegacyPageFileWrite(ctx.engine, source, slug, filePath, async () => {
      validate();
      assertPageFileRootClean(coordination);
      if (await target() !== filePath) throw new PageFileSyncConflict('binding_changed');
      validate();
      return mutate();
    }, coordination);
  }
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
export async function resolvePageFileRootHost(ctx: { engine: Partial<Pick<BrainEngine, 'kind' | 'executeRaw'>>; config: OperationContext['config'] | null }, sourceRoot: string): Promise<import('./page-file-root-transition.ts').PageFileRootHost | undefined> {
  if (ctx.config?.page_file_runtime?.mode === 'production') throw new PageFileSyncConflict('file_runtime_prerequisites_pending');
  const candidate = candidates.get(ctx.engine);
  if (candidate) {
    if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
    const { host, authority } = await candidate.ready;
    const validate = () => {
      if (candidate.closed) throw new PageFileSyncConflict('page_file_runtime_closed');
      host.revalidate();
    };
    validate();
    const canonical = await realpath(sourceRoot);
    const root = host.manifest.roots.find(r => r.directory.path === canonical);
    if (!root) {
      // Independent sources retain the ordinary catalog absence gate. Never
      // send overlapping unmanaged roots through a different lock namespace.
      if (host.manifest.roots.some(r => canonical.startsWith(r.directory.path + sep) || r.directory.path.startsWith(canonical + sep)))
        throw new PageFileSyncConflict('page_file_nested_root_unsupported');
      return undefined;
    }
    const coordination = { root: canonical, lockDirectory: host.manifest.lock.path, topology: host.manifest.topology, timeoutMs: 1000 };
    const validateTarget = async () => {
      validate();
      if (await realpath(sourceRoot) !== canonical) throw new PageFileSyncConflict('binding_changed');
      if (!ctx.engine.executeRaw) throw new PageFileSyncConflict('page_file_root_gate_unavailable');
      const [src] = await ctx.engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [root.sourceId]);
      if (src?.local_path !== canonical) throw new PageFileSyncConflict('binding_changed');
      validate();
    };
    await validateTarget();
    const withExclusiveRoot = async <T>(fn: () => Promise<T>): Promise<T> => {
      await validateTarget();
      const lock = await acquirePageFileLock({ ...coordination, rootMode: 'exclusive', paths: [] });
      if (!lock) throw new PageFileSyncConflict('page_file_root_gate_unavailable');
      try { await validateTarget(); const result = await fn(); await validateTarget(); return result; }
      finally { await lock.release(); }
    };
    const services = authority.forRoot({ ...coordination, withExclusiveRoot, revalidate: validateTarget });
    return Object.freeze({ ...coordination, transition: services.transition,
      reconcile: async () => { await validateTarget(); await services.reconcile(); await validateTarget(); } });
  }
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
  if (candidates.has(ctx.engine)) throw new PageFileSyncConflict('page_file_candidate_lifecycle_unavailable');
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
  if (configured?.mode === 'production') throw new PageFileSyncConflict('file_runtime_prerequisites_pending');
  const candidate = candidates.get(ctx.engine);
  if (candidate) return resolveCandidate(candidate, ctx.engine, source, slug);
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
