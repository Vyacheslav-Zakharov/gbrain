import type { BrainEngine } from '../engine.ts';

export interface SourceRefreshDueRow {
  profile_id: string;
  connector_id: string;
  source_object: string;
  approved_source_id: string;
  freshness_policy: string | null;
  total_rows: number;
  due_rows: number;
  never_synced_rows: number;
  oldest_stale_after: string | null;
  last_synced_at: string | null;
  reason: 'stale' | 'initial_sync';
}

export interface SourceRefreshPlan {
  mode: 'report-only' | 'enqueue';
  count: number;
  due: SourceRefreshDueRow[];
  jobs?: Array<{ profile_id: string; job_id: number; status: string; queue: string; run_id: string; idempotency_key: string; deduped?: boolean }>;
}

export interface SourceRefreshEnqueueOptions {
  queue?: string;
  priority?: number;
  timeout_ms?: number;
  require_clean_git?: boolean;
  no_embed?: boolean;
  now?: Date;
}

export function parseFreshnessPolicyMs(policy: string | null | undefined): number | null {
  if (!policy) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(policy.trim());
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  const ms = (((days * 24 + hours) * 60) + minutes) * 60_000;
  return ms > 0 ? ms : null;
}

export function nextStaleAfter(policy: string | null | undefined, base = new Date()): Date | null {
  const ms = parseFreshnessPolicyMs(policy);
  return ms === null ? null : new Date(base.getTime() + ms);
}

export async function listDueSourceRefreshes(engine: BrainEngine, opts: {
  profile_id?: string;
  limit?: number;
  now?: Date;
} = {}): Promise<SourceRefreshDueRow[]> {
  const params: unknown[] = [];
  const where: string[] = [`p.status IN ('reviewed', 'active')`];
  if (opts.profile_id) { params.push(opts.profile_id); where.push(`p.profile_id = $${params.length}`); }
  params.push((opts.now ?? new Date()).toISOString());
  const nowParam = `$${params.length}::timestamptz`;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  params.push(limit);
  const rows = await engine.executeRaw<SourceRefreshDueRow>(
    `WITH joined AS (
       SELECT p.profile_id,
              p.connector_id,
              p.source_object,
              p.approved_source_id,
              COALESCE(s.freshness_policy, p.profile_json->'freshness'->>'policy') AS freshness_policy,
              s.external_id,
              s.last_synced_at,
              s.stale_after,
              CASE
                WHEN s.external_id IS NULL THEN true
                WHEN s.stale_after IS NULL AND COALESCE(s.freshness_policy, p.profile_json->'freshness'->>'policy') IS NOT NULL THEN true
                WHEN s.stale_after IS NOT NULL AND s.stale_after <= ${nowParam} THEN true
                ELSE false
              END AS is_due
         FROM source_ingest_profiles p
         LEFT JOIN source_sync_state s ON s.profile_id = p.profile_id
        WHERE ${where.join(' AND ')}
     )
     SELECT profile_id,
            connector_id,
            source_object,
            approved_source_id,
            max(freshness_policy) AS freshness_policy,
            count(external_id)::int AS total_rows,
            count(*) FILTER (WHERE is_due)::int AS due_rows,
            count(*) FILTER (WHERE external_id IS NULL)::int AS never_synced_rows,
            min(stale_after)::text AS oldest_stale_after,
            max(last_synced_at)::text AS last_synced_at,
            CASE WHEN count(*) FILTER (WHERE external_id IS NULL) > 0 THEN 'initial_sync' ELSE 'stale' END AS reason
       FROM joined
      GROUP BY profile_id, connector_id, source_object, approved_source_id
     HAVING count(*) FILTER (WHERE is_due) > 0
      ORDER BY oldest_stale_after NULLS FIRST, profile_id
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export function sourceRefreshWindowKey(row: SourceRefreshDueRow): string {
  const marker = row.reason === 'initial_sync'
    ? 'initial'
    : (row.oldest_stale_after ?? row.last_synced_at ?? 'unknown');
  return `${row.profile_id}:${marker}`.replace(/[^A-Za-z0-9_.:-]+/g, '_');
}

export async function enqueueDueSourceRefreshJobs(
  engine: BrainEngine,
  due: SourceRefreshDueRow[],
  opts: SourceRefreshEnqueueOptions = {},
): Promise<NonNullable<SourceRefreshPlan['jobs']>> {
  const { MinionQueue } = await import('../minions/queue.ts');
  const queue = new MinionQueue(engine);
  const jobs: NonNullable<SourceRefreshPlan['jobs']> = [];
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  for (const row of due) {
    const windowKey = sourceRefreshWindowKey(row);
    const runId = `source-refresh-${row.profile_id}-${stamp}`;
    const data = {
      profile_id: row.profile_id,
      run_id: runId,
      ...(typeof opts.require_clean_git === 'boolean' ? { require_clean_git: opts.require_clean_git } : {}),
      changed_since: row.reason !== 'initial_sync',
      no_embed: opts.no_embed !== false,
    };
    const idempotencyKey = `source-refresh:${windowKey}`;
    const job = await queue.add('source-ingest', data, {
      queue: opts.queue || 'default',
      priority: typeof opts.priority === 'number' ? opts.priority : 0,
      max_attempts: 1,
      max_stalled: 5,
      timeout_ms: typeof opts.timeout_ms === 'number' ? opts.timeout_ms : 10 * 60_000,
      idempotency_key: idempotencyKey,
    });
    const actualRunId = String((job.data as Record<string, unknown>)?.run_id ?? runId);
    jobs.push({
      profile_id: row.profile_id,
      job_id: job.id,
      status: job.status,
      queue: job.queue,
      run_id: actualRunId,
      idempotency_key: idempotencyKey,
      deduped: actualRunId !== runId,
    });
  }
  return jobs;
}
