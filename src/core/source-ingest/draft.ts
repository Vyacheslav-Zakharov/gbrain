import type { DiscoveryProfile } from './connectors/types.ts';
import type { SourceIngestProfile } from './profile-schema.ts';
import { defaultEquipmentArticleTemplate } from './template-renderer.ts';

function safeKebab(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export interface DraftSourceIngestProfileOptions {
  connectorId: string;
  sourceObject: string;
  discovery: DiscoveryProfile;
  targetSourceId?: string | null;
  selectedFields?: string[];
  primaryKeyField?: string;
  updatedAtField?: string;
}

function filterDiscovery(discovery: DiscoveryProfile, selectedFields?: string[]): DiscoveryProfile {
  if (!selectedFields || selectedFields.length === 0) return discovery;
  const selected = new Set(selectedFields);
  return {
    ...discovery,
    fields: discovery.fields.filter(f => selected.has(f.name)),
    idCandidates: discovery.idCandidates.filter(f => selected.has(f)),
    updatedAtCandidates: discovery.updatedAtCandidates.filter(f => selected.has(f)),
  };
}

export function draftSourceIngestProfile(opts: DraftSourceIngestProfileOptions): { profile: SourceIngestProfile & { target: SourceIngestProfile['target'] & { suggested_source_id?: string | null } }; warnings: string[] } {
  const { connectorId, sourceObject, targetSourceId } = opts;
  const discovery = filterDiscovery(opts.discovery, opts.selectedFields);
  const idField = opts.primaryKeyField || (discovery.idCandidates.includes('id') ? 'id' : (discovery.idCandidates[0] || 'id'));
  const updatedAt = opts.updatedAtField || discovery.updatedAtCandidates[0];
  const isVehicle = sourceObject === 'vehicle';
  const hasName = discovery.fields.some(f => f.name === 'name');
  const piiFields = discovery.fields.filter(f => /iin|phone|email|responsible|person/i.test(f.name)).map(f => f.name);
  const warnings = ['draft_only_not_approved', 'source_id_not_frozen'];
  if (!updatedAt) warnings.push('no_changed_since_field');
  if (targetSourceId === 'shared' && piiFields.length > 0) warnings.push('shared_target_contains_sensitive_field_candidates');

  return {
    warnings,
    profile: {
      profile_id: `${safeKebab(connectorId)}-${safeKebab(sourceObject)}-v1`,
      status: 'draft',
      source_connector: connectorId,
      source_object: sourceObject,
      target: {
        gbrain_type: isVehicle ? 'equipment' : sourceObject,
        suggested_source_id: targetSourceId || null,
        slug_template: isVehicle ? 'assets/equipment/{{ code | slugify }}' : `${safeKebab(sourceObject)}/{{ ${idField} | slugify }}`,
      },
      selection: isVehicle ? {
        exclude: [
          { field: 'is_group', op: 'eq', value: true },
          { field: 'node_type', op: 'in', value: ['folder', 'category', 'location_node'] },
        ],
      } : {},
      identity: {
        external_id_field: idField,
        natural_key_fields: discovery.idCandidates.includes('code') ? ['code'] : [],
        display_name_field: hasName ? 'name' : idField,
      },
      freshness: {
        policy: isVehicle ? 'P30D' : 'P7D',
        on_access: 'acknowledge_when_stale',
        ...(updatedAt ? { changed_since_field: updatedAt } : {}),
      },
      mapping: { frontmatter: isVehicle ? { equipment_class: 'vehicle' } : {}, ...(isVehicle ? { article_template: defaultEquipmentArticleTemplate(discovery.fields.map(f => f.name)), source_fields: discovery.fields.map(f => f.name) } : {}) },
      links: isVehicle ? [
        { id: 'part-of-parent-equipment', type: 'part_of', target: { type: 'equipment', lookup: 'external_id', value_field: 'parent_id' }, when: [{ field: 'parent_id', op: 'exists' }], confidence: 0.7 },
        { id: 'located-at-facility', type: 'located_at', target: { type: 'facility', lookup: 'external_id', value_field: 'location_id' }, when: [{ field: 'location_id', op: 'exists' }], confidence: 0.7 },
      ] : [],
      update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: discovery.fields.map(f => f.name) },
      security: { classification: targetSourceId === 'shared' ? 'shared' : 'internal', pii: isVehicle && discovery.fields.some(f => /responsible|person|plate/i.test(f.name)), pii_fields: piiFields },
      review: { drafted_by: 'agent', approved_by: null, approved_at: null },
    },
  };
}
