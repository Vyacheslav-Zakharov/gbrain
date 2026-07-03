import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

interface SourceIngestCatalogTree {
  connectors?: Array<Record<string, unknown>>;
  base_views?: Array<Record<string, unknown>>;
  transform_views?: Array<Record<string, unknown>>;
  article_views?: Array<Record<string, unknown>>;
  schema?: Record<string, unknown>;
}

type ConnectorChoice = {
  id: string;
  kind?: string;
  displayName: string;
  object: string;
  supportsChangedSince?: boolean;
  credentialMode?: string;
  status?: string;
  requiredKeys?: string[];
  requiredEnv?: string[];
  fields?: Array<{ key: string; label: string; defaultValue: string }>;
  safety?: string[];
};

interface SourceIngestOverview {
  connectors: Array<{
    id: string;
    kind?: string;
    displayName: string;
    object: string;
    supportsChangedSince: boolean;
    credentialMode: string;
    status?: string;
    requiredKeys?: string[];
    requiredEnv?: string[];
    fields?: Array<{ key: string; label: string; defaultValue: string }>;
    safety?: string[];
  }>;
  profiles: { rows: Array<{ profile_id: string; status: string; current_version: number; profile_json: unknown }>; count: number };
  status: { rows: Array<Record<string, unknown>>; summary?: Record<string, unknown> };
  refresh: { count: number; due?: Array<Record<string, unknown>> };
  connector_configs?: { rows: Array<Record<string, unknown>>; count: number };
  source_tables?: Array<Record<string, unknown>>;
  catalog_tree?: SourceIngestCatalogTree;
  sources: Array<{ id: string; name: string; path?: string; federated?: boolean }>;
}

interface ReviewForm {
  connector_id: string;
  source_object: string;
  table_name: string;
  target_source_id: string;
  slug_prefix: string;
  freshness_policy: string;
  primary_key_field: string;
  updated_at_field: string;
  sample_limit: number;
}

const DEFAULT_ARTICLE_SECTIONS: Record<string, string> = {
  title: '{{ name }}',
  summary: '{{ name }} — единица автотранспорта/оборудования группы Аверс. Код: {{ code }}.',
  characteristics_type: '',
  characteristics_model: '',
  characteristics_status: '{{ status }}',
  characteristics_inventory: '{{ code }}',
  links: '',
  notes: 'Данные импортированы из AppSheet. Ручные пояснения можно добавлять вне managed block.',
  timeline: '',
};

function firstField(fields: Set<string>, candidates: string[]): string {
  return candidates.find(f => fields.has(f)) || '';
}

function makeDefaultArticleSections(fieldNames: string[]): Record<string, string> {
  const fields = new Set(fieldNames);
  const titleField = firstField(fields, ['name', 'title', 'code', 'id']);
  const codeField = firstField(fields, ['code', 'external_code', 'id']);
  const typeField = firstField(fields, ['vehicle_class', 'equipment_class', 'type']);
  const modelField = firstField(fields, ['model', 'manufacturer_model', 'name']);
  const statusField = firstField(fields, ['status', 'state']);
  const inventoryField = firstField(fields, ['external_code', 'inventory_number', 'serial_number', 'code']);
  const links = [
    fields.has('location_id') ? '- Находится на площадке (located_at): {{ location_id }}' : '',
    fields.has('parent_id') ? '- Входит в состав узла (part_of): {{ parent_id }}' : '',
  ].filter(Boolean).join('\n');
  return {
    ...DEFAULT_ARTICLE_SECTIONS,
    title: titleField ? `{{ ${titleField} }}` : '',
    summary: `${titleField ? `{{ ${titleField} }}` : 'Единица автотранспорта/оборудования группы Аверс'}${codeField ? ` — код: {{ ${codeField} }}.` : '.'}`,
    characteristics_type: typeField ? `{{ ${typeField} }}` : '',
    characteristics_model: modelField ? `{{ ${modelField} }}` : '',
    characteristics_status: statusField ? `{{ ${statusField} }}` : '',
    characteristics_inventory: inventoryField ? `{{ ${inventoryField} }}` : '',
    links,
  };
}

function isNoisySourceField(field: Record<string, unknown>): boolean {
  const name = String(field.name ?? '').toLowerCase();
  const samples = asArr(field.samples).map(v => String(v ?? ''));
  const types = asArr(field.observedTypes).map(v => String(v ?? '').toLowerCase());
  return name.startsWith('related') || name.includes('related_') || name.includes('measurementacts') || types.some(t => t.includes('array') || t.includes('object')) || samples.some(s => s.length > 500 || s.split(',').length > 20);
}

const SECTION_LABELS: Record<string, string> = {
  title: 'Заголовок H1 / frontmatter title',
  summary: 'Описание под заголовком',
  characteristics_type: 'Характеристики → Тип',
  characteristics_model: 'Характеристики → Производитель/модель',
  characteristics_status: 'Характеристики → Состояние',
  characteristics_inventory: 'Характеристики → Инвентарный/серийный №',
  links: 'Связи',
  notes: 'Заметки',
  timeline: 'Timeline',
};

function val(x: unknown): string {
  return x === null || x === undefined || x === '' ? '—' : String(x);
}

function profileId(profile: unknown): string {
  return String((profile as Record<string, unknown> | null)?.profile_id ?? 'draft');
}

function statusBadge(status: unknown) {
  const s = String(status ?? 'unknown');
  const color = s === 'active' || s === 'reviewed' ? 'var(--success)' : s === 'draft' ? 'var(--warning)' : 'var(--text-muted)';
  return <span style={{ color }}>{s}</span>;
}

function asObj(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? x as Record<string, unknown> : {};
}

function asArr<T = unknown>(x: unknown): T[] {
  return Array.isArray(x) ? x as T[] : [];
}

function safeSourceTableId(connectorId: string, sourceObject: string, tableName: string): string {
  const suffix = tableName.trim() && tableName.trim() !== sourceObject
    ? `:${tableName.toLowerCase().trim().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'}`
    : '';
  return `${connectorId}:${sourceObject}${suffix}`;
}

function connectorFieldDefault(connector: ConnectorChoice | undefined, key: string, fallback: string): string {
  const field = connector?.fields?.find(f => f.key === key);
  return field?.defaultValue ?? fallback;
}

function formPatchForConnector(connector: ConnectorChoice | undefined): Partial<ReviewForm> {
  if (!connector) return {};
  return {
    source_object: connector.object,
    table_name: connectorFieldDefault(connector, 'tableName', connector.object),
    primary_key_field: connectorFieldDefault(connector, 'primaryKeyField', 'id'),
    updated_at_field: connectorFieldDefault(connector, 'updatedAtField', ''),
    slug_prefix: connectorFieldDefault(connector, 'slugPrefix', 'source-ingest/records'),
    freshness_policy: connectorFieldDefault(connector, 'freshnessPolicy', 'P30D'),
  };
}

