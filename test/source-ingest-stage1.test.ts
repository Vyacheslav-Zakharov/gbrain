import { describe, expect, test } from 'bun:test';
import { FakeSourceConnector } from '../src/core/source-ingest/connectors/fake.ts';
import { discoverSourceObject } from '../src/core/source-ingest/discovery.ts';
import { validateSourceIngestProfile } from '../src/core/source-ingest/profile-schema.ts';
import { buildSourceDryRun } from '../src/core/source-ingest/dry-run.ts';
import { mergeManagedBlock, renderManagedBlock } from '../src/core/source-ingest/managed-block.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { profileHash } from '../src/core/source-ingest/store.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const vehicleProfile = {
  profile_id: 'fake-source-vehicle-v1',
  status: 'reviewed',
  source_connector: 'fake-source',
  source_object: 'vehicle',
  target: { gbrain_type: 'equipment', approved_source_id: 'shared', slug_template: 'assets/equipment/{{ code | slugify }}' },
  selection: { exclude: [{ field: 'is_group', op: 'eq', value: true }] },
  identity: { external_id_field: 'id', natural_key_fields: ['code'], display_name_field: 'name' },
  freshness: { policy: 'P30D', on_access: 'acknowledge_when_stale', changed_since_field: 'updated_at' },
  mapping: { frontmatter: { equipment_class: 'vehicle' } },
  links: [
    { id: 'located-at-facility', type: 'located_at', target: { type: 'facility', lookup: 'external_id', value_field: 'location_id' }, when: [{ field: 'location_id', op: 'exists' }] },
  ],
  update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: ['title', 'external_code', 'equipment_class', 'status'] },
  security: { classification: 'shared', pii: true, pii_fields: ['plate', 'responsible_person_id'] },
};

function ctx(): OperationContext {
  const engine = {
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM sources')) return params?.[0] === 'shared' ? [{ id: 'shared' }] : [];
      if (sql.includes('FROM source_sync_state')) return [];
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, config: { engine: 'pglite' }, logger: console, dryRun: false, remote: true, sourceId: 'shared' } as OperationContext;
}

