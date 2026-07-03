export type SourceIngestProfileStatus = 'draft' | 'reviewed' | 'active' | 'paused' | 'deprecated';
export type SourceIngestOnAccess = 'none' | 'banner' | 'enqueue_refresh' | 'acknowledge_when_stale';
export type SourceIngestUpdateMode = 'managed_block';

export interface SourceFilterRule {
  field: string;
  op: 'exists' | 'not_exists' | 'eq' | 'neq' | 'in' | 'not_in' | 'lte' | 'gte' | 'lt' | 'gt';
  value?: unknown;
}

export interface SourceLinkRule {
  id: string;
  when?: SourceFilterRule[];
  type: string;
  target: {
    type: string;
    lookup: 'external_id' | 'slug' | 'field_value';
    value_field?: string;
    slug_template?: string;
  };
  confidence?: number;
}

export interface SourceTransformProfileSource {
  alias: string;
  /** Stable saved source table/config id; preferred UI contract for multi-source transforms. */
  source_table_id?: string;
  connector?: string;
  object: string;
  fields?: string[];
  sample_limit?: number;
}

export interface SourceTransformProfile {
  engine?: 'pglite';
  sources: SourceTransformProfileSource[];
  sql: string;
  primary_key_field?: string;
  updated_at_field?: string;
}

export interface SourceIngestProfile {
  profile_id: string;
  status: SourceIngestProfileStatus;
  source_connector: string;
  source_object: string;
  transform?: SourceTransformProfile;
  owner?: string;
  target: {
    gbrain_type: string;
    approved_source_id?: string;
    slug_template: string;
  };
  selection?: { include?: SourceFilterRule[]; exclude?: SourceFilterRule[] };
  identity: { external_id_field: string; natural_key_fields?: string[]; display_name_field: string };
  freshness?: { policy?: string; on_access?: SourceIngestOnAccess; changed_since_field?: string };
  mapping?: { frontmatter?: Record<string, string | number | boolean | null>; sections?: Record<string, unknown>; source_fields?: string[]; article_template?: { frontmatter?: Record<string, string | number | boolean | null>; sections?: Record<string, string> } };
  links?: SourceLinkRule[];
  update_policy: { mode: SourceIngestUpdateMode; preserve_manual_sections: true; field_allowlist?: string[] };
  security: { classification: 'public' | 'shared' | 'internal' | 'restricted'; pii: boolean; pii_fields?: string[] };
  review?: { drafted_by?: string; approved_by?: string | null; approved_at?: string | null };
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{1,96}$/;
const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function issue(path: string, code: string, message: string, severity: 'error' | 'warning' = 'error'): ValidationIssue {
  return { path, code, message, severity };
}

function validateFieldPath(path: string, value: unknown, issues: ValidationIssue[]): void {
  if (typeof value !== 'string' || value.length === 0 || !FIELD_PATH_RE.test(value)) {
    issues.push(issue(path, 'invalid_field_path', 'Expected a non-empty dot field path.'));
  }
}

function validateFilter(path: string, raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue(path, 'invalid_filter', 'Filter rule must be an object.'));
    return;
  }
  validateFieldPath(`${path}.field`, raw.field, issues);
  const allowed = new Set(['exists', 'not_exists', 'eq', 'neq', 'in', 'not_in', 'lte', 'gte', 'lt', 'gt']);
  if (typeof raw.op !== 'string' || !allowed.has(raw.op)) issues.push(issue(`${path}.op`, 'invalid_operator', 'Unsupported filter operator.'));
  if ((raw.op === 'in' || raw.op === 'not_in') && !Array.isArray(raw.value)) issues.push(issue(`${path}.value`, 'invalid_filter_value', '`in`/`not_in` filters require an array value.'));
}

