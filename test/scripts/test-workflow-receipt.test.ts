import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..', '..');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/test.yml'), 'utf-8');
const statusStart = workflow.indexOf('\n  test-status:');
const receiptStart = workflow.indexOf('\n  exact-sha-receipt:');
const statusJob = statusStart >= 0 && receiptStart > statusStart ? workflow.slice(statusStart, receiptStart) : '';
const receiptJob = receiptStart >= 0 ? workflow.slice(receiptStart) : '';

describe('manual exact-SHA test workflow', () => {
  it('offers a force_full dispatch input and bypasses the pass cache when requested', () => {
    expect(workflow).toContain('force_full:');
    expect(workflow).toContain('type: boolean');
    expect(workflow).toContain("if: inputs.force_full != true");
  });

  it('writes and uploads an exact-SHA receipt even when the gate fails', () => {
    expect(receiptStart).toBeGreaterThan(0);
    expect(receiptJob).toContain('if: always()');
    expect(receiptJob).toContain('github.sha');
    expect(receiptJob).toContain('github.run_id');
    expect(receiptJob).toContain('needs.test-status.result');
    expect(receiptJob).toContain('test "$CHECKED_OUT_SHA" = "$CANDIDATE_SHA"');
    expect(receiptJob).toContain('"checked_out_sha"');
    expect(receiptJob).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(receiptJob).toContain('if-no-files-found: error');
  });

  it('fails closed when cache-check itself did not succeed', () => {
    expect(statusJob).toContain('needs.cache-check.result');
    expect(statusJob).toContain('if [ "$CACHE_CHECK" != "success" ]');
    expect(statusJob.indexOf('if [ "$CACHE_CHECK" != "success" ]')).toBeLessThan(statusJob.indexOf('if [ "$HIT" = "true" ]'));
  });
});
