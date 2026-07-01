import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { enqueueDueSourceRefreshJobs, listDueSourceRefreshes } from '../source-ingest/freshness.ts';

export async function runPhaseSourceRefresh(engine: BrainEngine, opts: {
  dryRun?: boolean;
  sourceId?: string;
  queue?: string;
  limit?: number;
} = {}): Promise<PhaseResult> {
  const due = await listDueSourceRefreshes(engine, { limit: opts.limit ?? 50, source_id: opts.sourceId });
  if (opts.dryRun) {
    return {
      phase: 'source_refresh',
      status: 'ok',
      duration_ms: 0,
      summary: `source_refresh dry-run: ${due.length} profile(s) due`,
      details: { mode: 'dry-run', count: due.length, due },
    };
  }
  const jobs = await enqueueDueSourceRefreshJobs(engine, due, { queue: opts.queue ?? 'default', no_embed: true });
  return {
    phase: 'source_refresh',
    status: 'ok',
    duration_ms: 0,
    summary: `source_refresh enqueued ${jobs.length} source-ingest job(s)`,
    details: { mode: 'enqueue', count: due.length, due, jobs },
  };
}