describe('source-ingest Stage 1 contract', () => {
  test('fake connector discovery profiles vehicle fields and folder-node signal', async () => {
    const discovery = await discoverSourceObject(new FakeSourceConnector(), 'vehicle', 10);
    expect(discovery.connectorId).toBe('fake-source');
    expect(discovery.sampled).toBe(3);
    expect(discovery.idCandidates).toContain('id');
    expect(discovery.updatedAtCandidates).toContain('updated_at');
    expect(discovery.fields.map(f => f.name)).toContain('is_group');
  });

  test('profile validator requires frozen approved_source_id for reviewed/active profiles', () => {
    const ok = validateSourceIngestProfile(vehicleProfile);
    expect(ok.ok).toBe(true);
    const bad = validateSourceIngestProfile({ ...vehicleProfile, target: { ...vehicleProfile.target, approved_source_id: undefined } });
    expect(bad.ok).toBe(false);
    expect(bad.issues.map(i => i.code)).toContain('source_id_not_frozen');
  });

  test('profile validator rejects mutable source_sync frontmatter allowlist', () => {
    const bad = validateSourceIngestProfile({
      ...vehicleProfile,
      update_policy: { ...vehicleProfile.update_policy, field_allowlist: ['title', 'source_sync.last_synced_at'] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.issues.map(i => i.code)).toContain('sync_metadata_in_frontmatter');
  });

  test('managed block insert and replace preserve manual sections around block', () => {
    const first = mergeManagedBlock('Manual intro\n', 'fake-source-vehicle-v1', 'fake-source:vehicle:veh-001', 'Generated v1');
    expect(first.action).toBe('inserted');
    expect(first.content).toContain('Manual intro');
    expect(first.content).toContain(renderManagedBlock('fake-source-vehicle-v1', 'fake-source:vehicle:veh-001', 'Generated v1'));
    const second = mergeManagedBlock(first.content, 'fake-source-vehicle-v1', 'fake-source:vehicle:veh-001', 'Generated v2');
    expect(second.action).toBe('replaced');
    expect(second.content).toContain('Manual intro');
    expect(second.content).toContain('Generated v2');
    expect(second.content).not.toContain('Generated v1');
  });

  test('operations are registered with remote-safe read split and local-only dry-run/write gates', () => {
    for (const name of ['source_discover', 'source_profile_draft', 'source_validate_profile', 'source_profile_get', 'source_sync_status']) {
      expect(operationsByName[name]).toBeTruthy();
      expect(operationsByName[name].scope).toBe('read');
      expect(operationsByName[name].localOnly).not.toBe(true);
    }
    expect(operationsByName.source_dry_run).toBeTruthy();
    expect(operationsByName.source_dry_run.scope).toBe('read');
    expect(operationsByName.source_dry_run.localOnly).toBe(true);
    for (const name of ['source_profile_put', 'source_ingest', 'source_refresh', 'source_revert']) {
      expect(operationsByName[name]).toBeTruthy();
      expect(operationsByName[name].scope).toBe('write');
      expect(operationsByName[name].localOnly).toBe(true);
    }
  });

  test('source_dry_run returns rule-level counts, stratified samples, and managed-block previews', async () => {
    const piiPreviewProfile = {
      ...vehicleProfile,
      update_policy: { ...vehicleProfile.update_policy, field_allowlist: [...vehicleProfile.update_policy.field_allowlist, 'plate'] },
    };
    const out = await operationsByName.source_dry_run.handler(ctx(), { profile: piiPreviewProfile, sample_limit: 10 }) as any;
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.counts.sampled).toBe(3);
    expect(out.counts.would_write).toBe(2);
    expect(out.counts.skipped).toBe(1);
    expect(out.link_rules[0].rule_id).toBe('located-at-facility');
    expect(out.link_rules[0].matched).toBe(2);
    expect(out.stratified_samples.would_write.length).toBeGreaterThan(0);
    expect(out.stratified_samples.worst_case.longest_managed_block.external_id).toBeTruthy();
    expect(out.stratified_samples.worst_case.most_null_fields.external_id).toBeTruthy();
    expect(out.sample_pages[0].managed_block_preview).toContain('gbrain-source-sync:start');
    expect(out.sample_pages[0].slug).toBe('assets/equipment/a-001');
    expect(out.sample_pages[0].managed_block_preview).not.toContain('001AAA02');
    expect(out.sample_pages[0].article_markdown_preview).not.toContain('001AAA02');
    expect(out.sample_pages[0].managed_block_preview).toContain('[PII masked]');
    expect(out.sample_pages[0].article_markdown_preview).not.toContain('emp-001');
    expect(out.deferred_checks).toContain('cross_source_edge_resolution_deferred_until_target_resolver_stage');
    expect(out.deferred_checks).toContain('managed_block_before_after_diff_deferred_until_update_path');
    expect(out.warnings).toContain('shared_profile_has_pii_candidates');
  });

  test('source_dry_run counts array-valued multi-assignment targets as distinct edges', () => {
    const profile = {
      ...vehicleProfile,
      links: [{ id: 'holds-position', type: 'holds_position', target: { type: 'position', lookup: 'field_value', value_field: 'position_ids', slug_template: 'positions/{{ value }}' } }],
    };
    const out = buildSourceDryRun(profile as any, [
      { external_id: 'emp-1', data: { code: 'emp-1', position_ids: ['pos-1', 'pos-2', 'pos-1'] } },
      { external_id: 'emp-2', data: { code: 'emp-2', position_ids: [] } },
    ]);
    expect(out.link_rules[0]).toMatchObject({ matched: 1, edge_count: 2, multi_target_records: 1, unresolved_bucket: 1, ambiguous_bucket: 0 });
    expect(out.link_rules[0].sample_edges.map((e: any) => e.target_value)).toEqual(['pos-1', 'pos-2']);
  });

  test('source_dry_run detects slug collisions and surfaces collision worst-case sample', () => {
    const sample = [
      { external_id: 'veh-null-1', data: { id: 'veh-null-1', code: null, name: 'Missing code 1', is_group: false, status: 'active' } },
      { external_id: 'veh-null-2', data: { id: 'veh-null-2', code: undefined, name: 'Missing code 2', is_group: false, status: 'active' } },
    ];
    const out = buildSourceDryRun(vehicleProfile as any, sample);
    expect(out.counts.slug_collisions).toBe(1);
    expect(out.slug_collisions[0].slug).toBe('assets/equipment/item');
    expect(out.slug_collisions[0].external_ids).toEqual(['veh-null-1', 'veh-null-2']);
    expect(out.stratified_samples.worst_case.slug_collision?.slug).toBe('assets/equipment/item');
    expect(out.warnings).toContain('slug_collision_candidates');
  });

  test('source_profile_draft uses discovery heuristics but remains unapproved', async () => {
    const out = await operationsByName.source_profile_draft.handler(ctx(), { connector_id: 'fake-source', source_object: 'vehicle', target_source_id: 'shared', sample_limit: 10 }) as any;
    expect(out.profile.status).toBe('draft');
    expect(out.profile.target.gbrain_type).toBe('equipment');
    expect(out.profile.target.suggested_source_id).toBe('shared');
    expect(out.profile.target.approved_source_id).toBeUndefined();
    expect(out.warnings).toContain('source_id_not_frozen');
  });

  test('source_profile_put is local-only and persists approved profile versions', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const engine = {
      executeRaw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('FROM sources')) return params?.[0] === 'shared' ? [{ id: 'shared' }] : [];
        if (sql.includes('SELECT current_version FROM source_ingest_profiles')) return [];
        return [];
      },
    } as unknown as BrainEngine;
    const localCtx = { engine, config: { engine: 'pglite' }, logger: console, dryRun: false, remote: false, sourceId: 'shared' } as OperationContext;
    const profileToApprove = { ...vehicleProfile, status: 'draft', target: { ...vehicleProfile.target, approved_source_id: undefined } };
    const out = await operationsByName.source_profile_put.handler(localCtx, {
      profile: profileToApprove,
      approve: true,
      approved_source_id: 'shared',
      profile_hash: profileHash(profileToApprove as any),
      approved_by: 'tester',
      change_note: 'approve vehicle profile',
    }) as any;
    expect(out.ok).toBe(true);
    expect(out.saved.version).toBe(1);
    expect(out.profile.status).toBe('reviewed');
    expect(out.profile.target.approved_source_id).toBe('shared');
    expect(calls.some(c => c.sql.includes('INSERT INTO source_ingest_profiles'))).toBe(true);
    expect(calls.some(c => c.sql.includes('INSERT INTO source_ingest_profile_versions'))).toBe(true);
    const profileInsert = calls.find(c => c.sql.includes('INSERT INTO source_ingest_profiles'))!;
    const versionInsert = calls.find(c => c.sql.includes('INSERT INTO source_ingest_profile_versions'))!;
    expect(profileInsert.sql).toContain('$11::jsonb');
    expect(versionInsert.sql).toContain('$6::jsonb');
    expect(typeof profileInsert.params?.[10]).toBe('object');
    expect(typeof versionInsert.params?.[5]).toBe('object');
    expect(profileInsert.params?.[10]).not.toBe(JSON.stringify(profileInsert.params?.[10]));
  });
});
