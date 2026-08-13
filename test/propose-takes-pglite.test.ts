import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  runPhaseProposeTakes, contentHash, PROPOSE_TAKES_PROMPT_VERSION,
  type ExtractorResult,
} from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function ctx(): OperationContext {
  return { engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false, remote: false, sourceId: 'default' };
}
function receipt(outcome: ExtractorResult['outcome'], actualModel = 'anthropic:claude-sonnet-4-6', hash = 'a'): ExtractorResult {
  const raw_response = hash === 'b' ? '[ ]' : '[]';
  return { proposals: [], outcome, actual_model: actualModel, stop_reason: 'end', raw_response,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
    response_length: Buffer.byteLength(raw_response), response_sha256: contentHash(raw_response), parsed_count: 0,
    dropped_count: outcome === 'schema_rows_dropped' ? 1 : 0 };
}

describe('propose_takes real PGLite contracts', () => {
  test('valid empty caches while malformed output remains failed and retryable', async () => {
    await engine.putPage('probe/valid', { title: 'valid', type: 'analysis', compiled_truth: 'Valid empty evidence.' } as never, { sourceId: 'default' });
    let validCalls = 0;
    const valid = async () => { validCalls += 1; return receipt('model_empty_valid'); };
    const v1 = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: valid });
    const v2 = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: valid });
    expect([v1.status, v2.status, validCalls]).toEqual(['ok', 'ok', 1]);

    await engine.putPage('probe/bad', { title: 'bad', type: 'analysis', compiled_truth: 'Malformed evidence.' } as never, { sourceId: 'default' });
    let badCalls = 0;
    const malformed = async ({ pagePath }: { pagePath: string }) => pagePath === 'probe/bad'
      ? (badCalls += 1, receipt('schema_rows_dropped')) : receipt('model_empty_valid');
    const b1 = await runPhaseProposeTakes(ctx(), { pageLimit: 2, budgetUsd: 0.1, extractor: malformed });
    const b2 = await runPhaseProposeTakes(ctx(), { pageLimit: 2, budgetUsd: 0.1, extractor: malformed });
    expect([b1.status, b2.status, badCalls]).toEqual(['fail', 'fail', 2]);
    const rollup = await engine.executeRaw<{ halt_count: number; round_completed_count: number }>(
      `SELECT halt_count,round_completed_count FROM extract_rollup_7d WHERE kind='takes.proposed' AND source_id='default'`,
    );
    expect([Number(rollup[0]?.halt_count), Number(rollup[0]?.round_completed_count)]).toEqual([2, 1]);
  }, 30000);

  test('fresh running blocks; stale running archives atomically; later run retries', async () => {
    const body = 'Lease recovery evidence.';
    await engine.putPage('probe/lease', { title: 'lease', type: 'analysis', compiled_truth: body } as never, { sourceId: 'default' });
    await engine.executeRaw(
      `INSERT INTO take_proposal_scans(source_id,page_slug,content_hash,prompt_version,proposal_run_id,model_id,status)
       VALUES('default','probe/lease',$1,$2,'old-run','anthropic:claude-sonnet-4-6','running')`,
      [contentHash(body), PROPOSE_TAKES_PROMPT_VERSION],
    );
    let calls = 0;
    const extractor = async () => { calls += 1; return receipt('model_empty_valid'); };
    const fresh = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor });
    expect([fresh.status, calls, (fresh.details as Record<string, unknown>).cache_hits]).toEqual(['fail', 0, 0]);
    await engine.executeRaw(`UPDATE take_proposal_scans SET started_at=now()-interval '31 minutes'`);
    const stale = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor });
    expect([stale.status, calls, (stale.details as Record<string, unknown>).stale_running_closed]).toEqual(['fail', 0, 1]);
    const archived = await engine.executeRaw<{ proposal_run_id: string; status: string }>(
      `SELECT proposal_run_id,snapshot->>'status' status FROM take_proposal_scan_attempts`,
    );
    expect(archived).toEqual([{ proposal_run_id: 'old-run', status: 'running' }]);
    const retry = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor });
    expect([retry.status, calls]).toEqual(['ok', 1]);
  }, 30000);

  test('late provider completion cannot overwrite a reclaimed attempt', async () => {
    await engine.putPage('probe/race', { title: 'race', type: 'analysis', compiled_truth: 'Race evidence.' } as never, { sourceId: 'default' });
    let release!: (value: ExtractorResult) => void;
    let entered!: () => void;
    const blocked = new Promise<ExtractorResult>(resolve => { release = resolve; });
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const first = runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: async () => { entered(); return blocked; } });
    await dispatched;
    await engine.executeRaw(`UPDATE take_proposal_scans SET started_at=now()-interval '31 minutes'`);
    await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: async () => receipt('model_empty_valid', undefined, 'b') });
    const retry = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: async () => receipt('model_empty_valid', undefined, 'b') });
    release(receipt('model_empty_valid', undefined, 'a'));
    const late = await first;
    const row = await engine.executeRaw<{ response_sha256: string; status: string }>(`SELECT response_sha256,status FROM take_proposal_scans`);
    expect([retry.status, late.status, row[0]?.status, row[0]?.response_sha256]).toEqual(['ok', 'fail', 'completed', contentHash('[ ]')]);
  }, 30000);

  test('forged cacheable envelope is downgraded and retried', async () => {
    await engine.putPage('probe/forged', { title: 'forged', type: 'analysis', compiled_truth: 'Forged receipt evidence.' } as never, { sourceId: 'default' });
    let calls = 0;
    const forged = async () => { calls += 1; return { ...receipt('model_empty_valid'), response_sha256: 'bad', dropped_count: 1 }; };
    const first = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: forged });
    const second = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: forged });
    const scan = await engine.executeRaw<{ status: string; outcome: string }>(`SELECT status,outcome FROM take_proposal_scans`);
    expect([first.status, second.status, calls, scan[0]]).toEqual(['fail', 'fail', 2, { status: 'failed', outcome: 'legacy_unverified' }]);
  }, 30000);

  test('invalid receipt cannot persist forged valid-looking response identity', async () => {
    await engine.putPage('probe/forged-telemetry', { title: 'forged', type: 'analysis', compiled_truth: 'Forged telemetry evidence.' } as never, { sourceId: 'default' });
    const forgedHash = 'f'.repeat(64);
    await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: async () => ({
      ...receipt('model_empty_valid'), response_length: 999, response_sha256: forgedHash, dropped_count: 1,
    }) });
    const telemetry = await engine.executeRaw<{ response_length: number; response_sha256: string; outcome: string }>(
      `SELECT response_length,response_sha256,outcome FROM take_proposal_scans`,
    );
    expect(telemetry[0]?.outcome).toBe('legacy_unverified');
    expect(telemetry[0]?.response_length).not.toBe(999);
    expect(telemetry[0]?.response_sha256).not.toBe(forgedHash);
  }, 30000);

  test('a later proposal conflict rolls back every proposal from the failed attempt', async () => {
    await engine.putPage('probe/atomic', { title: 'atomic', type: 'analysis', compiled_truth: 'Atomic proposal evidence.' } as never, { sourceId: 'default' });
    const first = {
      claim_text: 'First candidate', kind: 'take' as const, claim_class: 'judgment' as const,
      holder: 'brain', weight: 0.7, domain: 'test',
    };
    const second = { ...first, claim_text: 'Second candidate' };
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION fail_second_candidate() RETURNS trigger AS $$
      BEGIN
        IF NEW.claim_text = 'Second candidate' THEN RAISE EXCEPTION 'test fault after first proposal'; END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await engine.executeRaw(`CREATE TRIGGER test_fail_second_candidate
      BEFORE INSERT ON take_proposals FOR EACH ROW EXECUTE FUNCTION fail_second_candidate()`);
    const result = await runPhaseProposeTakes(ctx(), {
      pageLimit: 1, budgetUsd: 0.1,
      extractor: async () => {
        const raw_response = JSON.stringify([first, second]);
        return {
          ...receipt('model_nonempty_valid'), proposals: [first, second], raw_response,
          response_length: Buffer.byteLength(raw_response), response_sha256: contentHash(raw_response), parsed_count: 2,
        };
      },
    });
    const proposals = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int count FROM take_proposals`);
    const scan = await engine.executeRaw<{ status: string; outcome: string }>(`SELECT status,outcome FROM take_proposal_scans`);
    expect([result.status, Number(proposals[0]?.count), scan[0]]).toEqual([
      'fail', 0, { status: 'failed', outcome: 'runtime_failed' },
    ]);
  }, 30000);

  test('mismatched actual model retains conservative reservation', async () => {
    await engine.putPage('probe/mismatch', { title: 'mismatch', type: 'analysis', compiled_truth: 'Accounting evidence.' } as never, { sourceId: 'default' });
    const result = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1,
      extractor: async () => receipt('model_empty_valid', 'openai:gpt-5-mini') });
    const scan = await engine.executeRaw<{ reserved_call_usd: number; actual_call_usd: number | null; reservation_released_usd: number; usage_reconciled: boolean }>(
      `SELECT reserved_call_usd,actual_call_usd,reservation_released_usd,usage_reconciled FROM take_proposal_scans`,
    );
    expect(result.status).toBe('ok');
    expect(Number((result.details as Record<string, unknown>).estimated_spend_usd)).toBe(0);
    expect(Number((result.details as Record<string, unknown>).accounted_exposure_usd)).toBeGreaterThan(0);
    expect(Number(scan[0]?.reserved_call_usd)).toBeGreaterThan(0);
    expect([scan[0]?.actual_call_usd, Number(scan[0]?.reservation_released_usd), scan[0]?.usage_reconciled]).toEqual([null, 0, false]);
    const rollup = await engine.executeRaw<{ cost_usd: number }>(
      `SELECT cost_usd FROM extract_rollup_7d WHERE kind='takes.proposed' AND source_id='default'`,
    );
    expect(Number(rollup[0]?.cost_usd)).toBeGreaterThan(0);
  }, 30000);

  test('nonzero cache tokens retain the full conservative reservation', async () => {
    await engine.putPage('probe/cache-usage', { title: 'cache', type: 'analysis', compiled_truth: 'Cached token accounting evidence.' } as never, { sourceId: 'default' });
    const result = await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1,
      extractor: async () => ({ ...receipt('model_empty_valid'),
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 5, cache_creation_tokens: 7 },
      }),
    });
    const scan = await engine.executeRaw<{ actual_call_usd: number | null; reservation_released_usd: number; usage_reconciled: boolean }>(
      `SELECT actual_call_usd,reservation_released_usd,usage_reconciled FROM take_proposal_scans`,
    );
    expect(result.status).toBe('ok');
    expect(Number((result.details as Record<string, unknown>).accounted_exposure_usd)).toBeGreaterThan(0);
    expect([scan[0]?.actual_call_usd, Number(scan[0]?.reservation_released_usd), scan[0]?.usage_reconciled]).toEqual([null, 0, false]);
  }, 30000);

  test('proposal_count records persisted rows while parsed_count records model rows', async () => {
    await engine.putPage('probe/counts', { title: 'counts', type: 'analysis', compiled_truth: 'Suppressed governance evidence.' } as never, { sourceId: 'default' });
    const proposal = { claim_text: 'Reviewed claim', kind: 'take' as const, claim_class: 'judgment' as const,
      holder: 'brain', weight: 0.7, domain: 'test' };
    await engine.executeRaw(`INSERT INTO take_proposals
      (source_id,page_slug,content_hash,prompt_version,proposal_run_id,status,claim_text,claim_hash,kind,holder,weight,domain,model_id)
      VALUES('default','probe/counts','old','old','old','accepted',$1,'old-hash','take','brain',0.7,'test','old-model')`, [proposal.claim_text]);
    const raw_response = JSON.stringify([proposal]);
    await runPhaseProposeTakes(ctx(), { pageLimit: 1, budgetUsd: 0.1, extractor: async () => ({
      ...receipt('model_nonempty_valid'), proposals: [proposal], raw_response,
      response_length: Buffer.byteLength(raw_response), response_sha256: contentHash(raw_response), parsed_count: 1,
    }) });
    const scan = await engine.executeRaw<{ proposal_count: number; parsed_count: number; suppressed_count: number }>(
      `SELECT proposal_count,parsed_count,suppressed_count FROM take_proposal_scans`,
    );
    expect(scan[0]).toEqual({ proposal_count: 0, parsed_count: 1, suppressed_count: 1 });
  }, 30000);
});
