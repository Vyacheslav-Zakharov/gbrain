import type { SourceRecord } from './connectors/types.ts';
import type { SourceFilterRule, SourceIngestProfile, SourceLinkRule } from './profile-schema.ts';
import { renderManagedBlock } from './managed-block.ts';
import { renderArticleTemplate } from './template-renderer.ts';

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = v;
  }
  return out;
}

function valueAt(data: Record<string, unknown>, path: string): unknown {
  return flatten(data)[path];
}

function slugify(v: unknown): string {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '') || 'item';
}

export function renderSlugTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/{{\s*([A-Za-z_][A-Za-z0-9_.]*)(?:\s*\|\s*slugify)?\s*}}/g, (_m, field) => slugify(valueAt(data, field)));
}

function filterMatches(rule: SourceFilterRule, data: Record<string, unknown>): boolean {
  const v = valueAt(data, rule.field);
  switch (rule.op) {
    case 'exists': return v !== undefined && v !== null && v !== '';
    case 'not_exists': return v === undefined || v === null || v === '';
    case 'eq': return v === rule.value;
    case 'neq': return v !== rule.value;
    case 'in': return Array.isArray(rule.value) && rule.value.includes(v);
    case 'not_in': return Array.isArray(rule.value) && !rule.value.includes(v);
    case 'lte': return Number(v) <= Number(rule.value);
    case 'gte': return Number(v) >= Number(rule.value);
    case 'lt': return Number(v) < Number(rule.value);
    case 'gt': return Number(v) > Number(rule.value);
    default: return false;
  }
}

function includeRecord(profile: SourceIngestProfile, record: SourceRecord): { include: boolean; reason?: string } {
  const includes = profile.selection?.include || [];
  const excludes = profile.selection?.exclude || [];
  if (includes.length > 0 && !includes.every(r => filterMatches(r, record.data))) return { include: false, reason: 'include_filter_not_matched' };
  const exclude = excludes.find(r => filterMatches(r, record.data));
  if (exclude) return { include: false, reason: `exclude_filter:${exclude.field}:${exclude.op}` };
  return { include: true };
}

function ruleApplies(rule: SourceLinkRule, record: SourceRecord): boolean {
  return (rule.when || []).every(r => filterMatches(r, record.data));
}

function managedBody(profile: SourceIngestProfile, record: SourceRecord): string {
  const title = String(valueAt(record.data, profile.identity.display_name_field) ?? record.external_id);
  const lines = [`## Source data`, ``, `- Name: ${title}`, `- External ID: ${record.external_id}`];
  for (const field of profile.update_policy.field_allowlist || []) {
    const v = valueAt(record.data, field);
    if (v !== undefined && v !== null && v !== '') lines.push(`- ${field}: ${String(v)}`);
  }
  return lines.join('\n');
}

function samplePage(profile: SourceIngestProfile, record: SourceRecord) {
  const slug = renderSlugTemplate(profile.target.slug_template, record.data);
  const externalRef = `${profile.source_connector}:${profile.source_object}:${record.external_id}`;
  const article = renderArticleTemplate(profile, record);
  const block = renderManagedBlock(profile.profile_id, externalRef, managedBody(profile, record));
  return {
    external_id: record.external_id,
    slug,
    title: article.title,
    source_ingest: { profile_id: profile.profile_id, external_ref: externalRef },
    managed_block_preview: block,
    managed_block_length: block.length,
    article_markdown_preview: article.body,
    article_empty_slots: article.emptySlots,
    article_rendered_fields: article.renderedFields,
    null_field_count: Object.values(flatten(record.data)).filter(v => v === null || v === undefined || v === '').length + article.emptySlots.length,
    frontmatter_preview: {
      ...article.frontmatter,
      source_ingest: { profile_id: profile.profile_id, external_ref: externalRef },
    },
  };
}

