import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ArticleViewEditor } from './source-ingest/ArticleViewEditor';
import { BaseViewEditor } from './source-ingest/BaseViewEditor';
import { ConnectorEditor } from './source-ingest/ConnectorEditor';
import { DEFAULT_CHANGE_INTELLIGENCE_POLICY, parseChangeIntelligence, serializeChangeIntelligence, type ChangeIntelligencePolicy } from './source-ingest/ChangeIntelligenceEditor';
import { SchemaWorkbench } from './source-ingest/SchemaWorkbench';
import { SourceIngestCatalogPanel } from './source-ingest/SourceIngestCatalogPanel';
import { SourceIngestWizard } from './source-ingest/SourceIngestWizard';
import { TransformViewEditor } from './source-ingest/TransformViewEditor';
import { asArr, asObj, MiniBadge, shortHash, type CatalogArea, type SourceIngestCatalogTree, val } from './source-ingest/shared';

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

interface BaseViewForm {
  base_view_id: string;
  connector_id: string;
  object_name: string;
  display_name: string;
  primary_key_field: string;
  updated_at_field: string;
  selected_fields_text: string;
  row_filter_text: string;
  sample_limit: number;
}

interface TransformViewForm {
  transform_view_id: string;
  display_name: string;
  inputs_text: string;
  sql: string;
  primary_key_field: string;
  updated_at_field: string;
}

