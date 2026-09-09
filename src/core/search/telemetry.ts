/**
 * v0.32.3 search-lite telemetry rollup writer.
 *
 * Architecture decision (D2 in the plan, [CDX-19]): per-process in-memory
 * bucket, flushed periodically (60s OR 100 calls, whichever first) AND on
 * process exit via beforeExit/SIGINT/SIGTERM with a 2-second timeout cap.
 * The search hot path NEVER waits on this write — `record()` is sync and
 * the flush is fire-and-forget.
 *
 * Schema math per [CDX-17]: rows are sums + counts only, NEVER averages.
 * Read-time derives averages. ON CONFLICT DO UPDATE adds raw values so two
 * gbrain processes flushing the same (date, mode, intent) tuple accumulate
 * correctly.
 *
 * The bucket map is keyed by `${date}::${mode}::${intent}`. Date is the
 * UTC ISO date (YYYY-MM-DD). Cross-midnight calls land in distinct buckets
 * automatically.
 *
 * Per-process bucketing means stdio MCP, HTTP MCP, and CLI processes each
 * maintain their own buffers. Stats are directional, not exact — acceptable
 * because the consumer is the operator (or an agent running `gbrain search
 * tune`), not a financial ledger. The "lose last bucket on hard crash"
 * downside is documented in the methodology doc.
 */

import type { BrainEngine } from '../engine.ts';
import type { HybridSearchMeta } from '../types.ts';

interface Bucket {
  date: string;
  mode: string;
  intent: string;
  count: number;
  sum_results: number;
  sum_tokens: number;
  sum_budget_dropped: number;
  cache_hit: number;
  cache_miss: number;
  // T7 — rank-1 base_score drift signal (aggregate, NOT per-query rows, D10).
  // sum/count derive the mean; 3 coarse buckets give a distribution shape.
  sum_rank1_score: number;
  count_rank1: number;
  rank1_lt_solid: number;  // base_score < 0.6
  rank1_solid: number;     // 0.6 <= base_score < 0.85
  rank1_high: number;      // base_score >= 0.85
  expansion_calls: number;
  expansion_arms_total: number;
  expansion_arms_failed: number;
  expansion_partial_failures: number;
  expansion_all_failures: number;
  expansion_original_failed: number;
  expansion_original_recovered: number;
  expansion_embedding_timeout_failures: number;
  expansion_embedding_rate_limit_failures: number;
  expansion_embedding_provider_failures: number;
  expansion_vector_timeout_failures: number;
  expansion_vector_database_failures: number;
  expansion_unknown_failures: number;
}

// T7 — coarse rank-1 score bands (mirror evidence.ts SOLID/HIGH floors).
const RANK1_SOLID_FLOOR = 0.6;
const RANK1_HIGH_FLOOR = 0.85;

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_THRESHOLD_CALLS = 100;

/**
 * Per-process telemetry singleton. Each gbrain process (CLI, stdio MCP,
 * HTTP MCP) gets one instance. The flush timer and exit hooks are
 * installed lazily on the first `record()` call so importing this module
 * has no side effects.
 */
class TelemetryWriter {
  private buckets = new Map<string, Bucket>();
  private pendingCount = 0;
  private engine: BrainEngine | null = null;
  private timer: NodeJS.Timeout | null = null;
  private exitHookInstalled = false;
  private flushInFlight: Promise<void> | null = null;

  /** Wire the engine. Called once per process at search-time. Subsequent calls are a no-op. */
  setEngine(engine: BrainEngine): void {
    if (!this.engine) {
      this.engine = engine;
      this.ensureExitHook();
      this.ensureTimer();
    }
  }

  /**
   * Record a search call. Sync — never blocks the hot path. Returns
   * immediately after bumping the in-memory bucket. Flush is async +
   * fire-and-forget.
   */
  record(meta: HybridSearchMeta, opts: { results_count: number; tokens_estimate?: number; rank1_score?: number } = { results_count: 0 }): void {
    const date = nowDate();
    const mode = meta.mode ?? 'unset';
    const intent = meta.intent ?? 'unset';
    const key = `${date}::${mode}::${intent}`;