function summarizeLinkRule(rule: SourceLinkRule, records: SourceRecord[]) {
  const values = new Map<string, number>();
  const unresolved: string[] = [];
  const sampleEdges: Array<{ from_external_id: string; target_value: string }> = [];
  const applies = records.filter(r => ruleApplies(rule, r));
  for (const r of applies) {
    const field = rule.target.value_field;
    const raw = field ? valueAt(r.data, field) : undefined;
    if (raw === undefined || raw === null || raw === '') {
      unresolved.push(r.external_id);
      continue;
    }
    const value = String(raw);
    values.set(value, (values.get(value) || 0) + 1);
    if (sampleEdges.length < 5) sampleEdges.push({ from_external_id: r.external_id, target_value: value });
  }
  const ambiguousTargets = Array.from(values.entries()).filter(([, count]) => count > 1).map(([target_value, count]) => ({ target_value, count }));
  return {
    rule_id: rule.id,
    type: rule.type,
    target_type: rule.target.type,
    matched: applies.length - unresolved.length,
    total: records.length,
    applies_to: applies.length,
    unresolved_bucket: unresolved.length,
    ambiguous_bucket: ambiguousTargets.length,
    low_confidence_bucket: (rule.confidence ?? 1) < 0.75 ? applies.length : 0,
    unresolved_sample: unresolved.slice(0, 5),
    ambiguous_targets: ambiguousTargets.slice(0, 5),
    sample_edges: sampleEdges,
    warnings: [
      ...((rule.confidence ?? 1) < 0.75 ? ['low_confidence_rule'] : []),
      ...(ambiguousTargets.length > 0 ? ['ambiguous_target_values_in_sample'] : []),
    ],
  };
}

function detectSlugCollisions(pages: ReturnType<typeof samplePage>[]) {
  const bySlug = new Map<string, string[]>();
  for (const p of pages) {
    const existing = bySlug.get(p.slug) || [];
    existing.push(p.external_id);
    bySlug.set(p.slug, existing);
  }
  return Array.from(bySlug.entries())
    .filter(([, external_ids]) => external_ids.length > 1)
    .map(([slug, external_ids]) => ({ slug, external_ids, count: external_ids.length }));
}

function pickStratifiedSamples(
  pages: ReturnType<typeof samplePage>[],
  skipped: Array<{ external_id: string; reason: string }>,
  linkRules: ReturnType<typeof summarizeLinkRule>[],
  slugCollisions: ReturnType<typeof detectSlugCollisions>,
) {
  const longest = [...pages].sort((a, b) => b.managed_block_length - a.managed_block_length)[0] || null;
  const mostNull = [...pages].sort((a, b) => b.null_field_count - a.null_field_count)[0] || null;
  const collision = slugCollisions[0]
    ? pages.find(p => slugCollisions[0].external_ids.includes(p.external_id)) || null
    : null;
  const ambiguousLink = linkRules.find(r => r.ambiguous_bucket > 0) || null;
  const lowConfidenceLink = linkRules.find(r => r.low_confidence_bucket > 0) || null;
  return {
    would_write: pages.slice(0, 3),
    worst_case: {
      longest_managed_block: longest,
      most_null_fields: mostNull,
      slug_collision: collision,
      ambiguous_link_rule: ambiguousLink,
      low_confidence_link_rule: lowConfidenceLink,
    },
    skipped: skipped.slice(0, 3),
    link_warnings: linkRules.filter(r => r.warnings.length > 0).map(r => ({ rule_id: r.rule_id, warnings: r.warnings })),
  };
}

export function buildSourceDryRun(profile: SourceIngestProfile, sample: SourceRecord[]) {
  const skipped: Array<{ external_id: string; reason: string }> = [];
  const candidates: SourceRecord[] = [];
  for (const record of sample) {
    const decision = includeRecord(profile, record);
    if (decision.include) candidates.push(record);
    else skipped.push({ external_id: record.external_id, reason: decision.reason || 'filtered' });
  }
  const pages = candidates.map(r => samplePage(profile, r));
  const linkRules = (profile.links || []).map(rule => summarizeLinkRule(rule, candidates));
  const slugCollisions = detectSlugCollisions(pages);
  return {
    ok: true,
    dry_run: true,
    counts: {
      sampled: sample.length,
      would_write: candidates.length,
      skipped: skipped.length,
      failed: 0,
      slug_collisions: slugCollisions.length,
    },
    skipped,
    slug_collisions: slugCollisions,
    link_rules: linkRules,
    routing_sensitivity: { approved_source_id: profile.target.approved_source_id ?? null, classification: profile.security.classification, pii: profile.security.pii, pii_fields: profile.security.pii_fields || [] },
    stratified_samples: pickStratifiedSamples(pages, skipped, linkRules, slugCollisions),
    sample_pages: pages.slice(0, 3),
    deferred_checks: [
      'cross_source_edge_resolution_deferred_until_target_resolver_stage',
      'managed_block_before_after_diff_deferred_until_update_path',
    ],
    warnings: [
      ...(profile.security.pii && profile.security.classification === 'shared' ? ['shared_profile_has_pii_candidates'] : []),
      ...(profile.target.approved_source_id ? [] : ['approved_source_id_missing']),
      ...(slugCollisions.length > 0 ? ['slug_collision_candidates'] : []),
    ],
  };
}
