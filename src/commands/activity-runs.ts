import type { BrainEngine } from '../core/engine.ts';
import type { MinionJobStatus } from '../core/minions/types.ts';

export const ACTIVITY_PERIODS = ['24h', 'yesterday', '7d', '30d', '365d'] as const;
export type ActivityPeriod = typeof ACTIVITY_PERIODS[number];
export const ACTIVITY_JOB_STATUSES = [
  'waiting', 'active', 'completed', 'failed', 'delayed', 'dead',
  'cancelled', 'waiting-children', 'paused',
] as const satisfies readonly MinionJobStatus[];

const PERIOD_MS: Record<ActivityPeriod, number> = {
  '24h': 24 * 60 * 60 * 1000,
  'yesterday': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000,
};

export interface ActivityQuery {
  period?: string;
  since?: string;
  until?: string;
  status?: string;
  name?: string;
  source?: string;
  limit?: number;
  offset?: number;
  exportAll?: boolean;
}

export interface ActivityRange {
  period: ActivityPeriod | 'custom';
  since: string;
  until: string;
}

export interface ActivityPhase {
  phase: string;
  status: string;
  duration_ms: number;
  summary: string;
  details: Record<string, string | number | boolean>;
  has_error: boolean;
  error_code?: string;
  pages_affected_count: number;
}

export interface ActivityRun {
  id: number;
  name: string;
  status: string;
  source_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  partial: boolean;
  has_error: boolean;
  phases: ActivityPhase[];
}

export interface ActivitySnapshot {
  schema_version: 1;
  generated_at: string;
  range: ActivityRange;
  filters: { status?: string; name?: string; source?: string };
  summary: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    dead: number;
    cancelled: number;
    active: number;
    waiting: number;
    delayed: number;
    waiting_children: number;
    paused: number;
    duration_ms: number;
    estimated_spend_usd: number;
    pages_changed: number;
    atoms_extracted: number;
    concepts_written: number;
    proposals_inserted: number;
    takes_written: number;
    facts_inserted: number;
  };
  phase_rollup: Array<{
    phase: string;
    status: string;
    runs: number;
    duration_ms: number;
    estimated_spend_usd: number;
  }>;
  by_type: Array<{ name: string; total: number; completed: number; failed: number; partial: number }>;
  by_source: Array<{ source_id: string; total: number; completed: number; failed: number; partial: number }>;
  runs: ActivityRun[];
  statuses: readonly MinionJobStatus[];
  pagination: { limit: number; offset: number; returned: number; total: number; export_truncated: boolean };
}

interface SummaryRow {
  total: unknown;
  completed: unknown;
  partial: unknown;
  failed: unknown;
  dead: unknown;
  cancelled: unknown;
  active: unknown;
  waiting: unknown;
  delayed: unknown;
  waiting_children: unknown;
  paused: unknown;
  duration_ms: unknown;
}

interface MetricRow {
  estimated_spend_usd: unknown;
  pages_changed: unknown;
  atoms_extracted: unknown;
  concepts_written: unknown;
  proposals_inserted: unknown;
  takes_written: unknown;
  facts_inserted: unknown;
}

interface PhaseRollupRow {
  phase: string | null;
  status: string | null;
  runs: unknown;
  duration_ms: unknown;
  estimated_spend_usd: unknown;
}

interface GroupRow {
  key: string;
  total: unknown;
  completed: unknown;
  failed: unknown;
  partial: unknown;
}

interface JobRow {
  id: number;
  name: string;
  status: string;
  source_id: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  error_text: string | null;
  result: unknown;
}

function finiteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function iso(value: string | Date | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const SAFE_DETAIL_KEYS = new Set([
  'added', 'dryRun', 'gaps', 'mode', 'pages_affected', 'brier', 'profile_written',
  'skipped', 'total_resolved', 'voice_gate_attempts', 'voice_gate_passed',
  'buckets_processed', 'buckets_skipped', 'facts_consolidated', 'takes_written',
  'facts_inserted', 'max_total_cost_usd', 'max_total_walltime_min', 'pages_processed',
  'pages_skipped', 'skipped_by_brain_wide_cap', 'skipped_by_brain_wide_walltime',
  'sources_count', 'sources_processed', 'spent_usd', 'embedded', 'pages_embedded_count',
  'total_chunks', 'would_embed', 'max_cost_usd', 'max_pages_per_tick', 'order',
  'pages_enriched', 'pages_skipped_insufficient', 'incremental', 'linksCreated',
  'slugs_targeted', 'timelineCreated', 'atoms_extracted', 'budget_usd', 'dry_run',
  'duplicates_skipped', 'estimated_spend_usd', 'pack_gated', 'reason',
  'pages_skipped_budget', 'transcripts_processed', 'transcripts_skipped_budget',
  'transcripts_total', 'factsDeleted', 'factsInserted', 'pagesScanned', 'pagesWithFacts',
  'phantoms_ambiguous', 'phantoms_lock_busy', 'phantoms_more_pending',
  'phantoms_redirected', 'phantoms_scanned', 'phantoms_skipped_drift', 'auto_applied',
  'auto_resolve', 'auto_resolve_threshold', 'budget_exhausted', 'cache_hits',
  'ensemble_invoked', 'ensemble_unanimous', 'prompt_version', 'takes_scanned',
  'too_recent', 'verdicts_written', 'fixed', 'issues', 'pages_scanned', 'excluded',
  'total_orphans', 'total_pages', 'cache_misses', 'proposal_run_id',
  'proposals_inserted', 'purged_batch_retry_audit_files_count',
  'purged_brainstorm_checkpoints_count', 'purged_checkpoints_count',
  'purged_orphan_clones_count', 'purged_pages_count', 'purged_sources_count',
  'purged_volunteer_events_count', 'pages_recomputed', 'chunks_walked',
  'edges_ambiguous', 'edges_resolved', 'edges_unmatched', 'sources_walked',
  'suggestions_emitted', 'count', 'modified', 'deleted', 'failedFiles', 'renamed',
  'syncStatus', 'atoms_seen', 'concepts_written', 'groups_found',
]);
const SAFE_STRING_DETAIL_KEYS = new Set([
  'mode', 'order', 'reason', 'skipped', 'prompt_version', 'proposal_run_id', 'syncStatus',
]);

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : fallback;
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?):\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(?:authorization|password|passwd|secret|token|api[_-]?key|connection_string)\s*[:=]\s*\S+/gi, '[redacted-secret]')
    .replace(/(?:^|\s)(?:[A-Za-z]:\\|\/(?:home|Users|tmp|etc|var|opt|srv)\/)[^\s"']+/g, ' [redacted-path]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeDetails(value: unknown): Record<string, string | number | boolean> {
  const source = record(value);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'string' && SAFE_STRING_DETAIL_KEYS.has(key)) out[key] = safeText(raw, 160);
  }
  return out;
}

export function resolveActivityRange(query: Pick<ActivityQuery, 'period' | 'since' | 'until'>, now = new Date()): ActivityRange {
  const untilDate = query.until ? new Date(query.until) : now;
  if (Number.isNaN(untilDate.getTime())) throw new Error('Invalid until timestamp');

  if (query.since) {
    const sinceDate = new Date(query.since);
    if (Number.isNaN(sinceDate.getTime())) throw new Error('Invalid since timestamp');
    if (sinceDate >= untilDate) throw new Error('since must be earlier than until');
    const maxWindowMs = 366 * 24 * 60 * 60 * 1000;
    if (untilDate.getTime() - sinceDate.getTime() > maxWindowMs) {
      throw new Error('Custom activity range cannot exceed 366 days');
    }
    return { period: 'custom', since: sinceDate.toISOString(), until: untilDate.toISOString() };
  }

  const period = (query.period ?? '24h') as ActivityPeriod;
  if (!ACTIVITY_PERIODS.includes(period)) {
    throw new Error(`Invalid period. Expected one of: ${ACTIVITY_PERIODS.join(', ')}`);
  }
  if (period === 'yesterday') {
    const endOfRange = new Date(untilDate);
    endOfRange.setHours(0, 0, 0, 0);
    const sinceDate = new Date(endOfRange);
    sinceDate.setDate(sinceDate.getDate() - 1);
    return { period, since: sinceDate.toISOString(), until: endOfRange.toISOString() };
  }
  const sinceDate = new Date(untilDate.getTime() - PERIOD_MS[period]);
  return { period, since: sinceDate.toISOString(), until: untilDate.toISOString() };
}

export function normalizeActivityRun(row: JobRow, now = new Date()): ActivityRun {
  const result = record(row.result);
  const report = record(result.report);
  const phases = array(report.phases).map((raw): ActivityPhase => {
    const phase = record(raw);
    const pagesAffectedCount = array(phase.pagesAffected ?? phase.pages_affected)
      .filter(v => typeof v === 'string').length;
    const error = record(phase.error);
    const errorCode = safeIdentifier(error.code, '');
    return {
      phase: safeIdentifier(phase.phase, 'unknown'),
      status: safeIdentifier(phase.status, 'unknown'),
      duration_ms: finiteNumber(phase.duration_ms),
      summary: safeText(phase.summary, 240),
      details: safeDetails(phase.details),
      has_error: phase.error !== undefined && phase.error !== null,
      ...(errorCode ? { error_code: errorCode } : {}),
      pages_affected_count: pagesAffectedCount,
    };
  });

  const started = iso(row.started_at);
  const finished = iso(row.finished_at);
  const durationMs = started
    ? Math.max(0, new Date(finished ?? now.toISOString()).getTime() - new Date(started).getTime())
    : 0;
  const reportStatus = typeof report.status === 'string' ? report.status : undefined;
  const resultStatus = typeof result.status === 'string' ? result.status : undefined;

  return {
    id: finiteNumber(row.id),
    name: row.name,
    status: row.status,
    source_id: row.source_id || 'global',
    created_at: iso(row.created_at) ?? now.toISOString(),
    started_at: started,
    finished_at: finished,
    duration_ms: durationMs,
    partial: result.partial === true || resultStatus === 'partial' || reportStatus === 'partial',
    has_error: typeof row.error_text === 'string' && row.error_text.length > 0,
    phases,
  };
}

