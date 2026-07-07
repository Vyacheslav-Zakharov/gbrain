import React from 'react';

type Busy = string | null;
type TransformViewForm = {
  transform_view_id: string;
  display_name: string;
  inputs_text: string;
  sql: string;
  primary_key_field: string;
  updated_at_field: string;
};

type Props = {
  busy: Busy;
  transformViewForm: TransformViewForm;
  setTransformViewForm: React.Dispatch<React.SetStateAction<TransformViewForm>>;
  parsedInputsCount: number;
  canTransformPreview: boolean;
  catalogBaseViews: Array<Record<string, unknown>>;
  transformPreview: unknown;
  transformViewSaveResult: unknown;
  seedTransformViewFromBase: () => void;
  generateSelectForTransform: () => void;
  runTransformPreview: () => void;
  saveTransformView: () => void;
  deleteTransformView: () => void;
  appendBaseViewInput: (baseViewId: string) => void;
  TransformResultPreview: React.ComponentType<{ value: unknown }>;
  PreviewJson: React.ComponentType<{ value: unknown; empty: string }>;
  studioSectionStyle: (area: string) => React.CSSProperties;
};

export function TransformViewEditor({ busy, transformViewForm, setTransformViewForm, parsedInputsCount, canTransformPreview, catalogBaseViews, transformPreview, transformViewSaveResult, seedTransformViewFromBase, generateSelectForTransform, runTransformPreview, saveTransformView, deleteTransformView, appendBaseViewInput, TransformResultPreview, PreviewJson, studioSectionStyle }: Props) {
  return <section style={studioSectionStyle('transform_views')}>
    <h2 className="section-title">3. Transform view / Преобразование</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      First-class transform view: base-view inputs + read-only SQL + result identity fields. SQL is saved as catalog metadata; execution remains in staging PGLite preview/dry-run paths.
    </p>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={seedTransformViewFromBase}>Seed from selected base view</button>
      <button className="btn btn-secondary" disabled={busy !== null || parsedInputsCount === 0} onClick={generateSelectForTransform}>Generate SELECT</button>
      <button className="btn btn-secondary" disabled={busy !== null || !canTransformPreview} onClick={() => void runTransformPreview()}>{busy === 'transform-preview' ? 'Executing…' : 'Execute SQL preview'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !transformViewForm.transform_view_id || parsedInputsCount === 0 || !transformViewForm.sql.trim() || !transformViewForm.primary_key_field} onClick={() => void saveTransformView()}>{busy === 'catalog-transform-view' ? 'Saving…' : 'Save transform view'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !transformViewForm.transform_view_id} onClick={() => void deleteTransformView()}>{busy === 'catalog-transform-view-delete' ? 'Deleting…' : 'Delete transform view'}</button>
      <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>Inputs bind aliases to base views. Generate SELECT is a starter; joins remain explicit SQL.</span>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <label>Transform view id
        <input value={transformViewForm.transform_view_id} onChange={e => setTransformViewForm(prev => ({ ...prev, transform_view_id: e.target.value }))} placeholder="tv-vehicles-clean" />
      </label>
      <label>Display name
        <input value={transformViewForm.display_name} onChange={e => setTransformViewForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="Автотранспорт transform" />
      </label>
      <label>Primary key field in SQL result
        <input value={transformViewForm.primary_key_field} onChange={e => setTransformViewForm(prev => ({ ...prev, primary_key_field: e.target.value }))} placeholder="vehicleID" />
      </label>
      <label>Updated-at field in SQL result
        <input value={transformViewForm.updated_at_field} onChange={e => setTransformViewForm(prev => ({ ...prev, updated_at_field: e.target.value }))} placeholder="max_updated_at" />
      </label>
      <label style={{ gridColumn: '1 / -1' }}>Transform inputs JSON
        <textarea rows={5} value={transformViewForm.inputs_text} onChange={e => setTransformViewForm(prev => ({ ...prev, inputs_text: e.target.value }))} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
      </label>
      {catalogBaseViews.length > 0 && <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {catalogBaseViews.map(row => <button key={String(row.base_view_id)} type="button" className="btn btn-secondary" onClick={() => appendBaseViewInput(String(row.base_view_id))}>Add input {String(row.base_view_id)}</button>)}
      </div>}
      <label style={{ gridColumn: '1 / -1' }}>Read-only SQL
        <textarea rows={8} value={transformViewForm.sql} onChange={e => setTransformViewForm(prev => ({ ...prev, sql: e.target.value }))} placeholder={"SELECT main.vehicleID, main.govNumber, main.updatedAt AS max_updated_at\nFROM main\nWHERE main.vehicleID IS NOT NULL"} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
      </label>
      <div style={{ gridColumn: '1 / -1', color: parsedInputsCount > 0 && transformViewForm.sql.trim() ? 'var(--text-muted)' : 'var(--warning)', fontSize: 12 }}>
        Parsed base-view inputs: {parsedInputsCount}. Saving a transform marks dependent article views stale through <code>source_transform_view_upsert</code>.
      </div>
    </div>
    {transformPreview !== null && <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>SQL preview result</h3>
      <TransformResultPreview value={transformPreview} />
    </div>}
    {transformViewSaveResult !== null && <div style={{ marginTop: 12 }}><h3 style={{ fontSize: 13 }}>Saved transform view</h3><PreviewJson value={transformViewSaveResult} empty="No save result." /></div>}
  </section>;
}
