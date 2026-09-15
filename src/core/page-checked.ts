import type { BrainEngine } from './engine.ts';
import { isDeepStrictEqual } from 'node:util';
import { updateCheckedPage, type CheckedPageFields } from './page-checked-store.ts';
import { stripTakesFence } from './takes-fence.ts';
import { stripFactsFence } from './facts-fence.ts';
import type { Operation, OperationContext, OperationError as OpError } from './operations.ts';

/** No importer, enrichment, graph, filesystem, provider, or background hooks. */
export function createPageCheckedOperations(deps: {
  OperationError: typeof OpError;
  /** Internal offline integration seam; production registry deliberately omits it. */
  filePages?: import('./page-file-db.ts').PageFileDatabase;
  resolveFileRuntime?: typeof import('./page-file-runtime.ts').resolvePageFileRuntime;
  validatePageSlug: (slug: string) => void;
  resolveFederatedWriteSourceId: (ctx: OperationContext, source: unknown) => string;
  resolveRequestedScope: (ctx: OperationContext, source: string | undefined) => unknown;
}): Operation[] {
  const { OperationError } = deps;
  const identity = (ctx: OperationContext, p: Record<string, unknown>, write: boolean) => {
    deps.validatePageSlug(p.slug as string);
    if (typeof p.source_id !== 'string' || !p.source_id || p.source_id.trim() !== p.source_id || p.source_id === '__all__') {
      throw new OperationError('invalid_params', 'An exact source_id is required');
    }
    if (write && ctx.viaSubagent === true) {
      const prefix = `wiki/agents/${ctx.subagentId}/`;
      if (!Number.isSafeInteger(ctx.subagentId) || (ctx.subagentId as number) < 0
        || !(p.slug as string).startsWith(prefix) || (p.slug as string).length === prefix.length) {
        throw new OperationError('permission_denied', 'Checked writes require the owning subagent namespace');
      }
    }
    if (ctx.remote !== false) {
      const grants = write ? ctx.auth?.writeSources : ctx.auth?.allowedSources;
      if (grants !== undefined && !grants.includes(p.source_id)) {
        throw new OperationError('permission_denied', 'Source is outside your grant');
      }
    }
    if (write) deps.resolveFederatedWriteSourceId(ctx, p.source_id);
    else deps.resolveRequestedScope(ctx, p.source_id);
    return [p.source_id, p.slug] as [string, string];
  };
  const privacy = (ctx: OperationContext, row: Record<string, unknown>) => {
    if (ctx.remote === false) return;
    for (const key of ['compiled_truth', 'timeline']) {
      const body = row[key] as string;
      if (stripFactsFence(stripTakesFence(body), { keepVisibility: ['world'] }) !== body) {
        throw new OperationError('permission_denied', 'Checked snapshot requires privacy redaction');
      }
    }
  };
  const eligible = async (engine: BrainEngine, row: Record<string, unknown>, ctx: OperationContext) => {
    const sources = await engine.executeRaw<{ local_path: string | null }>(
      'SELECT local_path FROM sources WHERE id = $1', [row.source_id]);
    // Some trusted server contexts carry legacy filesystem keys beyond GBrainConfig.
    const fileSync = (ctx.config as unknown as { sync?: { repo_path?: unknown } }).sync;
    if (row.page_kind !== 'markdown' || row.source_path !== null || !sources.length
      || sources[0].local_path || fileSync?.repo_path || await engine.getConfig('sync.repo_path')) {
      throw new OperationError('ineligible_page', 'Checked operations require a database-only markdown page');
    }
  };
  const receipt = (row: Record<string, unknown>) => ({
    source_id: row.source_id, slug: row.slug, revision: row.write_revision,
    page: { type: row.type, title: row.title, compiled_truth: row.compiled_truth,
      timeline: row.timeline, frontmatter: row.frontmatter },
    persistence: 'database_only',
    derived_state: 'chunks_current_embeddings_pending',
  });
  const identityParams = {
    slug: { type: 'string' as const, required: true, description: 'Exact page slug; no alias or fuzzy resolution.' },
    source_id: { type: 'string' as const, required: true, description: 'Exact owning source; no default or federation wildcard.' },
  };
  return [{
    name: 'recover_page_file_checked', scope: 'write', mutating: true, localOnly: true,
    description: 'Trusted local exact-intent recovery of a prepared file replacement. Explicit resume-exact or abort; CAS is not owner approval. Never selects unexpected file content.',
    params: {
      ...identityParams,
      action: { type:'string', required:true, description:'Explicit resume-exact or abort.' },
      operation_id: { type:'string', required:true, description:'Original operation UUID.' },
      expected_revision: { type:'string', required:true, description:'Original approved revision.' },
      file_baseline: { type:'object', required:true, description:'Original approved file baseline.' },
      page: { type:'object', required:true, description:'Original exact approved page projection.' },
      raw_markdown: { type:'string', required:true, description:'Original exact approved replacement bytes.' },
    },
    handler: async (ctx,p) => {
      if (ctx.remote !== false) throw new OperationError('permission_denied','Recovery requires a trusted local caller');
      const request = structuredClone(p);
      const [source,slug] = identity(ctx,request,true);
      if (ctx.dryRun || !['resume-exact','abort'].includes(request.action as string)) throw new OperationError('invalid_params','Explicit recovery intent required');
      const filePages = (await deps.resolveFileRuntime?.(ctx,source,slug))?.pages ?? deps.filePages;
      if (!filePages) throw new OperationError('ineligible_page','File runtime unavailable');
      return filePages.recover(source,slug,request,row => { identity(ctx,request,true); privacy(ctx,row); });
    },
  }, {
    name: 'get_page_checked', scope: 'read',
    description: 'Read an exact page snapshot and opaque revision for page-only CAS. Does not bump retrieval metadata. Not owner approval.',
    params: identityParams,
    handler: async (ctx, p) => {
      const [source, slug] = identity(ctx, p, false);
      const filePages = (await deps.resolveFileRuntime?.(ctx, source, slug))?.pages ?? deps.filePages;
      if (filePages) return filePages.get(source, slug, row => privacy(ctx, row));
      const rows = await ctx.engine.executeRaw<Record<string, unknown>>(
        `SELECT * FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`, [source, slug]);
      if (!rows.length) throw new OperationError('page_not_found', 'Page not found');
      await eligible(ctx.engine, rows[0], ctx);
      privacy(ctx, rows[0]);
      return receipt(rows[0]);
    },
  }, {
    name: 'put_page_checked', scope: 'write', mutating: true,
    description: 'Page-only conditional replacement of editable fields. Requires exact revision and separate owner approval. No graph/timeline extraction, file write-through, tags, chunks or embeddings.',
    params: {
      ...identityParams,
      operation_id: { type: 'string', description: 'File replacement idempotency UUID.' },
      file_baseline: { type: 'object', description: 'Original file baseline returned by checked read before preparation.' },
      raw_markdown: { type: 'string', description: 'Exact approved replacement file bytes as UTF-8.' },
      expected_revision: { type: 'string', required: true, description: 'Opaque revision returned by get_page_checked. Updates existing live pages only.' },
      page: { type: 'object', required: true, description: 'Full editable snapshot: type, title, compiled_truth, timeline, frontmatter. All other columns are preserved.' },
    },
    handler: async (ctx, p) => {
      const [source, slug] = identity(ctx, p, true);
      if (ctx.dryRun) {
        throw new OperationError('invalid_params', 'Checked apply is unavailable in dry-run; use get_page_checked for a read-only snapshot');
      }
      const update = !Object.hasOwn(p, 'if_absent') && typeof p.expected_revision === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.expected_revision);
      if (!update) throw new OperationError('invalid_params', 'Supply a valid expected_revision; create is not supported');
      const page = p.page as Record<string, unknown>;
      const keys = ['type', 'title', 'compiled_truth', 'timeline', 'frontmatter'];
      if (!page || typeof page !== 'object' || Array.isArray(page)
        || Object.keys(page).length !== keys.length || keys.some(k => !Object.hasOwn(page, k))
        || keys.slice(0, 4).some(k => typeof page[k] !== 'string' || (page[k] as string).includes('\0'))
        || !(page.type as string).trim() || !(page.title as string).trim()
        || !page.frontmatter || typeof page.frontmatter !== 'object' || Array.isArray(page.frontmatter)) {
        throw new OperationError('invalid_params', 'Supply exactly the complete editable snapshot with string content and object frontmatter');
      }
      const filePages = (await deps.resolveFileRuntime?.(ctx, source, slug))?.pages ?? deps.filePages;
      if (filePages) return filePages.put(source, slug, p, current => {
        identity(ctx, p, true); privacy(ctx, current);
      });
      const row = await updateCheckedPage(ctx.engine, {
        source, slug, expectedRevision: p.expected_revision as string, page: page as unknown as CheckedPageFields,
      }, async (current, tx) => { identity(ctx, p, true); await eligible(tx, current, ctx); privacy(ctx, current);
        if (!isDeepStrictEqual(page.frontmatter, current.frontmatter) || page.timeline !== current.timeline) {
          throw new OperationError('invalid_params', 'Frontmatter and timeline are preserved; changes require a separate operation');
        } });
      if (!row) throw new OperationError('precondition_failed', 'Page changed or is unavailable; re-read and obtain approval again');
      return receipt(row);
    },
  }];
}