function PreviewJson({ value, empty }: { value: unknown; empty: string }) {
  return <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: 260, overflow: 'auto' }}>{value ? JSON.stringify(value, null, 2) : empty}</pre>;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function defaultTransformSources(form: ReviewForm, fields: string[]): string {
  return JSON.stringify([
    {
      alias: 'main',
      source_table_id: safeSourceTableId(form.connector_id, form.source_object, form.table_name),
      connector: form.connector_id,
      object: form.source_object,
      primary_key_field: form.primary_key_field,
      updated_at_field: form.updated_at_field || undefined,
      fields,
    },
  ], null, 2);
}

function TransformResultPreview({ value }: { value: unknown }) {
  const v = asObj(value);
  if (!value) return <div style={{ color: 'var(--text-muted)' }}>No transform preview yet.</div>;
  const records = asArr<Record<string, unknown>>(v.records);
  if (v.error) return <div style={{ color: 'var(--error)' }}>{String(v.error)}</div>;
  const keys = Array.from(new Set(records.flatMap(r => Object.keys(asObj(r.data))))).slice(0, 12);
  return <div style={{ color: 'var(--text-secondary)' }}>
    <div style={{ marginBottom: 8 }}><b>Transform result rows</b>: {val(v.count)}</div>
    {records.length === 0 ? <div style={{ color: 'var(--warning)' }}>SQL returned no rows.</div> : <table><thead><tr><th>external_id</th>{keys.map(k => <th key={k}>{k}</th>)}</tr></thead><tbody>
      {records.slice(0, 10).map((r, i) => {
        const data = asObj(r.data);
        return <tr key={i}><td className="mono">{val(r.external_id)}</td>{keys.map(k => <td key={k} className="mono">{val(data[k])}</td>)}</tr>;
      })}
    </tbody></table>}
  </div>;
}

function DiscoveryPreview({ value }: { value: unknown }) {
  const d = asObj(value);
  if (!value) return <div style={{ color: 'var(--text-muted)' }}>No discovery yet.</div>;
  const fields = asArr<Record<string, unknown>>(d.fields);
  return <div style={{ color: 'var(--text-secondary)' }}>
    <div style={{ marginBottom: 8 }}><b>{val(d.connectorId)}</b> / {val(d.objectName)} · sampled {val(d.sampled)} · fields {fields.length}</div>
    <div style={{ marginBottom: 8 }}>IDs: {asArr(d.idCandidates).map(String).join(', ') || '—'} · Updated: {asArr(d.updatedAtCandidates).map(String).join(', ') || '—'}</div>
    {asArr(d.warnings).length > 0 && <div style={{ color: 'var(--warning)', marginBottom: 8 }}>Warnings: {asArr(d.warnings).map(String).join(', ')}</div>}
    <table><thead><tr><th>field</th><th>types</th><th>null</th><th>samples</th></tr></thead><tbody>
      {fields.slice(0, 12).map((f, i) => <tr key={i}><td className="mono">{val(f.name)}</td><td>{asArr(f.observedTypes).join(', ')}</td><td>{typeof f.nullRatio === 'number' ? `${Math.round(f.nullRatio * 100)}%` : '—'}</td><td className="mono">{asArr(f.samples).slice(0, 3).map(val).join(' · ')}</td></tr>)}
    </tbody></table>
  </div>;
}

function CatalogCount({ label, rows }: { label: string; rows: Array<Record<string, unknown>> }) {
  return <div className="metric"><div className="metric-value">{rows.length}</div><div className="metric-label">{label}</div></div>;
}

function CatalogSection({ title, rows, idKey, subtitle }: { title: string; rows: Array<Record<string, unknown>>; idKey: string; subtitle: (row: Record<string, unknown>) => string }) {
  return <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
    <h3 style={{ fontSize: 13, marginBottom: 8 }}>{title}</h3>
    {rows.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>No catalog objects yet.</div>}
    {rows.map(row => {
      const stale = row.stale === true;
      const enabled = row.enabled !== false;
      return <div key={String(row[idKey])} style={{ padding: 8, borderRadius: 6, background: stale ? 'rgba(245, 158, 11, 0.12)' : 'rgba(148, 163, 184, 0.08)', marginBottom: 6 }}>
        <div><code>{val(row[idKey])}</code> {stale && <span style={{ color: 'var(--warning)' }}>stale</span>} {!enabled && <span style={{ color: 'var(--warning)' }}>disabled</span>}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{subtitle(row)}</div>
        {stale && <div style={{ color: 'var(--warning)', fontSize: 12 }}>reasons: {asArr(row.stale_reasons).map(String).join(', ') || '—'}</div>}
      </div>;
    })}
  </div>;
}

function SourceIngestCatalogPanel({ tree, onSelectConnector }: { tree: SourceIngestCatalogTree; onSelectConnector?: (row: Record<string, unknown>) => void }) {
  const connectors = tree.connectors ?? [];
  const baseViews = tree.base_views ?? [];
  const transformViews = tree.transform_views ?? [];
  const articleViews = tree.article_views ?? [];
  return <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
    <h2 className="section-title">Catalog tree preview</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      Phase 1 shell: first-class catalog objects from <code>source_ingest_tree</code>. Existing review wizard below remains the compatibility path until the new object editors are complete.
    </p>
    <div className="metrics" style={{ marginBottom: 12 }}>
      <CatalogCount label="connectors" rows={connectors} />
      <CatalogCount label="base views" rows={baseViews} />
      <CatalogCount label="transforms" rows={transformViews} />
      <CatalogCount label="article views" rows={articleViews} />
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Подключения</h3>
        {connectors.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>No catalog connectors yet.</div>}
        {connectors.map(row => {
          const enabled = row.enabled !== false;
          return <button key={String(row.connector_id)} className="btn btn-secondary" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => onSelectConnector?.(row)}>
            <code>{val(row.connector_id)}</code> {!enabled && <span style={{ color: 'var(--warning)' }}>disabled</span>}
            <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12 }}>{val(row.display_name)} · kind {val(row.kind)} · last test {val(row.last_test_ok)}</span>
          </button>;
        })}
      </div>
      <CatalogSection title="Источники" rows={baseViews} idKey="base_view_id" subtitle={row => `${val(row.display_name)} · ${val(row.connector_id)} / ${val(row.object_name)} · fields ${asArr(row.selected_fields).length}`} />
      <CatalogSection title="Преобразования" rows={transformViews} idKey="transform_view_id" subtitle={row => `${val(row.display_name)} · inputs ${asArr(row.inputs).length} · pk ${val(row.primary_key_field)}`} />
      <CatalogSection title="Публикации" rows={articleViews} idKey="article_view_id" subtitle={row => `${val(row.status)} · ${val(row.gbrain_type)} → ${val(row.target_source_id)} · compiled ${val(row.version_hash)}`} />
    </div>
    <div style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 12 }}>Схема мозга: read-only = {String(asObj(tree.schema).read_only ?? true)}.</div>
  </section>;
}

