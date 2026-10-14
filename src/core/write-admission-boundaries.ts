import type { Application, RequestHandler } from 'express';
import type { BrainEngine } from './engine.ts';
import { withSourceWrites, WriteAdmissionError } from './write-admission.ts';

// These paths only read/preview. POST is used for large request payloads.
const PREVIEW_POSTS = new Set([
  '/admin/api/source-ingest/catalog/delete-impact',
  '/admin/api/source-ingest/catalog/connector/list-objects',
  '/admin/api/source-ingest/catalog/connector/test',
  '/admin/api/source-ingest/catalog/base-view/discover',
  '/admin/api/source-ingest/discover',
  '/admin/api/source-ingest/test-connection',
  '/admin/api/source-ingest/dry-run',
  '/admin/api/source-ingest/catalog/article-view/dry-run',
]);

/** Wrap final async handlers, NOT response-finish/close middleware: client
 * disconnect cannot release exclusion while the server still mutates.
 * Review/catalog routes may affect multiple sources resolved inside handlers;
 * do not trust a source_id supplied in the request to narrow their admission.
 */
export function installHttpWriteAdmission(app: Application, engine: BrainEngine): void {
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    const register = app[method].bind(app);
    (app as any)[method] = (path: unknown, ...handlers: RequestHandler[]) => {
      const protectedRoute = typeof path === 'string' && !PREVIEW_POSTS.has(path) && (
        path.startsWith('/admin/api/meeting-review/') || path.startsWith('/admin/api/ai-review/') ||
        path.startsWith('/admin/api/source-ingest/') || path.startsWith('/portal/api/review/')
      );
      if (protectedRoute) {
        const handler = handlers.pop()!;
        handlers.push(async (req, res, next) => {
          try {
            await withSourceWrites(engine, null, async () => { await handler(req, res, next); });
          } catch (error) {
            if (error instanceof WriteAdmissionError && !res.headersSent) {
              res.setHeader('Retry-After', '5');
              res.status(503).json({ error: 'source_write_busy', retryable: true, message: error.message });
            } else next(error);
          }
        });
      }
      return (register as any)(path, ...handlers);
    };
  }
}

/** Job data is not a permit. Only known, source-scoped native handlers get a
 * narrow scope; other handlers may genuinely write across the whole brain.
 * source-ingest resolves its approved source inside the executor wrapper.
 */
export function withWorkerWriteAdmission<T>(engine: BrainEngine, name: string,
  data: Record<string, unknown>, callback: () => Promise<T>): Promise<T> {
  if (name === 'source-ingest' || name === 'sync') return callback(); // native entrypoint resolves full scope before mutation
  if (name === 'embed-backfill' && typeof data.sourceId === 'string') {
    return withSourceWrites(engine, [data.sourceId], callback);
  }
  return withSourceWrites(engine, null, callback);
}

const READ_CLI = new Set([
  'serve', 'watch', 'call', 'jobs', 'agent', 'features', 'graph-query', 'salience',
  'anomalies', 'status', 'whoknows', 'transcripts', 'models', 'founder', 'recall',
  'code-def', 'code-refs', 'code-callers', 'code-callees', 'check-backlinks',
  'lint', 'check-resolvable', 'check-update', 'skillpack-check', 'report',
]);

/** Existing scoped importer/sync APIs carry their own nested admission. Other
 * command implementations are admitted for their complete awaited invocation.
 */
export async function withCliWriteAdmission<T>(engine: BrainEngine, command: string,
  args: string[], callback: () => Promise<T>): Promise<T> {
  if (args.includes('--help') || args.includes('-h') || READ_CLI.has(command)) return callback();
  if (['sources', 'repos'].includes(command) && ['list', 'current', 'status', 'archived', 'audit'].includes(args[0] ?? 'list')) return callback();
  if (command === 'search' && args[0] !== 'tune') return callback();
  if (command === 'think' && !args.includes('--save') && !args.includes('--take')) return callback();
  if (command === 'import') return callback(); // source resolution at runImport, before first mutation
  if (command === 'sync' && !args.includes('--all')) {
    const { resolveSourceId } = await import('./source-resolver.ts');
    const index = args.indexOf('--source');
    const sourceId = await resolveSourceId(engine, index >= 0 ? args[index + 1] : null);
    const repoIndex = args.indexOf('--repo');
    return withSourceWrites(engine, [sourceId], callback, { repositoryPaths: repoIndex >= 0 && args[repoIndex + 1] ? [args[repoIndex + 1]] : [] });
  }
  return withSourceWrites(engine, null, callback);
}