export function validateSourceIngestProfile(raw: unknown): { ok: boolean; issues: ValidationIssue[]; profile?: SourceIngestProfile } {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) return { ok: false, issues: [issue('', 'invalid_profile', 'Profile must be an object.')] };

  const p = raw as Record<string, unknown>;
  if (typeof p.profile_id !== 'string' || !PROFILE_ID_RE.test(p.profile_id)) issues.push(issue('profile_id', 'invalid_profile_id', 'Use lowercase kebab-case profile id.'));
  if (!['draft', 'reviewed', 'active', 'paused', 'deprecated'].includes(String(p.status))) issues.push(issue('status', 'invalid_status', 'Invalid profile status.'));
  if (typeof p.source_connector !== 'string' || p.source_connector.length === 0) issues.push(issue('source_connector', 'required', 'source_connector is required.'));
  if (typeof p.source_object !== 'string' || p.source_object.length === 0) issues.push(issue('source_object', 'required', 'source_object is required.'));

  if (!isObject(p.target)) {
    issues.push(issue('target', 'required', 'target is required.'));
  } else {
    if (typeof p.target.gbrain_type !== 'string' || p.target.gbrain_type.length === 0) issues.push(issue('target.gbrain_type', 'required', 'target.gbrain_type is required.'));
    if (typeof p.target.slug_template !== 'string' || !p.target.slug_template.includes('{{')) issues.push(issue('target.slug_template', 'invalid_slug_template', 'slug_template must include a template variable.'));
    if (p.target.approved_source_id !== undefined && (typeof p.target.approved_source_id !== 'string' || !SOURCE_ID_RE.test(p.target.approved_source_id))) issues.push(issue('target.approved_source_id', 'invalid_source_id', 'approved_source_id must match GBrain source id syntax.'));
  }

  if (!isObject(p.identity)) {
    issues.push(issue('identity', 'required', 'identity is required.'));
  } else {
    validateFieldPath('identity.external_id_field', p.identity.external_id_field, issues);
    validateFieldPath('identity.display_name_field', p.identity.display_name_field, issues);
    if (p.identity.natural_key_fields !== undefined) {
      if (!Array.isArray(p.identity.natural_key_fields)) issues.push(issue('identity.natural_key_fields', 'invalid_type', 'natural_key_fields must be an array.'));
      else p.identity.natural_key_fields.forEach((v, i) => validateFieldPath(`identity.natural_key_fields.${i}`, v, issues));
    }
  }

  if (isObject(p.selection)) {
    for (const group of ['include', 'exclude'] as const) {
      const rules = p.selection[group];
      if (rules !== undefined) {
        if (!Array.isArray(rules)) issues.push(issue(`selection.${group}`, 'invalid_type', 'Expected array of filter rules.'));
        else rules.forEach((r, i) => validateFilter(`selection.${group}.${i}`, r, issues));
      }
    }
  }

  if (isObject(p.freshness)) {
    if (p.freshness.on_access !== undefined && !['none', 'banner', 'enqueue_refresh', 'acknowledge_when_stale'].includes(String(p.freshness.on_access))) issues.push(issue('freshness.on_access', 'invalid_on_access', 'Unsupported on_access refresh behavior.'));
    if (p.freshness.changed_since_field !== undefined) validateFieldPath('freshness.changed_since_field', p.freshness.changed_since_field, issues);
  }

  if (p.transform !== undefined) {
    if (!isObject(p.transform)) {
      issues.push(issue('transform', 'invalid_transform', 'transform must be an object.'));
    } else {
      const t = p.transform as Record<string, unknown>;
      if (t.engine !== undefined && t.engine !== 'pglite') issues.push(issue('transform.engine', 'invalid_transform_engine', 'Only pglite transform engine is supported.'));
      if (typeof t.sql !== 'string' || !/^\s*(select|with)\b/i.test(t.sql)) issues.push(issue('transform.sql', 'invalid_transform_sql', 'Transform SQL must start with SELECT or WITH.'));
      if (typeof t.sql === 'string' && t.sql.trim().replace(/;\s*$/, '').includes(';')) issues.push(issue('transform.sql', 'multiple_statements', 'Only one transform SELECT statement is allowed.'));
      if (typeof t.primary_key_field !== 'string' || !SQL_IDENT_RE.test(t.primary_key_field)) issues.push(issue('transform.primary_key_field', 'required', 'Transform profiles must define a stable primary_key_field.'));
      if (!Array.isArray(t.sources) || t.sources.length === 0) {
        issues.push(issue('transform.sources', 'required', 'Transform requires at least one source alias.'));
      } else {
        t.sources.forEach((src, i) => {
          if (!isObject(src)) { issues.push(issue(`transform.sources.${i}`, 'invalid_source', 'Source must be an object.')); return; }
          if (typeof src.alias !== 'string' || !SQL_IDENT_RE.test(src.alias)) issues.push(issue(`transform.sources.${i}.alias`, 'invalid_alias', 'Alias must be a SQL identifier.'));
          if (src.source_table_id !== undefined && (typeof src.source_table_id !== 'string' || src.source_table_id.trim().length === 0)) issues.push(issue(`transform.sources.${i}.source_table_id`, 'invalid_source_table_id', 'source_table_id must be a non-empty string.'));
          if (src.connector !== undefined && typeof src.connector !== 'string') issues.push(issue(`transform.sources.${i}.connector`, 'invalid_connector', 'Connector must be a string.'));
          if (typeof src.object !== 'string' || !src.object) issues.push(issue(`transform.sources.${i}.object`, 'required', 'Source object is required.'));
          if (src.fields !== undefined && !Array.isArray(src.fields)) issues.push(issue(`transform.sources.${i}.fields`, 'invalid_fields', 'fields must be an array.'));
        });
      }
    }
  }

  if (p.links !== undefined) {
    if (!Array.isArray(p.links)) issues.push(issue('links', 'invalid_type', 'links must be an array.'));
    else p.links.forEach((l, i) => {
      if (!isObject(l)) { issues.push(issue(`links.${i}`, 'invalid_link', 'Link rule must be an object.')); return; }
      if (typeof l.id !== 'string' || l.id.length === 0) issues.push(issue(`links.${i}.id`, 'required', 'Link rule id is required.'));
      if (typeof l.type !== 'string' || l.type.length === 0) issues.push(issue(`links.${i}.type`, 'required', 'Link type is required.'));
      if (!isObject(l.target)) issues.push(issue(`links.${i}.target`, 'required', 'Link target is required.'));
      if (Array.isArray(l.when)) l.when.forEach((r, j) => validateFilter(`links.${i}.when.${j}`, r, issues));
    });
  }

  if (!isObject(p.update_policy)) {
    issues.push(issue('update_policy', 'required', 'update_policy is required.'));
  } else {
    if (p.update_policy.mode !== 'managed_block') issues.push(issue('update_policy.mode', 'invalid_mode', 'Only managed_block is supported in Stage 1.'));
    if (p.update_policy.preserve_manual_sections !== true) issues.push(issue('update_policy.preserve_manual_sections', 'required', 'Must explicitly preserve manual sections.'));
    const allow = p.update_policy.field_allowlist;
    if (Array.isArray(allow) && allow.some(v => typeof v === 'string' && v.startsWith('source_sync'))) issues.push(issue('update_policy.field_allowlist', 'sync_metadata_in_frontmatter', 'Mutable source_sync fields must not be written to frontmatter.'));
  }

  if (!isObject(p.security)) {
    issues.push(issue('security', 'required', 'security is required.'));
  } else {
    if (!['public', 'shared', 'internal', 'restricted'].includes(String(p.security.classification))) issues.push(issue('security.classification', 'invalid_classification', 'Invalid security classification.'));
    if (typeof p.security.pii !== 'boolean') issues.push(issue('security.pii', 'required', 'security.pii boolean is required.'));
  }

  const approvedSource = isObject(p.target) ? p.target.approved_source_id : undefined;
  if ((p.status === 'reviewed' || p.status === 'active') && typeof approvedSource !== 'string') issues.push(issue('target.approved_source_id', 'source_id_not_frozen', 'Reviewed/active profiles must freeze approved_source_id.'));

  return { ok: issues.every(i => i.severity !== 'error'), issues, profile: raw as unknown as SourceIngestProfile };
}

export function sourceIngestProfileJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'GBrain Source Ingest Profile',
    type: 'object',
    required: ['profile_id', 'status', 'source_connector', 'source_object', 'target', 'identity', 'update_policy', 'security'],
    additionalProperties: true,
    properties: {
      profile_id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,96}$' },
      status: { enum: ['draft', 'reviewed', 'active', 'paused', 'deprecated'] },
      source_connector: { type: 'string' },
      source_object: { type: 'string' },
      target: { type: 'object', required: ['gbrain_type', 'slug_template'] },
    },
  };
}