function DryRunPreview({ value, currentTargetSourceId }: { value: unknown; currentTargetSourceId: string }) {
  const d = asObj(value);
  if (!value) return <div style={{ color: 'var(--text-muted)' }}>No dry-run yet.</div>;
  const counts = asObj(d.counts);
  const samplePages = asArr<Record<string, unknown>>(d.sample_pages);
  const warnings = asArr(d.warnings);
  const sensitivity = asObj(d.routing_sensitivity);
  const piiFields = asArr(sensitivity.pii_fields).map(String);
  const hasPii = sensitivity.pii === true || piiFields.length > 0;
  const routedSource = String(sensitivity.approved_source_id ?? currentTargetSourceId ?? '—');
  const crossSource = routedSource !== '—' && currentTargetSourceId && routedSource !== currentTargetSourceId;
  return <div style={{ color: 'var(--text-secondary)' }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(90px, 1fr))', gap: 8, marginBottom: 10 }}>
      {['sampled', 'would_write', 'skipped', 'slug_collisions'].map(k => <div className="metric" key={k}><div className="metric-value">{val(counts[k])}</div><div className="metric-label">{k}</div></div>)}
    </div>
    <div style={{ marginBottom: 10, padding: 10, borderRadius: 6, background: hasPii || crossSource ? 'rgba(245, 158, 11, 0.12)' : 'rgba(16, 185, 129, 0.10)', color: hasPii || crossSource ? 'var(--warning)' : 'var(--success)' }}>
      <b>Routing / sensitivity</b>
      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
        target source: <code>{currentTargetSourceId || '—'}</code> · dry-run source: <code>{routedSource}</code> · classification: <code>{val(sensitivity.classification)}</code> · pii: <code>{String(hasPii)}</code>
      </div>
      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>pii_fields: {piiFields.length ? piiFields.map(f => <code key={f} style={{ marginRight: 6 }}>{f}</code>) : '—'}</div>
      {crossSource && <div style={{ marginTop: 4 }}>Cross-source mismatch: dry-run routing source differs from selected target source.</div>}
    </div>
    {warnings.length > 0 && <div style={{ color: 'var(--warning)', marginBottom: 8 }}>Warnings: {warnings.map(String).join(', ')}</div>}
    <table><thead><tr><th>slug</th><th>title</th><th>external</th><th>empty template slots</th></tr></thead><tbody>
      {samplePages.map((p, i) => <tr key={i}><td className="mono">{val(p.slug)}</td><td>{hasPii ? '[PII masked]' : val(p.title)}</td><td className="mono">{val(p.external_id)}</td><td>{asArr(p.article_empty_slots).map(String).join(', ') || '—'}</td></tr>)}
    </tbody></table>
    {samplePages.length > 0 && <details style={{ marginTop: 8 }}><summary>{hasPii ? 'Rendered article previews (PII fields masked)' : 'Rendered article previews'}</summary>
      {samplePages.map((p, i) => <details key={i} style={{ marginTop: 8 }} open={i === 0}><summary>{val(p.slug)} · {hasPii ? '[PII masked]' : val(p.title)}</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{String(p.article_markdown_preview || p.managed_block_preview || '')}</pre></details>)}
    </details>}
  </div>;
}

