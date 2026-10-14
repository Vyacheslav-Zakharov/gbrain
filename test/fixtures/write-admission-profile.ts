import type { SourceIngestProfile } from '../../src/core/source-ingest/profile-schema.ts';
export const admissionProfile: SourceIngestProfile = {
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
