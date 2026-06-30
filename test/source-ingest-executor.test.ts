import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { putSourceIngestProfile, profileHash } from '../src/core/source-ingest/store.ts';
import { runSourceIngestExecutor } from '../src/core/source-ingest/executor.ts';
import { buildSourceRevertReport } from '../src/core/source-ingest/revert.ts';
import { makeSourceIngestHandler, parseSourceIngestJobData } from '../src/core/minions/handlers/source-ingest.ts';
import { appendCompleted, fingerprint } from '../src/core/op-checkpoint.ts';
import { importFromContent } from '../src/core/import-file.ts';
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
  mapping: { frontmatter: { equipment_class: 'vehicle' } },
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
  await engine.executeRaw('DELETE FROM op_checkpoint_paths');
  await engine.executeRaw('DELETE FROM op_checkpoints');
  await engine.executeRaw('DELETE FROM source_sync_state');
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
    expect(page?.frontmatter.source_ingest).toMatchObject({ profile_id: profile.profile_id, external_ref: 'fake-source:vehicle:veh-001', run_id: 'run-test-1' });
    const rows = await engine.executeRaw<{ run_id: string; last_result: string; content_fingerprint: string }>(
      `SELECT run_id, last_result, content_fingerprint FROM source_sync_state WHERE external_id = $1`,
      ['veh-001'],
    );
    expect(rows[0].run_id).toBe('run-test-1');
    expect(rows[0].last_result).toBe('success');
    expect(rows[0].content_fingerprint.length).toBeGreaterThan(10);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync('git', ['-C', repo, 'log', '-1', '--oneline'], { encoding: 'utf8' })).toContain('source-ingest run_id=run-test-1');
  }, 30000);

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
    const original = `---\ntype: equipment\ntitle: Existing A-001\nstatus: active\nsource_id: shared\n---\n\n# Existing A-001\n\nManual pre-source-ingest body.\n`;
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
    expect(readFileSync(join(repo, 'source-ingest/vehicles/a-001.md'), 'utf8')).toContain('Manual pre-source-ingest body.');
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