export function SourceIngestPage() {
  const [data, setData] = useState<SourceIngestOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<string>('');
  const [report, setReport] = useState<unknown>(null);
  const [discovery, setDiscovery] = useState<unknown>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [dryRun, setDryRun] = useState<unknown>(null);
  const [transformPreview, setTransformPreview] = useState<unknown>(null);
  const [dryRunSourceId, setDryRunSourceId] = useState<string | null>(null);
  const [sensitivityAck, setSensitivityAck] = useState(false);
  const [approveResult, setApproveResult] = useState<unknown>(null);
  const [connectionTest, setConnectionTest] = useState<unknown>(null);
  const [secretAudit, setSecretAudit] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secretForm, setSecretForm] = useState({ app_id: '', access_key: '' });
  const [form, setForm] = useState<ReviewForm>({
    connector_id: 'appsheet-vehicles',
    source_object: 'vehicle',
    table_name: 'vehicles',
    target_source_id: 'shared',
    slug_prefix: 'source-ingest/vehicles',
    freshness_policy: 'P30D',
    primary_key_field: 'vehicleID',
    updated_at_field: '',
    sample_limit: 25,
  });
  const [articleSections, setArticleSections] = useState<Record<string, string>>(DEFAULT_ARTICLE_SECTIONS);
  const [articleDirty, setArticleDirty] = useState(false);
  const [selectedSourceFields, setSelectedSourceFields] = useState<string[]>([]);
  const [activeSection, setActiveSection] = useState<string>('summary');
  const [transformEnabled, setTransformEnabled] = useState(false);
  const [transformSourcesText, setTransformSourcesText] = useState('');
  const [transformSql, setTransformSql] = useState('');
  const [transformPrimaryKey, setTransformPrimaryKey] = useState('vehicleID');
  const [transformUpdatedAt, setTransformUpdatedAt] = useState('');
  const [catalogConnectorForm, setCatalogConnectorForm] = useState({ connector_id: 'appsheet-protokolist', kind: 'appsheet', display_name: 'AppSheet Протоколист', enabled: true });
  const [catalogConnectorObjects, setCatalogConnectorObjects] = useState<unknown>(null);
  const [catalogConnectorTest, setCatalogConnectorTest] = useState<unknown>(null);

  const load = async () => {
    try {
      const out = await api.sourceIngestOverview();
      setData(out);
      setErr(null);
      const firstProfile = out?.profiles?.rows?.[0]?.profile_id;
      if (!selectedProfile && firstProfile) setSelectedProfile(firstProfile);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { void load(); }, []);

  const catalogConnectors = data?.catalog_tree?.connectors ?? [];
  const connectorChoices = [
    ...(data?.connectors ?? []).map(c => ({ id: c.id, kind: c.kind ?? c.id, displayName: c.displayName, status: c.status, object: c.object, fields: c.fields, requiredKeys: c.requiredKeys, requiredEnv: c.requiredEnv, safety: c.safety })),
    ...catalogConnectors.map(c => ({ id: String(c.connector_id), kind: String(c.kind ?? ''), displayName: String(c.display_name ?? c.connector_id), status: 'catalog', object: 'vehicle', fields: undefined, requiredKeys: c.kind === 'appsheet' ? ['app_id', 'access_key'] : [], requiredEnv: [], safety: ['First-class catalog connector: table binding is configured in base/source table settings.'] })),
  ].filter((c, i, arr) => c.id && arr.findIndex(x => x.id === c.id) === i);
  const selectedConnector = connectorChoices.find(c => c.id === form.connector_id);
  const sourceTables = data?.source_tables ?? [];
  const configId = safeSourceTableId(form.connector_id, form.source_object, form.table_name);
  const matchingConfigs = data?.connector_configs?.rows?.filter(c => c.connector_id === form.connector_id && c.source_object === form.source_object) ?? [];
  const savedConfig = data?.connector_configs?.rows?.find(c => c.config_id === configId)
    || (matchingConfigs.length === 1 ? matchingConfigs[0] : undefined);
  const secretStatus = (savedConfig?.secrets as Record<string, unknown> | undefined)
    || { configured: false, missing_keys: selectedConnector?.requiredKeys ?? [], required_keys: selectedConnector?.requiredKeys ?? [], missing_env: selectedConnector?.requiredEnv ?? [], required_env: selectedConnector?.requiredEnv ?? [], masked: {}, storage: 'none' };
  const summary = data?.status.summary ?? {};
  const discoveredFields = asArr<Record<string, unknown>>(asObj(discovery).fields);
  const selectedSourceFieldSet = new Set(selectedSourceFields);
  const includedDiscoveryFields = discoveredFields.filter(f => selectedSourceFieldSet.has(String(f.name)));
  const activeProfile = useMemo(() => (draft as Record<string, unknown> | null)?.profile ?? null, [draft]);
  const transformSources = useMemo(() => parseJsonArray(transformSourcesText), [transformSourcesText]);
  const transformConfig = useMemo(() => {
    if (!transformEnabled) return undefined;
    return {
      engine: 'pglite',
      primary_key_field: transformPrimaryKey || 'id',
      updated_at_field: transformUpdatedAt || 'updated_at',
      sources: transformSources,
      sql: transformSql,
    };
  }, [transformEnabled, transformPrimaryKey, transformUpdatedAt, transformSources, transformSql]);
  const profileForReview = useMemo(() => {
    if (!activeProfile) return null;
    const raw = { ...(activeProfile as Record<string, unknown>) };
    const mapping = { ...(asObj(raw.mapping)) };
    mapping.article_template = {
      ...(asObj(mapping.article_template)),
      sections: articleSections,
    };
    mapping.source_fields = selectedSourceFields;
    raw.mapping = mapping;
    raw.update_policy = { ...asObj(raw.update_policy), field_allowlist: selectedSourceFields };
    if (transformConfig) raw.transform = transformConfig;
    else delete raw.transform;
    return raw;
  }, [activeProfile, articleSections, selectedSourceFields, transformConfig]);
  const canDryRun = Boolean(profileForReview);
  const canTransformPreview = Boolean(profileForReview && transformEnabled && transformSources.length > 0 && transformSql.trim());
  const dryRunSensitivity = asObj(asObj(dryRun).routing_sensitivity);
  const dryRunPiiFields = asArr(dryRunSensitivity.pii_fields).map(String);
  const dryRunHasPii = dryRunSensitivity.pii === true || dryRunPiiFields.length > 0;
  const dryRunRoutedSource = String(dryRunSensitivity.approved_source_id ?? dryRunSourceId ?? form.target_source_id ?? '');
  const dryRunCrossSource = Boolean(dryRun && dryRunRoutedSource && form.target_source_id && dryRunRoutedSource !== form.target_source_id);
  const requiresSensitivityAck = Boolean(dryRun && (dryRunHasPii || dryRunCrossSource));
  const dryRunMatchesCurrentSource = Boolean(dryRun && dryRunSourceId === form.target_source_id);
  const dryRunProfileHash = typeof (dryRun as Record<string, unknown> | null)?.profile_hash === 'string' ? String((dryRun as Record<string, unknown>).profile_hash) : '';
  const dryRunSourceMismatch = Boolean(dryRun && dryRunSourceId && dryRunSourceId !== form.target_source_id);
  const canApprove = Boolean(activeProfile && dryRun && dryRunProfileHash && dryRunMatchesCurrentSource && (!requiresSensitivityAck || sensitivityAck) && !(dryRun as Record<string, unknown>).error);

  const runStep = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setErr(null);
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const payload = () => ({
    config_id: configId,
    connector_id: form.connector_id,
    source_object: form.source_object,
    target_source_id: form.target_source_id,
    slug_prefix: form.slug_prefix,
    freshness_policy: form.freshness_policy,
    primary_key_field: form.primary_key_field,
    updated_at_field: form.updated_at_field,
    sample_limit: form.sample_limit,
    // Table name is non-secret UI config. It can be saved through
    // source_connector_configs; AppSheet credentials remain server-side only.
    table_name: form.table_name,
    selected_fields: selectedSourceFields,
  });

  const configPayload = () => ({
    config_id: configId,
    connector_id: form.connector_id,
    source_object: form.source_object,
    display_name: form.connector_id === 'appsheet-vehicles' ? 'AppSheet автотранспорт' : form.connector_id,
    table_name: form.table_name,
    target_source_id: form.target_source_id,
    slug_prefix: form.slug_prefix,
    freshness_policy: form.freshness_policy,
    primary_key_field: form.primary_key_field,
    updated_at_field: form.updated_at_field,
    enabled: true,
    config_json: { table_name: form.table_name, primary_key_field: form.primary_key_field, updated_at_field: form.updated_at_field, selected_fields: selectedSourceFields, article_sections: articleSections, transform_enabled: transformEnabled, transform_sources: parseJsonArray(transformSourcesText), transform_sql: transformSql, transform_primary_key: transformPrimaryKey, transform_updated_at: transformUpdatedAt },
  });

  const applySavedConfig = () => {
    if (!savedConfig) return;
    const savedJson = asObj(savedConfig.config_json);
    const savedFields = asArr(savedJson.selected_fields).map(String).filter(Boolean);
    setForm({
      ...form,
      table_name: String(savedConfig.table_name ?? form.table_name),
      target_source_id: String(savedConfig.target_source_id ?? form.target_source_id),
      slug_prefix: String(savedConfig.slug_prefix ?? form.slug_prefix),
      freshness_policy: String(savedConfig.freshness_policy ?? form.freshness_policy),
      primary_key_field: String(savedJson.primary_key_field ?? form.primary_key_field),
      updated_at_field: String(savedJson.updated_at_field ?? form.updated_at_field),
    });
    if (savedFields.length > 0) setSelectedSourceFields(savedFields);
    const savedSections = asObj(savedJson.article_sections);
    if (Object.keys(savedSections).length > 0) {
      setArticleSections({ ...DEFAULT_ARTICLE_SECTIONS, ...Object.fromEntries(Object.entries(savedSections).map(([k, v]) => [k, String(v ?? '')])) });
      setArticleDirty(true);
    }
    setTransformEnabled(savedJson.transform_enabled === true);
    if (Array.isArray(savedJson.transform_sources)) setTransformSourcesText(JSON.stringify(savedJson.transform_sources, null, 2));
    if (typeof savedJson.transform_sql === 'string') setTransformSql(savedJson.transform_sql);
    if (typeof savedJson.transform_primary_key === 'string') setTransformPrimaryKey(savedJson.transform_primary_key);
    if (typeof savedJson.transform_updated_at === 'string') setTransformUpdatedAt(savedJson.transform_updated_at);
    setDryRun(null);
    setTransformPreview(null);
    setDryRunSourceId(null);
    setSensitivityAck(false);
    setApproveResult(null);
  };

  const saveConfig = async () => runStep('save-config', async () => {
    await api.sourceIngestSaveConfig(configPayload());
    await load();
  });

  const rotateSecret = async () => runStep('save-secret', async () => {
    await api.sourceIngestSaveConfig(configPayload());
    await api.sourceIngestSaveSecret({
      config_id: configId,
      connector_id: form.connector_id,
      source_object: form.source_object,
      secrets: secretForm,
    });
    setSecretForm({ app_id: '', access_key: '' });
    await load();
    setConnectionTest(await api.sourceIngestTestConnection(payload()));
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const deleteSecret = async () => runStep('delete-secret', async () => {
    await api.sourceIngestDeleteSecret({ config_id: configId, connector_id: form.connector_id, source_object: form.source_object });
    await load();
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const loadSecretAudit = async () => runStep('secret-audit', async () => {
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const saveCatalogConnector = async () => runStep('catalog-connector', async () => {
    await api.sourceIngestSaveCatalogConnector({
      ...catalogConnectorForm,
      config_json: { source: 'admin-ui', phase: 'catalog-tree-shell' },
    });
    await load();
  });

  const selectCatalogConnector = (row: Record<string, unknown>) => {
    const connectorId = String(row.connector_id ?? '');
    setCatalogConnectorForm({
      connector_id: connectorId,
      kind: String(row.kind ?? 'appsheet'),
      display_name: String(row.display_name ?? connectorId),
      enabled: row.enabled !== false,
    });
    setForm(prev => ({ ...prev, connector_id: connectorId }));
    setCatalogConnectorObjects(null);
    setCatalogConnectorTest(null);
  };

  const catalogConnectorPayload = () => ({
    connector_id: catalogConnectorForm.connector_id,
    kind: catalogConnectorForm.kind,
    source_object: form.source_object,
    table_name: form.table_name,
    primary_key_field: form.primary_key_field,
    updated_at_field: form.updated_at_field,
  });

  const listCatalogConnectorObjects = async () => runStep('catalog-list-objects', async () => {
    setCatalogConnectorObjects(await api.sourceIngestConnectorListObjects(catalogConnectorPayload()));
  });

  const testCatalogConnector = async () => runStep('catalog-test-connector', async () => {
    setCatalogConnectorTest(await api.sourceIngestCatalogConnectorTest(catalogConnectorPayload()));
    await load();
  });

  const deleteCatalogConnector = async () => runStep('catalog-delete-connector', async () => {
    await api.sourceIngestDeleteCatalogConnector(catalogConnectorForm.connector_id);
    setCatalogConnectorObjects(null);
    setCatalogConnectorTest(null);
    await load();
  });

  const testConnection = async () => runStep('test-connection', async () => {
    setConnectionTest(await api.sourceIngestTestConnection(payload()));
  });

  const refreshReport = async () => runStep('refresh-report', async () => {
    const out = await api.sourceIngestRefreshReport(selectedProfile || undefined);
    setReport(out);
    await load();
  });

  const discover = async () => runStep('discover', async () => {
    const out = await api.sourceIngestDiscover(payload());
    const fields = asArr<Record<string, unknown>>(asObj(out).fields);
    const selected = fields.filter(f => !isNoisySourceField(f)).map(f => String(f.name)).filter(Boolean);
    setDiscovery(out);
    const ids = asArr((out as Record<string, unknown>).idCandidates).map(String);
    const updated = asArr((out as Record<string, unknown>).updatedAtCandidates).map(String);
    if (!form.primary_key_field || form.primary_key_field === 'id' || form.primary_key_field === 'vehicleID') {
      const preferredId = ids.includes('vehicleID') ? 'vehicleID' : (ids[0] || form.primary_key_field);
      if (preferredId) setForm(prev => ({ ...prev, primary_key_field: preferredId }));
    }
    if (!form.updated_at_field && updated[0]) setForm(prev => ({ ...prev, updated_at_field: updated[0] }));
    setSelectedSourceFields(selected);
    if (!transformSourcesText) setTransformSourcesText(defaultTransformSources(form, selected));
    if (!articleDirty) setArticleSections(makeDefaultArticleSections(selected));
    setDryRun(null);
    setTransformPreview(null);
    setDryRunSourceId(null);
    setApproveResult(null);
  });

  const draftProfile = async () => runStep('draft', async () => {
    const out = await api.sourceIngestDraft(payload());
    const profile = asObj((out as Record<string, unknown>).profile);
    const mapping = asObj(profile.mapping);
    const articleTemplate = asObj(mapping.article_template);
    const sections = asObj(articleTemplate.sections);
    const draftedFields = asArr(mapping.source_fields).map(String).filter(Boolean);
    if (draftedFields.length > 0 && selectedSourceFields.length === 0) setSelectedSourceFields(draftedFields);
    if (!articleDirty && Object.keys(sections).length > 0) setArticleSections({ ...DEFAULT_ARTICLE_SECTIONS, ...Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, String(v ?? '')])) });
    setDraft(out);
    setDryRun(null);
    setTransformPreview(null);
    setDryRunSourceId(null);
    setSensitivityAck(false);
    setApproveResult(null);
  });

  const updateArticleSection = (key: string, value: string) => {
    setArticleDirty(true);
    setArticleSections(prev => ({ ...prev, [key]: value }));
    setDryRun(null);
    setTransformPreview(null);
    setDryRunSourceId(null);
    setSensitivityAck(false);
    setApproveResult(null);
  };

  const insertFieldToken = (field: string) => {
    const token = `{{ ${field} }}`;
    updateArticleSection(activeSection, `${articleSections[activeSection] || ''}${articleSections[activeSection] ? ' ' : ''}${token}`);
  };

  const setFieldSelected = (field: string, checked: boolean) => {
    setSelectedSourceFields(prev => {
      const next = checked ? Array.from(new Set([...prev, field])) : prev.filter(f => f !== field);
      if (!articleDirty) setArticleSections(makeDefaultArticleSections(next));
      return next;
    });
    setDryRun(null);
    setTransformPreview(null);
    setDryRunSourceId(null);
    setSensitivityAck(false);
    setApproveResult(null);
  };

  const selectAllFields = (fields: string[]) => {
    setSelectedSourceFields(fields);
    if (!articleDirty) setArticleSections(makeDefaultArticleSections(fields));
    setDryRun(null);
    setTransformPreview(null);
    setDryRunSourceId(null);
    setApproveResult(null);
  };

  const invalidateTransformPreview = () => {
    setDryRun(null);
    setTransformPreview(null);
    setDryRunSourceId(null);
    setSensitivityAck(false);
    setApproveResult(null);
  };

  const updateFormAndInvalidate = (patch: Partial<ReviewForm>) => {
    setForm(prev => ({ ...prev, ...patch }));
    invalidateTransformPreview();
  };

  const runTransformPreview = async () => runStep('transform-preview', async () => {
    if (!profileForReview) return;
    setTransformPreview(await api.sourceIngestTransformPreview({ ...payload(), profile: profileForReview, sample_limit: form.sample_limit, target_source_id: form.target_source_id }));
  });

  const runDryRun = async () => runStep('dry-run', async () => {
    if (!profileForReview) return;
    setDryRun(await api.sourceIngestDryRun({ ...payload(), profile: profileForReview, sample_limit: form.sample_limit, target_source_id: form.target_source_id }));
    setDryRunSourceId(form.target_source_id);
    setSensitivityAck(false);
  });

  const approveProfile = async () => runStep('approve', async () => {
    if (!profileForReview) return;
    if (dryRunSourceId !== form.target_source_id) {
      throw new Error(`dry_run_source_mismatch: dry-run was for ${dryRunSourceId ?? 'none'}, current target is ${form.target_source_id}. Run dry-run preview again before approving.`);
    }
    if (requiresSensitivityAck && !sensitivityAck) {
      throw new Error('sensitivity_ack_required: acknowledge PII/cross-source routing before approving.');
    }
    const out = await api.sourceIngestApproveProfile({
      profile: profileForReview,
      approved_source_id: form.target_source_id,
      dry_run_target_source_id: dryRunSourceId,
      profile_hash: dryRunProfileHash,
      sensitivity_ack: sensitivityAck,
      change_note: `approved AppSheet vehicle profile from admin UI (${form.slug_prefix})`,
    });
    setApproveResult(out);
    await load();
  });

  if (err && !data) return <div style={{ color: 'var(--error)' }}><h1>Source Ingest</h1><pre>{err}</pre></div>;
  if (!data) return <div style={{ color: 'var(--text-muted)' }}>Loading source ingest console…</div>;

  return (
    <div>
      <h1 className="page-title">Source Ingest</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 18 }}>
        Review workflow: configure → discover → draft profile → dry-run preview → approve. Import/refresh remains separate and guarded.
      </p>
      {err && <div style={{ color: 'var(--error)', marginBottom: 12 }}><b>Error:</b> {err}</div>}

      <div className="metrics">
        <div className="metric"><div className="metric-value">{val(summary.rows ?? data.status.rows.length)}</div><div className="metric-label">sync rows</div></div>
        <div className="metric"><div className="metric-value">{val(summary.fresh ?? 0)}</div><div className="metric-label">fresh</div></div>
        <div className="metric"><div className="metric-value">{val(summary.stale ?? 0)}</div><div className="metric-label">stale</div></div>
        <div className="metric"><div className="metric-value">{data.refresh.count}</div><div className="metric-label">due profiles</div></div>
      </div>

      <SourceIngestCatalogPanel tree={data.catalog_tree ?? { connectors: [], base_views: [], transform_views: [], article_views: [], schema: { read_only: true } }} onSelectConnector={selectCatalogConnector} />

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">0. Catalog connector instance</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
          Creates the new first-class connector object (system + non-secret config). Table binding remains in Source table / connector config until the base-view editor lands.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 14, alignItems: 'end' }}>
          <label>Connector id
            <input value={catalogConnectorForm.connector_id} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, connector_id: e.target.value }))} placeholder="appsheet-protokolist" />
          </label>
          <label>Kind
            <select value={catalogConnectorForm.kind} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, kind: e.target.value }))}>
              <option value="appsheet">appsheet</option>
              <option value="fake">fake</option>
            </select>
          </label>
          <label>Display name
            <input value={catalogConnectorForm.display_name} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="AppSheet Протоколист" />
          </label>
          <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id || !catalogConnectorForm.kind} onClick={() => void saveCatalogConnector()}>{busy === 'catalog-connector' ? 'Saving…' : 'Save connector'}</button>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void listCatalogConnectorObjects()}>{busy === 'catalog-list-objects' ? 'Loading objects…' : 'List objects'}</button>
          <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void testCatalogConnector()}>{busy === 'catalog-test-connector' ? 'Testing…' : 'Test connector'}</button>
          <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void deleteCatalogConnector()}>{busy === 'catalog-delete-connector' ? 'Deleting…' : 'Delete connector'}</button>
          <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>List/test use current Source object + table fields below; read-only sample/listObjects only.</span>
        </div>
        {(catalogConnectorObjects !== null || catalogConnectorTest !== null) && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
          <div><h3 style={{ fontSize: 13 }}>Objects</h3><PreviewJson value={catalogConnectorObjects} empty="No listObjects result yet." /></div>
          <div><h3 style={{ fontSize: 13 }}>Connection test</h3><PreviewJson value={catalogConnectorTest} empty="No test result yet." /></div>
        </div>}
      </section>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">1. Source table / connector config</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
          Сохраняем не просто connector, а конкретную таблицу источника: <code>{configId}</code>. Один connector может иметь несколько source tables для join/union в transform.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <label>Connector
            <select value={form.connector_id} onChange={e => {
              const connector = connectorChoices.find(c => c.id === e.target.value);
              const patch = formPatchForConnector(connector);
              updateFormAndInvalidate({ connector_id: e.target.value, ...patch });
              setTransformPrimaryKey(patch.primary_key_field || 'id');
              setTransformUpdatedAt(patch.updated_at_field || '');
              setTransformSourcesText('');
            }}>
              {connectorChoices.map(c => <option key={c.id} value={c.id}>{c.displayName} ({c.id}){c.status === 'scaffold' ? ' — scaffold' : c.status === 'catalog' ? ' — catalog' : ''}</option>)}
            </select>
            {selectedConnector?.status === 'scaffold' && <span style={{ display: 'block', color: 'var(--warning)', fontSize: 12 }}>Scaffold only: можно сохранить source table config и использовать в transform JSON, но live discovery/sample будет работать после реализации connector IO.</span>}
          </label>
          <label>Source object
            <input value={form.source_object} onChange={e => updateFormAndInvalidate({ source_object: e.target.value })} />
          </label>
          <label>Source table name / API object
            <input value={form.table_name} onChange={e => updateFormAndInvalidate({ table_name: e.target.value })} />
          </label>
          <label>Primary key field
            <input value={form.primary_key_field} onChange={e => { updateFormAndInvalidate({ primary_key_field: e.target.value }); setTransformPrimaryKey(e.target.value || transformPrimaryKey); }} placeholder="vehicleID" />
          </label>
          <label>Updated-at field (optional)
            <input value={form.updated_at_field} onChange={e => { updateFormAndInvalidate({ updated_at_field: e.target.value }); setTransformUpdatedAt(e.target.value || transformUpdatedAt); }} placeholder="updatedAt / modified" />
          </label>
          <label>Target GBrain source
            <select value={form.target_source_id} onChange={e => updateFormAndInvalidate({ target_source_id: e.target.value })}>
              {data.sources.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}
            </select>
          </label>
          <label>Slug prefix
            <input value={form.slug_prefix} onChange={e => updateFormAndInvalidate({ slug_prefix: e.target.value })} />
          </label>
          <label>Article freshness policy
            <select value={form.freshness_policy} onChange={e => updateFormAndInvalidate({ freshness_policy: e.target.value })}>
              <option value="PT6H">6 hours</option>
              <option value="P1D">1 day</option>
              <option value="P7D">7 days</option>
              <option value="P30D">30 days</option>
              <option value="P90D">90 days</option>
            </select>
          </label>
          <label>Sample limit
            <input type="number" min={1} max={200} value={form.sample_limit} onChange={e => updateFormAndInvalidate({ sample_limit: Number(e.target.value) || 25 })} />
          </label>
        </div>
        <div style={{ marginTop: 12, color: 'var(--text-secondary)' }}>
          Credential storage: <b>{val(secretStatus.storage)}</b>
          <span style={{ marginLeft: 8, color: secretStatus.configured ? 'var(--success)' : 'var(--warning)' }}>
            {secretStatus.configured ? 'configured' : `missing: ${((secretStatus.missing_keys as string[]) ?? []).join(', ') || 'unknown'}`}
          </span>
          <div style={{ marginTop: 6 }}>
            Masked: {Object.entries(asObj(secretStatus.masked)).map(([k, v]) => <span key={k} style={{ marginRight: 10 }}><code>{k}</code> {String(v)}</span>)}
            {Object.keys(asObj(secretStatus.masked)).length === 0 && '—'}
          </div>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            Updated: {val(secretStatus.updated_by)} · {val(secretStatus.updated_at)}
          </div>
        </div>
        {form.connector_id === 'appsheet-vehicles' ? <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 12 }}>
            <label>App ID
              <input type="password" autoComplete="off" value={secretForm.app_id} onChange={e => setSecretForm({ ...secretForm, app_id: e.target.value })} placeholder="saved separately; never shown back" />
            </label>
            <label>Access Key
              <input type="password" autoComplete="off" value={secretForm.access_key} onChange={e => setSecretForm({ ...secretForm, access_key: e.target.value })} placeholder="saved separately; never shown back" />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn btn-secondary" disabled={busy !== null || !secretForm.app_id || !secretForm.access_key} onClick={() => void rotateSecret()}>{busy === 'save-secret' ? 'Saving secret…' : 'Rotate/save secret + test'}</button>
            <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void deleteSecret()}>{busy === 'delete-secret' ? 'Deleting…' : 'Delete secret'}</button>
            <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void loadSecretAudit()}>{busy === 'secret-audit' ? 'Loading audit…' : 'Audit'}</button>
          </div>
        </> : <div style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 12 }}>
          Credential editor for <code>{form.connector_id}</code> is scaffolded but not active yet. Save non-secret source table config now; connector-specific secret fields arrive with live connector IO.
        </div>}
        {secretAudit !== null && <details open style={{ marginTop: 10 }}><summary>Secret audit</summary><PreviewJson value={secretAudit} empty="No audit." /></details>}
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void saveConfig()}>{busy === 'save-config' ? 'Saving…' : 'Save config'}</button>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void testConnection()}>{busy === 'test-connection' ? 'Testing…' : 'Test connection'}</button>
          <button className="btn btn-secondary" disabled={busy !== null || !savedConfig} onClick={applySavedConfig}>Load saved config</button>
          <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>
            saved: {savedConfig ? `${savedConfig.config_id} · ${savedConfig.enabled ? 'enabled' : 'disabled'}` : 'none'}
          </span>
        </div>
        {connectionTest !== null && (() => {
          const t = asObj(connectionTest);
          const ok = t.ok === true;
          return <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: ok ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)', color: ok ? 'var(--success)' : 'var(--warning)' }}>
            <b>{ok ? 'connection ok' : 'connection failed'}</b>
            <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>
              {ok
                ? `sampled ${val(t.sampled)} · fields ${val(t.fields_count)} · ${val(t.elapsed_ms)} ms`
                : val(t.error)}
            </span>
          </div>;
        })()}
        {discoveredFields.length > 0 && <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 8 }}>
            <div>
              <b>Fields to carry forward</b>
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Uncheck noisy AppSheet relation/list fields before Draft profile. Only selected fields are shown in the mapper and passed into the drafted profile.</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" type="button" onClick={() => selectAllFields(discoveredFields.map(f => String(f.name)).filter(Boolean))}>Select all</button>
              <button className="btn btn-secondary" type="button" onClick={() => selectAllFields(discoveredFields.filter(f => !isNoisySourceField(f)).map(f => String(f.name)).filter(Boolean))}>Exclude noisy</button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 6, maxHeight: 260, overflow: 'auto' }}>
            {discoveredFields.map(f => {
              const name = String(f.name);
              const noisy = isNoisySourceField(f);
              return <label key={name} style={{ display: 'block', padding: 6, borderRadius: 6, background: selectedSourceFieldSet.has(name) ? 'rgba(16, 185, 129, 0.08)' : 'rgba(148, 163, 184, 0.08)' }}>
                <input type="checkbox" checked={selectedSourceFieldSet.has(name)} onChange={e => setFieldSelected(name, e.target.checked)} style={{ marginRight: 6 }} />
                <code>{name}</code>{noisy && <span style={{ color: 'var(--warning)', marginLeft: 6 }}>noisy</span>}
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11 }}>{asArr(f.samples).slice(0, 2).map(val).join(' · ') || '—'}</span>
              </label>;
            })}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>Selected {selectedSourceFields.length} of {discoveredFields.length}. If you change selection after dry-run, run Draft profile/Dry-run again before approval.</div>
        </div>}
        <ul style={{ marginTop: 10, paddingLeft: 18, color: 'var(--text-secondary)' }}>
          {(selectedConnector?.safety ?? []).map(s => <li key={s}>{s}</li>)}
        </ul>
        <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>Saved source tables</h3>
          {sourceTables.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>No saved source tables yet. Save config after setting connector/table/key fields.</div>}
          {sourceTables.length > 0 && <div style={{ display: 'grid', gap: 8 }}>
            {sourceTables.map(t => <div key={String(t.source_table_id)} style={{ padding: 8, borderRadius: 6, background: String(t.source_table_id) === configId ? 'rgba(16, 185, 129, 0.10)' : 'rgba(148, 163, 184, 0.08)' }}>
              <div><code>{val(t.source_table_id)}</code> {t.enabled === false && <span style={{ color: 'var(--warning)' }}>disabled</span>}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>table: <code>{val(t.table_name)}</code> · key: <code>{val(t.primary_key_field)}</code> · updated: <code>{val(t.updated_at_field)}</code> · fields: {asArr(t.fields).length}</div>
              <button className="btn btn-secondary" type="button" style={{ marginTop: 6 }} onClick={() => setTransformSourcesText(prev => prev || JSON.stringify([{ alias: String(t.table_name || t.source_object || 'src').replace(/[^A-Za-z0-9_]+/g, '_'), source_table_id: t.source_table_id, connector: t.connector_id, object: t.source_object, fields: asArr(t.fields) }], null, 2))}>Use in transform sources</button>
            </div>)}
          </div>}
        </div>
      </section>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">2. Optional SQL transform</h2>
        <label style={{ display: 'block', marginBottom: 10 }}>
          <input type="checkbox" checked={transformEnabled} onChange={e => { setTransformEnabled(e.target.checked); if (!transformSourcesText) setTransformSourcesText(defaultTransformSources(form, selectedSourceFields)); invalidateTransformPreview(); }} style={{ marginRight: 8 }} />
          Enable SQL transform before mapping
        </label>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 10 }}>
          Use this for multi-source joins, counts and complex WHERE logic. Each source entry should reference a saved <code>source_table_id</code> (for example <code>appsheet-autopark.vehicles</code> or <code>bigquery-galery.vehicle_costs</code>); it is staged as a temporary PGlite table named by <code>alias</code>.
        </div>
        {transformEnabled && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <label>Primary key field in SQL result
            <input value={transformPrimaryKey} onChange={e => { setTransformPrimaryKey(e.target.value); invalidateTransformPreview(); }} placeholder="vehicleID" />
          </label>
          <label>Updated-at field in SQL result
            <input value={transformUpdatedAt} onChange={e => { setTransformUpdatedAt(e.target.value); invalidateTransformPreview(); }} placeholder="max_updated_at" />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>Transform sources JSON
            <textarea rows={7} value={transformSourcesText} onChange={e => { setTransformSourcesText(e.target.value); invalidateTransformPreview(); }} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>Read-only SQL
            <textarea rows={9} value={transformSql} onChange={e => { setTransformSql(e.target.value); invalidateTransformPreview(); }} placeholder={"SELECT main.vehicleID, main.govNumber, main.updatedAt AS max_updated_at\nFROM main\nWHERE main.vehicleID IS NOT NULL"} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          </label>
          <div style={{ gridColumn: '1 / -1', color: transformSources.length > 0 && transformSql.trim() ? 'var(--text-muted)' : 'var(--warning)', fontSize: 12 }}>
            Parsed sources: {transformSources.length}. SQL is sent only inside profile dry-run/approval; mutating SQL is rejected server-side.
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn btn-secondary" disabled={busy !== null || !canTransformPreview} onClick={() => void runTransformPreview()}>{busy === 'transform-preview' ? 'Previewing transform…' : 'Preview transform rows'}</button>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Inspect SQL result before article mapping and approval.</span>
          </div>
          {transformPreview !== null && <div style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <TransformResultPreview value={transformPreview} />
          </div>}
        </div>}
      </section>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">3. Review workflow</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void discover()}>{busy === 'discover' ? 'Discovering…' : 'Discover'}</button>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void draftProfile()}>{busy === 'draft' ? 'Drafting…' : 'Draft profile'}</button>
          <button className="btn btn-secondary" disabled={busy !== null || !canDryRun} onClick={() => void runDryRun()}>{busy === 'dry-run' ? 'Running…' : 'Dry-run preview'}</button>
          <button className="btn btn-primary" disabled={busy !== null || !canApprove} onClick={() => void approveProfile()}>{busy === 'approve' ? 'Approving…' : 'Approve profile'}</button>
          {dryRunSourceMismatch && <span style={{ color: 'var(--warning)', alignSelf: 'center' }}>Target source changed from dry-run ({dryRunSourceId}) to {form.target_source_id}; run dry-run preview again.</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 320px) 1fr', gap: 14, marginBottom: 14 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Source fields</h3>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>Click a field to insert <code>{'{{ field }}'}</code> into the active template box.</div>
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              {discoveredFields.length === 0 && <div style={{ color: 'var(--text-muted)' }}>Run Discover first.</div>}
              {discoveredFields.length > 0 && includedDiscoveryFields.length === 0 && <div style={{ color: 'var(--warning)' }}>No fields selected in Configure connector.</div>}
              {includedDiscoveryFields.map(f => <button key={String(f.name)} className="btn btn-secondary" style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left' }} onClick={() => insertFieldToken(String(f.name))}>
                <span className="mono">{val(f.name)}</span>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11 }}>{asArr(f.samples).slice(0, 2).map(val).join(' · ') || '—'}</span>
              </button>)}
            </div>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Article mapping editor — equipment template</h3>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 10 }}>
              Write static text and insert source-field tokens. Dry-run preview renders the final Markdown for several input rows. Editing mapping invalidates the previous dry-run/approval.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {Object.entries(articleSections).map(([key, value]) => <label key={key} style={{ display: 'block' }}>
                {SECTION_LABELS[key] || key}
                <textarea
                  rows={key === 'links' || key === 'notes' ? 4 : 2}
                  value={value}
                  onFocus={() => setActiveSection(key)}
                  onChange={e => updateArticleSection(key, e.target.value)}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                />
              </label>)}
            </div>
          </div>
        </div>
        {requiresSensitivityAck && <label style={{ display: 'block', marginBottom: 12, padding: 10, borderRadius: 6, background: 'rgba(245, 158, 11, 0.12)', color: 'var(--warning)' }}>
          <input type="checkbox" checked={sensitivityAck} onChange={e => setSensitivityAck(e.target.checked)} style={{ marginRight: 8 }} />
          I acknowledge this dry-run targets <code>{form.target_source_id}</code>, classification <code>{val(dryRunSensitivity.classification)}</code>, PII fields <code>{dryRunPiiFields.join(', ') || '—'}</code>, and any cross-source routing warnings.
        </label>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Discovery</h3>
            <DiscoveryPreview value={discovery} />
          </div>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Draft profile</h3>
            <PreviewJson value={draft} empty="No draft yet." />
          </div>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Dry-run</h3>
            <DryRunPreview value={dryRun} currentTargetSourceId={form.target_source_id} />
          </div>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Approval</h3>
            <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: 260, overflow: 'auto' }}>{approveResult ? JSON.stringify(approveResult, null, 2) : activeProfile ? `Ready: ${profileId(activeProfile)}` : 'Draft a profile first.'}</pre>
          </div>
        </div>
      </section>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">4. Profiles / refresh</h2>
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)}>
            <option value="">All profiles</option>
            {data.profiles.rows.map(p => <option key={p.profile_id} value={p.profile_id}>{p.profile_id} · {p.status} · v{p.current_version}</option>)}
          </select>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void refreshReport()}>Report due refresh</button>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void load()}>Reload</button>
        </div>
        <table>
          <thead><tr><th>profile</th><th>external</th><th>freshness</th><th>result</th><th>slug</th><th>stale after</th></tr></thead>
          <tbody>
            {data.status.rows.map((r, i) => (
              <tr key={i}>
                <td className="mono">{val(r.profile_id)}</td>
                <td className="mono">{val(r.external_id)}</td>
                <td>{statusBadge(r.freshness)}</td>
                <td>{val(r.last_result)}</td>
                <td className="mono">{val(r.slug)}</td>
                <td className="mono">{val(r.stale_after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {report !== null && (
        <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18 }}>
          <h2 className="section-title">Last report-only refresh plan</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{JSON.stringify(report, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
