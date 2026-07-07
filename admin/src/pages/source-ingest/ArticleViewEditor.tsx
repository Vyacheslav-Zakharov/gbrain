import React, { useMemo, useState } from 'react';
import { ArticleViewStatePanel } from './ArticleViewStatePanel';
import { asArr, asObj, val } from './shared';

type Busy = string | null;
type ArticleViewForm = {
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
};

type ArticleInputChoice = { kind: 'base_view' | 'transform_view'; id: string; label: string };
type Tab = 'definition' | 'preview' | 'runs';

type Props = {
  busy: Busy;
  sources: Array<{ id: string; name: string }>;
  formSampleLimit: number;
  articleViewForm: ArticleViewForm;
  setArticleViewForm: React.Dispatch<React.SetStateAction<ArticleViewForm>>;
  articleViewCurrentChainHash: string;
  selectedArticleViewRow: Record<string, unknown> | null;
  articleAvailableFields: string[];
  articleInputChoices: ArticleInputChoice[];
  articleSections: Record<string, string>;
  sectionLabels: Record<string, string>;
  articleViewPreview: unknown;
  articleViewRuns: unknown;
  articleViewRunResult: unknown;
  articleViewSaveResult: unknown;
  articleViewApproveResult: unknown;
  setActiveSection: (section: string) => void;
  seedArticleViewFromCurrent: () => void;
  runArticleViewPreview: () => void;
  saveArticleView: () => void;
  deleteArticleView: () => void;
  approveArticleView: () => void;
  loadArticleViewRuns: () => void;
  runArticleViewBatch: (limit?: number, changed_since?: boolean) => void;
  invalidateArticleViewPreview: () => void;
  insertFieldToken: (field: string) => void;
  updateArticleSection: (key: string, value: string) => void;
  DryRunPreview: React.ComponentType<{ value: unknown; currentTargetSourceId: string }>;
  PreviewJson: React.ComponentType<{ value: unknown; empty: string }>;
  studioSectionStyle: (area: string) => React.CSSProperties;
};

function TabButton({ tab, active, children, onClick }: { tab: Tab; active: Tab; children: React.ReactNode; onClick: (tab: Tab) => void }) {
  return <button type="button" className={active === tab ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => onClick(tab)}>{children}</button>;
}

