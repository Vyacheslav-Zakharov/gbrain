import { posix } from 'node:path';

export interface ProjectionPolicy {
  mode: string;
  sourceId?: string;
  root?: string;
  managed?: boolean;
  /** All input/sync roots; trusted enrollment must supply the complete inventory. */
  inputRoots?: string[];
}
export interface ProjectionSnapshot {
  sourceId: string;
  pageId: string;
  generation: number;
  pageKind: string;
  slug: string;
  title: string;
  body: string;
  tags: string[];
  sourcePath?: string;
}
export interface ProjectionResult {
  status: 'not_required' | 'blocked' | 'pending';
  reason: string;
  materialized: false;
  plan?: { path: string; markdown: string; renderer: 'preview-v1' };
}

/** Proposed materializer entry, NOT a durable exporter. No IO/engine capabilities.
 * Plans are untrusted previews until the future guarded adapter validates physical
 * roots, ownership, policy generation, writer rights and an atomic DB obligation.
 */
export function materializeMarkdownProjection(input: {
  policy?: ProjectionPolicy;
  snapshot: unknown;
}): ProjectionResult {
  const policy = input.policy;
  if (!policy || policy.mode === 'disabled' || policy.mode === 'db_only') {
    return { status: 'not_required', reason: 'disabled_or_unconfigured', materialized: false };
  }
  const blocked = (reason: string): ProjectionResult => ({ status: 'blocked', reason, materialized: false });
  if (policy.mode !== 'projection_required') return blocked('policy_not_supported');
  const root = policy.root;
  const canonicalRoot = (p: string) => p !== '/' && posix.isAbsolute(p) && posix.normalize(p) === p && !/[\\\0]/.test(p);
  if (!root || !canonicalRoot(root) || policy.managed !== true || !Array.isArray(policy.inputRoots)) return blocked('unmanaged_root');
  for (const path of policy.inputRoots) {
    if (!canonicalRoot(path) || path === root || root.startsWith(path + '/') || path.startsWith(root + '/')) return blocked('input_root_overlap');
  }
  const page = input.snapshot as ProjectionSnapshot | undefined;
  const segment = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
  if (!page || typeof page.sourceId !== 'string' || !segment.test(page.sourceId) || page.sourceId !== policy.sourceId) return blocked('source_scope');
  if (page.pageKind !== 'markdown') return blocked('not_markdown_article');
  if (typeof page.slug !== 'string' || !page.slug.split('/').every(part => segment.test(part))) return blocked('unsafe_article_path');
  if (!page.pageId || !Number.isSafeInteger(page.generation) || page.generation < 1 || typeof page.title !== 'string' || typeof page.body !== 'string' || !Array.isArray(page.tags) || !page.tags.every(tag => typeof tag === 'string')) return blocked('invalid_snapshot');
  // sourcePath is intentionally never a destination (PDF/DOCX originals stay untouched).
  const metadata = { source_id: page.sourceId, page_id: page.pageId, generation: page.generation, title: page.title, tags: [...new Set(page.tags)].sort() };
  const markdown = '---\n' + Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n\n' + page.body + '\n';
  return { status: 'pending', reason: 'durable_adapter_not_connected', materialized: false, plan: { path: posix.join(root, page.sourceId, page.slug + '.md'), markdown, renderer: 'preview-v1' } };
}