    let b = this.buckets.get(key);
    if (!b) {
      b = {
        date,
        mode,
        intent,
        count: 0,
        sum_results: 0,
        sum_tokens: 0,
        sum_budget_dropped: 0,
        cache_hit: 0,
        cache_miss: 0,
        sum_rank1_score: 0,
        count_rank1: 0,
        rank1_lt_solid: 0,
        rank1_solid: 0,
        rank1_high: 0,
        expansion_calls: 0,
        expansion_arms_total: 0,
        expansion_arms_failed: 0,
        expansion_partial_failures: 0,
        expansion_all_failures: 0,
        expansion_original_failed: 0,
        expansion_original_recovered: 0,
        expansion_embedding_timeout_failures: 0,
        expansion_embedding_rate_limit_failures: 0,
        expansion_embedding_provider_failures: 0,
        expansion_vector_timeout_failures: 0,
        expansion_vector_database_failures: 0,
        expansion_unknown_failures: 0,
      };
      this.buckets.set(key, b);
    }

    b.count += 1;
    b.sum_results += Math.max(0, Math.floor(opts.results_count));
    b.sum_tokens += Math.max(0, Math.floor(opts.tokens_estimate ?? meta.token_budget?.used ?? 0));
    b.sum_budget_dropped += Math.max(0, Math.floor(meta.token_budget?.dropped ?? 0));
    if (meta.cache?.status === 'hit') b.cache_hit += 1;
    if (meta.cache?.status === 'miss') b.cache_miss += 1;
    if (meta.arms) {
      const arms = meta.arms;
      b.expansion_calls += 1;
      b.expansion_arms_total += Math.max(0, Math.floor(arms.total));
      b.expansion_arms_failed += Math.max(0, Math.floor(arms.failed));
      if (arms.failed > 0 && arms.failed < arms.total) b.expansion_partial_failures += 1;
      if (arms.total > 0 && arms.failed >= arms.total) b.expansion_all_failures += 1;
      if (arms.original_failed) b.expansion_original_failed += 1;
      if (arms.recovered_original) b.expansion_original_recovered += 1;
      b.expansion_embedding_timeout_failures += arms.failure_reasons.embedding_timeout ?? 0;
      b.expansion_embedding_rate_limit_failures += arms.failure_reasons.embedding_rate_limit ?? 0;
      b.expansion_embedding_provider_failures += arms.failure_reasons.embedding_provider ?? 0;
      b.expansion_vector_timeout_failures += arms.failure_reasons.vector_timeout ?? 0;
      b.expansion_vector_database_failures += arms.failure_reasons.vector_database ?? 0;
      b.expansion_unknown_failures += arms.failure_reasons.unknown ?? 0;
    }
    // T7 — rank-1 base_score drift signal. Only counts queries that returned
    // a result (rank1_score present + finite).
    if (typeof opts.rank1_score === 'number' && Number.isFinite(opts.rank1_score)) {
      const s = opts.rank1_score;
      b.sum_rank1_score += s;
      b.count_rank1 += 1;
      if (s < RANK1_SOLID_FLOOR) b.rank1_lt_solid += 1;
      else if (s < RANK1_HIGH_FLOOR) b.rank1_solid += 1;
      else b.rank1_high += 1;
    }

    this.pendingCount += 1;
    if (this.pendingCount >= FLUSH_THRESHOLD_CALLS) {
      void this.flush().catch(() => { /* swallow */ });
    }
  }

