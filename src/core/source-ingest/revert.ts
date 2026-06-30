import type { BrainEngine } from '../engine.ts';

export interface SourceRevertReportRow {
  connector_id: string;
  source_object: string;
  external_id: string;
  slug: string;
  approved_source_id: string;
  profile_id: string;
  profile_version: number;
  last_result: string | null;
  last_error: string | null;
  last_synced_at: string | null;
}

export interface SourceRevertReport {
  mode: 'report-only';
  run_id: string;
  counts: { affected: number; success_or_unchanged: number; failed: number };
  pages: Array<{
    slug: string;
    source_id: string;
    external_id: string;
    profile_id: string;
    last_result: string | null;
    revert_action: 'would-review';
  }>;
  warnings: string[];
}

export async function buildSourceRevertReport(engine: BrainEngine, runId: string): Promise<SourceRevertReport> {
  const rows = await engine.executeRaw<SourceRevertReportRow>(
    `SELECT connector_id, source_object, external_id, slug, approved_source_id, profile_id, profile_version,
            last_result, last_error, last_synced_at
       FROM source_sync_state
      WHERE run_id = $1
      ORDER BY slug, external_id`,
    [runId],
  );
  return {
    mode: 'report-only',
    run_id: runId,
    counts: {
      affected: rows.length,
      success_or_unchanged: rows.filter(r => r.last_result === 'success' || r.last_result === 'unchanged').length,
      failed: rows.filter(r => r.last_result === 'failed').length,
    },
    pages: rows.map(r => ({
      slug: r.slug,
      source_id: r.approved_source_id,
      external_id: `${r.connector_id}:${r.source_object}:${r.external_id}`,
      profile_id: r.profile_id,
      last_result: r.last_result,
      revert_action: 'would-review',
    })),
    warnings: [
      'report_only_stage3b_no_mutation',
      'created_vs_updated_rollback_semantics_deferred',
    ],
  };
}
