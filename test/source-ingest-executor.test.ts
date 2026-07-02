import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { putSourceIngestProfile, profileHash } from '../src/core/source-ingest/store.ts';
import { runSourceIngestExecutor, sourceIngestLockId } from '../src/core/source-ingest/executor.ts';
import { buildSourceRevertReport } from '../src/core/source-ingest/revert.ts';
import { makeSourceIngestHandler, parseSourceIngestJobData } from '../src/core/minions/handlers/source-ingest.ts';
import { listDueSourceRefreshes, parseFreshnessPolicyMs, enqueueDueSourceRefreshJobs } from '../src/core/source-ingest/freshness.ts';
import {
  deleteSourceConnectorSecrets,
  getSourceConnectorSecretConfig,
  listSourceConnectorConfigs,
  listSourceConnectorSecretAudit,
  putSourceConnectorConfig,
  putSourceConnectorSecrets,
  sourceConnectorSecretStatus,
} from '../src/core/source-ingest/connector-config.ts';
import { rowToVehicleRecord, AppSheetVehicleConnector } from '../src/core/source-ingest/connectors/appsheet-vehicles.ts';
import { runCycle } from '../src/core/cycle.ts';
import { buildSourceDryRun } from '../src/core/source-ingest/dry-run.ts';
import { appendCompleted, fingerprint } from '../src/core/op-checkpoint.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { withEnv } from './helpers/with-env.ts';
import type { SourceIngestProfile } from '../src/core/source-ingest/profile-schema.ts';

let engine: PGLiteEngine;
const tempDirs: string[] = [];

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'source-ingest-executor-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Source Ingest Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'source-ingest@example.test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
  return dir;
}

const profile: SourceIngestProfile = {
  profile_id: 'fake-source-vehicle-v1',
  status: 'reviewed',
  source_connector: 'fake-source',
  source_object: 'vehicle',
  target: { gbrain_type: 'equipment', approved_source_id: 'shared', slug_template: 'source-ingest/vehicles/{{ code | slugify }}' },
  selection: { exclude: [{ field: 'is_group', op: 'eq', value: true }] },
  identity: { external_id_field: 'id', natural_key_fields: ['code'], display_name_field: 'name' },
  freshness: { policy: 'P30D', on_access: 'acknowledge_when_stale', changed_since_field: 'updated_at' },
  mapping: {
    frontmatter: { equipment_class: 'vehicle' },
    article_template: {
      sections: {
        title: '{{ name }}',
        summary: '{{ name }} — тестовая единица техники. Код: {{ code }}.',
        characteristics_type: '{{ vehicle_class }}',
        characteristics_model: '{{ model }} {{ year }}',
        characteristics_status: '{{ status }}',
        characteristics_inventory: '{{ code }}',
        links: '- Находится на площадке (located_at): {{ location_id }}',
        notes: 'Пилотная карточка source-ingest.',
        timeline: '',
      },
    },
  },
  links: [{ id: 'located-at-facility', type: 'located_at', target: { type: 'facility', lookup: 'external_id', value_field: 'location_id' }, when: [{ field: 'location_id', op: 'exists' }] }],
  update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: ['code', 'model', 'year', 'status', 'vehicle_class', 'location_id'] },
  security: { classification: 'shared', pii: true, pii_fields: ['plate', 'responsible_person_id'] },
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM op_checkpoint_paths');
  await engine.executeRaw('DELETE FROM op_checkpoints');
  await engine.executeRaw('DELETE FROM source_ingest_run_items');
  await engine.executeRaw('DELETE FROM source_sync_state');
  await engine.executeRaw('DELETE FROM source_connector_configs');
  await engine.executeRaw('DELETE FROM source_ingest_profile_versions');
  await engine.executeRaw('DELETE FROM source_ingest_profiles');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM tags');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM sources WHERE id != 'default'`);
});

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function seed(repo: string) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1,$2,$3,'{"federated": true}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    ['shared', 'shared', repo],
  );
  await putSourceIngestProfile(engine, profile, { createdBy: 'test', changeNote: 'seed' });
}