  /**
   * Drain the bucket map to the database. Idempotent; concurrent flushes
   * are coalesced via flushInFlight. The bucket map is swapped atomically
   * before the SQL write so new `record()` calls during flush land in a
   * fresh map.
   */
  async flush(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    if (!this.engine || this.buckets.size === 0) {
      this.pendingCount = 0;
      return;
    }

    // Swap the map: a new record() call during flush goes into the new map.
    const snapshot = this.buckets;
    this.buckets = new Map();
    this.pendingCount = 0;

    const engine = this.engine;
    this.flushInFlight = (async () => {
      try {
        for (const b of snapshot.values()) {
          try {
            await engine.executeRaw(
              `INSERT INTO search_telemetry
                 (date, mode, intent, count, sum_results, sum_tokens, sum_budget_dropped, cache_hit, cache_miss,
                  sum_rank1_score, count_rank1, rank1_lt_solid, rank1_solid, rank1_high,
                  expansion_calls, expansion_arms_total, expansion_arms_failed, expansion_partial_failures,
                  expansion_all_failures, expansion_original_failed, expansion_original_recovered,
                  expansion_embedding_timeout_failures, expansion_embedding_rate_limit_failures,
                  expansion_embedding_provider_failures, expansion_vector_timeout_failures,
                  expansion_vector_database_failures, expansion_unknown_failures, first_seen, last_seen)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                       $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, now(), now())
               ON CONFLICT (date, mode, intent) DO UPDATE SET
                 count = search_telemetry.count + EXCLUDED.count,
                 sum_results = search_telemetry.sum_results + EXCLUDED.sum_results,
                 sum_tokens = search_telemetry.sum_tokens + EXCLUDED.sum_tokens,
                 sum_budget_dropped = search_telemetry.sum_budget_dropped + EXCLUDED.sum_budget_dropped,
                 cache_hit = search_telemetry.cache_hit + EXCLUDED.cache_hit,
                 cache_miss = search_telemetry.cache_miss + EXCLUDED.cache_miss,
                 sum_rank1_score = search_telemetry.sum_rank1_score + EXCLUDED.sum_rank1_score,
                 count_rank1 = search_telemetry.count_rank1 + EXCLUDED.count_rank1,
                 rank1_lt_solid = search_telemetry.rank1_lt_solid + EXCLUDED.rank1_lt_solid,
                 rank1_solid = search_telemetry.rank1_solid + EXCLUDED.rank1_solid,
                 rank1_high = search_telemetry.rank1_high + EXCLUDED.rank1_high,
                 expansion_calls = search_telemetry.expansion_calls + EXCLUDED.expansion_calls,
                 expansion_arms_total = search_telemetry.expansion_arms_total + EXCLUDED.expansion_arms_total,
                 expansion_arms_failed = search_telemetry.expansion_arms_failed + EXCLUDED.expansion_arms_failed,
                 expansion_partial_failures = search_telemetry.expansion_partial_failures + EXCLUDED.expansion_partial_failures,
                 expansion_all_failures = search_telemetry.expansion_all_failures + EXCLUDED.expansion_all_failures,
                 expansion_original_failed = search_telemetry.expansion_original_failed + EXCLUDED.expansion_original_failed,
                 expansion_original_recovered = search_telemetry.expansion_original_recovered + EXCLUDED.expansion_original_recovered,
                 expansion_embedding_timeout_failures = search_telemetry.expansion_embedding_timeout_failures + EXCLUDED.expansion_embedding_timeout_failures,
                 expansion_embedding_rate_limit_failures = search_telemetry.expansion_embedding_rate_limit_failures + EXCLUDED.expansion_embedding_rate_limit_failures,
                 expansion_embedding_provider_failures = search_telemetry.expansion_embedding_provider_failures + EXCLUDED.expansion_embedding_provider_failures,
                 expansion_vector_timeout_failures = search_telemetry.expansion_vector_timeout_failures + EXCLUDED.expansion_vector_timeout_failures,
                 expansion_vector_database_failures = search_telemetry.expansion_vector_database_failures + EXCLUDED.expansion_vector_database_failures,
                 expansion_unknown_failures = search_telemetry.expansion_unknown_failures + EXCLUDED.expansion_unknown_failures,
                 last_seen = now()`,
              [b.date, b.mode, b.intent, b.count, b.sum_results, b.sum_tokens, b.sum_budget_dropped, b.cache_hit, b.cache_miss,
               b.sum_rank1_score, b.count_rank1, b.rank1_lt_solid, b.rank1_solid, b.rank1_high,
               b.expansion_calls, b.expansion_arms_total, b.expansion_arms_failed, b.expansion_partial_failures,
               b.expansion_all_failures, b.expansion_original_failed, b.expansion_original_recovered,
               b.expansion_embedding_timeout_failures, b.expansion_embedding_rate_limit_failures,
               b.expansion_embedding_provider_failures, b.expansion_vector_timeout_failures,
               b.expansion_vector_database_failures, b.expansion_unknown_failures],
            );
          } catch {
            // swallow — telemetry write must never break the hot path.
            // Per-bucket isolation: one bad row doesn't lose the others.
          }
        }
      } finally {
        this.flushInFlight = null;
      }
    })();
    return this.flushInFlight;
  }

