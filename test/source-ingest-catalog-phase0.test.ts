import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  compileSourceArticleView,
  baseViewHash,
  listSourceArticleViews,
  listSourceBaseViews,
  listSourceTransformViews,
  sourceIngestTree,
  upsertSourceArticleView,
  upsertSourceBaseView,
  upsertSourceConnectorView,
  upsertSourceTransformView,
} from '../src/core/source-ingest/catalog.ts';
import { profileHash } from '../src/core/source-ingest/store.ts';
import { getSourceConnector } from '../src/core/source-ingest/connectors/fake.ts';
import {
  connectorSecretConfigId,
  getSourceConnectorSecretConfig,
  listSourceConnectorSecretAudit,
  putSourceConnectorConfig,
  putSourceConnectorSecrets,
  sourceConnectorSecretStatus,
} from '../src/core/source-ingest/connector-config.ts';
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
    for (const name of ['source_ingest_tree', 'source_connector_list', 'source_base_view_list', 'source_base_view_execute', 'source_transform_view_list', 'source_transform_view_execute', 'source_article_view_list', 'source_article_view_dry_run']) {
      expect(operationsByName[name]).toBeTruthy();
      expect(operationsByName[name].scope).toBe('read');
    }
    for (const name of ['source_connector_upsert', 'source_connector_delete', 'source_catalog_delete_impact', 'source_base_view_upsert', 'source_base_view_delete', 'source_transform_view_upsert', 'source_transform_view_delete', 'source_article_view_upsert', 'source_article_view_delete']) {
      expect(operationsByName[name]).toBeTruthy();
      expect(operationsByName[name].scope).toBe('admin');
    }
    for (const name of ['source_base_view_execute', 'source_transform_view_execute', 'source_article_view_dry_run']) {
      expect(operationsByName[name].localOnly).toBe(true);
    }
    for (const name of ['source_article_view_approve', 'source_article_view_run']) {
      expect(operationsByName[name]).toBeTruthy();
      expect(operationsByName[name].localOnly).toBe(true);
      expect(operationsByName[name].scope).toBe('write');
    }
  });

  test('first-class AppSheet connector ids resolve to the generic AppSheet runtime connector', async () => {
    const connector = getSourceConnector('appsheet-protokolist', { table_name: 'Автотранспорт' });
    expect(connector).toBeTruthy();
    const objects = await connector!.listObjects();
    expect(objects.map(o => o.name)).toContain('vehicle');
  });

  test('connector credentials use connector-scope first and legacy object-scope fallback', async () => {
    const connectorId = 'appsheet-avto';
    const canonical = connectorSecretConfigId(connectorId);
    const legacy = `${connectorId}:vehicle`;
    await putSourceConnectorConfig(engine, { config_id: canonical, connector_id: connectorId, source_object: '__connection__', display_name: 'AppSheet Avto', enabled: true });
    await putSourceConnectorConfig(engine, { config_id: legacy, connector_id: connectorId, source_object: 'vehicle', display_name: 'Legacy vehicle scope', enabled: true });

    await putSourceConnectorSecrets(engine, { config_id: legacy, connector_id: connectorId, source_object: 'vehicle', secret_json: { app_id: 'legacy-app', access_key: 'legacy-key' } }, { actor: 'test-legacy' });
    expect(await getSourceConnectorSecretConfig(engine, connectorId, 'vehicle', canonical)).toMatchObject({ app_id: 'legacy-app', access_key: 'legacy-key' });

    await putSourceConnectorSecrets(engine, { config_id: canonical, connector_id: connectorId, source_object: '__connection__', secret_json: { app_id: 'canonical-app', access_key: 'canonical-key' } }, { actor: 'test-canonical' });
    expect(await getSourceConnectorSecretConfig(engine, connectorId, 'vehicle', canonical)).toMatchObject({ app_id: 'canonical-app', access_key: 'canonical-key' });

    const status = await sourceConnectorSecretStatus(engine, connectorId, canonical, 'vehicle');
    expect(status.config_id).toBe(canonical);
    expect(status.resolved_config_id).toBe(canonical);
    expect(status.legacy_config_id).toBe(legacy);
    expect(status.checked_config_ids).toContain(legacy);
    expect(status.configured).toBe(true);

    const audit = await listSourceConnectorSecretAudit(engine, canonical, 10);
    expect(audit.map(row => row.config_id)).toEqual(expect.arrayContaining([canonical, legacy]));
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
      change_intelligence: {
        version: 1,
        enabled: true,
        mode: 'hybrid',
        snapshot_strategy: 'full_record',
        effective_at_field: 'updated_at',
        current_state_fields: ['name'],
        timeline_fields: ['name'],
        relationship_rules: [],
        related_pages: { policy: 'graph_projection' },
        agent: { enabled: false, semantic_fields: [], confidence_threshold: 0.85, allowed_actions: ['summary_proposal', 'timeline_proposal', 'related_page_proposal'] },
        approval: { deterministic: 'auto', agent: 'review', cascade: 'review' },
      },
      update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: ['code', 'name'] },
      security: { classification: 'shared', pii: false },
      status: 'draft',
    });

    const [savedDraft] = await listSourceArticleViews(engine, 'av-equipment');
    await upsertSourceArticleView(engine, savedDraft.article_json as any);
    await upsertSourceArticleView(engine, savedDraft.article_json as any);
    const [resavedDraft] = await listSourceArticleViews(engine, 'av-equipment');
    expect(resavedDraft.stale_reasons.filter(reason => reason === 'article_view_changed')).toHaveLength(1);

    const compiled = await compileSourceArticleView(engine, 'av-equipment', { approvedBy: 'tester' });
    expect(compiled.compiled_profile).toMatchObject({
      profile_id: 'av-equipment',
      status: 'reviewed',
      source_connector: 'fake-source',
      source_object: 'vehicle',
      target: { approved_source_id: 'shared', gbrain_type: 'equipment' },
    });
    expect(compiled.compiled_profile.selection?.include?.[0]).toMatchObject({ field: 'is_group', op: 'eq', value: false });
    expect(compiled.compiled_profile.change_intelligence).toMatchObject({
      version: 1,
      enabled: true,
      mode: 'hybrid',
      current_state_fields: ['name'],
      timeline_fields: ['name'],
      approval: { deterministic: 'auto', agent: 'review', cascade: 'review' },
    });
    expect(compiled.version_hash).toBe(profileHash(compiled.compiled_profile));

    const [row] = await listSourceArticleViews(engine, 'av-equipment');
    expect(row.stale).toBe(false);
    expect(row.stale_reasons).toEqual([]);
    expect(row.compiled_profile?.profile_id).toBe('av-equipment');
  });

  test('base and transform execute ops run samples and update preview metadata', async () => {
    await upsertSourceConnectorView(engine, { connector_id: 'fake-source', kind: 'fake', display_name: 'Fake Source' });
    await upsertSourceBaseView(engine, {
      base_view_id: 'bv-vehicles',
      connector_id: 'fake-source',
      object_name: 'vehicle',
      selected_fields: ['id', 'code', 'name', 'is_group', 'updated_at'],
      row_filter: [{ field: 'is_group', op: 'eq', value: false }],
      sample_limit: 10,
      primary_key_field: 'id',
      updated_at_field: 'updated_at',
      discovery_json: { primary_key_field: 'legacy-wrong-id', updated_at_field: 'legacy_wrong_timestamp' },
    });
    const initialHash = baseViewHash({
      base_view_id: 'bv-vehicles', connector_id: 'fake-source', object_name: 'vehicle',
      selected_fields: ['id', 'code', 'name', 'is_group', 'updated_at'],
      row_filter: [{ field: 'is_group', op: 'eq', value: false }], sample_limit: 10,
      primary_key_field: 'id', updated_at_field: 'updated_at',
    });
    expect(initialHash).not.toBe(baseViewHash({
      base_view_id: 'bv-vehicles', connector_id: 'fake-source', object_name: 'vehicle',
      selected_fields: ['id', 'code', 'name', 'is_group', 'updated_at'],
      row_filter: [{ field: 'is_group', op: 'eq', value: false }], sample_limit: 10,
      primary_key_field: 'other_id', updated_at_field: 'updated_at',
    }));
    const ctx = { engine, config: {}, logger: console, sourceId: 'default', remote: false, dryRun: true } as any;

    const baseOut = await operationsByName.source_base_view_execute.handler(ctx, { base_view_id: 'bv-vehicles', sample_limit: 10, discover_all_fields: true }) as any;
    expect(baseOut.ok).toBe(true);
    expect(baseOut.filtered).toBe(2);
    expect(baseOut.discovery.sampled).toBe(2);
    expect(baseOut.discovery.fields.some((field: any) => field.name === 'plate')).toBe(true);
    const [baseAfter] = await listSourceBaseViews(engine, 'bv-vehicles') as any[];
    expect(baseAfter.last_discovered_at).toBeTruthy();
    expect(baseAfter.primary_key_field).toBe('id');
    expect(baseAfter.updated_at_field).toBe('updated_at');
    expect(baseAfter.discovery_json?.primary_key_field).toBeUndefined();
    expect(baseAfter.discovery_json?.samples).toBeUndefined();
    expect(baseAfter.discovery_json?.fields.some((field: any) => field.name === 'plate')).toBe(false);

    // Legacy callers that omit the new first-class fields preserve reviewer choices.
    await upsertSourceBaseView(engine, {
      base_view_id: 'bv-vehicles', connector_id: 'fake-source', object_name: 'vehicle',
      selected_fields: ['id', 'code', 'name', 'is_group', 'updated_at'],
      row_filter: [{ field: 'is_group', op: 'eq', value: false }], sample_limit: 10,
    });
    const [baseAfterLegacySave] = await listSourceBaseViews(engine, 'bv-vehicles') as any[];
    expect(baseAfterLegacySave.primary_key_field).toBe('id');
    expect(baseAfterLegacySave.updated_at_field).toBe('updated_at');

    await upsertSourceTransformView(engine, {
      transform_view_id: 'tv-vehicles-clean',
      inputs: [{ alias: 'main', base_view_id: 'bv-vehicles' }],
      sql: 'SELECT id, code, name FROM main WHERE is_group = false',
      primary_key_field: 'id',
    });
    const transformOut = await operationsByName.source_transform_view_execute.handler(ctx, { transform_view_id: 'tv-vehicles-clean', sample_limit: 10 }) as any;
    expect(transformOut.ok).toBe(true);
    expect(transformOut.row_count).toBe(2);
    expect(transformOut.rows[0]).toHaveProperty('code');
    const [transformAfter] = await listSourceTransformViews(engine, 'tv-vehicles-clean') as any[];
    expect(transformAfter.last_preview_ok).toBe(true);
    expect(transformAfter.last_preview_at).toBeTruthy();

    await expect(operationsByName.source_base_view_execute.handler({ ...ctx, remote: true }, { base_view_id: 'bv-vehicles' })).rejects.toThrow('local/trusted only');
    await expect(operationsByName.source_transform_view_execute.handler({ ...ctx, remote: true }, { transform_view_id: 'tv-vehicles-clean' })).rejects.toThrow('local/trusted only');
  });

  test('delete guards require dependency impact confirmation before destructive catalog deletes', async () => {
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
      status: 'draft',
    });
    const ctx = { engine, config: {}, logger: console, sourceId: 'default', remote: false, dryRun: false } as any;

    const impact = await operationsByName.source_catalog_delete_impact.handler(ctx, { kind: 'base_view', id: 'bv-vehicles' }) as any;
    expect(impact.ok).toBe(true);
    expect(impact.impact.blocking).toBe(true);
    expect(impact.impact.dependencies.transform_views.length).toBe(1);
    expect(impact.impact.dependencies.article_views.length).toBe(1);
    expect(impact.impact.confirm_token).toBeTruthy();

    await expect(operationsByName.source_base_view_delete.handler(ctx, { base_view_id: 'bv-vehicles' })).rejects.toThrow('delete_blocked');
    await expect(operationsByName.source_base_view_delete.handler(ctx, { base_view_id: 'bv-vehicles', force: true, confirm_token: 'wrong' })).rejects.toThrow('delete_blocked');

    const deleted = await operationsByName.source_base_view_delete.handler(ctx, { base_view_id: 'bv-vehicles', force: true, confirm_token: impact.impact.confirm_token }) as any;
    expect(deleted.ok).toBe(true);
    expect(deleted.deleted).toBe(true);
    expect((await listSourceBaseViews(engine, 'bv-vehicles')).length).toBe(0);

    const articleDeleted = await operationsByName.source_article_view_delete.handler(ctx, { article_view_id: 'av-equipment' }) as any;
    expect(articleDeleted.ok).toBe(true);
    expect(articleDeleted.deleted).toBe(true);
    await operationsByName.source_transform_view_delete.handler(ctx, { transform_view_id: 'tv-vehicles-clean' });
    const connectorDeleted = await operationsByName.source_connector_delete.handler(ctx, { connector_id: 'fake-source' }) as any;
    expect(connectorDeleted.deleted).toBe(true);

    await expect(operationsByName.source_catalog_delete_impact.handler({ ...ctx, remote: true }, { kind: 'connector', id: 'fake-source' })).rejects.toThrow('local/trusted only');
  });

  test('article view dry-run returns chain hash without freezing and approve rejects stale hash', async () => {
    await upsertSourceConnectorView(engine, { connector_id: 'fake-source', kind: 'fake', display_name: 'Fake Source' });
    await upsertSourceBaseView(engine, {
      base_view_id: 'bv-vehicles',
      connector_id: 'fake-source',
      object_name: 'vehicle',
      selected_fields: ['id', 'code', 'name', 'is_group', 'updated_at'],
      row_filter: [{ field: 'is_group', op: 'eq', value: false }],
      sample_limit: 5,
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

    const ctx = { engine, config: {}, logger: console, sourceId: 'default', remote: false, dryRun: true } as any;
    const preview = await operationsByName.source_article_view_dry_run.handler(ctx, { article_view_id: 'av-equipment', sample_limit: 3 }) as any;
    expect(preview.ok).toBe(true);
    expect(preview.current_chain_hash).toBeTruthy();
    expect(preview.dry_run.counts.sampled).toBeGreaterThan(0);

    const [beforeApprove] = await listSourceArticleViews(engine, 'av-equipment');
    expect(beforeApprove.compiled_profile).toBeNull();
    expect(beforeApprove.current_chain_hash).toBeNull();

    await expect(operationsByName.source_article_view_approve.handler(ctx, {
      article_view_id: 'av-equipment',
      current_chain_hash: 'definitely-not-current',
    })).rejects.toThrow('chain_hash_mismatch');

    const approved = await operationsByName.source_article_view_approve.handler(ctx, {
      article_view_id: 'av-equipment',
      current_chain_hash: preview.current_chain_hash,
    }) as any;
    expect(approved.ok).toBe(true);
    expect(approved.compiled.current_chain_hash).toBe(preview.current_chain_hash);
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
