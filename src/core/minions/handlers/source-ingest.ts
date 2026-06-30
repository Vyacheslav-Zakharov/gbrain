import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import { runSourceIngestExecutor, type SourceIngestExecutorResult } from '../../source-ingest/executor.ts';

export interface SourceIngestJobData {
  profile_id: string;
  run_id?: string;
  limit?: number;
  require_clean_git?: boolean;
  allow_db_only?: boolean;
  no_embed?: boolean;
  changed_since?: boolean;
}

function parseBoolean(data: Record<string, unknown>, key: keyof SourceIngestJobData): boolean | undefined {
  return typeof data[key] === 'boolean' ? data[key] as boolean : undefined;
}

function parseNumber(data: Record<string, unknown>, key: keyof SourceIngestJobData): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseSourceIngestJobData(data: Record<string, unknown>): SourceIngestJobData {
  const profileId = data.profile_id;
  if (typeof profileId !== 'string' || profileId.trim().length === 0) {
    throw new Error('source-ingest job requires data.profile_id');
  }
  const runId = typeof data.run_id === 'string' && data.run_id.trim().length > 0
    ? data.run_id.trim()
    : undefined;
  return {
    profile_id: profileId.trim(),
    ...(runId ? { run_id: runId } : {}),
    ...(parseNumber(data, 'limit') !== undefined ? { limit: parseNumber(data, 'limit') } : {}),
    ...(parseBoolean(data, 'require_clean_git') !== undefined ? { require_clean_git: parseBoolean(data, 'require_clean_git') } : {}),
    ...(parseBoolean(data, 'allow_db_only') !== undefined ? { allow_db_only: parseBoolean(data, 'allow_db_only') } : {}),
    ...(parseBoolean(data, 'no_embed') !== undefined ? { no_embed: parseBoolean(data, 'no_embed') } : {}),
    ...(parseBoolean(data, 'changed_since') !== undefined ? { changed_since: parseBoolean(data, 'changed_since') } : {}),
  };
}

export function summarizeSourceIngestProgress(result: SourceIngestExecutorResult) {
  return {
    phase: 'completed',
    run_id: result.run_id,
    profile_id: result.profile_id,
    source_id: result.source_id,
    ok: result.ok,
    counts: result.counts,
    git_commit: result.git_commit ?? null,
    graph_writes: result.graph_writes,
  };
}

export function makeSourceIngestHandler(engine: BrainEngine) {
  return async function sourceIngestHandler(job: MinionJobContext): Promise<SourceIngestExecutorResult> {
    const opts = parseSourceIngestJobData(job.data);
    await job.updateProgress({ phase: 'starting', profile_id: opts.profile_id, run_id: opts.run_id ?? null });
    await job.log(`[source-ingest] starting run profile=${opts.profile_id} run_id=${opts.run_id ?? '(auto)'}`);
    if (job.signal.aborted) throw new Error('source-ingest job aborted before start');
    const result = await runSourceIngestExecutor(engine, opts, {
      warn: (message: string) => { void job.log(`[source-ingest:warn] ${message}`); },
    });
    await job.updateProgress(summarizeSourceIngestProgress(result));
    return result;
  };
}
