import { describe, expect, test } from 'bun:test';
import { buildSourceTimelineEntries, changeIntelligenceFetchFields } from '../src/core/source-ingest/change-intelligence.ts';
import type { SourceIngestProfile } from '../src/core/source-ingest/profile-schema.ts';

function profile(): SourceIngestProfile {
  return {
    profile_id: 'zp-employees-test',
    status: 'active',
    source_connector: 'fake-source',
    source_object: 'employees',
    target: { gbrain_type: 'person', approved_source_id: 'internal-hr', slug_template: 'hcm/employees/{{ person_id | slugify }}' },
    identity: { external_id_field: 'person_id', display_name_field: 'full_name', natural_key_fields: ['full_name'] },
    change_intelligence: {
      version: 1,
      enabled: true,
      mode: 'hybrid',
      snapshot_strategy: 'full_record',
      effective_at_field: 'updated_at',
      current_state_fields: ['status', 'position_id'],
      timeline_fields: ['status', 'position_id', 'hire_date', 'fire_date'],
      baseline_timeline_fields: ['hire_date', 'fire_date'],
      relationship_rules: [],
      related_pages: { policy: 'graph_projection' },
      agent: { enabled: false, semantic_fields: [], confidence_threshold: 0.9, allowed_actions: [] },
      approval: { deterministic: 'auto', agent: 'review', cascade: 'review' },
    },
    update_policy: { mode: 'managed_block', preserve_manual_sections: true },
    security: { classification: 'internal', pii: true },
    review: {},
  };
}

describe('source-ingest Change Intelligence', () => {
  test('projects every field required for deterministic diffs', () => {
    expect(changeIntelligenceFetchFields(profile())).toEqual([
      'status', 'position_id', 'hire_date', 'fire_date', 'updated_at',
    ]);
  });

  test('creates meaningful dated baseline events only for configured non-empty fields', () => {
    const entries = buildSourceTimelineEntries({
      profile: profile(),
      record: {
        external_id: 'person-1',
        source_updated_at: '2026-07-22T10:00:00Z',
        data: { person_id: 'person-1', full_name: 'Alice Example', status: 'работает', hire_date: '2024-03-05', fire_date: null, updated_at: '2026-07-22T10:00:00Z' },
      },
      slug: 'hcm/employees/person-1',
      sourceId: 'internal-hr',
      previousSnapshot: null,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.date).toBe('2024-03-05');
    expect(entries[0]?.summary).toBe('Принят(а) на работу');
  });

  test('uses deterministic ids for later field changes', () => {
    const args = {
      profile: profile(),
      record: {
        external_id: 'person-1',
        source_updated_at: '2026-07-22T10:00:00Z',
        data: { person_id: 'person-1', full_name: 'Alice Example', status: 'уволен', position_id: 'p2', updated_at: '2026-07-22T10:00:00Z' },
      },
      slug: 'hcm/employees/person-1',
      sourceId: 'internal-hr',
      previousSnapshot: { person_id: 'person-1', full_name: 'Alice Example', status: 'работает', position_id: 'p1', updated_at: '2026-07-21T10:00:00Z' },
    };
    const first = buildSourceTimelineEntries(args);
    const second = buildSourceTimelineEntries(args);
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    expect(first.map(entry => entry.source)).toEqual(second.map(entry => entry.source));
  });
});