function buildWhere(range: ActivityRange, query: ActivityQuery): { sql: string; params: unknown[] } {
  const clauses = ['created_at >= $1', 'created_at < $2'];
  const params: unknown[] = [range.since, range.until];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    clauses.push(clause.replace('?', `$${params.length}`));
  };
  if (query.status) add('status = ?', query.status);
  if (query.name) add('name = ?', query.name);
  if (query.source) add(`COALESCE(data->>'source_id', data->>'sourceId', 'global') = ?`, query.source);
  return { sql: clauses.join(' AND '), params };
}

const NUMERIC = (path: string) => `CASE WHEN ${path} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${path})::numeric ELSE 0 END`;

export async function readActivitySnapshot(
  engine: BrainEngine,
  query: ActivityQuery = {},
  now = new Date(),
): Promise<ActivitySnapshot> {
  const range = resolveActivityRange(query, now);
  const limit = query.exportAll ? 5000 : Math.max(1, Math.min(100, Math.floor(query.limit ?? 30)));
  const offset = query.exportAll ? 0 : Math.max(0, Math.floor(query.offset ?? 0));
  const where = buildWhere(range, query);
  const typeWhere = buildWhere(range, { ...query, name: undefined });
  const sourceWhere = buildWhere(range, { ...query, source: undefined });
  const phaseArray = `CASE WHEN jsonb_typeof(result->'report'->'phases') = 'array' THEN result->'report'->'phases' ELSE '[]'::jsonb END`;
  const partialExpr = `(result->>'partial' = 'true' OR result->>'status' = 'partial' OR result->'report'->>'status' = 'partial')`;
  const sourceExpr = `COALESCE(data->>'source_id', data->>'sourceId', 'global')`;

  const [summaryRows, metricRows, phaseRows, typeRows, sourceRows, jobRows] = await Promise.all([
    engine.executeRaw<SummaryRow>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE ${partialExpr}) AS partial,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed,
              COUNT(*) FILTER (WHERE status = 'dead') AS dead,
              COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
              COUNT(*) FILTER (WHERE status = 'active') AS active,
              COUNT(*) FILTER (WHERE status = 'waiting') AS waiting,
              COUNT(*) FILTER (WHERE status = 'delayed') AS delayed,
              COUNT(*) FILTER (WHERE status = 'waiting-children') AS waiting_children,
              COUNT(*) FILTER (WHERE status = 'paused') AS paused,
              COALESCE(SUM(CASE WHEN started_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (COALESCE(finished_at, LEAST(now(), $2::timestamptz)) - started_at)) * 1000
                ELSE 0 END), 0) AS duration_ms
         FROM minion_jobs WHERE ${where.sql}`,
      where.params,
    ),
    engine.executeRaw<MetricRow>(
      `SELECT
          COALESCE(SUM(${NUMERIC("phase->'details'->>'estimated_spend_usd'")}), 0) AS estimated_spend_usd,
          COALESCE(SUM(${NUMERIC("phase->'details'->>'added'")} + ${NUMERIC("phase->'details'->>'modified'")} + ${NUMERIC("phase->'details'->>'deleted'")} + ${NUMERIC("phase->'details'->>'concepts_written'")} + ${NUMERIC("phase->'details'->>'pages_enriched'")}), 0) AS pages_changed,
          COALESCE(SUM(${NUMERIC("phase->'details'->>'atoms_extracted'")}), 0) AS atoms_extracted,
          COALESCE(SUM(${NUMERIC("phase->'details'->>'concepts_written'")}), 0) AS concepts_written,
          COALESCE(SUM(${NUMERIC("phase->'details'->>'proposals_inserted'")}), 0) AS proposals_inserted,
          COALESCE(SUM(${NUMERIC("phase->'details'->>'takes_written'")} + ${NUMERIC("phase->'details'->>'consolidate_takes_written'")}), 0) AS takes_written,
          COALESCE(SUM(${NUMERIC("phase->'details'->>'facts_inserted'")}), 0) AS facts_inserted
         FROM minion_jobs
         CROSS JOIN LATERAL jsonb_array_elements(${phaseArray}) AS phase
        WHERE ${where.sql}`,
      where.params,
    ),
    engine.executeRaw<PhaseRollupRow>(
      `SELECT phase->>'phase' AS phase,
              COALESCE(phase->>'status', 'unknown') AS status,
              COUNT(*) AS runs,
              COALESCE(SUM(${NUMERIC("phase->>'duration_ms'")}), 0) AS duration_ms,
              COALESCE(SUM(${NUMERIC("phase->'details'->>'estimated_spend_usd'")}), 0) AS estimated_spend_usd
         FROM minion_jobs
         CROSS JOIN LATERAL jsonb_array_elements(${phaseArray}) AS phase
        WHERE ${where.sql}
        GROUP BY phase->>'phase', COALESCE(phase->>'status', 'unknown')
        ORDER BY COALESCE(SUM(${NUMERIC("phase->>'duration_ms'")}), 0) DESC, phase->>'phase' ASC`,
      where.params,
    ),
    engine.executeRaw<GroupRow>(
      `SELECT name AS key, COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE status IN ('failed', 'dead')) AS failed,
              COUNT(*) FILTER (WHERE ${partialExpr}) AS partial
         FROM minion_jobs WHERE ${typeWhere.sql}
        GROUP BY name ORDER BY COUNT(*) DESC, name ASC`,
      typeWhere.params,
    ),
    engine.executeRaw<GroupRow>(
      `SELECT ${sourceExpr} AS key, COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE status IN ('failed', 'dead')) AS failed,
              COUNT(*) FILTER (WHERE ${partialExpr}) AS partial
         FROM minion_jobs WHERE ${sourceWhere.sql}
        GROUP BY ${sourceExpr} ORDER BY COUNT(*) DESC, ${sourceExpr} ASC`,
      sourceWhere.params,
    ),
    engine.executeRaw<JobRow>(
      `SELECT id, name, status, ${sourceExpr} AS source_id,
              created_at, started_at, finished_at, error_text, result
         FROM minion_jobs WHERE ${where.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
      [...where.params, limit, offset],
    ),
  ]);

  const s = summaryRows[0] ?? {} as SummaryRow;
  const m = metricRows[0] ?? {} as MetricRow;
  const total = finiteNumber(s.total);
  const filters = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.name ? { name: query.name } : {}),
    ...(query.source ? { source: query.source } : {}),
  };

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    range,
    filters,
    summary: {
      total,
      completed: finiteNumber(s.completed),
      partial: finiteNumber(s.partial),
      failed: finiteNumber(s.failed),
      dead: finiteNumber(s.dead),
      cancelled: finiteNumber(s.cancelled),
      active: finiteNumber(s.active),
      waiting: finiteNumber(s.waiting),
      delayed: finiteNumber(s.delayed),
      waiting_children: finiteNumber(s.waiting_children),
      paused: finiteNumber(s.paused),
      duration_ms: finiteNumber(s.duration_ms),
      estimated_spend_usd: finiteNumber(m.estimated_spend_usd),
      pages_changed: finiteNumber(m.pages_changed),
      atoms_extracted: finiteNumber(m.atoms_extracted),
      concepts_written: finiteNumber(m.concepts_written),
      proposals_inserted: finiteNumber(m.proposals_inserted),
      takes_written: finiteNumber(m.takes_written),
      facts_inserted: finiteNumber(m.facts_inserted),
    },
    phase_rollup: phaseRows.map(row => ({
      phase: row.phase ?? 'unknown',
      status: row.status ?? 'unknown',
      runs: finiteNumber(row.runs),
      duration_ms: finiteNumber(row.duration_ms),
      estimated_spend_usd: finiteNumber(row.estimated_spend_usd),
    })),
    by_type: typeRows.map(row => ({
      name: row.key,
      total: finiteNumber(row.total),
      completed: finiteNumber(row.completed),
      failed: finiteNumber(row.failed),
      partial: finiteNumber(row.partial),
    })),
    by_source: sourceRows.map(row => ({
      source_id: row.key,
      total: finiteNumber(row.total),
      completed: finiteNumber(row.completed),
      failed: finiteNumber(row.failed),
      partial: finiteNumber(row.partial),
    })),
    runs: jobRows.map(row => normalizeActivityRun(row, now)),
    statuses: ACTIVITY_JOB_STATUSES,
    pagination: {
      limit,
      offset,
      returned: jobRows.length,
      total,
      export_truncated: query.exportAll === true && jobRows.length < total,
    },
  };
}