describe('source-ingest Stage 3A executor', () => {
  test('writes fake-source vehicle pages through git-backed source and commits them', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-test-1', no_embed: true });
    expect(out.ok).toBe(true);
    expect(out.counts.written).toBe(2);
    expect(out.counts.skipped).toBe(1);
    expect(out.graph_writes).toBe('deferred');
    expect(out.git_commit?.committed).toBe(true);
    expect(out.results.every(r => r.status !== 'failed')).toBe(true);
    const page = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    expect(page?.type).toBe('equipment');
    expect(page?.compiled_truth).toContain('## Характеристики');
    expect(page?.compiled_truth).toContain('Пилотная карточка source-ingest.');
    expect(page?.compiled_truth).toContain('<!-- gbrain-source-sync:start');
    expect(page?.frontmatter.source_ingest).toMatchObject({ profile_id: profile.profile_id, external_ref: 'fake-source:vehicle:veh-001', run_id: 'run-test-1' });
    const rows = await engine.executeRaw<{ run_id: string; last_result: string; content_fingerprint: string; managed_block_hash: string }>(
      `SELECT run_id, last_result, content_fingerprint, managed_block_hash FROM source_sync_state WHERE external_id = $1`,
      ['veh-001'],
    );
    expect(rows[0].run_id).toBe('run-test-1');
    expect(rows[0].last_result).toBe('success');
    expect(rows[0].content_fingerprint.length).toBeGreaterThan(10);
    expect(rows[0].managed_block_hash).toBe(rows[0].content_fingerprint);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync('git', ['-C', repo, 'log', '-1', '--oneline'], { encoding: 'utf8' })).toContain('source-ingest run_id=run-test-1');
  }, 30000);

  test('dry-run renders article template previews for multiple rows', () => {
    const sample = [
      { external_id: 'veh-001', data: { id: 'veh-001', code: 'A-001', name: 'Toyota Hilux A001', vehicle_class: 'pickup', model: 'Toyota Hilux', year: 2021, status: 'active', is_group: false, location_id: 'facility-almaty-yard' } },
      { external_id: 'veh-002', data: { id: 'veh-002', code: 'A-002', name: 'Hyundai Porter A002', vehicle_class: 'truck', model: 'Hyundai Porter', year: 2020, status: 'repair', is_group: false, location_id: 'facility-almaty-yard' } },
    ];
    const out = buildSourceDryRun(profile, sample);
    expect(out.sample_pages.length).toBe(2);
    expect(out.sample_pages[0].article_markdown_preview).toContain('## Характеристики');
    expect(out.sample_pages[0].article_markdown_preview).toContain('Toyota Hilux 2021');
    expect(out.sample_pages[1].article_markdown_preview).toContain('Hyundai Porter 2020');
    expect(out.sample_pages[0].article_empty_slots).toEqual([]);
  });

  test('second identical run is unchanged and preserves page content_hash', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-test-1', no_embed: true });
    const first = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-test-2', no_embed: true });
    const second = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    expect(out.ok).toBe(true);
    expect(out.counts.unchanged).toBe(2);
    expect(first?.content_hash).toBe(second?.content_hash);
    expect(out.git_commit?.committed).toBe(false);
    expect(out.git_commit?.reason).toBe('no_changes');
    const sync = await engine.executeRaw<{ run_id: string; last_result: string }>(
      `SELECT run_id, last_result FROM source_sync_state WHERE external_id = $1`,
      ['veh-001'],
    );
    expect(sync[0]).toEqual({ run_id: 'run-test-2', last_result: 'unchanged' });
  }, 30000);

  test('blocks dirty git-backed source before writing', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    writeFileSync(join(repo, 'dirty.md'), 'dirty\n');
    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-dirty', no_embed: true });
    expect(out.ok).toBe(false);
    expect(out.storage.mode).toBe('blocked');
    if (out.storage.mode === 'blocked') expect(out.storage.reason).toBe('dirty_git_tree');
    expect(await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' })).toBeNull();
  }, 30000);

  test('blocks concurrent source-ingest runs with the same per-source lock before writing', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, 999999, 'other-host', NOW(), NOW() + INTERVAL '30 minutes', NOW())`,
      [sourceIngestLockId('shared')],
    );
    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-lock-busy', no_embed: true });
    expect(out.ok).toBe(false);
    expect(out.storage.mode).toBe('blocked');
    if (out.storage.mode === 'blocked') expect(out.storage.reason).toBe('source_ingest_lock_busy');
    expect(await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' })).toBeNull();
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  }, 30000);

  test('warns when a human edited inside the managed block before refresh', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-edit-1', no_embed: true });
    const page = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    expect(page).toBeTruthy();
    const edited = page!.compiled_truth.replace('- status: active', '- status: human-edited-inside-block');
    const imported = await importFromContent(engine, 'source-ingest/vehicles/a-001', edited, {
      noEmbed: true,
      sourceId: 'shared',
      sourcePath: 'source-ingest/vehicles/a-001.md',
      source_kind: 'manual_test_edit',
      source_uri: 'test:inside-managed-block',
      ingested_via: 'test',
      remote: false,
    });
    expect(imported.status).toBe('imported');
    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-edit-2', no_embed: true });
    const record = out.results.find(r => r.external_id === 'veh-001');
    expect(record?.warnings).toContain('managed_block_user_edit_overwritten');
    const refreshed = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    expect(refreshed?.compiled_truth).toContain('- status: active');
  }, 30000);

  test('resumes from op-checkpoint and skips completed external refs', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-resume-1', limit: 1, no_embed: true });
    const key = {
      op: 'source_ingest',
      fingerprint: fingerprint({ profile_id: profile.profile_id, profile_hash: profileHash(profile), source_id: 'shared', connector: 'fake-source', object: 'vehicle', mode: 'stage3a' }),
    };
    await appendCompleted(engine, key, ['fake-source:vehicle:veh-001']);
    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-resume-2', no_embed: true });
    expect(out.ok).toBe(true);
    expect(out.results.find(r => r.external_id === 'veh-001')).toMatchObject({ status: 'skipped', reason: 'checkpoint_completed' });
    expect(out.results.find(r => r.external_id === 'veh-002')).toMatchObject({ status: 'written' });
    expect(out.checkpoint.cleared).toBe(true);
    expect(await engine.getPage('source-ingest/vehicles/a-002', { sourceId: 'shared' })).toBeTruthy();
  }, 30000);

  test('source_revert uses append-only run ledger even after later run overwrites source_sync_state.run_id', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-ledger-a', limit: 1, no_embed: true });
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-ledger-b', limit: 1, no_embed: true });
    const state = await engine.executeRaw<{ run_id: string }>(`SELECT run_id FROM source_sync_state WHERE external_id = 'veh-001'`);
    expect(state[0].run_id).toBe('run-ledger-b');
    const report = await buildSourceRevertReport(engine, 'run-ledger-a');
    expect(report.counts.affected).toBe(1);
    expect(report.pages[0]).toMatchObject({ slug: 'source-ingest/vehicles/a-001', revert_action: 'would-soft-delete' });
  }, 30000);

  test('failed write-through cleans DB orphan and leaves git tree clean for next preflight', async () => {
    const repo = tempGitRepo();
    mkdirSync(join(repo, 'source-ingest/vehicles/a-002.md'), { recursive: true });
    writeFileSync(join(repo, 'source-ingest/vehicles/a-002.md/placeholder'), 'directory conflict for write-through\n');
    execFileSync('git', ['add', 'source-ingest/vehicles/a-002.md/placeholder'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'seed conflicting path'], { cwd: repo });
    await seed(repo);

    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-partial-fail', no_embed: true });
    expect(out.ok).toBe(false);
    expect(out.results.find(r => r.external_id === 'veh-001')).toMatchObject({ status: 'written' });
    expect(out.results.find(r => r.external_id === 'veh-002')?.status).toBe('failed');
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
    expect(await engine.getPage('source-ingest/vehicles/a-002', { sourceId: 'shared' })).toBeNull();
    const failedRows = await engine.executeRaw<{ action: string; last_result: string }>(`SELECT action, last_result FROM source_ingest_run_items WHERE run_id = $1 AND external_id = 'veh-002'`, ['run-partial-fail']);
    expect(failedRows[0]).toEqual({ action: 'failed', last_result: 'failed' });

    const next = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-after-partial-fail', limit: 1, no_embed: true });
    expect(next.storage.mode).toBe('git-backed');
  }, 30000);

  test('source_revert report-only lists pages touched by run_id without mutating', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-revert-report', no_embed: true });
    const before = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    const report = await buildSourceRevertReport(engine, 'run-revert-report');
    const after = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    expect(report.mode).toBe('report-only');
    expect(report.counts.affected).toBe(2);
    expect(report.pages.map(p => p.slug).sort()).toEqual(['source-ingest/vehicles/a-001', 'source-ingest/vehicles/a-002']);
    expect(report.warnings).toContain('report_only_stage3b_no_mutation');
    expect(after?.content_hash).toBe(before?.content_hash);
  }, 30000);

  test('source_revert apply soft-deletes pages created by the run and commits file removal', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-revert-created', no_embed: true });
    const report = await buildSourceRevertReport(engine, 'run-revert-created', { apply: true, no_embed: true });
    expect(report.mode).toBe('apply');
    expect(report.counts.reverted).toBe(2);
    expect(report.pages.every(p => p.revert_action === 'soft-deleted')).toBe(true);
    expect(await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' })).toBeNull();
    expect(await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared', includeDeleted: true })).toBeTruthy();
    expect(existsSync(join(repo, 'source-ingest/vehicles/a-001.md'))).toBe(false);
    expect(report.git_commit?.committed).toBe(true);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  }, 30000);

  test('source_revert apply restores previous version for updated pages', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    const original = `---\ntype: equipment\ntitle: Existing A-001\nstatus: active\nsource_id: shared\nequipment:\n  identifiers:\n    vin: VIN-001\n  tags:\n    - nested\n    - revert\n---\n\n# Existing A-001\n\nManual pre-source-ingest body.\n`;
    await importFromContent(engine, 'source-ingest/vehicles/a-001', original, {
      noEmbed: true,
      sourceId: 'shared',
      sourcePath: 'source-ingest/vehicles/a-001.md',
      remote: false,
    });
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-revert-update', limit: 1, no_embed: true });
    expect((await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' }))?.compiled_truth).toContain('Source data');
    const report = await buildSourceRevertReport(engine, 'run-revert-update', { apply: true, no_embed: true });
    expect(report.pages.find(p => p.slug === 'source-ingest/vehicles/a-001')).toMatchObject({ revert_action: 'reverted-version' });
    const reverted = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    expect(reverted?.compiled_truth).toContain('Manual pre-source-ingest body.');
    const restoredFile = readFileSync(join(repo, 'source-ingest/vehicles/a-001.md'), 'utf8');
    expect(restoredFile).toContain('Manual pre-source-ingest body.');
    expect(restoredFile).toContain('equipment:\n');
    expect(restoredFile).toContain('identifiers:\n    vin: VIN-001');
    expect(restoredFile).toContain('tags:\n    - nested\n    - revert');
    const restoredPage = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    expect((restoredPage?.frontmatter.equipment as Record<string, unknown>)?.identifiers).toMatchObject({ vin: 'VIN-001' });
    expect(report.git_commit?.committed).toBe(true);
  }, 30000);

  test('source_revert apply blocks when page changed after run unless forced', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-revert-block', no_embed: true });
    await new Promise(resolve => setTimeout(resolve, 1100));
    const page = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    await importFromContent(engine, 'source-ingest/vehicles/a-001', `${page!.compiled_truth}\n\nManual after-run edit.\n`, {
      noEmbed: true,
      sourceId: 'shared',
      sourcePath: 'source-ingest/vehicles/a-001.md',
      remote: false,
    });
    const report = await buildSourceRevertReport(engine, 'run-revert-block', { apply: true, no_embed: true });
    expect(report.pages.find(p => p.slug === 'source-ingest/vehicles/a-001')).toMatchObject({ revert_action: 'blocked', reason: 'page_updated_after_run' });
    expect(await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' })).toBeTruthy();
  }, 30000);

  test('source_refresh freshness planner marks stale rows due and fresh rows not due', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    expect(parseFreshnessPolicyMs('P30D')).toBe(30 * 24 * 60 * 60_000);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-freshness', no_embed: true });
    const sync = await engine.executeRaw<{ stale_after: string | null }>(
      `SELECT stale_after::text FROM source_sync_state WHERE external_id = $1`,
      ['veh-001'],
    );
    expect(sync[0].stale_after).toBeTruthy();
    expect(await listDueSourceRefreshes(engine, { profile_id: profile.profile_id })).toEqual([]);
    await engine.executeRaw(`UPDATE source_sync_state SET stale_after = now() - interval '1 hour' WHERE profile_id = $1`, [profile.profile_id]);
    const due = await listDueSourceRefreshes(engine, { profile_id: profile.profile_id });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ profile_id: profile.profile_id, due_rows: 2, reason: 'stale' });
  }, 30000);

  test('source_refresh planner returns initial_sync for reviewed profiles with no sync rows', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    const due = await listDueSourceRefreshes(engine, { profile_id: profile.profile_id });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ profile_id: profile.profile_id, total_rows: 0, never_synced_rows: 1, reason: 'initial_sync' });
  }, 30000);

  test('source_refresh enqueue is idempotent for the same freshness window', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-refresh-dedupe', no_embed: true });
    await engine.executeRaw(`UPDATE source_sync_state SET stale_after = now() - interval '1 hour' WHERE profile_id = $1`, [profile.profile_id]);
    const due = await listDueSourceRefreshes(engine, { profile_id: profile.profile_id });
    const first = await enqueueDueSourceRefreshJobs(engine, due, { require_clean_git: false, no_embed: true, now: new Date('2026-07-01T00:00:00Z') });
    const second = await enqueueDueSourceRefreshJobs(engine, due, { require_clean_git: false, no_embed: true, now: new Date('2026-07-01T00:05:00Z') });
    expect(first[0].job_id).toBe(second[0].job_id);
    expect(second[0].deduped).toBe(true);
    const rows = await engine.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM minion_jobs WHERE name = 'source-ingest'`);
    expect(rows[0].count).toBe('1');
  }, 30000);

  test('source_refresh cycle phase enqueues jobs without connector IO', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-refresh-cycle', no_embed: true });
    await engine.executeRaw(`UPDATE source_sync_state SET stale_after = now() - interval '1 hour' WHERE profile_id = $1`, [profile.profile_id]);
    const report = await runCycle(engine, { brainDir: null, phases: ['source_refresh'] });
    expect(report.phases[0]).toMatchObject({ phase: 'source_refresh', status: 'ok' });
    const jobs = await engine.executeRaw<{ data: unknown }>(`SELECT data FROM minion_jobs WHERE name = 'source-ingest'`);
    expect(jobs).toHaveLength(1);
    const data = typeof jobs[0].data === 'string' ? JSON.parse(jobs[0].data) : jobs[0].data as Record<string, unknown>;
    expect(data).toMatchObject({ profile_id: profile.profile_id, changed_since: true, no_embed: true });
  }, 30000);

  test('source_refresh source filter is applied before limit', async () => {
    const sharedRepo = tempGitRepo();
    const internalRepo = tempGitRepo();
    await seed(sharedRepo);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ($1,$2,$3,'{"federated": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      ['internal-equipment', 'internal-equipment', internalRepo],
    );
    await putSourceIngestProfile(engine, {
      ...profile,
      profile_id: 'fake-source-vehicle-internal-v1',
      target: { ...profile.target, approved_source_id: 'internal-equipment', slug_template: 'source-ingest/internal-vehicles/{{ code | slugify }}' },
    }, { createdBy: 'test', changeNote: 'seed internal' });

    const due = await listDueSourceRefreshes(engine, { source_id: 'internal-equipment', limit: 1 });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ profile_id: 'fake-source-vehicle-internal-v1', approved_source_id: 'internal-equipment' });
  }, 30000);

  test('source_ingest changed_since no-ops when connector has no newer records', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-changed-full', no_embed: true });
    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-changed-empty', no_embed: true, changed_since: true });
    expect(out.counts).toMatchObject({ sampled: 0, written: 0, unchanged: 0, skipped: 0, failed: 0 });
    expect(out.git_commit?.committed).toBe(false);
    expect(out.git_commit?.reason).toBe('no_files');
  }, 30000);

  test('source_ingest changed_since retries failed rows even when older than successful cursor', async () => {
    const repo = tempGitRepo();
    mkdirSync(join(repo, 'source-ingest/vehicles/a-001.md'), { recursive: true });
    writeFileSync(join(repo, 'source-ingest/vehicles/a-001.md/placeholder'), 'directory conflict for write-through\n');
    execFileSync('git', ['add', 'source-ingest/vehicles/a-001.md/placeholder'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'seed older conflicting path'], { cwd: repo });
    await seed(repo);

    const first = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-changed-fail-older', no_embed: true });
    expect(first.ok).toBe(false);
    expect(first.results.find(r => r.external_id === 'veh-001')?.status).toBe('failed');
    expect(first.results.find(r => r.external_id === 'veh-002')?.status).toBe('written');

    const retry = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-changed-retry-failed', no_embed: true, changed_since: true });
    expect(retry.counts.sampled).toBe(1);
    expect(retry.results.map(r => r.external_id)).toEqual(['veh-001']);
    expect(retry.results[0]).toMatchObject({ external_id: 'veh-001', status: 'failed' });
  }, 30000);

  test('source connector config persists non-secret AppSheet vehicle settings and redacts secrets', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await putSourceConnectorConfig(engine, {
      connector_id: 'appsheet-vehicles',
      source_object: 'vehicle',
      display_name: 'AppSheet автотранспорт',
      table_name: 'Автотранспорт',
      target_source_id: 'shared',
      slug_prefix: 'source-ingest/vehicles',
      freshness_policy: 'P30D',
      enabled: true,
      config_json: { table_name: 'Автотранспорт' },
    }, { actor: 'test' });
    const rows = await listSourceConnectorConfigs(engine, 'appsheet-vehicles:vehicle');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ connector_id: 'appsheet-vehicles', source_object: 'vehicle', table_name: 'Автотранспорт', enabled: true });
    expect(JSON.stringify(rows[0])).not.toContain('APPSHEET_VEHICLES_ACCESS_KEY=');
    const secrets = await sourceConnectorSecretStatus(engine, 'appsheet-vehicles');
    expect(secrets.required_keys).toEqual(['app_id', 'access_key']);
    expect(secrets.missing_keys).toEqual(expect.arrayContaining(['app_id', 'access_key']));
  });

  test('DB-backed AppSheet secrets rotate encrypted-at-rest, mask, audit, and delete without exposing values in status', async () => {
    await withEnv({ GBRAIN_SOURCE_CONNECTOR_SECRET_KEY: 'test-source-connector-secret-key' }, async () => {
      const repo = tempGitRepo();
      await seed(repo);
      await putSourceConnectorConfig(engine, {
        connector_id: 'appsheet-vehicles',
        source_object: 'vehicle',
        display_name: 'AppSheet автотранспорт',
        table_name: 'Автотранспорт',
        target_source_id: 'shared',
        slug_prefix: 'source-ingest/vehicles',
        freshness_policy: 'P30D',
        enabled: true,
        config_json: { table_name: 'Автотранспорт' },
      }, { actor: 'test' });

      const rotated = await putSourceConnectorSecrets(engine, {
        connector_id: 'appsheet-vehicles',
        source_object: 'vehicle',
        secret_json: { app_id: 'app-123456', access_key: 'key-secret-7890' },
      }, { actor: 'admin:test' });
      expect(rotated).toMatchObject({ configured: true, storage: 'db', updated_by: 'admin:test' });
      expect(rotated.masked).toEqual({ app_id: '••••3456', access_key: '••••7890' });
      expect(JSON.stringify(rotated)).not.toContain('key-secret-7890');

      const raw = await engine.executeRaw<{ secret_json: Record<string, unknown> }>(`SELECT secret_json FROM source_connector_secrets WHERE config_id = $1`, ['appsheet-vehicles:vehicle']);
      expect(raw[0].secret_json.__encrypted).toBe(true);
      expect(JSON.stringify(raw[0].secret_json)).not.toContain('key-secret-7890');
      expect(JSON.stringify(raw[0].secret_json)).not.toContain('app-123456');

      const secretConfig = await getSourceConnectorSecretConfig(engine, 'appsheet-vehicles', 'vehicle');
      expect(secretConfig).toEqual({ app_id: 'app-123456', access_key: 'key-secret-7890' });
      const audit = await listSourceConnectorSecretAudit(engine, 'appsheet-vehicles:vehicle');
      expect(audit[0]).toMatchObject({ action: 'rotate', actor: 'admin:test', secret_keys: ['access_key', 'app_id'] });
      expect(JSON.stringify(audit)).not.toContain('key-secret-7890');

      const deleted = await deleteSourceConnectorSecrets(engine, { connector_id: 'appsheet-vehicles', source_object: 'vehicle' }, { actor: 'admin:test' });
      expect(deleted.configured).toBe(false);
      expect((await getSourceConnectorSecretConfig(engine, 'appsheet-vehicles', 'vehicle'))).toEqual({});
      const auditAfterDelete = await listSourceConnectorSecretAudit(engine, 'appsheet-vehicles:vehicle');
      expect(auditAfterDelete[0]).toMatchObject({ action: 'delete', actor: 'admin:test' });
    });
  });

  test('AppSheet connector uses saved table config without leaking credentials', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
      return new Response(JSON.stringify([{ ID: 'truck-1', ГосНомер: '111AAA02', Модель: 'Kamaz', ДатаИзменения: '2026-07-01T10:00:00+05:00' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const connector = new AppSheetVehicleConnector({ appId: 'app', accessKey: 'secret', tableName: 'Автотранспорт', baseUrl: 'https://203.0.113.10/api/v2/apps', fetchImpl });
    const sample = await connector.sample('vehicle', 5);
    expect(sample[0].external_id).toBe('truck-1');
    expect(calls[0].url).toContain(encodeURIComponent('Автотранспорт'));
    expect(JSON.stringify(calls[0].body)).not.toContain('secret');
  });

  test('AppSheet connector rejects internal base_url before credentialed fetch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new AppSheetVehicleConnector({
      appId: 'app',
      accessKey: 'secret',
      tableName: 'Автотранспорт',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      fetchImpl,
    });

    const err = await connector.sample('vehicle', 1).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('URL targets internal/private network');
    expect(called).toBe(false);
  });

  test('AppSheet vehicle connector scaffold normalizes vehicle rows without live network', () => {
    const rec = rowToVehicleRecord({ ID: 'car-1', ГосНомер: '777ABC02', Модель: 'MAN TGS', ДатаИзменения: '2026-06-30T10:00:00+05:00' });
    expect(rec).toMatchObject({ external_id: 'car-1', source_updated_at: '2026-06-30T10:00:00+05:00' });
    expect(rec.data).toMatchObject({ id: 'car-1', code: '777ABC02', name: 'MAN TGS', type: 'vehicle', is_group: false });
  });

  test('source-ingest minion handler parses payload, updates progress, and runs executor', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    expect(parseSourceIngestJobData({ profile_id: ' fake-source-vehicle-v1 ', limit: 1 })).toMatchObject({ profile_id: 'fake-source-vehicle-v1', limit: 1 });
    const progress: unknown[] = [];
    const logs: string[] = [];
    const handler = makeSourceIngestHandler(engine);
    const out = await handler({
      id: 42,
      name: 'source-ingest',
      data: { profile_id: profile.profile_id, run_id: 'run-job-handler', no_embed: true },
      attempts_made: 0,
      signal: new AbortController().signal,
      shutdownSignal: new AbortController().signal,
      updateProgress: async p => { progress.push(p); },
      updateTokens: async () => {},
      log: async m => { logs.push(typeof m === 'string' ? m : JSON.stringify(m)); },
      isActive: async () => true,
      readInbox: async () => [],
    });
    expect(out.ok).toBe(true);
    expect(out.run_id).toBe('run-job-handler');
    expect(out.counts.written).toBe(2);
    expect(progress[0]).toMatchObject({ phase: 'starting', profile_id: profile.profile_id });
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', run_id: 'run-job-handler', ok: true });
    expect(logs.some(l => l.includes('starting run'))).toBe(true);
  }, 30000);
});