  /** Stop the timer and uninstall exit hooks. Called from tests / shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buckets.clear();
    this.pendingCount = 0;
  }

  /** Test-only — read the current bucket count without draining. */
  bucketCountForTest(): number {
    return this.buckets.size;
  }

  /** Test-only — read a specific bucket (returns null if absent). */
  bucketForTest(date: string, mode: string, intent: string): Readonly<Bucket> | null {
    return this.buckets.get(`${date}::${mode}::${intent}`) ?? null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => { /* swallow */ });
    }, FLUSH_INTERVAL_MS);
    // Unref so the timer doesn't keep the process alive on its own.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private ensureExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;

    // Lossy by design: skip the buffered drain entirely on process exit.
    //
    // The earlier implementation installed `process.on('beforeExit', drainOnExit)`
    // with an inner `Promise.race([flush(), setTimeout(2000)])`. That enqueued
    // new async work AFTER the event loop had emptied, which kept the process
    // alive past beforeExit — short-lived CLI invocations (`gbrain query "the"`
    // exiting after 100ms of work) ended up waiting on the DB write to settle.
    // On a slow or busy PGLite, the write never settled and the CLI hung
    // forever. That deadlock surfaced as the `test/e2e/claw-test.test.ts`
    // hang (the harness spawns short-lived gbrain queries that should exit
    // in <1s but never did).
    //
    // Resolution per [CDX-19]: the periodic flush timer (unref'd) handles
    // long-running processes (HTTP MCP server, autopilot, jobs work). For
    // short-lived CLI invocations, telemetry buffering of one search call
    // is acceptable to lose. Stats are directional, not exact.
    //
    // The signal handlers (SIGINT / SIGTERM) also drop — kill -TERM should
    // exit immediately, not block on a DB write that may never complete.
  }

  // Test-only: previously inspected by tests. Retained as a no-op so the
  // test harness's _resetTelemetryWriterForTest doesn't need to know about
  // the exit-hook decision.
  flushOnExitForTest(): Promise<void> {
    return this.flush().catch(() => { /* swallow */ });
  }
}

/** Module-level singleton, one per process. */
let _writer: TelemetryWriter | null = null;

export function getTelemetryWriter(): TelemetryWriter {
  if (!_writer) _writer = new TelemetryWriter();
  return _writer;
}

/**
 * Convenience entry point for hot-path callers. Wires the engine lazily
 * and records the call. Never throws.
 */
export function recordSearchTelemetry(
  engine: BrainEngine,
  meta: HybridSearchMeta,
  opts: { results_count: number; tokens_estimate?: number; rank1_score?: number } = { results_count: 0 },
): void {
  try {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    w.record(meta, opts);
  } catch {
    // swallow — telemetry is best-effort.
  }
}

/**
 * Read aggregated stats over a window. Read-time derives averages from
 * sums + counts so writers can ON CONFLICT-add freely.
 */
export interface StatsWindow {
  total_calls: number;
  cache_hits: number;
  cache_misses: number;
  cache_hit_rate: number;
  avg_results: number;
  avg_tokens: number;
  total_budget_dropped: number;
  intent_distribution: Record<string, number>;
  mode_distribution: Record<string, number>;
  window_days: number;
  oldest_seen?: string;
  newest_seen?: string;
  // T7 — rank-1 base_score drift signal. avg_rank1_score is the headline the
  // doctor/operator watches for downward drift; the 3 buckets give shape.
  avg_rank1_score: number | null; // null when no rank-1 samples
  rank1_count: number;
  rank1_distribution: { lt_solid: number; solid: number; high: number };
  expansion_arms: {
    calls: number;
    total: number;
    failed: number;
    partial_failure_calls: number;
    all_failure_calls: number;
    original_failed_calls: number;
    original_recovered_calls: number;
    degraded_call_rate: number;
    failure_reasons: {
      embedding_timeout: number;
      embedding_rate_limit: number;
      embedding_provider: number;
      vector_timeout: number;
      vector_database: number;
      unknown: number;
    };
  };
}

