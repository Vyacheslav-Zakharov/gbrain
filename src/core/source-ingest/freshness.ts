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
  jobs?: Array<{ profile_id: string; job_id: number; status: string; queue: string; run_id: string }>;
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
