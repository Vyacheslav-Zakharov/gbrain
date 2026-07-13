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
  sourceTableSummariesFromConfigs,
} from '../src/core/source-ingest/connector-config.ts';
import { rowToVehicleRecord, AppSheetVehicleConnector } from '../src/core/source-ingest/connectors/appsheet-vehicles.ts';
import { runCycle } from '../src/core/cycle.ts';
import { buildSourceDryRun } from '../src/core/source-ingest/dry-run.ts';
import { draftSourceIngestProfile } from '../src/core/source-ingest/draft.ts';
import { buildProfileSampleRecords, connectorConfigForSource } from '../src/core/source-ingest/source-fetch.ts';
import { executeSourceTransform } from '../src/core/source-ingest/transform.ts';
import { discoverSourceObject, profileRecords } from '../src/core/source-ingest/discovery.ts';
import { renderArticleTemplate, renderTemplateString } from '../src/core/source-ingest/template-renderer.ts';
import type { SourceIngestProfile } from '../src/core/source-ingest/profile-schema.ts';
import { appendCompleted, fingerprint } from '../src/core/op-checkpoint.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { withEnv } from './helpers/with-env.ts';
import { operationsByName } from '../src/core/operations.ts';

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
    expect(page?.frontmatter.source_ingest).toMatchObject({ profile_id: profile.profile_id, external_ref: 'fake-source:vehicle:veh-001' });
    expect((page?.frontmatter.source_ingest as Record<string, unknown>).run_id).toBeUndefined();
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

  test('draft template only uses selected discovery fields and drops noisy/unselected fields', () => {
    const discovery = {
      connectorId: 'appsheet-vehicles',
      objectName: 'vehicle',
      sampled: 2,
      fields: [
        { name: 'id', observedTypes: ['string'], nullRatio: 0, samples: ['veh-1'], cardinality: 1 },
        { name: 'code', observedTypes: ['string'], nullRatio: 0, samples: ['A-001'], cardinality: 1 },
        { name: 'name', observedTypes: ['string'], nullRatio: 0, samples: ['Toyota Hilux'], cardinality: 1 },
        { name: 'status', observedTypes: ['string'], nullRatio: 0, samples: ['active'], cardinality: 1 },
        { name: 'related_measurementacts', observedTypes: ['array'], nullRatio: 0, samples: ['x,y,z'], cardinality: 1 },
      ],
      idCandidates: ['id', 'code'],
      updatedAtCandidates: ['updated_at'],
      parentCandidates: [],
      samples: [],
      warnings: [],
    };
    const { profile: drafted } = draftSourceIngestProfile({
      connectorId: 'appsheet-vehicles',
      sourceObject: 'vehicle',
      discovery,
      targetSourceId: 'shared',
      selectedFields: ['id', 'code', 'name', 'status'],
    });
    const raw = JSON.stringify(drafted.mapping?.article_template?.sections || {});
    expect(raw).toContain('{{ name }}');
    expect(raw).toContain('{{ code }}');
    expect(raw).toContain('{{ status }}');
    expect(raw).not.toContain('{{ model }}');
    expect(raw).not.toContain('external_code');
    expect(raw).not.toContain('related_measurementacts');
    expect(drafted.update_policy.field_allowlist).toEqual(['id', 'code', 'name', 'status']);
    expect(drafted.mapping?.source_fields).toEqual(['id', 'code', 'name', 'status']);
  });

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

  test('dry-run masks PII fields in expanded server preview', () => {
    const piiProfile: SourceIngestProfile = {
      ...profile,
      security: { ...profile.security, pii: true, pii_fields: ['name', 'vin', 'owner.email'] },
      mapping: {
        ...profile.mapping,
        article_template: {
          sections: {
            title: '{{ name }}',
            summary: 'VIN {{ vin }} owner {{ owner.email }} code {{ code }}',
          },
        },
      },
      update_policy: { ...profile.update_policy, field_allowlist: ['code', 'name', 'vin', 'owner.email'] },
    };
    const out = buildSourceDryRun(piiProfile, [{
      external_id: 'veh-pii',
      source_updated_at: null,
      data: { id: 'veh-pii', code: 'A-PII', name: 'Secret Driver', vin: 'VIN-SECRET-123', owner: { email: 'secret@example.com' } },
    }]);
    const raw = JSON.stringify(out.sample_pages[0]);
    expect(raw).toContain('[PII masked]');
    expect(raw).not.toContain('Secret Driver');
    expect(raw).not.toContain('VIN-SECRET-123');
    expect(raw).not.toContain('secret@example.com');
    expect(raw).toContain('A-PII');
  });

  test('source_dry_run returns profile_hash and source_profile_put approve requires matching dry-run hash', async () => {
    const ctx = { engine, config: {}, logger: console, sourceId: 'default', remote: false, dryRun: false } as any;
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ($1,$2,$3,'{"federated": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      ['shared', 'shared', tempGitRepo()],
    );
    const dry = await operationsByName.source_dry_run.handler({ ...ctx, dryRun: true }, { profile, sample_limit: 2 });
    const dryHash = String((dry as Record<string, unknown>).profile_hash);
    expect(dryHash).toBe(profileHash(profile));

    await expect(operationsByName.source_profile_put.handler(ctx, {
      profile,
      approve: true,
      approved_source_id: 'shared',
      approved_by: 'test',
    })).rejects.toThrow('profile_hash from the last dry-run is required');

    await expect(operationsByName.source_profile_put.handler(ctx, {
      profile,
      approve: true,
      approved_source_id: 'shared',
      approved_by: 'test',
      profile_hash: 'bad-hash',
    })).rejects.toThrow('profile_hash_mismatch');
  });

  test('source-ingest uses the same per-source lock namespace as gbrain sync', () => {
    expect(sourceIngestLockId('shared')).toBe('gbrain-sync:shared');
  });

  test('SQL transform can join multiple source objects and aggregate before dry-run mapping', async () => {
    const transformedProfile: SourceIngestProfile = {
      ...profile,
      profile_id: 'fake-source-vehicle-transform-v1',
      transform: {
        engine: 'pglite',
        primary_key_field: 'id',
        updated_at_field: 'updated_at',
        sources: [
          { alias: 'vehicles', connector: 'fake-source', object: 'vehicle', fields: ['id', 'code', 'name', 'status', 'is_group', 'updated_at'] },
          { alias: 'acts', connector: 'fake-source', object: 'measurement_acts', fields: ['id', 'vehicle_id', 'status'] },
        ],
        sql: `
          SELECT
            v.id,
            v.code,
            v.name,
            v.status,
            v.updated_at,
            COUNT(a.id)::int AS active_act_count
          FROM vehicles v
          LEFT JOIN acts a ON a.vehicle_id = v.id AND a.status = 'active'
          WHERE v.is_group = false AND v.status = 'active'
          GROUP BY v.id, v.code, v.name, v.status, v.updated_at
          ORDER BY v.code
        `,
      },
      mapping: {
        ...profile.mapping,
        article_template: {
          sections: {
            title: '{{ name }}',
            summary: '{{ name }} — активных актов: {{ active_act_count }}.',
          },
        },
      },
      update_policy: { ...profile.update_policy, field_allowlist: ['code', 'name', 'status', 'active_act_count'] },
    };

    const sample = await buildProfileSampleRecords(transformedProfile, 10, { defaultConnector: 'fake-source', defaultObject: 'vehicle' });
    expect(sample.map(r => r.external_id)).toEqual(['veh-001']);
    expect(sample[0].data).toMatchObject({ code: 'A-001', active_act_count: 2 });
    const dry = buildSourceDryRun(transformedProfile, sample);
    expect(dry.sample_pages[0]?.article_markdown_preview).toContain('активных актов: 2');

    const repo = tempGitRepo();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ($1,$2,$3,'{"federated": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      ['shared', 'shared', repo],
    );
    await putSourceIngestProfile(engine, transformedProfile, { createdBy: 'test', changeNote: 'transform-seed' });
    const out = await runSourceIngestExecutor(engine, { profile_id: transformedProfile.profile_id, run_id: 'run-transform-test', no_embed: true });
    expect(out.counts.written).toBe(1);
    const page = await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' });
    expect(page?.compiled_truth).toContain('активных актов: 2');
  });

  test('SQL transform enforces row cap before materializing preview samples', async () => {
    const manyRowsProfile: SourceIngestProfile = {
      ...profile,
      profile_id: 'fake-source-transform-rowcap-v1',
      transform: {
        engine: 'pglite',
        primary_key_field: 'id',
        sources: [{ alias: 'vehicles', connector: 'fake-source', object: 'vehicle', fields: ['id', 'code', 'is_group'] }],
        sql: `
          SELECT v.id || '-' || gs.n AS id, v.code, gs.n
          FROM vehicles v
          CROSS JOIN generate_series(1, 10) AS gs(n)
          WHERE v.is_group = false
          ORDER BY v.code, gs.n
        `,
      },
    };

    await expect(buildProfileSampleRecords(manyRowsProfile, 2, { defaultConnector: 'fake-source', defaultObject: 'vehicle' }))
      .rejects.toThrow('transform_row_cap_exceeded: result exceeds 2 rows');
  });

  test('SQL transform aborts long-running work without blocking other JS timers', async () => {
    const started = Date.now();
    const timer = new Promise<'timer'>(resolve => setTimeout(() => resolve('timer'), 20));
    const transform = executeSourceTransform(
      {
        engine: 'pglite',
        primary_key_field: 'n',
        sources: [{ alias: 'source', object: 'vehicle' }],
        sql: 'SELECT n FROM generate_series(1, 1000000000) AS gs(n)',
      },
      async () => [],
      { timeoutMs: 100, rowLimit: 1000 },
    );

    await expect(timer).resolves.toBe('timer');
    await expect(transform).rejects.toThrow('transform_timeout: exceeded 100ms');
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 5000);

  test('SQL transform coerces timestamptz updated_at_field into source_updated_at', async () => {
    const result = await executeSourceTransform(
      {
        engine: 'pglite',
        primary_key_field: 'id',
        updated_at_field: 'updated_at',
        sources: [{ alias: 'source', object: 'vehicle' }],
        sql: `SELECT 'veh-ts'::text AS id, max(ts)::timestamptz AS updated_at FROM (VALUES ('2026-07-01T10:00:00Z'::timestamptz)) AS t(ts)`,
      },
      async () => [],
    );
    expect(result.records[0].source_updated_at).toBe('2026-07-01T10:00:00.000Z');
  });

  test('SQL transform preserves empty text and serializes large bigint-like values safely', async () => {
    const result = await executeSourceTransform(
      {
        engine: 'pglite',
        primary_key_field: 'id',
        sources: [{ alias: 'source', object: 'vehicle' }],
        sql: "SELECT 'veh-big'::text AS id, ''::text AS note, 9007199254740993::bigint AS big_code",
      },
      async () => [],
    );
    expect(result.records[0].data.note).toBe('');
    expect(result.records[0].data.big_code).toBe('9007199254740993');
  });

  test('template renderer rejects unknown filters and keeps markdown title single-line/capped', () => {
    const emptySlots: string[] = [];
    const rendered = renderTemplateString('{{ name | unknown }}', { external_id: 'x', data: { name: 'Secret' } }, emptySlots);
    expect(rendered).toBe('');
    expect(emptySlots).toContain('name (unknown filter: unknown)');
    const article = renderArticleTemplate({
      ...profile,
      mapping: {
        ...profile.mapping,
        article_template: { sections: { title: '{{ name }}', notes: 'ok' } },
      },
    }, { external_id: 'x', data: { name: 'Line 1\nLine 2' } });
    expect(article.title).toBe('Line 1 Line 2');
    expect(article.body).toContain('# Line 1 Line 2\n');
  });

  test('SQL transform rejects missing and null primary keys instead of row-N fallback', async () => {
    await expect(executeSourceTransform(
      {
        engine: 'pglite',
        sources: [{ alias: 'source', object: 'vehicle' }],
        sql: 'SELECT 1 AS id',
      },
      async () => [],
    )).rejects.toThrow('invalid transform SQL: primary_key_field_required');

    await expect(executeSourceTransform(
      {
        engine: 'pglite',
        primary_key_field: 'id',
        sources: [{ alias: 'source', object: 'vehicle' }],
        sql: 'SELECT NULL::text AS id',
      },
      async () => [],
    )).rejects.toThrow('transform_primary_key_missing: id');
  });

  test('failed rows are retried on next transform run', async () => {
    const repo = tempGitRepo();
    mkdirSync(join(repo, 'source-ingest/vehicles/a-002.md'), { recursive: true });
    writeFileSync(join(repo, 'source-ingest/vehicles/a-002.md/placeholder'), 'untracked directory conflict for transform retry\n');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ($1,$2,$3,'{"federated": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      ['shared', 'shared', repo],
    );
    const transformedProfile: SourceIngestProfile = {
      ...profile,
      profile_id: 'fake-source-transform-retry-v1',
      transform: {
        engine: 'pglite',
        primary_key_field: 'id',
        updated_at_field: 'updated_at',
        sources: [{ alias: 'vehicles', connector: 'fake-source', object: 'vehicle', fields: ['id', 'code', 'name', 'status', 'is_group', 'updated_at'] }],
        sql: `SELECT id, code, name, status, updated_at FROM vehicles WHERE is_group = false ORDER BY code`,
      },
    };
    await putSourceIngestProfile(engine, transformedProfile, { createdBy: 'test', changeNote: 'transform-retry-seed' });

    const first = await runSourceIngestExecutor(engine, { profile_id: transformedProfile.profile_id, run_id: 'run-transform-partial-fail', require_clean_git: false, no_embed: true });
    expect(first.ok).toBe(false);
    expect(first.results.find(r => r.external_id === 'veh-002')?.status).toBe('failed');
    rmSync(join(repo, 'source-ingest/vehicles/a-002.md'), { recursive: true, force: true });

    const second = await runSourceIngestExecutor(engine, { profile_id: transformedProfile.profile_id, run_id: 'run-transform-retry', changed_since: true, require_clean_git: false, no_embed: true });
    expect(second.results.find(r => r.external_id === 'veh-002')?.status).toBe('written');
    const retried = await engine.executeRaw<{ run_id: string; last_result: string }>(
      `SELECT run_id, last_result FROM source_sync_state WHERE profile_id = $1 AND external_id = 'veh-002'`,
      [transformedProfile.profile_id],
    );
    expect(retried[0]).toEqual({ run_id: 'run-transform-retry', last_result: 'success' });
    expect(await engine.getPage('source-ingest/vehicles/a-002', { sourceId: 'shared' })).toBeTruthy();
  }, 30000);

  test('source identity keeps the existing slug when the profile slug template changes', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-stable-slug-1', no_embed: true });
    await putSourceIngestProfile(engine, {
      ...profile,
      target: { ...profile.target, slug_template: 'source-ingest/vehicles-v2/{{ code | slugify }}' },
    }, { createdBy: 'test', changeNote: 'change slug convention' });

    const out = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-stable-slug-2', no_embed: true });
    expect(out.ok).toBe(true);
    expect(await engine.getPage('source-ingest/vehicles/a-001', { sourceId: 'shared' })).toBeTruthy();
    expect(await engine.getPage('source-ingest/vehicles-v2/a-001', { sourceId: 'shared' })).toBeNull();
  }, 30000);

  test('existing manual page requires explicit adoption map and preserves manual content when adopted', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    const slug = 'source-ingest/vehicles/a-001';
    const manual = `---\ntype: equipment\ntitle: Manual A-001\nstatus: curated\naliases:\n  - manual-a001\ncompany_metadata:\n  owner: human\n  tier: gold\n---\n# Manual A-001\n\nHuman-owned context.\n\n<!-- timeline -->\n\n- **2026-07-01** | Human timeline entry.\n`;
    mkdirSync(join(repo, 'source-ingest/vehicles'), { recursive: true });
    writeFileSync(join(repo, `${slug}.md`), manual);
    execFileSync('git', ['add', `${slug}.md`], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'manual equipment page'], { cwd: repo });
    await importFromContent(engine, slug, manual, { sourceId: 'shared', sourcePath: `${slug}.md`, noEmbed: true, remote: false });

    const blocked = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-adoption-blocked', limit: 1, no_embed: true });
    expect(blocked.results.find(r => r.external_id === 'veh-001')).toMatchObject({ status: 'failed' });
    expect(blocked.results.find(r => r.external_id === 'veh-001')?.reason).toContain('requires explicit adoption mapping');

    await putSourceIngestProfile(engine, {
      ...profile,
      identity: { ...profile.identity, existing_slug_map: { 'veh-001': slug }, require_explicit_resolution: true },
    }, { createdBy: 'test', changeNote: 'require complete adoption plan' });
    await expect(runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-adoption-incomplete', no_embed: true }))
      .rejects.toThrow('explicit identity resolution required before source ingest for veh-002');
    expect((await engine.getPage(slug, { sourceId: 'shared' }))?.compiled_truth).not.toContain('source-sync:start');

    await putSourceIngestProfile(engine, {
      ...profile,
      identity: {
        ...profile.identity,
        existing_slug_map: { 'veh-001': slug },
        explicit_create_ids: ['veh-002'],
        require_explicit_resolution: true,
      },
    }, { createdBy: 'test', changeNote: 'approve explicit adoption and create resolutions' });
    const adopted = await runSourceIngestExecutor(engine, { profile_id: profile.profile_id, run_id: 'run-adoption-approved', no_embed: true });
    expect(adopted.results.find(r => r.external_id === 'veh-001')?.status).toBe('written');
    const page = await engine.getPage(slug, { sourceId: 'shared' });
    expect(page?.compiled_truth).toContain('Human-owned context.');
    expect(page?.compiled_truth).toContain('source-sync:start');
    expect(page?.timeline).toContain('Human timeline entry.');
    const persistedMarkdown = readFileSync(join(repo, `${slug}.md`), 'utf8');
    expect(persistedMarkdown).toContain('<!-- timeline -->');
    expect(persistedMarkdown).toContain('Human timeline entry.');
    expect(page?.frontmatter.status).toBe('curated');
    expect(page?.frontmatter.aliases).toEqual(['manual-a001']);
    expect(page?.frontmatter.company_metadata).toEqual({ owner: 'human', tier: 'gold' });
    expect((page?.frontmatter.source_ingest as Record<string, unknown>)?.run_id).toBeUndefined();
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

  test('blocks transform sub-sources that are not fake-source in Stage 3A', async () => {
    const repo = tempGitRepo();
    await seed(repo);
    const badProfile: SourceIngestProfile = {
      ...profile,
      profile_id: 'fake-source-transform-bad',
      transform: {
        engine: 'pglite',
        primary_key_field: 'id',
        sources: [
          { alias: 'vehicles', connector: 'appsheet-vehicles', object: 'vehicle', fields: ['id', 'code'] },
        ],
        sql: 'SELECT id, code FROM vehicles',
      },
    };
    await putSourceIngestProfile(engine, badProfile, { createdBy: 'test', changeNote: 'bad transform connector' });

    await expect(runSourceIngestExecutor(engine, { profile_id: badProfile.profile_id, run_id: 'run-transform-bad', no_embed: true }))
      .rejects.toThrow('source_ingest live connector not enabled: transform source vehicles uses appsheet-vehicles');
  });

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
    await putSourceIngestProfile(engine, {
      ...profile,
      identity: { ...profile.identity, existing_slug_map: { 'veh-001': 'source-ingest/vehicles/a-001' } },
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
    expect(await listDueSourceRefreshes(engine, { profile_id: profile.profile_id, active_only: true })).toEqual([]);
    await engine.executeRaw(`UPDATE source_ingest_profiles SET status = 'active', profile_json = jsonb_set(profile_json, '{status}', '"active"'::jsonb) WHERE profile_id = $1`, [profile.profile_id]);
    expect(await listDueSourceRefreshes(engine, { profile_id: profile.profile_id, active_only: true })).toHaveLength(1);
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
    await engine.executeRaw(`UPDATE source_ingest_profiles SET status = 'active', profile_json = jsonb_set(profile_json, '{status}', '"active"'::jsonb) WHERE profile_id = $1`, [profile.profile_id]);
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
    const summaries = sourceTableSummariesFromConfigs(rows);
    expect(summaries[0]).toMatchObject({
      source_table_id: 'appsheet-vehicles:vehicle',
      connector_id: 'appsheet-vehicles',
      table_name: 'Автотранспорт',
      primary_key_field: null,
      updated_at_field: null,
      enabled: true,
    });
    const secrets = await sourceConnectorSecretStatus(engine, 'appsheet-vehicles');
    expect(secrets.required_keys).toEqual(['app_id', 'access_key']);
    expect(secrets.missing_keys).toEqual(expect.arrayContaining(['app_id', 'access_key']));
  });

  test('scaffold connector secrets advertise required keys without exposing values', async () => {
    await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: undefined }, async () => {
      const repo = tempGitRepo();
      await seed(repo);
      await putSourceConnectorConfig(engine, {
        config_id: 'bigquery:table:dataset.vehicle-costs',
        connector_id: 'bigquery',
        source_object: 'table',
        display_name: 'BigQuery vehicle costs',
        table_name: 'dataset.vehicle_costs',
        enabled: true,
        config_json: { table_name: 'dataset.vehicle_costs', primary_key_field: 'vehicleID', updated_at_field: 'updated_at' },
      }, { actor: 'test' });
      const before = await sourceConnectorSecretStatus(engine, 'bigquery', 'bigquery:table:dataset.vehicle-costs');
      expect(before).toMatchObject({ configured: false, missing_keys: ['service_account_json'] });
      const rotated = await putSourceConnectorSecrets(engine, {
        config_id: 'bigquery:table:dataset.vehicle-costs',
        connector_id: 'bigquery',
        source_object: 'table',
        secret_json: { serviceAccountJson: '{"client_email":"svc@example.com","private_key":"SECRET"}' },
      }, { actor: 'admin:test' });
      expect(rotated.configured).toBe(true);
      expect(JSON.stringify(rotated)).not.toContain('SECRET');
      const secretConfig = await getSourceConnectorSecretConfig(engine, 'bigquery', 'table', 'bigquery:table:dataset.vehicle-costs');
      expect(secretConfig.service_account_json).toContain('svc@example.com');
    });
  });

  test('DB-backed AppSheet secrets rotate encrypted-at-rest, mask, audit, and delete without exposing values in status', async () => {
    await withEnv({ GBRAIN_SOURCE_CONNECTOR_SECRET_KEY: 'test-source-connector-secret-key' }, async () => {
      const repo = tempGitRepo();
      await seed(repo);
      await putSourceConnectorConfig(engine, {
        config_id: 'connector:appsheet-vehicles',
        connector_id: 'appsheet-vehicles',
        source_object: '__connection__',
        display_name: 'AppSheet автотранспорт',
        enabled: true,
        config_json: { connector_level: true, kind: 'appsheet' },
      }, { actor: 'test' });

      const rotated = await putSourceConnectorSecrets(engine, {
        connector_id: 'appsheet-vehicles',
        source_object: 'vehicle',
        secret_json: { app_id: 'app-123456', access_key: 'key-secret-7890' },
      }, { actor: 'admin:test' });
      expect(rotated).toMatchObject({ configured: true, storage: 'db', updated_by: 'admin:test' });
      expect(rotated.masked).toEqual({ app_id: '••••3456', access_key: '••••7890' });
      expect(JSON.stringify(rotated)).not.toContain('key-secret-7890');

      const raw = await engine.executeRaw<{ secret_json: Record<string, unknown> }>(`SELECT secret_json FROM source_connector_secrets WHERE config_id = $1`, ['connector:appsheet-vehicles']);
      expect(raw[0].secret_json.__encrypted).toBe(true);
      expect(JSON.stringify(raw[0].secret_json)).not.toContain('key-secret-7890');
      expect(JSON.stringify(raw[0].secret_json)).not.toContain('app-123456');

      const secretConfig = await getSourceConnectorSecretConfig(engine, 'appsheet-vehicles', 'vehicle');
      expect(secretConfig).toEqual({ app_id: 'app-123456', access_key: 'key-secret-7890' });
      await putSourceConnectorConfig(engine, {
        config_id: 'connector:appsheet-avto',
        connector_id: 'appsheet-avto',
        source_object: '__connection__',
        display_name: 'Авто AppSheet',
        enabled: true,
        config_json: { connector_level: true, kind: 'appsheet' },
      }, { actor: 'test' });
      const customRotated = await putSourceConnectorSecrets(engine, {
        config_id: 'connector:appsheet-avto',
        connector_id: 'appsheet-avto',
        source_object: '__connection__',
        secret_json: { app_id: 'custom-app', access_key: 'custom-key-1234' },
      }, { actor: 'admin:test' });
      expect(customRotated).toMatchObject({ configured: true, storage: 'db' });
      expect(await getSourceConnectorSecretConfig(engine, 'appsheet-avto', '__connection__', 'connector:appsheet-avto'))
        .toEqual({ app_id: 'custom-app', access_key: 'custom-key-1234' });
      expect(JSON.stringify(customRotated)).not.toContain('custom-key-1234');
      expect(await getSourceConnectorSecretConfig(engine, 'appsheet-vehicles', 'vehicle', 'appsheet-vehicles:vehicle:vehicles'))
        .toEqual({ app_id: 'app-123456', access_key: 'key-secret-7890' });
      expect(await sourceConnectorSecretStatus(engine, 'appsheet-vehicles', 'appsheet-vehicles:vehicle:vehicles', 'vehicle'))
        .toMatchObject({ configured: true, storage: 'db' });
      const audit = await listSourceConnectorSecretAudit(engine, 'connector:appsheet-vehicles');
      expect(audit[0]).toMatchObject({ action: 'rotate', actor: 'admin:test', secret_keys: ['access_key', 'app_id'] });
      expect(typeof audit[0].id).toBe('string');
      expect(JSON.stringify(audit)).not.toContain('key-secret-7890');

      const deleted = await deleteSourceConnectorSecrets(engine, { connector_id: 'appsheet-vehicles', source_object: 'vehicle' }, { actor: 'admin:test' });
      expect(deleted.configured).toBe(false);
      expect((await getSourceConnectorSecretConfig(engine, 'appsheet-vehicles', 'vehicle'))).toEqual({});
      const auditAfterDelete = await listSourceConnectorSecretAudit(engine, 'connector:appsheet-vehicles');
      expect(auditAfterDelete[0]).toMatchObject({ action: 'delete', actor: 'admin:test' });
    });
  });

  test('AppSheet connector does not send ColumnNames because some apps return zero rows when projected', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
      return new Response(JSON.stringify([{ ID: 'truck-1', ГосНомер: '111AAA02', Модель: 'Kamaz', ДатаИзменения: '2026-07-01T10:00:00+05:00', related_measurementacts: ['x'] }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const connector = new AppSheetVehicleConnector({ appId: 'app', accessKey: 'secret', tableName: 'Автотранспорт', baseUrl: 'https://203.0.113.10/api/v2/apps', fetchImpl });
    const sample = await connector.sample('vehicle', 5, { fields: ['id', 'code', 'name', 'status'] });
    expect(calls[0].body.Properties.ColumnNames).toBeUndefined();
    expect(sample[0].data).toMatchObject({ id: 'truck-1', code: '111AAA02', name: 'Kamaz' });
    expect(JSON.stringify(calls[0].body)).not.toContain('secret');
  });

  test('AppSheet discovery profiles real source columns, not synthetic canonical names', async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify([
      { VehicleID: 'truck-1', registration_number: '111AAA02', brand: 'Kamaz', created_at: '2026-07-01T10:00:00+05:00' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const connector = new AppSheetVehicleConnector({ connectorId: 'appsheet-avto', appId: 'app', accessKey: 'secret', tableName: 'vehicles', primaryKeyField: 'VehicleID', updatedAtField: 'created_at', baseUrl: 'https://203.0.113.10/api/v2/apps', fetchImpl });
    const profile = await discoverSourceObject(connector, 'vehicles', 5, { primaryKeyField: 'VehicleID', updatedAtField: 'created_at' });
    expect(profile.fields.map(f => f.name)).toEqual(['brand', 'created_at', 'registration_number', 'VehicleID'].sort((a, b) => a.localeCompare(b)));
    expect(profile.fields.map(f => f.name)).not.toContain('code');
    expect(profile.fields.map(f => f.name)).not.toContain('name');
    expect(profile.fields.map(f => f.name)).not.toContain('type');
    expect(profile.idCandidates).toContain('VehicleID');
  });

  test('custom AppSheet connector does not inherit legacy vehicle env credentials', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const previousAppId = process.env.APPSHEET_VEHICLES_APP_ID;
    const previousAccessKey = process.env.APPSHEET_VEHICLES_ACCESS_KEY;
    process.env.APPSHEET_VEHICLES_APP_ID = 'legacy-vehicle-app';
    process.env.APPSHEET_VEHICLES_ACCESS_KEY = 'legacy-vehicle-key';
    try {
      const connector = new AppSheetVehicleConnector({
        connectorId: 'appsheet-protokolist',
        tableName: 'PeriodicMeetingSeries',
        primaryKeyField: 'seriesID',
        baseUrl: 'https://203.0.113.10/api/v2/apps',
        fetchImpl,
      });
      const error = await connector.sample('PeriodicMeetingSeries', 1).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error.message)).toContain('credentials are not configured for connector appsheet-protokolist');
      expect(called).toBe(false);
    } finally {
      if (previousAppId === undefined) delete process.env.APPSHEET_VEHICLES_APP_ID;
      else process.env.APPSHEET_VEHICLES_APP_ID = previousAppId;
      if (previousAccessKey === undefined) delete process.env.APPSHEET_VEHICLES_ACCESS_KEY;
      else process.env.APPSHEET_VEHICLES_ACCESS_KEY = previousAccessKey;
    }
  });

  test('draft AppSheet base view resolves connector-scoped DB secrets and its object as table', async () => {
    await putSourceConnectorConfig(engine, {
      config_id: 'connector:appsheet-protokolist',
      connector_id: 'appsheet-protokolist',
      source_object: '__connection__',
      display_name: 'Protocolist',
      enabled: true,
      config_json: { connector_level: true, kind: 'appsheet' },
    }, { actor: 'test' });
    await putSourceConnectorSecrets(engine, {
      config_id: 'connector:appsheet-protokolist',
      connector_id: 'appsheet-protokolist',
      source_object: '__connection__',
      secret_json: { app_id: 'protocolist-app', access_key: 'protocolist-key' },
    }, { actor: 'test' });

    const config = await connectorConfigForSource({
      engine,
      defaultConnector: 'appsheet-protokolist',
      defaultObject: 'PeriodicMeetingSeries',
    }, 'appsheet-protokolist', 'PeriodicMeetingSeries');

    expect(config).toMatchObject({
      app_id: 'protocolist-app',
      access_key: 'protocolist-key',
      table_name: 'PeriodicMeetingSeries',
    });
  });

  test('AppSheet discovery can profile an arbitrary table before a stable ID is selected but full fetch still fails closed', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify([
      { SeriesKey: 'series-1', MeetingTitle: 'Weekly operations', ModifiedOn: '2026-07-12T10:00:00Z' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const connector = new AppSheetVehicleConnector({
      connectorId: 'appsheet-protokolist',
      appId: 'app',
      accessKey: 'secret',
      tableName: 'PeriodicMeetingSeries',
      baseUrl: 'https://203.0.113.10/api/v2/apps',
      fetchImpl,
    });

    const sample = await connector.sample('PeriodicMeetingSeries', 5);
    expect(sample[0].external_id).toStartWith('discovery-');
    expect(sample[0].source_fields).toMatchObject({ SeriesKey: 'series-1', MeetingTitle: 'Weekly operations' });

    const error = await (async () => {
      for await (const _batch of connector.fetchAll!('PeriodicMeetingSeries')) {
        // no-op
      }
    })().catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toContain('configure primary_key_field before ingest');
  });

  test('AppSheet connector supports arbitrary table configs with explicit primary/update fields', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
      return new Response(JSON.stringify([
        { repairID: 'rep-1', vehicleID: 'veh-001', title: 'Замена масла', updatedAt: '2026-07-02T12:00:00+05:00', amount: 12000 },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const connector = new AppSheetVehicleConnector({
      appId: 'app',
      accessKey: 'secret',
      tableName: 'repairs',
      primaryKeyField: 'repairID',
      updatedAtField: 'updatedAt',
      baseUrl: 'https://203.0.113.10/api/v2/apps',
      fetchImpl,
    });

    const sample = await connector.sample('repairs', 5, { fields: ['repairID', 'vehicleID', 'title', 'amount'] });
    expect(await connector.listObjects()).toEqual([{ name: 'repairs', displayName: 'repairs', supportsChangedSince: true }]);
    expect(connector.id).toBe('appsheet-vehicles');
    expect(sample[0]).toMatchObject({ external_id: 'rep-1', source_updated_at: '2026-07-02T12:00:00+05:00' });
    expect(sample[0].data).toMatchObject({ id: 'rep-1', code: 'rep-1', name: 'Замена масла', type: 'repairs', vehicleID: 'veh-001', amount: 12000 });
    expect(calls[0].url).toContain('/tables/repairs/Action');
    expect(calls[0].body.Properties.ColumnNames).toBeUndefined();
    expect(JSON.stringify(calls[0].body)).not.toContain('secret');
  });

  test('AppSheet connector rejects successful responses with an unexpected JSON shape', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'table not found' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const connector = new AppSheetVehicleConnector({
      connectorId: 'appsheet-protokolist',
      appId: 'app',
      accessKey: 'secret',
      tableName: 'PeriodicMeetingSeries',
      primaryKeyField: 'seriesID',
      baseUrl: 'https://203.0.113.10/api/v2/apps',
      fetchImpl,
    });

    const error = await connector.sample('PeriodicMeetingSeries', 5).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toContain('AppSheet unexpected response shape');
    expect(String(error.message)).not.toContain('secret');
  });

  test('discovery preserves reviewer-selected fields and identity even when sample returns zero rows', () => {
    const profile = profileRecords('appsheet-avto', 'Vehicles', [], undefined, {
      fields: ['vehicleID', 'name', 'status'],
      primaryKeyField: 'vehicleID',
      updatedAtField: 'UpdatedAt',
    });
    expect(profile.sampled).toBe(0);
    expect(profile.fields.map(f => f.name)).toEqual(['name', 'status', 'UpdatedAt', 'vehicleID'].sort((a, b) => a.localeCompare(b)));
    expect(profile.idCandidates).toContain('vehicleID');
    expect(profile.updatedAtCandidates).toContain('UpdatedAt');
    expect(profile.warnings).toContain('sample_returned_no_rows_check_table_name_or_appsheet_filter');
    expect(profile.warnings).not.toContain('no_stable_id_candidate');
  });

  test('AppSheet connector exposes explicit vehicles table under the selected connector id', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
      return new Response(JSON.stringify([{ ID: 'truck-1', ГосНомер: '111AAA02', Модель: 'Kamaz', ДатаИзменения: '2026-07-01T10:00:00+05:00' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const connector = new AppSheetVehicleConnector({ connectorId: 'appsheet-avto', appId: 'app', accessKey: 'secret', tableName: 'vehicles', baseUrl: 'https://203.0.113.10/api/v2/apps', fetchImpl });
    expect(connector.id).toBe('appsheet-avto');
    expect(await connector.listObjects()).toEqual([
      { name: 'vehicles', displayName: 'Автотранспорт AppSheet', supportsChangedSince: true },
      { name: 'vehicle', displayName: 'Автотранспорт AppSheet (legacy alias)', supportsChangedSince: true },
    ]);
    const sample = await connector.sample('vehicles', 5, { fields: ['vehicleID\\nname\\nstatus'] });
    expect(sample[0].external_id).toBe('truck-1');
    expect(calls[0].url).toContain('/tables/vehicles/Action');
    expect(JSON.stringify(calls[0].body)).not.toContain('secret');
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

  test('AppSheet connector validates changed-since timestamp before building Selector', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new AppSheetVehicleConnector({ appId: 'app', accessKey: 'secret', tableName: 'Автотранспорт', baseUrl: 'https://203.0.113.10/api/v2/apps', fetchImpl });

    const err = await (async () => {
      for await (const _batch of connector.fetchChangedSince('vehicle', '2026-07-01T10:00:00Z" OR TRUE')) {
        // no-op
      }
    })().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('invalid AppSheet changed-since timestamp');
    expect(called).toBe(false);
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

  test('AppSheet vehicle connector fails closed when no stable id column exists', () => {
    expect(() => rowToVehicleRecord({ Модель: 'MAN TGS', ДатаИзменения: '2026-06-30T10:00:00+05:00' }))
      .toThrow('AppSheet vehicle row is missing a stable identity column');
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
