import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  compileSourceArticleView,
  listSourceArticleViews,
  sourceIngestTree,
  upsertSourceArticleView,
  upsertSourceBaseView,
  upsertSourceConnectorView,
  upsertSourceTransformView,
} from '../src/core/source-ingest/catalog.ts';
import { profileHash } from '../src/core/source-ingest/store.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('shared', 'shared', '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`);
});

describe('source-ingest Phase 0 catalog model', () => {
  test('registers catalog operations with read/admin/write trust split', () => {
    for (const name of ['source_ingest_tree', 'source_connector_list', 'source_base_view_list', 'source_transform_view_list', 'source_article_view_list']) {
      expect(operationsByName[name]).toBeTruthy();
      expect(operationsByName[name].scope).toBe('read');
    }
    for (const name of ['source_connector_upsert', 'source_base_view_upsert', 'source_transform_view_upsert', 'source_article_view_upsert']) {
      expect(operationsByName[name]).toBeTruthy();
      expect(operationsByName[name].scope).toBe('admin');
    }
    for (const name of ['source_article_view_approve', 'source_article_view_run']) {
      expect(operationsByName[name]).toBeTruthy();
      expect(operationsByName[name].localOnly).toBe(true);
      expect(operationsByName[name].scope).toBe('write');
    }
  });

  test('compiles an article view into a frozen SourceIngestProfile snapshot', async () => {
    await upsertSourceConnectorView(engine, { connector_id: 'fake-source', kind: 'fake', display_name: 'Fake Source', config_json: { capability: 'sample' } });
    await upsertSourceBaseView(engine, {
      base_view_id: 'bv-vehicles',
      connector_id: 'fake-source',
      object_name: 'vehicle',
      selected_fields: ['id', 'code', 'name', 'is_group', 'updated_at'],
      row_filter: [{ field: 'is_group', op: 'eq', value: false }],
      sample_limit: 10,
    });
    await upsertSourceArticleView(engine, {
      article_view_id: 'av-equipment',
      input: { kind: 'base_view', id: 'bv-vehicles' },
      gbrain_type: 'equipment',
      target_source_id: 'shared',
      slug_template: 'source-ingest/vehicles/{{ code | slugify }}',
      identity: { external_id_field: 'id', display_name_field: 'name', natural_key_fields: ['code'] },
      article_template: { sections: { title: '{{ name }}', summary: '{{ code }}' } },
      update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: ['code', 'name'] },
      security: { classification: 'shared', pii: false },
      status: 'draft',
    });

    const compiled = await compileSourceArticleView(engine, 'av-equipment', { approvedBy: 'tester' });
    expect(compiled.compiled_profile).toMatchObject({
      profile_id: 'av-equipment',
      status: 'reviewed',
      source_connector: 'fake-source',
      source_object: 'vehicle',
      target: { approved_source_id: 'shared', gbrain_type: 'equipment' },
    });
    expect(compiled.compiled_profile.selection?.include?.[0]).toMatchObject({ field: 'is_group', op: 'eq', value: false });
    expect(compiled.version_hash).toBe(profileHash(compiled.compiled_profile));

    const [row] = await listSourceArticleViews(engine, 'av-equipment');
    expect(row.stale).toBe(false);
    expect(row.stale_reasons).toEqual([]);
    expect(row.compiled_profile?.profile_id).toBe('av-equipment');
  });

  test('upstream edits mark dependent article views stale while keeping compiled snapshot unchanged', async () => {
    await upsertSourceConnectorView(engine, { connector_id: 'fake-source', kind: 'fake', display_name: 'Fake Source' });
    await upsertSourceBaseView(engine, { base_view_id: 'bv-vehicles', connector_id: 'fake-source', object_name: 'vehicle', selected_fields: ['id', 'code'], row_filter: [], sample_limit: 10 });
    await upsertSourceTransformView(engine, {
      transform_view_id: 'tv-vehicles-clean',
      inputs: [{ alias: 'main', base_view_id: 'bv-vehicles' }],
      sql: 'SELECT id, code FROM main',
      primary_key_field: 'id',
    });
    await upsertSourceArticleView(engine, {
      article_view_id: 'av-equipment',
      input: { kind: 'transform_view', id: 'tv-vehicles-clean' },
      gbrain_type: 'equipment',
      target_source_id: 'shared',
      slug_template: 'source-ingest/vehicles/{{ code | slugify }}',
      identity: { external_id_field: 'id', display_name_field: 'code' },
      update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: ['code'] },
      security: { classification: 'shared', pii: false },
      status: 'reviewed',
    });
    const compiled = await compileSourceArticleView(engine, 'av-equipment');

    await upsertSourceBaseView(engine, { base_view_id: 'bv-vehicles', connector_id: 'fake-source', object_name: 'vehicle', selected_fields: ['id', 'code', 'name'], row_filter: [], sample_limit: 10 });
    const [stale] = await listSourceArticleViews(engine, 'av-equipment');
    expect(stale.stale).toBe(true);
    expect(stale.stale_reasons).toContain('base_view_changed');
    expect(stale.compiled_profile).toEqual(compiled.compiled_profile);

    const tree = await sourceIngestTree(engine);
    expect(tree.article_views[0].stale).toBe(true);
  });
});