export async function readSearchStats(
  engine: BrainEngine,
  opts: { days?: number } = {},
): Promise<StatsWindow> {
  const days = Math.max(1, Math.min(365, opts.days ?? 7));
  const cutoffDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  try {
    const rows = await engine.executeRaw<{
      mode: string;
      intent: string;
      count: number;
      sum_results: number;
      sum_tokens: number;
      sum_budget_dropped: number;
      cache_hit: number;
      cache_miss: number;
      sum_rank1_score: number;
      count_rank1: number;
      rank1_lt_solid: number;
      rank1_solid: number;
      rank1_high: number;
      expansion_calls: number;
      expansion_arms_total: number;
      expansion_arms_failed: number;
      expansion_partial_failures: number;
      expansion_all_failures: number;
      expansion_original_failed: number;
      expansion_original_recovered: number;
      expansion_embedding_timeout_failures: number;
      expansion_embedding_rate_limit_failures: number;
      expansion_embedding_provider_failures: number;
      expansion_vector_timeout_failures: number;
      expansion_vector_database_failures: number;
      expansion_unknown_failures: number;
      first_seen: string;
      last_seen: string;
    }>(
      `SELECT mode, intent,
              SUM(count)::int             AS count,
              SUM(sum_results)::int       AS sum_results,
              SUM(sum_tokens)::int        AS sum_tokens,
              SUM(sum_budget_dropped)::int AS sum_budget_dropped,
              SUM(cache_hit)::int         AS cache_hit,
              SUM(cache_miss)::int        AS cache_miss,
              COALESCE(SUM(sum_rank1_score), 0)::float8 AS sum_rank1_score,
              COALESCE(SUM(count_rank1), 0)::int        AS count_rank1,
              COALESCE(SUM(rank1_lt_solid), 0)::int     AS rank1_lt_solid,
              COALESCE(SUM(rank1_solid), 0)::int        AS rank1_solid,
              COALESCE(SUM(rank1_high), 0)::int        AS rank1_high,
              COALESCE(SUM(expansion_calls), 0)::int AS expansion_calls,
              COALESCE(SUM(expansion_arms_total), 0)::int AS expansion_arms_total,
              COALESCE(SUM(expansion_arms_failed), 0)::int AS expansion_arms_failed,
              COALESCE(SUM(expansion_partial_failures), 0)::int AS expansion_partial_failures,
              COALESCE(SUM(expansion_all_failures), 0)::int AS expansion_all_failures,
              COALESCE(SUM(expansion_original_failed), 0)::int AS expansion_original_failed,
              COALESCE(SUM(expansion_original_recovered), 0)::int AS expansion_original_recovered,
              COALESCE(SUM(expansion_embedding_timeout_failures), 0)::int AS expansion_embedding_timeout_failures,
              COALESCE(SUM(expansion_embedding_rate_limit_failures), 0)::int AS expansion_embedding_rate_limit_failures,
              COALESCE(SUM(expansion_embedding_provider_failures), 0)::int AS expansion_embedding_provider_failures,
              COALESCE(SUM(expansion_vector_timeout_failures), 0)::int AS expansion_vector_timeout_failures,
              COALESCE(SUM(expansion_vector_database_failures), 0)::int AS expansion_vector_database_failures,
              COALESCE(SUM(expansion_unknown_failures), 0)::int AS expansion_unknown_failures,
              MIN(first_seen)::text       AS first_seen,
              MAX(last_seen)::text        AS last_seen
       FROM search_telemetry
       WHERE date >= $1
       GROUP BY mode, intent`,
      [cutoffDate],
    );

    let total_calls = 0;
    let cache_hits = 0;
    let cache_misses = 0;
    let total_results = 0;
    let total_tokens = 0;
    let total_budget_dropped = 0;
    const intent_distribution: Record<string, number> = {};
    const mode_distribution: Record<string, number> = {};
    let oldest_seen: string | undefined;
    let newest_seen: string | undefined;
    let sum_rank1 = 0;
    let count_rank1 = 0;
    let r1_lt = 0;
    let r1_solid = 0;
    let r1_high = 0;
    let armCalls = 0;
    let armTotal = 0;
    let armFailed = 0;
    let armPartial = 0;
    let armAll = 0;
    let armOriginalFailed = 0;
    let armOriginalRecovered = 0;
    const armReasons = {
      embedding_timeout: 0,
      embedding_rate_limit: 0,
      embedding_provider: 0,
      vector_timeout: 0,
      vector_database: 0,
      unknown: 0,
    };

    for (const r of rows) {
      total_calls += r.count;
      cache_hits += r.cache_hit;
      cache_misses += r.cache_miss;
      total_results += r.sum_results;
      total_tokens += r.sum_tokens;
      total_budget_dropped += r.sum_budget_dropped;
      sum_rank1 += r.sum_rank1_score;
      count_rank1 += r.count_rank1;
      r1_lt += r.rank1_lt_solid;
      r1_solid += r.rank1_solid;
      r1_high += r.rank1_high;
      armCalls += r.expansion_calls;
      armTotal += r.expansion_arms_total;
      armFailed += r.expansion_arms_failed;
      armPartial += r.expansion_partial_failures;
      armAll += r.expansion_all_failures;
      armOriginalFailed += r.expansion_original_failed;
      armOriginalRecovered += r.expansion_original_recovered;
      armReasons.embedding_timeout += r.expansion_embedding_timeout_failures;
      armReasons.embedding_rate_limit += r.expansion_embedding_rate_limit_failures;
      armReasons.embedding_provider += r.expansion_embedding_provider_failures;
      armReasons.vector_timeout += r.expansion_vector_timeout_failures;
      armReasons.vector_database += r.expansion_vector_database_failures;
      armReasons.unknown += r.expansion_unknown_failures;
      intent_distribution[r.intent] = (intent_distribution[r.intent] ?? 0) + r.count;
      mode_distribution[r.mode] = (mode_distribution[r.mode] ?? 0) + r.count;
      if (r.first_seen && (!oldest_seen || r.first_seen < oldest_seen)) oldest_seen = r.first_seen;
      if (r.last_seen && (!newest_seen || r.last_seen > newest_seen)) newest_seen = r.last_seen;
    }

    const probe_total = cache_hits + cache_misses;
    return {
      total_calls,
      cache_hits,
      cache_misses,
      cache_hit_rate: probe_total > 0 ? cache_hits / probe_total : 0,
      avg_results: total_calls > 0 ? total_results / total_calls : 0,
      avg_tokens: total_calls > 0 ? total_tokens / total_calls : 0,
      total_budget_dropped,
      intent_distribution,
      mode_distribution,
      window_days: days,
      oldest_seen,
      newest_seen,
      avg_rank1_score: count_rank1 > 0 ? sum_rank1 / count_rank1 : null,
      rank1_count: count_rank1,
      rank1_distribution: { lt_solid: r1_lt, solid: r1_solid, high: r1_high },
      expansion_arms: {
        calls: armCalls,
        total: armTotal,
        failed: armFailed,
        partial_failure_calls: armPartial,
        all_failure_calls: armAll,
        original_failed_calls: armOriginalFailed,
        original_recovered_calls: armOriginalRecovered,
        degraded_call_rate: armCalls > 0 ? (armPartial + armAll) / armCalls : 0,
        failure_reasons: armReasons,
      },
    };
  } catch {
    // Table missing or query failed — return empty stats rather than throw.
    return {
      total_calls: 0,
      cache_hits: 0,
      cache_misses: 0,
      cache_hit_rate: 0,
      avg_results: 0,
      avg_tokens: 0,
      total_budget_dropped: 0,
      intent_distribution: {},
      mode_distribution: {},
      window_days: days,
      avg_rank1_score: null,
      rank1_count: 0,
      rank1_distribution: { lt_solid: 0, solid: 0, high: 0 },
      expansion_arms: {
        calls: 0, total: 0, failed: 0,
        partial_failure_calls: 0, all_failure_calls: 0,
        original_failed_calls: 0, original_recovered_calls: 0,
        degraded_call_rate: 0,
        failure_reasons: {
          embedding_timeout: 0, embedding_rate_limit: 0, embedding_provider: 0,
          vector_timeout: 0, vector_database: 0, unknown: 0,
        },
      },
    };
  }
}

function nowDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Test-only — reset the module-level singleton between test cases. */
export function _resetTelemetryWriterForTest(): void {
  if (_writer) {
    _writer.stop();
    _writer = null;
  }
}