interface ArticleViewForm {
  article_view_id: string;
  display_name: string;
  input_kind: 'base_view' | 'transform_view';
  input_id: string;
  gbrain_type: string;
  target_source_id: string;
  slug_template: string;
  external_id_field: string;
  display_name_field: string;
  natural_key_fields_text: string;
  status: string;
  freshness_policy: string;
  classification: string;
  pii: boolean;
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

function profileId(profile: unknown): string {
  return String((profile as Record<string, unknown> | null)?.profile_id ?? 'draft');
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

function SourceIngestLineagePanel({
  activeArea,
  activeNode,
  connectorId,
  baseId,
  transformId,
  articleId,
  articleRow,
  transformInputs,
  onSelectNode,
}: {
  activeArea: CatalogArea;
  activeNode: string;
  connectorId: string;
  baseId: string;
  transformId: string;
  articleId: string;
  articleRow: Record<string, unknown> | null;
  transformInputs: Array<{ alias: string; base_view_id: string }>;
  onSelectNode: (node: string) => void;
}) {
  const articleInputKind = String(articleRow?.input_kind ?? '');
  const articleInputId = String(articleRow?.input_id ?? '');
  const nodes = [
    { key: 'connector', label: 'Connector', id: connectorId, node: connectorId ? `connector:${connectorId}` : 'section:connectors', tone: connectorId ? 'ok' : 'muted' as const },
    { key: 'base', label: 'Base view', id: baseId || transformInputs[0]?.base_view_id || '', node: baseId ? `base_view:${baseId}` : 'section:base_views', tone: (baseId || transformInputs.length) ? 'ok' : 'muted' as const },
    { key: 'transform', label: 'Transform', id: transformId || (articleInputKind === 'transform_view' ? articleInputId : ''), node: (transformId || articleInputKind === 'transform_view') ? `transform_view:${transformId || articleInputId}` : 'section:transform_views', tone: (transformId || articleInputKind === 'transform_view') ? 'info' : 'muted' as const },
    { key: 'article', label: 'Article view', id: articleId, node: articleId ? `article_view:${articleId}` : 'section:article_views', tone: articleId ? (articleRow?.stale === true ? 'warn' : 'ok') : 'muted' as const },
  ];
  return <section style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 12, background: 'rgba(15,23,42,0.34)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 8 }}>
      <b>Lineage / цепочка публикации</b>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Активно: <code>{activeArea}</code> · <code>{activeNode}</code></span>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
      {nodes.map((n, i) => <button key={n.key} type="button" className="btn btn-secondary" onClick={() => onSelectNode(n.node)} style={{ textAlign: 'left' }}>
        <span style={{ display: 'block' }}><MiniBadge tone={n.tone}>{i + 1}</MiniBadge>{n.label}</span>
        <code style={{ display: 'block', marginTop: 4 }}>{n.id || 'не выбрано'}</code>
      </button>)}
    </div>
    {articleRow && <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>
      input: <code>{val(articleRow.input_kind)}:{val(articleRow.input_id)}</code> · target: <code>{val(articleRow.target_source_id)}</code> · chain: <code>{shortHash(articleRow.current_chain_hash)}</code>
    </div>}
  </section>;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseCsvLines(text: string): string[] {
  return text.split(/\\n|[\n,]/).map(s => s.trim()).filter(Boolean);
}

function catalogSlugPart(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function defaultBaseViewId(connectorId: string, objectName: string, tableName: string): string {
  return `bv-${catalogSlugPart(safeSourceTableId(connectorId, objectName, tableName))}`;
}

function discoveryFieldNames(value: unknown): string[] {
  return asArr<Record<string, unknown>>(asObj(value).fields).map(f => String(f.name ?? '')).filter(Boolean);
}

function discoveryObjectNames(value: unknown, connectorId?: string): string[] {
  const obj = asObj(value);
  const resultConnectorId = String(obj.connector_id ?? '');
  if (connectorId && resultConnectorId && resultConnectorId !== connectorId) return [];
  return asArr<Record<string, unknown>>(obj.objects).map(o => String(o.name ?? '')).filter(Boolean);
}

function compactDiscoveryForSave(value: unknown): Record<string, unknown> {
  const d = asObj(value);
  if (Object.keys(d).length === 0) return {};
  const compactFields = asArr<Record<string, unknown>>(d.fields).map(f => ({
    name: f.name,
    observedTypes: f.observedTypes,
    nullRatio: f.nullRatio,
    samples: asArr(f.samples).slice(0, 3).map(x => {
      const s = val(x);
      return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    }),
  }));
  return {
    connectorId: d.connectorId,
    objectName: d.objectName,
    totalEstimate: d.totalEstimate,
    sampled: d.sampled,
    fields: compactFields,
    idCandidates: d.idCandidates,
    updatedAtCandidates: d.updatedAtCandidates,
    parentCandidates: d.parentCandidates,
    warnings: d.warnings,
  };
}

function defaultRowFilterText(): string {
  return '[]';
}

function parseTransformInputs(text: string): Array<{ alias: string; base_view_id: string }> {
  return parseJsonArray(text).map(input => {
    const raw = asObj(input);
    return { alias: String(raw.alias ?? '').trim(), base_view_id: String(raw.base_view_id ?? raw.source_table_id ?? '').trim() };
  }).filter(input => input.alias && input.base_view_id);
}

function defaultTransformViewInputs(baseViewId: string, alias = 'main'): string {
  return JSON.stringify([{ alias, base_view_id: baseViewId }], null, 2);
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

function transformSourcesForInputs(inputs: Array<{ alias: string; base_view_id: string }>, baseViews: Array<Record<string, unknown>>) {
  const lookup = new Map(baseViews.map(row => [String(row.base_view_id), row]));
  return inputs.map(input => {
    const base = lookup.get(input.base_view_id);
    const fields = asArr(base?.selected_fields).map(String).filter(Boolean);
    return {
      alias: input.alias,
      source_table_id: input.base_view_id,
      connector: String(base?.connector_id ?? ''),
      object: String(base?.object_name ?? input.base_view_id),
      fields,
      sample_limit: Number(base?.sample_limit) || 25,
    };
  });
}

function splitSqlProjection(selectList: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of selectList) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { if (current.trim()) parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function sqlProjectionFieldNames(sql: string): string[] {
  const match = sql.match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!match) return [];
  return splitSqlProjection(match[1]).flatMap(part => {
    if (/\.\*/.test(part) || part.trim() === '*') return [];
    const asMatch = part.match(/\bas\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*$/i);
    if (asMatch) return [asMatch[1]];
    const tail = part.match(/(?:^|\.)"?([A-Za-z_][A-Za-z0-9_]*)"?\s*$/);
    return tail ? [tail[1]] : [];
  }).filter((v, i, arr) => v && arr.indexOf(v) === i);
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

function sourceTableCell(row: Record<string, unknown>, field: string): unknown {
  const source = asObj(row.source_fields);
  const data = asObj(row.data);
  return Object.prototype.hasOwnProperty.call(source, field) ? source[field] : data[field];
}

function SourceSampleRowsTable({ discovery, selected }: { discovery: unknown; selected: string[] }) {
  const d = asObj(discovery);
  const rows = asArr<Record<string, unknown>>(d.samples).slice(0, Number(d.sampled) || 25);
  const fields = selected.length ? selected : discoveryFieldNames(discovery);
  if (rows.length === 0 || fields.length === 0) return null;
  return <div style={{ gridColumn: '1 / -1', marginTop: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
      <b>Sample rows</b>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{rows.length} rows × {fields.length} selected columns</span>
    </div>
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', maxHeight: 520, background: 'rgba(255,255,255,0.03)' }}>
      <table style={{ margin: 0, width: 'max-content', minWidth: '100%', borderCollapse: 'collapse' }}>
        <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-secondary)' }}>
          <tr>
            <th style={{ width: 52 }}>#</th>
            {fields.map(field => <th key={field} className="mono"><code>{field}</code></th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => <tr key={`${String(row.external_id ?? i)}-${i}`} style={{ background: i % 2 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
            <td style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
            {fields.map(field => <td key={`${i}-${field}`} className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val(sourceTableCell(row, field)) || '—'}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>;
}

function FieldSelectionPanel({ discovery, selected, onChange }: { discovery: unknown; selected: string[]; onChange: (fields: string[]) => void }) {
  const d = asObj(discovery);
  const fields = asArr<Record<string, unknown>>(d.fields);
  if (fields.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Run Execute / Discover fields to show selectable source fields.</div>;
  }
  const selectedSet = new Set(selected);
  const allNames = fields.map(f => String(f.name ?? '')).filter(Boolean);
  const recommended = fields.filter(f => !isNoisySourceField(f)).map(f => String(f.name ?? '')).filter(Boolean);
  const idCandidates = new Set(asArr(d.idCandidates).map(String));
  const updatedCandidates = new Set(asArr(d.updatedAtCandidates).map(String));
  const setField = (name: string, checked: boolean) => {
    const next = new Set(selectedSet);
    if (checked) next.add(name); else next.delete(name);
    onChange(allNames.filter(n => next.has(n)));
  };
  return <div style={{ gridColumn: '1 / -1' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
      <div>
        <b>Schema / selected fields</b>
        <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{selected.length} / {allNames.length}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px' }} onClick={() => onChange(allNames)}>Select all</button>
        <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px' }} onClick={() => onChange(recommended)}>Recommended</button>
        <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px' }} onClick={() => onChange([])}>Clear</button>
      </div>
    </div>
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', maxHeight: 430, background: 'rgba(255,255,255,0.03)' }}>
      <table style={{ margin: 0, width: '100%', borderCollapse: 'collapse' }}>
        <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-secondary)' }}>
          <tr>
            <th style={{ width: 48, textAlign: 'center' }}>Use</th>
            <th style={{ width: 42, textAlign: 'center' }}>PK</th>
            <th>Field name</th>
            <th style={{ width: 150 }}>Field type</th>
            <th>Samples</th>
            <th style={{ width: 130 }}>Description</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => {
            const name = String(f.name ?? '');
            const noisy = isNoisySourceField(f);
            const types = asArr(f.observedTypes).map(String).join(', ') || 'unknown';
            const samples = asArr(f.samples).slice(0, 3).map(val).join(' · ');
            const isPk = idCandidates.has(name);
            const isUpdated = updatedCandidates.has(name);
            return <tr key={`${name}-${i}`} style={{ background: selectedSet.has(name) ? 'rgba(136,170,255,0.10)' : i % 2 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
              <td style={{ textAlign: 'center' }}><input aria-label={`Use ${name}`} type="checkbox" checked={selectedSet.has(name)} onChange={e => setField(name, e.target.checked)} /></td>
              <td style={{ textAlign: 'center', color: isPk ? 'var(--success)' : 'var(--text-muted)', fontWeight: isPk ? 700 : 400 }}>{isPk ? '✓' : ''}</td>
              <td className="mono"><code>{name}</code>{isUpdated && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>updated</span>}</td>
              <td>{types}</td>
              <td className="mono" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{samples || '—'}</td>
              <td>{noisy ? <span style={{ color: 'var(--warning)' }}>noisy / related</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
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

function DryRunPreview({ value, currentTargetSourceId }: { value: unknown; currentTargetSourceId: string }) {
  const raw = asObj(value);
  const d = Object.keys(asObj(raw.dry_run)).length > 0 ? asObj(raw.dry_run) : raw;
  if (!value) return <div style={{ color: 'var(--text-muted)' }}>No dry-run yet.</div>;
  const counts = asObj(d.counts);
  const stratifiedSamples = asObj(d.stratified_samples);
  const samplePages = asArr<Record<string, unknown>>(d.sample_pages).length > 0
    ? asArr<Record<string, unknown>>(d.sample_pages)
    : asArr<Record<string, unknown>>(stratifiedSamples.would_write);
  const warnings = asArr(d.warnings);
  const sensitivity = asObj(d.routing_sensitivity);
  const piiFields = asArr(sensitivity.pii_fields).map(String);
  const hasPii = sensitivity.pii === true || piiFields.length > 0;
  const routedSource = String(sensitivity.approved_source_id ?? currentTargetSourceId ?? '—');
  const crossSource = routedSource !== '—' && currentTargetSourceId && routedSource !== currentTargetSourceId;
  const metricKeys = ['sampled', 'would_write', 'skipped', 'slug_collisions'];
  return <div style={{ color: 'var(--text-secondary)' }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 10 }}>
      {metricKeys.map(k => <div key={k} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'rgba(15, 23, 42, 0.38)' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>{k}</div>
        <div style={{ fontSize: 20, lineHeight: 1.15, fontWeight: 700, color: 'var(--text-primary)', marginTop: 4 }}>{val(counts[k])}</div>
      </div>)}
    </div>
    <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${hasPii || crossSource ? 'rgba(245, 158, 11, 0.35)' : 'rgba(16, 185, 129, 0.28)'}`, background: hasPii || crossSource ? 'rgba(245, 158, 11, 0.08)' : 'rgba(16, 185, 129, 0.06)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ color: hasPii || crossSource ? 'var(--warning)' : 'var(--success)' }}>Routing</b>
        <span>target <code>{currentTargetSourceId || '—'}</code></span>
        <span>dry-run <code>{routedSource}</code></span>
        <span>class <code>{val(sensitivity.classification)}</code></span>
        <span>pii <code>{String(hasPii)}</code></span>
        <span>pii_fields {piiFields.length ? piiFields.map(f => <code key={f} style={{ marginLeft: 4 }}>{f}</code>) : '—'}</span>
      </div>
      {crossSource && <div style={{ marginTop: 4, color: 'var(--warning)' }}>Cross-source mismatch: dry-run routing source differs from selected target source.</div>}
    </div>
    {warnings.length > 0 && <div style={{ color: 'var(--warning)', marginBottom: 8 }}>Warnings: {warnings.map(String).join(', ')}</div>}
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
      <table style={{ margin: 0 }}><thead><tr><th>slug</th><th>title</th><th>external</th><th>empty template slots</th></tr></thead><tbody>
        {samplePages.map((p, i) => <tr key={i}><td className="mono">{val(p.slug)}</td><td>{hasPii ? '[PII masked]' : val(p.title)}</td><td className="mono">{val(p.external_id)}</td><td>{asArr(p.article_empty_slots).map(String).join(', ') || '—'}</td></tr>)}
      </tbody></table>
    </div>
    {samplePages.length > 0 && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', color: 'var(--text-primary)' }}>{hasPii ? 'Rendered article previews (PII fields masked)' : 'Rendered article previews'}</summary>
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
  const [secretForm, setSecretForm] = useState({ app_id: '', access_key: '', connection_string: '' });
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
  const [catalogConnectorForm, setCatalogConnectorForm] = useState({ connector_id: 'appsheet-protokolist', kind: 'appsheet', display_name: '', enabled: true });
  const [catalogConnectorObjects, setCatalogConnectorObjects] = useState<unknown>(null);
  const [catalogConnectorTest, setCatalogConnectorTest] = useState<unknown>(null);
  const [catalogDeleteImpact, setCatalogDeleteImpact] = useState<unknown>(null);
  const [catalogConnectorSecretStatus, setCatalogConnectorSecretStatus] = useState<unknown>(null);
  const [baseViewForm, setBaseViewForm] = useState<BaseViewForm>({
    base_view_id: '',
    connector_id: '',
    object_name: '',
    display_name: '',
    primary_key_field: '',
    updated_at_field: '',
    selected_fields_text: '',
    row_filter_text: '[]',
    sample_limit: 25,
  });
  const [baseViewSaveResult, setBaseViewSaveResult] = useState<unknown>(null);
  const [baseViewDiscovery, setBaseViewDiscovery] = useState<unknown>(null);
  const [transformViewForm, setTransformViewForm] = useState<TransformViewForm>({
    transform_view_id: 'tv-vehicles-clean',
    display_name: 'Автотранспорт transform',
    inputs_text: defaultTransformViewInputs('bv-appsheet-vehicles-vehicle-vehicles'),
    sql: 'SELECT main.* FROM main',
    primary_key_field: 'vehicleID',
    updated_at_field: '',
  });
  const [transformViewSaveResult, setTransformViewSaveResult] = useState<unknown>(null);
  const [articleViewForm, setArticleViewForm] = useState<ArticleViewForm>({
    article_view_id: 'av-equipment',
    display_name: 'Equipment articles',
    input_kind: 'transform_view',
    input_id: 'tv-bv-appsheet-avto-vehicles',
    gbrain_type: 'equipment',
    target_source_id: 'shared',
    slug_template: 'source-ingest/vehicles/{{ vehicleID | slugify }}',
    external_id_field: 'vehicleID',
    display_name_field: 'govNumber',
    natural_key_fields_text: 'govNumber',
    status: 'draft',
    freshness_policy: 'P30D',
    classification: 'shared',
    pii: false,
  });
  const [articleChangePolicy, setArticleChangePolicy] = useState<ChangeIntelligencePolicy>(DEFAULT_CHANGE_INTELLIGENCE_POLICY);
  const [articleViewSaveResult, setArticleViewSaveResult] = useState<unknown>(null);
  const [articleViewApproveResult, setArticleViewApproveResult] = useState<unknown>(null);
  const [articleViewPreview, setArticleViewPreview] = useState<unknown>(null);
  const [articleViewCurrentChainHash, setArticleViewCurrentChainHash] = useState('');
  const [articleViewRuns, setArticleViewRuns] = useState<unknown>(null);
  const [articleViewRunResult, setArticleViewRunResult] = useState<unknown>(null);
  const [articleTemplate, setArticleTemplate] = useState<unknown>(null);
  const [schemaWorkbench, setSchemaWorkbench] = useState<unknown>(null);
  const [schemaType, setSchemaType] = useState('');
  const [schemaTypeExplain, setSchemaTypeExplain] = useState<unknown>(null);
  const [schemaTypeCard, setSchemaTypeCard] = useState<unknown>(null);
  const [activeArea, setActiveArea] = useState<CatalogArea>('connectors');
  const [activeNode, setActiveNode] = useState('section:connectors');

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
    try {
      setSchemaWorkbench(await api.sourceIngestSchemaView());
    } catch (e) {
      setErr(prev => prev ?? `schema_view_unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const refreshCatalogTree = async () => {
    const tree = await api.sourceIngestCatalogTree();
    setData(prev => prev ? { ...prev, catalog_tree: tree } : prev);
    return tree;
  };

  useEffect(() => { void load(); }, []);

  const loadArticleTemplate = async (type: string, opts: { resetEmpty?: boolean } = {}) => {
    if (!type.trim()) return;
    try {
      const tmpl = await api.sourceIngestArticleTemplate(type.trim());
      setArticleTemplate(tmpl);
      const sections = asArr<Record<string, unknown>>(asObj(tmpl).sections);
      if (sections.length > 0) {
        setArticleSections(prev => {
          const next: Record<string, string> = {};
          for (const section of sections) {
            const key = String(section.key ?? '').trim();
            if (!key) continue;
            next[key] = opts.resetEmpty && !String(prev[key] ?? '').trim() ? '' : String(prev[key] ?? '');
          }
          for (const [key, value] of Object.entries(prev)) if (!(key in next) && String(value || '').trim()) next[key] = value;
          return next;
        });
      }
    } catch (e) {
      setErr(prev => prev ?? `article_template_unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => { void loadArticleTemplate(articleViewForm.gbrain_type, { resetEmpty: true }); }, [articleViewForm.gbrain_type]);

  const catalogConnectors = data?.catalog_tree?.connectors ?? [];
  const articleTemplateObj = asObj(articleTemplate);
  const articleTemplateSections = asArr<Record<string, unknown>>(articleTemplateObj.sections);
  const articleSectionLabels = Object.fromEntries(articleTemplateSections.map(section => [String(section.key ?? ''), String(section.label ?? section.key ?? '')]).filter(([key]) => key));
  const articleRequiredFrontmatter = asArr(articleTemplateObj.required_frontmatter).map(String);
  const schemaObj = asObj(schemaWorkbench);
  const schemaGraph = asObj(schemaObj.graph);
  const schemaNodes = asArr<Record<string, unknown>>(schemaGraph.nodes);
  const schemaEdges = asArr<Record<string, unknown>>(schemaGraph.edges);
  const activeSchemaPack = asObj(schemaObj.active_pack);
  const schemaStats = asObj(schemaObj.stats);
  const catalogBaseViews = data?.catalog_tree?.base_views ?? [];
  const catalogTransformViews = data?.catalog_tree?.transform_views ?? [];
  const articleInputChoices = [
    ...catalogBaseViews.map(row => ({ kind: 'base_view' as const, id: String(row.base_view_id), label: `base_view · ${String(row.base_view_id)}` })),
    ...catalogTransformViews.map(row => ({ kind: 'transform_view' as const, id: String(row.transform_view_id), label: `transform_view · ${String(row.transform_view_id)}` })),
  ];
  const articleAvailableFields = useMemo(() => {
    if (articleViewForm.input_kind === 'base_view') {
      const base = catalogBaseViews.find(row => String(row.base_view_id) === articleViewForm.input_id);
      return asArr(base?.selected_fields).map(String).filter(Boolean);
    }
    const previewKeys = Array.from(new Set(asArr<Record<string, unknown>>(asObj(transformPreview).records).flatMap(r => Object.keys(asObj(r.data)))));
    if (previewKeys.length > 0) return previewKeys;
    const currentTransform = articleViewForm.input_id === transformViewForm.transform_view_id
      ? { inputs: parseTransformInputs(transformViewForm.inputs_text), sql: transformViewForm.sql }
      : (() => {
          const row = catalogTransformViews.find(t => String(t.transform_view_id) === articleViewForm.input_id);
          return row ? { inputs: asArr<Record<string, unknown>>(row.inputs).map(input => ({ alias: String(input.alias ?? ''), base_view_id: String(input.base_view_id ?? '') })).filter(input => input.alias && input.base_view_id), sql: String(row.sql ?? '') } : null;
        })();
    if (!currentTransform) return [];
    const projected = sqlProjectionFieldNames(currentTransform.sql);
    if (projected.length > 0) return projected;
    const baseLookup = new Map(catalogBaseViews.map(row => [String(row.base_view_id), row]));
    return Array.from(new Set(currentTransform.inputs.flatMap(input => asArr(baseLookup.get(input.base_view_id)?.selected_fields).map(String).filter(Boolean))));
  }, [articleViewForm.input_kind, articleViewForm.input_id, catalogBaseViews, catalogTransformViews, transformPreview, transformViewForm.inputs_text, transformViewForm.sql, transformViewForm.transform_view_id]);

  useEffect(() => {
    if (typeof window === 'undefined' || !data?.catalog_tree) return;
    const applyHashRoute = () => {
      const section = window.location.hash.match(/^#source-ingest\/(connectors|base|transform|article|schema)$/);
      if (section) {
        const area = section[1] === 'base' ? 'base_views' : section[1] === 'transform' ? 'transform_views' : section[1] === 'article' ? 'article_views' : section[1] === 'schema' ? 'schema_view' : 'connectors';
        setActiveArea(area);
        setActiveNode(`section:${area}`);
        return;
      }
      const m = window.location.hash.match(/^#source-ingest\/(connector|base|transform|article)\/([^/?#]+)/);
      if (!m) return;
      const id = decodeURIComponent(m[2]);
      if (m[1] === 'connector') {
        const row = (data.catalog_tree?.connectors ?? []).find(r => String(r.connector_id) === id);
        if (row) selectCatalogConnector(row);
      } else if (m[1] === 'base') {
        const row = (data.catalog_tree?.base_views ?? []).find(r => String(r.base_view_id) === id);
        if (row) selectBaseView(row);
      } else if (m[1] === 'transform') {
        const row = (data.catalog_tree?.transform_views ?? []).find(r => String(r.transform_view_id) === id);
        if (row) selectTransformView(row);
      } else if (m[1] === 'article') {
        const row = (data.catalog_tree?.article_views ?? []).find(r => String(r.article_view_id) === id);
        if (row) selectArticleView(row);
      }
    };
    applyHashRoute();
    window.addEventListener('hashchange', applyHashRoute);
    return () => window.removeEventListener('hashchange', applyHashRoute);
  }, [data?.catalog_tree]);

  const catalogConnectorChoices = catalogConnectors.map(c => {
    const kind = String(c.kind ?? '');
    return { id: String(c.connector_id), kind, displayName: String(c.display_name ?? c.connector_id), status: 'catalog', object: '', fields: undefined, requiredKeys: kind === 'appsheet' ? ['app_id', 'access_key'] : kind === 'postgres' ? ['connection_string'] : [], requiredEnv: [], safety: ['First-class catalog connector: table binding is configured in base/source table settings.'] };
  });
  const connectorChoices = [
    ...catalogConnectorChoices,
    ...(data?.connectors ?? []).map(c => ({ id: c.id, kind: c.kind ?? c.id, displayName: c.displayName, status: c.status, object: c.object, fields: c.fields, requiredKeys: c.requiredKeys, requiredEnv: c.requiredEnv, safety: c.safety })),
  ].filter((c, i, arr) => c.id && arr.findIndex(x => x.id === c.id) === i);
  const selectedConnector = connectorChoices.find(c => c.id === form.connector_id);
  const sourceTables = data?.source_tables ?? [];
  const configId = safeSourceTableId(form.connector_id, form.source_object, form.table_name);
  const matchingConfigs = data?.connector_configs?.rows?.filter(c => c.connector_id === form.connector_id && c.source_object === form.source_object) ?? [];
  const savedConfig = data?.connector_configs?.rows?.find(c => c.config_id === configId)
    || (matchingConfigs.length === 1 ? matchingConfigs[0] : undefined);
  const secretStatus = (savedConfig?.secrets as Record<string, unknown> | undefined)
    || { configured: false, missing_keys: selectedConnector?.requiredKeys ?? [], required_keys: selectedConnector?.requiredKeys ?? [], missing_env: selectedConnector?.requiredEnv ?? [], required_env: selectedConnector?.requiredEnv ?? [], masked: {}, storage: 'none' };
  const effectiveBaseViewId = baseViewForm.base_view_id.trim() || (baseViewForm.connector_id && baseViewForm.object_name ? defaultBaseViewId(baseViewForm.connector_id, baseViewForm.object_name, baseViewForm.object_name) : '');
  const baseViewSelectedFields = parseCsvLines(baseViewForm.selected_fields_text);
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
  const catalogTransformInputs = parseTransformInputs(transformViewForm.inputs_text);
  const canCatalogTransformPreview = Boolean(catalogTransformInputs.length > 0 && transformViewForm.sql.trim() && transformViewForm.primary_key_field);
  const canTransformPreview = Boolean((profileForReview && transformEnabled && transformSources.length > 0 && transformSql.trim()) || canCatalogTransformPreview);
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
  const studioSectionStyle = (areas: CatalogArea | CatalogArea[]): React.CSSProperties => {
    const areaList = Array.isArray(areas) ? areas : [areas];
    return {
      display: areaList.includes(activeArea) ? 'block' : 'none',
      background: 'var(--bg-secondary)',
      borderRadius: 8,
      padding: 18,
      marginBottom: 20,
    };
  };

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
    setSecretForm({ app_id: '', access_key: '', connection_string: '' });
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
      display_name: catalogConnectorForm.display_name.trim() || catalogConnectorForm.connector_id,
      config_json: catalogConnectorForm.kind === 'postgres'
        ? { source: 'admin-ui', phase: 'catalog-tree-shell', schema: 'gbrain', allowed_objects: ['companies', 'departments', 'positions', 'employees'] }
        : { source: 'admin-ui', phase: 'catalog-tree-shell' },
    });
    await load();
  });

  const setRouteHash = (node: string) => {
    if (typeof window === 'undefined') return;
    if (!node.includes(':')) return;
    const [kind, id] = node.split(':', 2);
    if (kind === 'section') {
      const routeArea = id === 'base_views' ? 'base' : id === 'transform_views' ? 'transform' : id === 'article_views' ? 'article' : id === 'schema_view' ? 'schema' : id;
      window.location.hash = `#source-ingest/${routeArea}`;
      return;
    }
    if (!id || id === 'new') return;
    const routeKind = kind === 'base_view' ? 'base' : kind === 'transform_view' ? 'transform' : kind === 'article_view' ? 'article' : kind;
    window.location.hash = `#source-ingest/${routeKind}/${encodeURIComponent(id)}`;
  };

  const handleSelectCatalogNode = (node: string) => {
    setActiveNode(node);
    setRouteHash(node);
    if (node.startsWith('section:')) {
      const area = node.slice('section:'.length);
      if (area === 'connectors' || area === 'base_views' || area === 'transform_views' || area === 'article_views' || area === 'schema_view') setActiveArea(area);
      return;
    }
    if (node === 'base_view:new') {
      setActiveArea('base_views');
      const connectorId = catalogConnectorForm.connector_id || String(catalogConnectors[0]?.connector_id ?? '');
      setBaseViewForm({
        base_view_id: '',
        connector_id: connectorId,
        object_name: '',
        display_name: '',
        primary_key_field: '',
        updated_at_field: '',
        selected_fields_text: '',
        row_filter_text: '[]',
        sample_limit: 25,
      });
      setBaseViewDiscovery(null);
      setBaseViewSaveResult(null);
    } else if (node === 'transform_view:new') {
      setActiveArea('transform_views');
    } else if (node === 'article_view:new') {
      setActiveArea('article_views');
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const shortcuts: Array<{ key: string; area: CatalogArea; node: string }> = [
      { key: '1', area: 'connectors', node: 'section:connectors' },
      { key: '2', area: 'base_views', node: 'section:base_views' },
      { key: '3', area: 'transform_views', node: 'section:transform_views' },
      { key: '4', area: 'article_views', node: 'section:article_views' },
      { key: '5', area: 'schema_view', node: 'section:schema_view' },
    ];
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const hit = shortcuts.find(s => s.key === event.key);
      if (!hit) return;
      event.preventDefault();
      setActiveArea(hit.area);
      handleSelectCatalogNode(hit.node);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [catalogConnectors, catalogConnectorForm.connector_id]);

  const selectCatalogConnector = (row: Record<string, unknown>) => {
    setActiveArea('connectors');
    const connectorId = String(row.connector_id ?? '');
    setActiveNode(`connector:${connectorId}`);
    setRouteHash(`connector:${connectorId}`);
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

  const catalogConnectorSecretConfigId = () => `connector:${catalogConnectorForm.connector_id}`;
  const catalogConnectorPayload = () => ({
    connector_id: catalogConnectorForm.connector_id,
    kind: catalogConnectorForm.kind,
    config_id: catalogConnectorSecretConfigId(),
  });

  useEffect(() => {
    const connectorId = baseViewForm.connector_id.trim();
    if (!connectorId) return;
    const current = asObj(catalogConnectorObjects);
    const currentObjects = asArr<Record<string, unknown>>(current.objects);
    if (String(current.connector_id ?? '') === connectorId && currentObjects.length > 0) return;
    const row = catalogConnectors.find(c => String(c.connector_id ?? '') === connectorId);
    if (!row) return;
    let cancelled = false;
    void api.sourceIngestConnectorListObjects({
      connector_id: connectorId,
      kind: String(row.kind ?? 'appsheet'),
      config_id: `connector:${connectorId}`,
    }).then(out => {
      if (!cancelled) setCatalogConnectorObjects(out);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [baseViewForm.connector_id, catalogConnectorObjects, catalogConnectors]);

  const explainSchemaType = async (type: string) => runStep('schema-explain-type', async () => {
    const t = type.trim();
    if (!t) return;
    setSchemaType(t);
    const [explain, card] = await Promise.all([
      api.sourceIngestSchemaExplainType(t),
      api.sourceIngestSchemaTypeCard(t),
    ]);
    setSchemaTypeExplain(explain);
    setSchemaTypeCard(card);
  });

  const createSchemaProposal = async (payload: Record<string, unknown>) => {
    let result: unknown = null;
    await runStep('schema-proposal', async () => {
      result = await api.sourceIngestSchemaProposalCreate(payload);
    });
    return result;
  };

  const saveCatalogConnectorCredentials = async () => runStep('catalog-save-secret', async () => {
    await api.sourceIngestSaveCatalogConnector({
      ...catalogConnectorForm,
      display_name: catalogConnectorForm.display_name.trim() || catalogConnectorForm.connector_id,
      config_json: catalogConnectorForm.kind === 'postgres'
        ? { source: 'admin-ui', phase: 'catalog-tree-shell', schema: 'gbrain', allowed_objects: ['companies', 'departments', 'positions', 'employees'] }
        : { source: 'admin-ui', phase: 'catalog-tree-shell' },
    });
    await api.sourceIngestSaveConfig({
      config_id: catalogConnectorSecretConfigId(),
      connector_id: catalogConnectorForm.connector_id,
      source_object: '__connection__',
      display_name: catalogConnectorForm.display_name.trim() || catalogConnectorForm.connector_id,
      enabled: true,
      config_json: { connector_level: true, kind: catalogConnectorForm.kind },
    });
    const status = await api.sourceIngestSaveSecret({
      config_id: catalogConnectorSecretConfigId(),
      connector_id: catalogConnectorForm.connector_id,
      source_object: '__connection__',
      secrets: secretForm,
    });
    setCatalogConnectorSecretStatus(status);
    setSecretForm({ app_id: '', access_key: '', connection_string: '' });
    setSecretAudit(await api.sourceIngestSecretAudit(catalogConnectorSecretConfigId()));
    await load();
  });

  const deleteCatalogConnectorCredentials = async () => runStep('catalog-delete-secret', async () => {
    const status = await api.sourceIngestDeleteSecret({
      config_id: catalogConnectorSecretConfigId(),
      connector_id: catalogConnectorForm.connector_id,
      source_object: '__connection__',
    });
    setCatalogConnectorSecretStatus(status);
    setSecretAudit(await api.sourceIngestSecretAudit(catalogConnectorSecretConfigId()));
    await load();
  });

  const listCatalogConnectorObjects = async () => runStep('catalog-list-objects', async () => {
    setCatalogConnectorObjects(await api.sourceIngestConnectorListObjects(catalogConnectorPayload()));
  });

  const testCatalogConnector = async () => runStep('catalog-test-connector', async () => {
    const out = await api.sourceIngestCatalogConnectorTest(catalogConnectorPayload());
    setCatalogConnectorTest(out);
    const objs = asArr<Record<string, unknown>>(asObj(out).objects);
    if (objs.length > 0) setCatalogConnectorObjects(out);
  });

  const runDeleteGuard = async (kind: string, id: string): Promise<{ confirmed: boolean; token?: string }> => {
    const out = await api.sourceIngestCatalogDeleteImpact({ kind, id });
    const impact = asObj(asObj(out).impact);
    setCatalogDeleteImpact(impact);
    if (impact.exists === false) return { confirmed: true, token: String(impact.confirm_token ?? '') };
    if (impact.blocking !== true) {
      const ok = window.confirm(`Delete ${kind} ${id}? No dependent catalog objects were found.`);
      return { confirmed: ok, token: String(impact.confirm_token ?? '') };
    }
    const deps = asObj(impact.dependencies);
    const baseCount = asArr(deps.base_views).length;
    const transformCount = asArr(deps.transform_views).length;
    const articleCount = asArr(deps.article_views).length;
    const ok = window.confirm(`Delete ${kind} ${id}? This has dependencies: ${baseCount} base views, ${transformCount} transform views, ${articleCount} article views. This may break downstream previews/runs. Confirm force delete?`);
    return { confirmed: ok, token: String(impact.confirm_token ?? '') };
  };

  const deleteCatalogConnector = async () => runStep('catalog-delete-connector', async () => {
    const guard = await runDeleteGuard('connector', catalogConnectorForm.connector_id);
    if (!guard.confirmed) return;
    await api.sourceIngestDeleteCatalogConnector(catalogConnectorForm.connector_id, guard.token, true);
    setCatalogConnectorObjects(null);
    setCatalogConnectorTest(null);
    await load();
  });

  const selectBaseView = (row: Record<string, unknown>) => {
    setActiveArea('base_views');
    setActiveNode(`base_view:${String(row.base_view_id ?? '')}`);
    setRouteHash(`base_view:${String(row.base_view_id ?? '')}`);
    const discoveryJson = asObj(row.discovery_json);
    const selected = asArr(row.selected_fields).map(String);
    setBaseViewForm({
      base_view_id: String(row.base_view_id ?? ''),
      connector_id: String(row.connector_id ?? form.connector_id),
      object_name: String(row.object_name ?? form.source_object),
      display_name: String(row.display_name ?? row.base_view_id ?? ''),
      primary_key_field: String(asObj(discoveryJson).primary_key_field ?? asArr(asObj(discoveryJson).idCandidates)[0] ?? 'vehicleID'),
      updated_at_field: String(asObj(discoveryJson).updated_at_field ?? asArr(asObj(discoveryJson).updatedAtCandidates)[0] ?? ''),
      selected_fields_text: selected.join('\n'),
      row_filter_text: JSON.stringify(asArr(row.row_filter), null, 2),
      sample_limit: Number(row.sample_limit ?? form.sample_limit ?? 25),
    });
    const hydratedDiscovery = Object.keys(discoveryJson).length ? discoveryJson : discovery;
    setDiscovery(hydratedDiscovery);
    setBaseViewDiscovery(hydratedDiscovery);
    setBaseViewSaveResult(null);
  };

  const seedBaseViewFromReview = () => {
    const fields = selectedSourceFields.length ? selectedSourceFields : discoveryFieldNames(discovery);
    const baseId = defaultBaseViewId(form.connector_id, form.source_object, form.table_name);
    setBaseViewForm({
      base_view_id: baseId,
      connector_id: form.connector_id,
      object_name: form.source_object,
      display_name: `${form.table_name || form.source_object} source view`,
      primary_key_field: form.primary_key_field || 'vehicleID',
      updated_at_field: form.updated_at_field || '',
      selected_fields_text: fields.join('\n'),
      row_filter_text: defaultRowFilterText(),
      sample_limit: form.sample_limit,
    });
    setBaseViewDiscovery(null);
    setBaseViewSaveResult(null);
  };

  const discoverBaseView = async () => runStep('catalog-base-view-discover', async () => {
    const selectedFields = parseCsvLines(baseViewForm.selected_fields_text);
    const baseViewId = effectiveBaseViewId;
    const savedBase = catalogBaseViews.some(row => String(row.base_view_id) === baseViewId);
    const out = await api.sourceIngestExecuteBaseView({
      ...(savedBase ? { base_view_id: baseViewId } : { draft: {
        connector_id: baseViewForm.connector_id,
        object_name: baseViewForm.object_name,
        selected_fields: selectedFields,
        row_filter: parseJsonArray(baseViewForm.row_filter_text),
        sample_limit: Number(baseViewForm.sample_limit) || 25,
        discovery_json: {
          primary_key_field: baseViewForm.primary_key_field || undefined,
          updated_at_field: baseViewForm.updated_at_field || undefined,
        },
      } }),
      sample_limit: Number(baseViewForm.sample_limit) || 25,
      discover_all_fields: true,
    });
    const discoveryOut = asObj(out).discovery || out;
    setBaseViewDiscovery(discoveryOut);
    const idCandidates = asArr(asObj(discoveryOut).idCandidates).map(String);
    const updatedCandidates = asArr(asObj(discoveryOut).updatedAtCandidates).map(String);
    const fields = discoveryFieldNames(discoveryOut);
    if (idCandidates[0] && !baseViewForm.primary_key_field.trim()) setBaseViewForm(prev => ({ ...prev, primary_key_field: idCandidates[0] }));
    if (updatedCandidates[0] && !baseViewForm.updated_at_field.trim()) setBaseViewForm(prev => ({ ...prev, updated_at_field: updatedCandidates[0] }));
    if (!baseViewForm.base_view_id.trim() && baseViewForm.connector_id && baseViewForm.object_name) {
      setBaseViewForm(prev => ({ ...prev, base_view_id: defaultBaseViewId(prev.connector_id, prev.object_name, prev.object_name) }));
    }
    if (fields.length > 0 && (!baseViewForm.selected_fields_text.trim() || fields.length > selectedFields.length)) {
      setBaseViewForm(prev => ({ ...prev, selected_fields_text: fields.join('\n') }));
    }
    if (savedBase) await refreshCatalogTree();
  });

  const saveBaseView = async () => runStep('catalog-base-view', async () => {
    const rowFilter = parseJsonArray(baseViewForm.row_filter_text);
    const baseViewId = effectiveBaseViewId;
    if (!baseViewId) throw new Error('base_view_id_required: enter connector and source object, then use the generated Base view id or type one manually.');
    const selectedFields = parseCsvLines(baseViewForm.selected_fields_text);
    const out = await api.sourceIngestSaveBaseView({
      base_view_id: baseViewId,
      connector_id: baseViewForm.connector_id,
      object_name: baseViewForm.object_name,
      display_name: baseViewForm.display_name,
      primary_key_field: baseViewForm.primary_key_field,
      updated_at_field: baseViewForm.updated_at_field,
      selected_fields: selectedFields,
      row_filter: rowFilter,
      sample_limit: Number(baseViewForm.sample_limit) || 25,
      discovery_json: {
        ...compactDiscoveryForSave(baseViewDiscovery ?? discovery),
        primary_key_field: baseViewForm.primary_key_field || undefined,
        updated_at_field: baseViewForm.updated_at_field || undefined,
      },
    });
    setBaseViewSaveResult(out);
    setBaseViewForm(prev => ({ ...prev, base_view_id: baseViewId }));
    setActiveArea('base_views');
    setActiveNode(`base_view:${baseViewId}`);
    setRouteHash(`base_view:${baseViewId}`);
    setTransformViewForm(prev => ({ ...prev, inputs_text: defaultTransformViewInputs(baseViewId), primary_key_field: baseViewForm.primary_key_field || prev.primary_key_field || form.primary_key_field || 'id', updated_at_field: baseViewForm.updated_at_field || prev.updated_at_field || form.updated_at_field || '' }));
    setTransformSourcesText(JSON.stringify([{ alias: 'main', source_table_id: baseViewId, connector: baseViewForm.connector_id, object: baseViewForm.object_name, fields: selectedFields, sample_limit: Number(baseViewForm.sample_limit) || 25 }], null, 2));
    try {
      await refreshCatalogTree();
    } catch {
      await load();
    }
  });

  const deleteBaseView = async () => runStep('catalog-base-view-delete', async () => {
    const baseViewId = effectiveBaseViewId;
    if (!baseViewId) throw new Error('base_view_id_required');
    const guard = await runDeleteGuard('base_view', baseViewId);
    if (!guard.confirmed) return;
    await api.sourceIngestDeleteBaseView(baseViewId, guard.token, true);
    setBaseViewSaveResult(null);
    setBaseViewDiscovery(null);
    await load();
  });

  const selectTransformView = (row: Record<string, unknown>) => {
    setActiveArea('transform_views');
    setActiveNode(`transform_view:${String(row.transform_view_id ?? '')}`);
    setRouteHash(`transform_view:${String(row.transform_view_id ?? '')}`);
    const inputs = asArr(row.inputs).map(input => {
      const raw = asObj(input);
      return { alias: String(raw.alias ?? ''), base_view_id: String(raw.base_view_id ?? '') };
    }).filter(input => input.alias && input.base_view_id);
    setTransformViewForm({
      transform_view_id: String(row.transform_view_id ?? ''),
      display_name: String(row.display_name ?? row.transform_view_id ?? ''),
      inputs_text: JSON.stringify(inputs, null, 2),
      sql: String(row.sql ?? ''),
      primary_key_field: String(row.primary_key_field ?? 'id'),
      updated_at_field: String(row.updated_at_field ?? ''),
    });
    setTransformEnabled(true);
    setTransformSourcesText(JSON.stringify(inputs.map(input => ({ alias: input.alias, source_table_id: input.base_view_id })), null, 2));
    setTransformSql(String(row.sql ?? ''));
    setTransformPrimaryKey(String(row.primary_key_field ?? 'id'));
    setTransformUpdatedAt(String(row.updated_at_field ?? ''));
    setTransformViewSaveResult(null);
  };

  const seedTransformViewFromBase = () => {
    const baseId = baseViewForm.base_view_id || String(catalogBaseViews[0]?.base_view_id ?? '');
    setTransformViewForm({
      transform_view_id: `tv-${catalogSlugPart(baseId || 'source')}`,
      display_name: `${baseViewForm.display_name || baseId || 'Source'} transform`,
      inputs_text: defaultTransformViewInputs(baseId || 'bv-source'),
      sql: 'SELECT main.* FROM main',
      primary_key_field: form.primary_key_field || transformPrimaryKey || 'id',
      updated_at_field: form.updated_at_field || transformUpdatedAt || '',
    });
    setTransformViewSaveResult(null);
  };

  const appendBaseViewInput = (baseViewId: string) => {
    const existing = parseTransformInputs(transformViewForm.inputs_text);
    if (existing.some(input => input.base_view_id === baseViewId)) return;
    const aliasSeed = catalogSlugPart(baseViewId).replace(/-/g, '_').slice(0, 24) || `src${existing.length + 1}`;
    const alias = existing.length === 0 ? 'main' : aliasSeed;
    setTransformViewForm(prev => ({ ...prev, inputs_text: JSON.stringify([...existing, { alias, base_view_id: baseViewId }], null, 2) }));
  };

  const generateSelectForTransform = () => {
    const inputs = parseTransformInputs(transformViewForm.inputs_text);
    if (inputs.length === 0) return;
    const lookup = new Map(catalogBaseViews.map(row => [String(row.base_view_id), row]));
    const projection = inputs.flatMap(input => {
      const fields = asArr(lookup.get(input.base_view_id)?.selected_fields).map(String).filter(Boolean);
      const safeFields = fields.length ? fields : ['*'];
      if (safeFields.includes('*')) return [`${input.alias}.*`];
      return safeFields.map(field => `${input.alias}.${field}${inputs.length > 1 ? ` AS ${input.alias}_${field}` : ''}`);
    });
    const from = inputs.map((input, i) => `${i === 0 ? 'FROM' : '-- JOIN'} ${input.alias}`).join('\n');
    const sql = `SELECT\n  ${projection.join(',\n  ')}\n${from}`;
    setTransformViewForm(prev => ({ ...prev, sql }));
  };

  const saveTransformView = async () => runStep('catalog-transform-view', async () => {
    const inputs = parseTransformInputs(transformViewForm.inputs_text);
    const out = await api.sourceIngestSaveTransformView({
      transform_view_id: transformViewForm.transform_view_id,
      display_name: transformViewForm.display_name,
      inputs,
      sql: transformViewForm.sql,
      primary_key_field: transformViewForm.primary_key_field,
      updated_at_field: transformViewForm.updated_at_field || undefined,
    });
    setTransformViewSaveResult(out);
    setTransformEnabled(true);
    setTransformSourcesText(JSON.stringify(inputs.map(input => ({ alias: input.alias, source_table_id: input.base_view_id })), null, 2));
    setTransformSql(transformViewForm.sql);
    setTransformPrimaryKey(transformViewForm.primary_key_field);
    setTransformUpdatedAt(transformViewForm.updated_at_field);
    setArticleViewForm(prev => ({ ...prev, input_kind: 'transform_view', input_id: transformViewForm.transform_view_id }));
    await load();
  });

  const deleteTransformView = async () => runStep('catalog-transform-view-delete', async () => {
    const transformViewId = transformViewForm.transform_view_id.trim();
    if (!transformViewId) throw new Error('transform_view_id_required');
    const guard = await runDeleteGuard('transform_view', transformViewId);
    if (!guard.confirmed) return;
    await api.sourceIngestDeleteTransformView(transformViewId, guard.token, true);
    setTransformViewSaveResult(null);
    setTransformPreview(null);
    await load();
  });

  const selectArticleView = (row: Record<string, unknown>) => {
    setActiveArea('article_views');
    setActiveNode(`article_view:${String(row.article_view_id ?? '')}`);
    setRouteHash(`article_view:${String(row.article_view_id ?? '')}`);
    const article = asObj(row.article_json);
    const input = asObj(article.input);
    const identity = asObj(article.identity);
    const security = asObj(article.security);
    const freshness = asObj(article.freshness_policy);
    const mapping = asObj(article.mapping);
    const template = asObj(article.article_template || asObj(mapping.article_template));
    const sections = asObj(template.sections);
    const rawInputKind = input.kind === 'transform_view' ? 'transform_view' : 'base_view';
    const rawInputId = String(input.id ?? row.input_id ?? '');
    const effectiveInputId = rawInputKind === 'transform_view' && rawInputId && !catalogTransformViews.some(t => String(t.transform_view_id) === rawInputId)
      ? String(catalogTransformViews[0]?.transform_view_id ?? rawInputId)
      : rawInputKind === 'base_view' && rawInputId && !catalogBaseViews.some(b => String(b.base_view_id) === rawInputId)
        ? String(catalogBaseViews[0]?.base_view_id ?? rawInputId)
        : rawInputId;
    setArticleViewForm({
      article_view_id: String(row.article_view_id ?? article.article_view_id ?? ''),
      display_name: String(article.display_name ?? row.article_view_id ?? ''),
      input_kind: rawInputKind,
      input_id: effectiveInputId,
      gbrain_type: String(row.gbrain_type ?? article.gbrain_type ?? 'equipment'),
      target_source_id: String(row.target_source_id ?? article.target_source_id ?? 'shared'),
      slug_template: String(article.slug_template ?? 'source-ingest/items/{{ id | slugify }}'),
      external_id_field: String(identity.external_id_field ?? 'id'),
      display_name_field: String(identity.display_name_field ?? ''),
      natural_key_fields_text: asArr(identity.natural_key_fields).map(String).join('\n'),
      status: String(row.status ?? article.status ?? 'draft'),
      freshness_policy: String(freshness.policy ?? 'P30D'),
      classification: String(security.classification ?? 'shared'),
      pii: security.pii === true,
    });
    setArticleChangePolicy(parseChangeIntelligence(article.change_intelligence));
    if (Object.keys(sections).length > 0) {
      setArticleSections({ ...DEFAULT_ARTICLE_SECTIONS, ...Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, String(v ?? '')])) });
      setArticleDirty(true);
    }
    setArticleViewSaveResult(null);
    invalidateArticleViewPreview();
  };

  const seedArticleViewFromCurrent = () => {
    const transformId = transformViewForm.transform_view_id || String(catalogTransformViews[0]?.transform_view_id ?? '');
    const baseId = baseViewForm.base_view_id || String(catalogBaseViews[0]?.base_view_id ?? '');
    const inputKind = transformId ? 'transform_view' : 'base_view';
    const inputId = transformId || baseId || 'bv-source';
    const keyField = transformViewForm.primary_key_field || form.primary_key_field || 'id';
    setArticleViewForm(prev => ({
      ...prev,
      article_view_id: prev.article_view_id || `av-${catalogSlugPart(inputId)}`,
      display_name: prev.display_name || `${inputId} articles`,
      input_kind: inputKind,
      input_id: inputId,
      target_source_id: form.target_source_id || prev.target_source_id,
      slug_template: form.slug_prefix ? `${form.slug_prefix.replace(/\/+$/g, '')}/{{ ${keyField} | slugify }}` : prev.slug_template,
      external_id_field: keyField,
      display_name_field: form.primary_key_field === keyField ? prev.display_name_field : form.primary_key_field || prev.display_name_field,
      freshness_policy: form.freshness_policy || prev.freshness_policy,
    }));
    setArticleViewSaveResult(null);
    invalidateArticleViewPreview();
  };

  const articleViewPayload = () => ({
    article_view_id: articleViewForm.article_view_id,
    display_name: articleViewForm.display_name,
    input_kind: articleViewForm.input_kind,
    input_id: articleViewForm.input_id,
    gbrain_type: articleViewForm.gbrain_type,
    target_source_id: articleViewForm.target_source_id,
    slug_template: articleViewForm.slug_template,
    identity: {
      external_id_field: articleViewForm.external_id_field,
      display_name_field: articleViewForm.display_name_field || articleViewForm.external_id_field,
      natural_key_fields: parseCsvLines(articleViewForm.natural_key_fields_text),
    },
    article_template: { sections: articleSections },
    change_intelligence: serializeChangeIntelligence(articleChangePolicy),
    freshness_policy: { policy: articleViewForm.freshness_policy },
    update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: selectedSourceFields },
    security: { classification: articleViewForm.classification, pii: articleViewForm.pii },
    status: articleViewForm.status,
  });

  const profileForCatalogTransformPreview = () => {
    const inputs = parseTransformInputs(transformViewForm.inputs_text);
    const sources = transformSourcesForInputs(inputs, catalogBaseViews);
    const primary = sources[0];
    return {
      profile_id: `${transformViewForm.transform_view_id || 'transform'}-preview`,
      status: 'reviewed',
      source_connector: primary?.connector || form.connector_id,
      source_object: primary?.object || form.source_object,
      transform: {
        engine: 'pglite',
        sources,
        sql: transformViewForm.sql,
        primary_key_field: transformViewForm.primary_key_field || 'id',
        ...(transformViewForm.updated_at_field ? { updated_at_field: transformViewForm.updated_at_field } : {}),
      },
      target: { gbrain_type: 'preview', approved_source_id: articleViewForm.target_source_id || form.target_source_id, slug_template: 'preview/{{ id | slugify }}' },
      identity: { external_id_field: transformViewForm.primary_key_field || 'id', natural_key_fields: [], display_name_field: transformViewForm.primary_key_field || 'id' },
      mapping: { source_fields: [], article_template: { sections: { title: '{{ id }}', summary: 'preview' } } },
      update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: [] },
      security: { classification: 'shared', pii: false },
    };
  };

  const profileForArticleViewPreview = () => {
    const article = articleViewPayload();
    const baseLookup = new Map(catalogBaseViews.map(row => [String(row.base_view_id), row]));
    const transformRow = articleViewForm.input_kind === 'transform_view'
      ? (articleViewForm.input_id === transformViewForm.transform_view_id
          ? { inputs: parseTransformInputs(transformViewForm.inputs_text), sql: transformViewForm.sql, primary_key_field: transformViewForm.primary_key_field, updated_at_field: transformViewForm.updated_at_field }
          : (() => {
              const row = catalogTransformViews.find(t => String(t.transform_view_id) === articleViewForm.input_id);
              return row ? { inputs: asArr<Record<string, unknown>>(row.inputs).map(input => ({ alias: String(input.alias ?? ''), base_view_id: String(input.base_view_id ?? '') })).filter(input => input.alias && input.base_view_id), sql: String(row.sql ?? ''), primary_key_field: String(row.primary_key_field ?? articleViewForm.external_id_field), updated_at_field: String(row.updated_at_field ?? '') } : null;
            })())
      : null;
    const primaryBaseId = articleViewForm.input_kind === 'base_view' ? articleViewForm.input_id : transformRow?.inputs[0]?.base_view_id;
    const base = baseLookup.get(String(primaryBaseId || ''));
    const fields = articleAvailableFields.length ? articleAvailableFields : asArr(base?.selected_fields).map(String).filter(Boolean);
    const stripTemplateField = (value: unknown) => String(value ?? '')
      .trim()
      .replace(/^{{\s*/, '')
      .replace(/\s*}}$/, '')
      .replace(/\s*\|.*$/, '')
      .trim();
    const validFieldSet = new Set(fields);
    const normalizeIdentityField = (value: unknown, fallback: string) => {
      const field = stripTemplateField(value);
      return field && validFieldSet.has(field) ? field : fallback;
    };
    const externalIdField = normalizeIdentityField(article.identity.external_id_field, fields[0] || 'id');
    const displayNameField = normalizeIdentityField(article.identity.display_name_field, externalIdField);
    const naturalKeyFields = asArr(article.identity.natural_key_fields)
      .map(stripTemplateField)
      .filter(field => field && validFieldSet.has(field));
    const identity = {
      ...asObj(article.identity),
      external_id_field: externalIdField,
      display_name_field: displayNameField,
      natural_key_fields: naturalKeyFields,
    };
    return {
      profile_id: `${articleViewForm.article_view_id || 'article'}-preview`,
      status: 'reviewed',
      source_connector: String(base?.connector_id ?? form.connector_id),
      source_object: String(base?.object_name ?? form.source_object),
      ...(transformRow ? { transform: { engine: 'pglite', sources: transformSourcesForInputs(transformRow.inputs, catalogBaseViews), sql: transformRow.sql, primary_key_field: transformRow.primary_key_field || articleViewForm.external_id_field || 'id', ...(transformRow.updated_at_field ? { updated_at_field: transformRow.updated_at_field } : {}) } } : {}),
      target: { gbrain_type: article.gbrain_type, approved_source_id: article.target_source_id, slug_template: article.slug_template },
      selection: { include: asArr(base?.row_filter) },
      identity,
      freshness: article.freshness_policy,
      mapping: { source_fields: fields, article_template: article.article_template },
      update_policy: { ...asObj(article.update_policy), field_allowlist: fields },
      security: article.security,
    };
  };

  const saveArticleView = async () => runStep('catalog-article-view', async () => {
    setArticleViewSaveResult(await api.sourceIngestSaveArticleView(articleViewPayload()));
    await load();
  });

  const deleteArticleView = async () => runStep('catalog-article-view-delete', async () => {
    const articleViewId = articleViewForm.article_view_id.trim();
    if (!articleViewId) throw new Error('article_view_id_required');
    const guard = await runDeleteGuard('article_view', articleViewId);
    if (!guard.confirmed) return;
    await api.sourceIngestDeleteArticleView(articleViewId);
    setArticleViewSaveResult(null);
    invalidateArticleViewPreview();
    await load();
  });

  const approveArticleView = async () => runStep('catalog-article-approve', async () => {
    if (!articleViewCurrentChainHash) {
      throw new Error('chain_hash_required: run Article preview again before approving.');
    }
    setArticleViewApproveResult(await api.sourceIngestApproveArticleView(articleViewForm.article_view_id, articleViewCurrentChainHash));
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
    setBaseViewForm(prev => ({
      ...prev,
      base_view_id: prev.base_view_id || defaultBaseViewId(form.connector_id, form.source_object, form.table_name),
      connector_id: form.connector_id,
      object_name: form.source_object,
      display_name: prev.display_name || `${form.table_name || form.source_object} source view`,
      selected_fields_text: selected.join('\n'),
      sample_limit: form.sample_limit,
    }));
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
    invalidateArticleViewPreview();
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

  const invalidateArticleViewPreview = () => {
    setArticleViewPreview(null);
    setArticleViewCurrentChainHash('');
    setArticleViewApproveResult(null);
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
    if (canCatalogTransformPreview) {
      const inputs = parseTransformInputs(transformViewForm.inputs_text);
      const savedTransform = catalogTransformViews.some(row => String(row.transform_view_id) === transformViewForm.transform_view_id);
      const out = await api.sourceIngestExecuteTransformView({
        ...(savedTransform ? { transform_view_id: transformViewForm.transform_view_id } : {}),
        draft: {
          inputs,
          sql: transformViewForm.sql,
          primary_key_field: transformViewForm.primary_key_field,
          updated_at_field: transformViewForm.updated_at_field || undefined,
        },
        sample_limit: Number(form.sample_limit) || 25,
      });
      setTransformPreview(out);
      if (savedTransform) await refreshCatalogTree();
      return;
    }
    const profile = profileForReview;
    if (!profile) throw new Error('transform_preview_requires_inputs_sql_and_primary_key');
    const out = await api.sourceIngestTransformPreview({ ...payload(), profile, sample_limit: form.sample_limit, target_source_id: form.target_source_id });
    setTransformPreview(out);
  });

  const runArticleViewPreview = async () => runStep('catalog-article-preview', async () => {
    const articleViewId = articleViewForm.article_view_id.trim();
    if (!articleViewId) throw new Error('article_view_id_required: enter Article view id before preview.');
    const saved = await api.sourceIngestSaveArticleView(articleViewPayload());
    setArticleViewSaveResult(saved);
    const out = await api.sourceIngestArticleViewDryRun({
      article_view_id: articleViewId,
      sample_limit: Number(form.sample_limit) || 25,
    });
    const wrapped = asObj(out);
    setArticleViewCurrentChainHash(String(wrapped.current_chain_hash ?? ''));
    setArticleViewPreview(wrapped.dry_run ?? out);
    await refreshCatalogTree();
  });

  const loadArticleViewRuns = async () => runStep('catalog-article-runs', async () => {
    const articleViewId = articleViewForm.article_view_id.trim();
    if (!articleViewId) throw new Error('article_view_id_required');
    setArticleViewRuns(await api.sourceIngestArticleViewRuns(articleViewId, 20));
    await refreshCatalogTree();
  });

  const runArticleViewBatch = async (limit?: number, changed_since = false) => runStep('catalog-article-run', async () => {
    const articleViewId = articleViewForm.article_view_id.trim();
    if (!articleViewId) throw new Error('article_view_id_required');
    const out = await api.sourceIngestRunArticleView({ article_view_id: articleViewId, ...(limit ? { limit } : {}), changed_since, require_clean_git: true });
    setArticleViewRunResult(out);
    setArticleViewRuns(await api.sourceIngestArticleViewRuns(articleViewId, 20));
    await refreshCatalogTree();
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

  const selectedArticleViewRow = (data.catalog_tree?.article_views ?? []).find(row => String(row.article_view_id ?? '') === articleViewForm.article_view_id.trim()) ?? null;
  const staleArticleCount = (data.catalog_tree?.article_views ?? []).filter(row => row.stale === true).length;

  return (
    <div>
      <div style={{
        position: 'sticky', top: -16, zIndex: 100, margin: '-16px -24px 14px', padding: '16px 24px 8px',
        background: 'var(--bg-primary)', boxShadow: '0 8px 18px rgba(0,0,0,0.28)', borderBottom: '1px solid var(--border, #333)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 40, flexWrap: 'wrap' }}>
          <h1 className="page-title" style={{ margin: 0, fontSize: 18, lineHeight: 1.1 }}>Source Ingest</h1>
          <span
            title="Workflow: configure connector → discover fields → draft profile → dry-run preview → approve. Import/refresh remains separate and guarded."
            style={{ width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--border, #333)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', cursor: 'help' }}
          >?</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginLeft: 'auto' }}>
            <span className="badge badge-read" title="Rows in source sync state">sync {val(summary.rows ?? data.status.rows.length)}</span>
            <span className="badge badge-success" title="Fresh sync rows">fresh {val(summary.fresh ?? 0)}</span>
            <span className="badge badge-write" title="Stale sync rows">stale {val(summary.stale ?? 0)}</span>
            <span className="badge badge-admin" title="Stale Article views requiring preview/approve">article stale {staleArticleCount}</span>
            <span className="badge badge-admin" title="Profiles due for refresh">due {data.refresh.count}</span>
          </div>
        </div>
        {err && <div style={{ color: 'var(--error)', marginTop: 6, fontSize: 12 }}><b>Error:</b> {err}</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
        <SourceIngestCatalogPanel
          tree={data.catalog_tree ?? { connectors: [], base_views: [], transform_views: [], article_views: [], schema: { read_only: true } }}
          activeArea={activeArea}
          activeNode={activeNode}
          schemaNodes={schemaNodes}
          onSelectArea={setActiveArea}
          onSelectNode={handleSelectCatalogNode}
          onSelectConnector={selectCatalogConnector}
          onSelectBaseView={selectBaseView}
          onSelectTransformView={selectTransformView}
          onSelectArticleView={selectArticleView}
          onSelectSchemaType={(type) => void explainSchemaType(type)}
        />

      <main style={{ minWidth: 0 }}>
        <SourceIngestWizard
          busy={busy}
          counts={{ connectors: catalogConnectors.length, baseViews: catalogBaseViews.length, transformViews: catalogTransformViews.length, articleViews: data.catalog_tree?.article_views?.length ?? 0, staleArticleViews: staleArticleCount }}
          onSelectArea={setActiveArea as (area: 'connectors' | 'base_views' | 'transform_views' | 'article_views') => void}
          onSelectNode={handleSelectCatalogNode}
          onSeedArticle={seedArticleViewFromCurrent}
          onSaveConnector={saveCatalogConnector}
          onSaveBaseView={saveBaseView}
          onSaveTransformView={saveTransformView}
          onSaveArticleView={saveArticleView}
          onPreviewArticleView={runArticleViewPreview}
          onApproveArticleView={approveArticleView}
        />
        <SourceIngestLineagePanel
          activeArea={activeArea}
          activeNode={activeNode}
          connectorId={catalogConnectorForm.connector_id || baseViewForm.connector_id || form.connector_id}
          baseId={baseViewForm.base_view_id || (articleViewForm.input_kind === 'base_view' ? articleViewForm.input_id : '')}
          transformId={transformViewForm.transform_view_id || (articleViewForm.input_kind === 'transform_view' ? articleViewForm.input_id : '')}
          articleId={articleViewForm.article_view_id}
          articleRow={selectedArticleViewRow}
          transformInputs={catalogTransformInputs}
          onSelectNode={handleSelectCatalogNode}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>EDIT</div>
            <h2 className="section-title" style={{ marginBottom: 0 }}>{activeArea === 'connectors' ? 'Connectors' : activeArea === 'base_views' ? 'Base views' : activeArea === 'transform_views' ? 'Transform views' : activeArea === 'article_views' ? 'Article views' : 'Schema view'}</h2>
          </div>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void load()}>Reload</button>
        </div>

        {catalogDeleteImpact !== null && <section style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 12, background: 'rgba(127, 29, 29, 0.14)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 8 }}>
            <b>Delete impact / dependency guard</b>
            <button className="btn btn-secondary" onClick={() => setCatalogDeleteImpact(null)}>Clear</button>
          </div>
          <PreviewJson value={catalogDeleteImpact} empty="No delete impact yet." />
        </section>}

      <ConnectorEditor
        busy={busy}
        catalogConnectorForm={catalogConnectorForm}
        setCatalogConnectorForm={setCatalogConnectorForm}
        secretForm={secretForm}
        setSecretForm={setSecretForm}
        catalogConnectorSecretStatus={catalogConnectorSecretStatus}
        catalogConnectorObjects={catalogConnectorObjects}
        catalogConnectorTest={catalogConnectorTest}
        catalogConnectorSecretConfigId={catalogConnectorSecretConfigId}
        saveCatalogConnector={saveCatalogConnector}
        saveCatalogConnectorCredentials={saveCatalogConnectorCredentials}
        deleteCatalogConnectorCredentials={deleteCatalogConnectorCredentials}
        listCatalogConnectorObjects={listCatalogConnectorObjects}
        testCatalogConnector={testCatalogConnector}
        deleteCatalogConnector={deleteCatalogConnector}
        PreviewJson={PreviewJson}
        studioSectionStyle={studioSectionStyle}
      />

      <BaseViewEditor
        busy={busy}
        formSourceObject={form.source_object}
        formTableName={form.table_name}
        baseViewForm={baseViewForm}
        setBaseViewForm={setBaseViewForm}
        effectiveBaseViewId={effectiveBaseViewId}
        catalogConnectorChoices={catalogConnectorChoices}
        catalogConnectorObjects={catalogConnectorObjects}
        objectSuggestions={discoveryObjectNames(catalogConnectorObjects, baseViewForm.connector_id)}
        baseViewDiscovery={baseViewDiscovery}
        baseViewSaveResult={baseViewSaveResult}
        fieldSelectionPanel={<FieldSelectionPanel discovery={baseViewDiscovery} selected={baseViewSelectedFields} onChange={fields => setBaseViewForm(prev => ({ ...prev, selected_fields_text: fields.join('\n') }))} />}
        sampleRowsPanel={<SourceSampleRowsTable discovery={baseViewDiscovery} selected={baseViewSelectedFields} />}
        makeBaseViewId={defaultBaseViewId}
        seedBaseViewFromReview={seedBaseViewFromReview}
        discoverBaseView={discoverBaseView}
        saveBaseView={saveBaseView}
        deleteBaseView={deleteBaseView}
        PreviewJson={PreviewJson}
        studioSectionStyle={studioSectionStyle}
      />


      <TransformViewEditor
        busy={busy}
        transformViewForm={transformViewForm}
        setTransformViewForm={setTransformViewForm}
        parsedInputsCount={parseTransformInputs(transformViewForm.inputs_text).length}
        canTransformPreview={canTransformPreview}
        catalogBaseViews={catalogBaseViews}
        transformPreview={transformPreview}
        transformViewSaveResult={transformViewSaveResult}
        seedTransformViewFromBase={seedTransformViewFromBase}
        generateSelectForTransform={generateSelectForTransform}
        runTransformPreview={runTransformPreview}
        saveTransformView={saveTransformView}
        deleteTransformView={deleteTransformView}
        appendBaseViewInput={appendBaseViewInput}
        TransformResultPreview={TransformResultPreview}
        PreviewJson={PreviewJson}
        studioSectionStyle={studioSectionStyle}
      />

      <ArticleViewEditor
        busy={busy}
        sources={data.sources}
        formSampleLimit={form.sample_limit}
        articleViewForm={articleViewForm}
        setArticleViewForm={setArticleViewForm}
        articleChangePolicy={articleChangePolicy}
        setArticleChangePolicy={setArticleChangePolicy}
        articleViewCurrentChainHash={articleViewCurrentChainHash}
        selectedArticleViewRow={selectedArticleViewRow}
        articleAvailableFields={articleAvailableFields}
        articleInputChoices={articleInputChoices}
        articleSections={articleSections}
        sectionLabels={articleSectionLabels}
        requiredFrontmatter={articleRequiredFrontmatter}
        articleTemplate={articleTemplate}
        articleViewPreview={articleViewPreview}
        articleViewRuns={articleViewRuns}
        articleViewRunResult={articleViewRunResult}
        articleViewSaveResult={articleViewSaveResult}
        articleViewApproveResult={articleViewApproveResult}
        setActiveSection={setActiveSection}
        seedArticleViewFromCurrent={seedArticleViewFromCurrent}
        runArticleViewPreview={runArticleViewPreview}
        saveArticleView={saveArticleView}
        deleteArticleView={deleteArticleView}
        approveArticleView={approveArticleView}
        loadArticleViewRuns={loadArticleViewRuns}
        runArticleViewBatch={runArticleViewBatch}
        invalidateArticleViewPreview={invalidateArticleViewPreview}
        insertFieldToken={insertFieldToken}
        updateArticleSection={updateArticleSection}
        DryRunPreview={DryRunPreview}
        PreviewJson={PreviewJson}
        studioSectionStyle={studioSectionStyle}
      />

      <SchemaWorkbench
        busy={busy}
        catalogCounts={{
          connectors: data.catalog_tree?.connectors?.length ?? 0,
          baseViews: data.catalog_tree?.base_views?.length ?? 0,
          transformViews: data.catalog_tree?.transform_views?.length ?? 0,
          articleViews: data.catalog_tree?.article_views?.length ?? 0,
        }}
        activeSchemaPack={activeSchemaPack}
        schemaStats={schemaStats}
        schemaNodes={schemaNodes}
        schemaEdges={schemaEdges}
        schemaType={schemaType}
        setSchemaType={setSchemaType}
        schemaTypeExplain={schemaTypeExplain}
        schemaTypeCard={schemaTypeCard}
        schemaWorkbench={schemaWorkbench}
        explainSchemaType={explainSchemaType}
        createSchemaProposal={createSchemaProposal}
        PreviewJson={PreviewJson}
        studioSectionStyle={studioSectionStyle}
      />




      </main>
      </div>
    </div>
  );
}
