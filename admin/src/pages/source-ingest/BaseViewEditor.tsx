import React from 'react';
import { asObj } from './shared';

type Busy = string | null;
type BaseViewForm = {
  base_view_id: string;
  connector_id: string;
  object_name: string;
  display_name: string;
  primary_key_field: string;
  updated_at_field: string;
  selected_fields_text: string;
  row_filter_text: string;
  sample_limit: number;
};

type CatalogConnectorChoice = { id: string; displayName: string };

type Props = {
  busy: Busy;
  formSourceObject: string;
  formTableName: string;
  baseViewForm: BaseViewForm;
  setBaseViewForm: React.Dispatch<React.SetStateAction<BaseViewForm>>;
  effectiveBaseViewId: string;
  catalogConnectorChoices: CatalogConnectorChoice[];
  catalogConnectorObjects: unknown;
  objectSuggestions: string[];
  baseViewDiscovery: unknown;
  baseViewSaveResult: unknown;
  fieldSelectionPanel: React.ReactNode;
  sampleRowsPanel: React.ReactNode;
  makeBaseViewId: (connectorId: string, objectName: string, tableName: string) => string;
  seedBaseViewFromReview: () => void;
  discoverBaseView: () => void;
  saveBaseView: () => void;
  deleteBaseView: () => void;
  PreviewJson: React.ComponentType<{ value: unknown; empty: string }>;
  studioSectionStyle: (area: string) => React.CSSProperties;
};

