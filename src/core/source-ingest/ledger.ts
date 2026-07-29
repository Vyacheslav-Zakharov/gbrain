import type { BrainEngine } from '../engine.ts';

/**
 * Source-ingest run ledger is append-only for revert/reporting, but it must not
 * grow unbounded on long-lived brains. Keep the retention window aligned with
 * op_checkpoints: long enough for normal rollback/debug windows, cheap to sweep
 * during the existing purge phase.
 */
export async function purgeStaleSourceIngestRunItems(
  engine: BrainEngine,
  ttlDays = 7,
): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ count: string | number }>(
      `WITH deleted AS (
         DELETE FROM source_ingest_run_items
         WHERE created_at < now() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(ttlDays)],
    );
    return Number(rows[0]?.count ?? 0);
  } catch (e) {
    console.error('[source-ingest] run-item purge failed:', (e as Error).message);
    return 0;
  }
}