export function ArticleViewEditor({ busy, sources, formSampleLimit, articleViewForm, setArticleViewForm, articleViewCurrentChainHash, selectedArticleViewRow, articleAvailableFields, articleInputChoices, articleSections, sectionLabels, articleViewPreview, articleViewRuns, articleViewRunResult, articleViewSaveResult, articleViewApproveResult, setActiveSection, seedArticleViewFromCurrent, runArticleViewPreview, saveArticleView, deleteArticleView, approveArticleView, loadArticleViewRuns, runArticleViewBatch, invalidateArticleViewPreview, insertFieldToken, updateArticleSection, DryRunPreview, PreviewJson, studioSectionStyle }: Props) {
  const [tab, setTab] = useState<Tab>('definition');
  const rows = asArr<Record<string, unknown>>(asObj(articleViewRuns).rows);
  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    if (!articleViewForm.article_view_id.trim()) missing.push('article_view_id');
    if (!articleViewForm.input_id.trim()) missing.push('input');
    if (!articleViewForm.gbrain_type.trim()) missing.push('gbrain_type');
    if (!articleViewForm.target_source_id.trim()) missing.push('target_source');
    if (!articleViewForm.slug_template.trim()) missing.push('slug_template');
    if (!articleViewForm.external_id_field.trim()) missing.push('external_id_field');
    if (Object.values(articleSections).every(v => !String(v || '').trim())) missing.push('article_template_sections');
    return missing;
  }, [articleViewForm, articleSections]);
  const canApprove = Boolean(articleViewForm.article_view_id && articleViewCurrentChainHash && missingRequired.length === 0);

  return <section style={studioSectionStyle('article_views')}>
    <h2 className="section-title">4. Article view / Публикация</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      First-class article view: definition → preview → guarded approve → run history. This replaces the legacy review path for publish work.
    </p>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={seedArticleViewFromCurrent}>Seed from current transform/base</button>
      <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => { setTab('preview'); void runArticleViewPreview(); }}>{busy === 'catalog-article-preview' ? 'Generating preview…' : 'Собрать превью'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => void saveArticleView()}>{busy === 'catalog-article-view' ? 'Saving…' : 'Save article view'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id} onClick={() => void deleteArticleView()}>{busy === 'catalog-article-view-delete' ? 'Deleting…' : 'Delete article view'}</button>
      <button className="btn btn-primary" disabled={busy !== null || !canApprove} onClick={() => void approveArticleView()}>{busy === 'catalog-article-approve' ? 'Approving…' : 'Approve / freeze snapshot'}</button>
      <span style={{ color: articleViewCurrentChainHash ? 'var(--success)' : 'var(--text-muted)', alignSelf: 'center' }}>{articleViewCurrentChainHash ? `chain ${articleViewCurrentChainHash.slice(0, 12)}…` : 'Preview required before approval.'}</span>
    </div>
    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
      <TabButton tab="definition" active={tab} onClick={setTab}>Определение</TabButton>
      <TabButton tab="preview" active={tab} onClick={setTab}>Превью</TabButton>
      <TabButton tab="runs" active={tab} onClick={setTab}>Запуски</TabButton>
    </div>
    {missingRequired.length > 0 && <div style={{ padding: 10, borderRadius: 8, background: 'rgba(245, 158, 11, 0.12)', color: 'var(--warning)', marginBottom: 12 }}>Required fields not filled: <code>{missingRequired.join(', ')}</code>. Save is allowed, but approve is blocked until these are filled.</div>}
    <ArticleViewStatePanel row={selectedArticleViewRow} previewHash={articleViewCurrentChainHash} />

    {tab === 'definition' && <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 14, alignItems: 'start', marginTop: 12 }}>
      <aside style={{ position: 'sticky', top: 90, border: '1px solid var(--border)', borderRadius: 8, padding: 10, maxHeight: 'calc(100vh - 118px)', overflow: 'auto', background: 'rgba(15,23,42,0.55)' }}>
        <h3 style={{ fontSize: 13, marginBottom: 6 }}>Поля входа</h3>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>Input: <code>{articleViewForm.input_kind}</code> · <code>{articleViewForm.input_id || '—'}</code>. Click inserts into the active template section.</div>
        {articleAvailableFields.length === 0 && <div style={{ color: 'var(--warning)', fontSize: 12 }}>No fields found. Run base/transform preview or use explicit SELECT aliases.</div>}
        {articleAvailableFields.map(field => <button key={field} type="button" className="btn btn-secondary" draggable onDragStart={e => e.dataTransfer.setData('text/plain', `{{ ${field} }}`)} onClick={() => insertFieldToken(field)} style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left', padding: '6px 8px' }}><code>{field}</code></button>)}
      </aside>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <label>Article view id<input value={articleViewForm.article_view_id} onChange={e => setArticleViewForm(prev => ({ ...prev, article_view_id: e.target.value }))} placeholder="av-equipment" /></label>
          <label>Display name<input value={articleViewForm.display_name} onChange={e => setArticleViewForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="Equipment articles" /></label>
          <label>Input kind<select value={articleViewForm.input_kind} onChange={e => { setArticleViewForm(prev => ({ ...prev, input_kind: e.target.value === 'transform_view' ? 'transform_view' : 'base_view' })); invalidateArticleViewPreview(); }}><option value="base_view">base_view</option><option value="transform_view">transform_view</option></select></label>
          <label>Input id<select value={`${articleViewForm.input_kind}:${articleViewForm.input_id}`} onChange={e => { const [kind, id] = e.target.value.split(':', 2); setArticleViewForm(prev => ({ ...prev, input_kind: kind === 'transform_view' ? 'transform_view' : 'base_view', input_id: id || e.target.value })); invalidateArticleViewPreview(); }}><option value={`${articleViewForm.input_kind}:${articleViewForm.input_id}`}>{articleViewForm.input_kind} · {articleViewForm.input_id || 'manual'}</option>{articleInputChoices.map(choice => <option key={`${choice.kind}:${choice.id}`} value={`${choice.kind}:${choice.id}`}>{choice.label}</option>)}</select><input value={articleViewForm.input_id} onChange={e => { setArticleViewForm(prev => ({ ...prev, input_id: e.target.value })); invalidateArticleViewPreview(); }} placeholder="tv-vehicles-clean" style={{ marginTop: 6 }} /></label>
          <label>GBrain type<input value={articleViewForm.gbrain_type} onChange={e => { setArticleViewForm(prev => ({ ...prev, gbrain_type: e.target.value })); invalidateArticleViewPreview(); }} placeholder="equipment" /></label>
          <label>Target GBrain source<select value={articleViewForm.target_source_id} onChange={e => { setArticleViewForm(prev => ({ ...prev, target_source_id: e.target.value })); invalidateArticleViewPreview(); }}>{sources.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}</select>{articleViewForm.target_source_id === 'shared' && <span style={{ display: 'block', color: 'var(--warning)', fontSize: 12 }}>shared = company canon visible to all federated readers.</span>}</label>
          <label style={{ gridColumn: '1 / -1' }}>Slug template<input value={articleViewForm.slug_template} onChange={e => { setArticleViewForm(prev => ({ ...prev, slug_template: e.target.value })); invalidateArticleViewPreview(); }} placeholder="source-ingest/vehicles/{{ vehicleID | slugify }}" /></label>
          <label>External id field<input value={articleViewForm.external_id_field} onChange={e => { setArticleViewForm(prev => ({ ...prev, external_id_field: e.target.value })); invalidateArticleViewPreview(); }} placeholder="vehicleID" /></label>
          <label>Display name field<input value={articleViewForm.display_name_field} onChange={e => { setArticleViewForm(prev => ({ ...prev, display_name_field: e.target.value })); invalidateArticleViewPreview(); }} placeholder="govNumber" /></label>
          <label>Natural key fields<textarea rows={3} value={articleViewForm.natural_key_fields_text} onChange={e => { setArticleViewForm(prev => ({ ...prev, natural_key_fields_text: e.target.value })); invalidateArticleViewPreview(); }} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} /></label>
          <label>Status<select value={articleViewForm.status} onChange={e => setArticleViewForm(prev => ({ ...prev, status: e.target.value }))}><option value="draft">draft</option><option value="reviewed">reviewed</option><option value="active">active</option><option value="paused">paused</option></select></label>
          <label>Freshness policy<select value={articleViewForm.freshness_policy} onChange={e => { setArticleViewForm(prev => ({ ...prev, freshness_policy: e.target.value })); invalidateArticleViewPreview(); }}><option value="manual">manual</option><option value="P1D">daily</option><option value="P7D">weekly</option><option value="P30D">every 30 days</option></select></label>
          <label>Classification<input value={articleViewForm.classification} onChange={e => { setArticleViewForm(prev => ({ ...prev, classification: e.target.value })); invalidateArticleViewPreview(); }} placeholder="shared" /></label>
          <label style={{ alignSelf: 'end' }}><input type="checkbox" checked={articleViewForm.pii} onChange={e => { setArticleViewForm(prev => ({ ...prev, pii: e.target.checked })); invalidateArticleViewPreview(); }} style={{ marginRight: 8 }} />Contains PII</label>
          <div style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Schema-template article sections</h3>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>TODO source of truth is active schema `_templates/&lt;type&gt;`; current editor keeps sections editable and blocks approve if all are empty.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{Object.entries(articleSections).map(([key, value]) => <label key={`article-view-${key}`} style={{ display: 'block' }}>{sectionLabels[key] || key}<textarea rows={key === 'links' || key === 'notes' ? 4 : 2} value={value} onFocus={() => setActiveSection(key)} onDrop={e => { e.preventDefault(); const token = e.dataTransfer.getData('text/plain'); if (token) updateArticleSection(key, `${value}${value ? ' ' : ''}${token}`); }} onDragOver={e => e.preventDefault()} onChange={e => updateArticleSection(key, e.target.value)} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} /></label>)}</div>
          </div>
        </div>
      </div>
    </div>}

    {tab === 'preview' && <section style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'rgba(15, 23, 42, 0.34)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div><h3 style={{ fontSize: 15, margin: 0 }}>Preview / Предпросмотр статей</h3><div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>Dry-run renders Markdown for {formSampleLimit || 25} rows and returns the chain hash required for approval.</div></div>
        <button className="btn btn-primary" disabled={busy !== null || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => void runArticleViewPreview()}>{busy === 'catalog-article-preview' ? 'Generating…' : `Preview ${formSampleLimit || 25} articles`}</button>
      </div>
      {articleViewPreview === null ? <div style={{ color: 'var(--text-muted)' }}>No article preview yet.</div> : <DryRunPreview value={articleViewPreview} currentTargetSourceId={articleViewForm.target_source_id} />}
      {(articleViewSaveResult !== null || articleViewApproveResult !== null) && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}><div><h3 style={{ fontSize: 13 }}>Saved article view</h3><PreviewJson value={articleViewSaveResult} empty="No save result." /></div><div><h3 style={{ fontSize: 13 }}>Approved compiled snapshot</h3><PreviewJson value={articleViewApproveResult} empty="No approve result." /></div></div>}
    </section>}

    {tab === 'runs' && <section style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id} onClick={() => void loadArticleViewRuns()}>{busy === 'catalog-article-runs' ? 'Loading…' : 'Load runs'}</button>
        <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id || selectedArticleViewRow?.stale === true} onClick={() => void runArticleViewBatch(20, false)}>Run trial batch (20)</button>
        <button className="btn btn-primary" disabled={busy !== null || !articleViewForm.article_view_id || selectedArticleViewRow?.stale === true} onClick={() => void runArticleViewBatch(undefined, true)}>Run changed_since</button>
        {selectedArticleViewRow?.stale === true && <span style={{ color: 'var(--warning)', alignSelf: 'center' }}>Stale: re-preview and approve before batch run.</span>}
      </div>
      <table><thead><tr><th>run_id</th><th>finished</th><th>total</th><th>success</th><th>unchanged</th><th>skipped</th><th>failed</th></tr></thead><tbody>{rows.map(row => <tr key={String(row.run_id)}><td className="mono">{val(row.run_id)}</td><td>{val(row.finished_at)}</td><td>{val(row.total)}</td><td>{val(row.success)}</td><td>{val(row.unchanged)}</td><td>{val(row.skipped)}</td><td>{val(row.failed)}</td></tr>)}</tbody></table>
      <div style={{ marginTop: 12 }}><h3 style={{ fontSize: 13 }}>Last run result</h3><PreviewJson value={articleViewRunResult} empty="No run executed from this UI session." /></div>
    </section>}
  </section>;
}
