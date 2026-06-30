import { describe, expect, test } from 'bun:test';
import { parseOpArgs, formatResult } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';

describe('parseOpArgs', () => {
  test('--no-<boolean> maps to false without consuming the next flag', () => {
    const params = parseOpArgs(operationsByName.query, [
      'freshEmbedSourceScope code source',
      '--limit',
      '8',
      '--no-expand',
      '--source-id',
      'gstack-code-repo-0e4763c9',
    ]);

    expect(params).toEqual({
      query: 'freshEmbedSourceScope code source',
      limit: 8,
      expand: false,
      source_id: 'gstack-code-repo-0e4763c9',
    });
  });

  test('source-ingest operator CLI parses positional profile and flags', () => {
    const op = operationsByName.source_ingest;
    expect(op.cliHints?.name).toBe('source-ingest-run');
    expect(op.cliHints?.aliases).toContain('source-ingest');
    const params = parseOpArgs(op, [
      'fake-source-vehicle-v1',
      '--run-id',
      'run-cli',
      '--limit',
      '2',
      '--no-require-clean-git',
      '--no-embed',
    ]);
    expect(params).toEqual({
      profile_id: 'fake-source-vehicle-v1',
      run_id: 'run-cli',
      limit: 2,
      require_clean_git: false,
      no_embed: true,
    });
  });

  test('source-ingest CLI format is operator-readable', () => {
    const text = formatResult('source_ingest', {
      ok: true,
      run_id: 'run-cli',
      profile_id: 'fake-source-vehicle-v1',
      source_id: 'shared',
      storage: { mode: 'git-backed', local_path: '/tmp/shared', git_clean: false, dirty_paths: ['?? companies/'] },
      counts: { sampled: 3, written: 2, unchanged: 0, skipped: 1, failed: 0 },
      git_commit: { committed: false, reason: 'no_changes' },
      graph_writes: 'deferred',
      results: [{ external_id: 'veh-001', status: 'written', slug: 'source-ingest/vehicles/a-001' }],
    });
    expect(text).toContain('source_ingest ok run_id=run-cli');
    expect(text).toContain('dirty_paths=?? companies/');
    expect(text).toContain('counts sampled=3 written=2 unchanged=0 skipped=1 failed=0');
    expect(text).toContain('veh-001: written source-ingest/vehicles/a-001');
  });

  test('source-revert operator CLI parses run id and formats report-only output', () => {
    const op = operationsByName.source_revert;
    expect(op.cliHints?.name).toBe('source-ingest-revert');
    expect(parseOpArgs(op, ['run-1'])).toEqual({ run_id: 'run-1' });
    const text = formatResult('source_revert', {
      mode: 'report-only',
      run_id: 'run-1',
      counts: { affected: 2, success_or_unchanged: 2, failed: 0 },
      pages: [{ slug: 'source-ingest/vehicles/a-001', source_id: 'shared', external_id: 'fake-source:vehicle:veh-001', revert_action: 'would-review' }],
      warnings: ['report_only_stage3b_no_mutation'],
    });
    expect(text).toContain('source_revert report-only run_id=run-1');
    expect(text).toContain('source-ingest/vehicles/a-001 source=shared');
    expect(text).toContain('warnings=report_only_stage3b_no_mutation');
  });
});