export function BaseViewEditor({ busy, formSourceObject, formTableName, baseViewForm, setBaseViewForm, effectiveBaseViewId, catalogConnectorChoices, objectSuggestions, baseViewDiscovery, baseViewSaveResult, fieldSelectionPanel, sampleRowsPanel, makeBaseViewId, seedBaseViewFromReview, discoverBaseView, saveBaseView, deleteBaseView, PreviewJson, studioSectionStyle }: Props) {
  const fieldOptions = Array.from(new Set([
    ...((asObj(baseViewDiscovery).fields as Array<Record<string, unknown>> | undefined) ?? []).map(f => String(f.name ?? '')).filter(Boolean),
    ...baseViewForm.selected_fields_text.split(/\n|,/).map(s => s.trim()).filter(Boolean),
    baseViewForm.primary_key_field,
    baseViewForm.updated_at_field,
  ].filter(Boolean)));
  const sourceObjectOptions = Array.from(new Set([...objectSuggestions, baseViewForm.object_name].filter(Boolean)));
  const idCandidates = Array.from(new Set([...(asObj(baseViewDiscovery).idCandidates as unknown[] | undefined ?? []).map(String), ...fieldOptions]));
  const updatedAtCandidates = Array.from(new Set([...(asObj(baseViewDiscovery).updatedAtCandidates as unknown[] | undefined ?? []).map(String), '', ...fieldOptions]));
  return <section style={studioSectionStyle('base_views')}>
    <h2 className="section-title">1. Base view / Источник</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      Base view binds a connector to one concrete source table/object. Enter the AppSheet table/API object here; connector credentials stay in Connectors.
    </p>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={seedBaseViewFromReview}>Seed from legacy discovery</button>
      <button className="btn btn-primary source-ingest-context-primary" disabled={busy !== null || !baseViewForm.connector_id || !baseViewForm.object_name} onClick={() => void discoverBaseView()}>{busy === 'catalog-base-view-discover' ? 'Изучаем поля…' : 'Изучить поля'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !effectiveBaseViewId || !baseViewForm.connector_id || !baseViewForm.object_name} onClick={() => void saveBaseView()}>{busy === 'catalog-base-view' ? 'Saving…' : 'Save base view'}</button>
      <button className="btn btn-danger" disabled={busy !== null || !effectiveBaseViewId} onClick={() => void deleteBaseView()}>{busy === 'catalog-base-view-delete' ? 'Удаляем…' : 'Удалить источник'}</button>
      <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>Следующий безопасный шаг — изучить поля и выбрать стабильный ID.</span>
    </div>
    <div className="source-ingest-form-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(220px, 1fr)', gap: 14, alignItems: 'start' }}>
      <label>Base view id <span style={{ color: 'var(--warning)' }}>*</span>
        <input value={baseViewForm.base_view_id} onChange={e => setBaseViewForm(prev => ({ ...prev, base_view_id: e.target.value }))} placeholder={effectiveBaseViewId || 'bv-appsheet-avto-vehicles'} />
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12 }}>Required. If empty, it will be generated as <code>{effectiveBaseViewId || 'bv-connector-object'}</code>.</span>
      </label>
      <label>Connector
        <select value={baseViewForm.connector_id} onChange={e => setBaseViewForm(prev => {
          const changed = prev.connector_id !== e.target.value;
          const next = changed
            ? { ...prev, connector_id: e.target.value, object_name: '', display_name: '', primary_key_field: '', updated_at_field: '', selected_fields_text: '', base_view_id: '' }
            : { ...prev, connector_id: e.target.value };
          return next.base_view_id.trim() ? next : { ...next, base_view_id: next.connector_id && next.object_name ? makeBaseViewId(next.connector_id, next.object_name, next.object_name) : '' };
        })}>
          <option value="">Select connector…</option>
          {catalogConnectorChoices.map(c => <option key={c.id} value={c.id}>{c.displayName} ({c.id})</option>)}
        </select>
      </label>
      <label>Source object / table
        {sourceObjectOptions.length > 0 ? <select value={baseViewForm.object_name} onChange={e => setBaseViewForm(prev => {
          const next = { ...prev, object_name: e.target.value };
          return prev.base_view_id.trim() ? next : { ...next, base_view_id: next.connector_id && next.object_name ? makeBaseViewId(next.connector_id, next.object_name, next.object_name) : '' };
        })}>
          <option value="">Select source object…</option>
          {sourceObjectOptions.map(name => <option key={name} value={name}>{name}</option>)}
        </select> : <input list="source-ingest-base-objects" value={baseViewForm.object_name} onChange={e => setBaseViewForm(prev => {
          const next = { ...prev, object_name: e.target.value };
          return prev.base_view_id.trim() ? next : { ...next, base_view_id: next.connector_id && next.object_name ? makeBaseViewId(next.connector_id, next.object_name, next.object_name) : '' };
        })} placeholder="например: vehicles" />}
        <datalist id="source-ingest-base-objects">
          {sourceObjectOptions.map(name => <option key={name} value={name} />)}
        </datalist>
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12 }}>Use “Test connector credentials” or “List available objects” on the connector to populate this dropdown. Legacy Review fields are not mixed into this list.</span>
      </label>
      <label>Display name
        <input value={baseViewForm.display_name} onChange={e => setBaseViewForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="Автотранспорт source view" />
      </label>
      <label>Sample limit
        <input type="number" min={1} max={200} value={baseViewForm.sample_limit} onChange={e => setBaseViewForm(prev => ({ ...prev, sample_limit: Number(e.target.value) || 25 }))} />
      </label>
      <label>Stable ID field
        {idCandidates.length > 0 ? <select value={baseViewForm.primary_key_field} onChange={e => setBaseViewForm(prev => ({ ...prev, primary_key_field: e.target.value }))}>
          <option value="">Select after discovery…</option>
          {idCandidates.filter(Boolean).map(name => <option key={name} value={name}>{name}</option>)}
        </select> : <input value={baseViewForm.primary_key_field} onChange={e => setBaseViewForm(prev => ({ ...prev, primary_key_field: e.target.value }))} placeholder="vehicleID / id / Код" />}
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12 }}>Required for stable external_id and later article slugs. Click Execute / Discover fields first, then choose a field.</span>
      </label>
      <label>Updated-at field
        {updatedAtCandidates.length > 1 ? <select value={baseViewForm.updated_at_field} onChange={e => setBaseViewForm(prev => ({ ...prev, updated_at_field: e.target.value }))}>
          <option value="">No incremental field</option>
          {updatedAtCandidates.filter(Boolean).map(name => <option key={name} value={name}>{name}</option>)}
        </select> : <input value={baseViewForm.updated_at_field} onChange={e => setBaseViewForm(prev => ({ ...prev, updated_at_field: e.target.value }))} placeholder="UpdatedAt / ДатаИзменения (optional)" />}
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12 }}>Optional; used for incremental refresh. Click Execute / Discover fields first, then choose a field.</span>
      </label>
      {fieldSelectionPanel}
      {baseViewDiscovery !== null && asObj(baseViewDiscovery).ok !== false && sampleRowsPanel}
      <details style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
        <summary>Дополнительные настройки</summary>
        <label style={{ display: 'block', marginTop: 10 }}>Row filter JSON <span title="Правила объединяются через AND. Поддерживаются: exists, not_exists, eq, neq, in, not_in, lt, lte, gt, gte." style={{ cursor: 'help', color: 'var(--accent)' }}>?</span>
        <details style={{ margin: '6px 0', color: 'var(--text-muted)', fontSize: 12 }}>
          <summary>How to write row filters</summary>
          <div style={{ marginTop: 6 }}>
            Use a JSON array of rules. All rules must match. Field can be nested with dots. Supported ops: <code>exists</code>, <code>not_exists</code>, <code>eq</code>, <code>neq</code>, <code>in</code>, <code>not_in</code>, <code>lt</code>, <code>lte</code>, <code>gt</code>, <code>gte</code>.
            <pre style={{ whiteSpace: 'pre-wrap' }}>{`[
  {"field":"is_active","op":"eq","value":true},
  {"field":"type","op":"in","value":["company","branch"]}
]`}</pre>
            Empty filter: <code>[]</code>.
          </div>
        </details>
          <textarea rows={4} value={baseViewForm.row_filter_text} onChange={e => setBaseViewForm(prev => ({ ...prev, row_filter_text: e.target.value }))} placeholder='[{"field":"is_active","op":"eq","value":true}]' style={{ width: '100%' }} />
        </label>
      </details>
    </div>
    {baseViewDiscovery !== null && asObj(baseViewDiscovery).ok === false && <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Discovery error</h3>
      <PreviewJson value={baseViewDiscovery} empty="No discovery result." />
    </div>}
    {baseViewSaveResult !== null && <details style={{ marginTop: 12 }}><summary>Технические детали</summary><PreviewJson value={baseViewSaveResult} empty="Нет результата сохранения." /></details>}
  </section>;
}
