import React from 'react';
import { ArticleViewStatePanel } from './ArticleViewStatePanel';
import { val } from './shared';

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
  articleViewSaveResult: unknown;
  articleViewApproveResult: unknown;
  setActiveSection: (section: string) => void;
  seedArticleViewFromCurrent: () => void;
  runArticleViewPreview: () => void;
  saveArticleView: () => void;
  deleteArticleView: () => void;
  approveArticleView: () => void;
  invalidateArticleViewPreview: () => void;
  insertFieldToken: (field: string) => void;
  updateArticleSection: (key: string, value: string) => void;
  DryRunPreview: React.ComponentType<{ value: unknown; currentTargetSourceId: string }>;
  PreviewJson: React.ComponentType<{ value: unknown; empty: string }>;
  studioSectionStyle: (area: string) => React.CSSProperties;
};

export function ArticleViewEditor({ busy, sources, formSampleLimit, articleViewForm, setArticleViewForm, articleViewCurrentChainHash, selectedArticleViewRow, articleAvailableFields, articleInputChoices, articleSections, sectionLabels, articleViewPreview, articleViewSaveResult, articleViewApproveResult, setActiveSection, seedArticleViewFromCurrent, runArticleViewPreview, saveArticleView, deleteArticleView, approveArticleView, invalidateArticleViewPreview, insertFieldToken, updateArticleSection, DryRunPreview, PreviewJson, studioSectionStyle }: Props) {
  return <section style={studioSectionStyle('article_views')}>
    <h2 className="section-title">4. Article view / Публикация</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      First-class article view: chooses a base/transform input, target source, GBrain type, slug/identity mapping, article template, update/security/freshness policy, then freezes through approve.
    </p>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={seedArticleViewFromCurrent}>Seed from current transform/base</button>
      <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => void runArticleViewPreview()}>{busy === 'catalog-article-preview' ? 'Generating preview…' : 'Preview generated article'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => void saveArticleView()}>{busy === 'catalog-article-view' ? 'Saving…' : 'Save article view'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id} onClick={() => void deleteArticleView()}>{busy === 'catalog-article-view-delete' ? 'Deleting…' : 'Delete article view'}</button>
      <button className="btn btn-primary" disabled={busy !== null || !articleViewForm.article_view_id || !articleViewCurrentChainHash} onClick={() => void approveArticleView()}>{busy === 'catalog-article-approve' ? 'Approving…' : 'Approve / freeze snapshot'}</button>
      <span style={{ color: articleViewCurrentChainHash ? 'var(--success)' : 'var(--text-muted)', alignSelf: 'center' }}>{articleViewCurrentChainHash ? `Preview chain hash ${articleViewCurrentChainHash.slice(0, 12)}…` : 'Run preview to unlock chain-hash guarded approval.'}</span>
    </div>
    <ArticleViewStatePanel row={selectedArticleViewRow} previewHash={articleViewCurrentChainHash} />
    <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 14, alignItems: 'start', marginTop: 12 }}>
      <aside style={{ position: 'sticky', top: 90, border: '1px solid var(--border)', borderRadius: 8, padding: 10, maxHeight: 'calc(100vh - 118px)', overflow: 'auto', background: 'rgba(15,23,42,0.55)' }}>
        <h3 style={{ fontSize: 13, marginBottom: 6 }}>Available fields</h3>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>Input: <code>{articleViewForm.input_kind}</code> · <code>{articleViewForm.input_id || '—'}</code>. Click inserts into active section; drag into any textarea also works.</div>
        {articleAvailableFields.length === 0 && <div style={{ color: 'var(--warning)', fontSize: 12 }}>No fields found. For transform inputs, run SQL preview once or use explicit SELECT aliases.</div>}
        {articleAvailableFields.map(field => <button key={field} type="button" className="btn btn-secondary" draggable onDragStart={e => e.dataTransfer.setData('text/plain', `{{ ${field} }}`)} onClick={() => insertFieldToken(field)} style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left', padding: '6px 8px' }}>
          <code>{field}</code>
        </button>)}
      </aside>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <label>Article view id
            <input value={articleViewForm.article_view_id} onChange={e => setArticleViewForm(prev => ({ ...prev, article_view_id: e.target.value }))} placeholder="av-equipment" />
          </label>
          <label>Display name
            <input value={articleViewForm.display_name} onChange={e => setArticleViewForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="Equipment articles" />
          </label>
          <label>Input kind
            <select value={articleViewForm.input_kind} onChange={e => { setArticleViewForm(prev => ({ ...prev, input_kind: e.target.value === 'transform_view' ? 'transform_view' : 'base_view' })); invalidateArticleViewPreview(); }}>
              <option value="base_view">base_view</option>
              <option value="transform_view">transform_view</option>
            </select>
          </label>
          <label>Input id
            <select value={articleViewForm.input_id} onChange={e => {
              const [kind, id] = e.target.value.split(':', 2);
              setArticleViewForm(prev => ({ ...prev, input_kind: kind === 'transform_view' ? 'transform_view' : 'base_view', input_id: id || e.target.value }));
              invalidateArticleViewPreview();
            }}>
              <option value={`${articleViewForm.input_kind}:${articleViewForm.input_id}`}>{articleViewForm.input_kind} · {articleViewForm.input_id || 'manual'}</option>
              {articleInputChoices.map(choice => <option key={`${choice.kind}:${choice.id}`} value={`${choice.kind}:${choice.id}`}>{choice.label}</option>)}
            </select>
            <input value={articleViewForm.input_id} onChange={e => { setArticleViewForm(prev => ({ ...prev, input_id: e.target.value })); invalidateArticleViewPreview(); }} placeholder="tv-vehicles-clean" style={{ marginTop: 6 }} />
          </label>
          <label>GBrain type
            <input value={articleViewForm.gbrain_type} onChange={e => setArticleViewForm(prev => ({ ...prev, gbrain_type: e.target.value }))} placeholder="equipment" />
          </label>
          <label>Target GBrain source
            <select value={articleViewForm.target_source_id} onChange={e => { setArticleViewForm(prev => ({ ...prev, target_source_id: e.target.value })); invalidateArticleViewPreview(); }}>
              {sources.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>Slug template
            <input value={articleViewForm.slug_template} onChange={e => { setArticleViewForm(prev => ({ ...prev, slug_template: e.target.value })); invalidateArticleViewPreview(); }} placeholder="source-ingest/vehicles/{{ vehicleID | slugify }}" />
          </label>
          <label>External id field
            <input value={articleViewForm.external_id_field} onChange={e => { setArticleViewForm(prev => ({ ...prev, external_id_field: e.target.value })); invalidateArticleViewPreview(); }} placeholder="vehicleID" />
          </label>
          <label>Display name field
            <input value={articleViewForm.display_name_field} onChange={e => { setArticleViewForm(prev => ({ ...prev, display_name_field: e.target.value })); invalidateArticleViewPreview(); }} placeholder="govNumber" />
          </label>
          <label>Natural key fields
            <textarea rows={3} value={articleViewForm.natural_key_fields_text} onChange={e => { setArticleViewForm(prev => ({ ...prev, natural_key_fields_text: e.target.value })); invalidateArticleViewPreview(); }} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          </label>
          <label>Status
            <select value={articleViewForm.status} onChange={e => setArticleViewForm(prev => ({ ...prev, status: e.target.value }))}>
              <option value="draft">draft</option>
              <option value="reviewed">reviewed</option>
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
          </label>
          <label>Freshness policy
            <select value={articleViewForm.freshness_policy} onChange={e => { setArticleViewForm(prev => ({ ...prev, freshness_policy: e.target.value })); invalidateArticleViewPreview(); }}>
              <option value="PT6H">6 hours</option>
              <option value="P1D">1 day</option>
              <option value="P7D">7 days</option>
              <option value="P30D">30 days</option>
              <option value="P90D">90 days</option>
            </select>
          </label>
          <label>Classification
            <input value={articleViewForm.classification} onChange={e => { setArticleViewForm(prev => ({ ...prev, classification: e.target.value })); invalidateArticleViewPreview(); }} placeholder="shared" />
          </label>
          <label style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={articleViewForm.pii} onChange={e => { setArticleViewForm(prev => ({ ...prev, pii: e.target.checked })); invalidateArticleViewPreview(); }} style={{ marginRight: 8 }} />
            Contains PII
          </label>
          <div style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Article template sections used by article view</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {Object.entries(articleSections).map(([key, value]) => <label key={`article-view-${key}`} style={{ display: 'block' }}>
                {sectionLabels[key] || key}
                <textarea rows={key === 'links' || key === 'notes' ? 4 : 2} value={value} onFocus={() => setActiveSection(key)} onDrop={e => { e.preventDefault(); const token = e.dataTransfer.getData('text/plain'); if (token) updateArticleSection(key, `${value}${value ? ' ' : ''}${token}`); }} onDragOver={e => e.preventDefault()} onChange={e => updateArticleSection(key, e.target.value)} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
              </label>)}
            </div>
          </div>
        </div>
      </div>
    </div>
    <section style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'rgba(15, 23, 42, 0.34)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ minWidth: 260 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>5. Article preview / Предпросмотр статей</h3>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, maxWidth: 760 }}>Предпросмотр Markdown для первых {formSampleLimit || 25} строк текущего Article view. Это проверка перед сохранением/approve, без отдельного legacy-блока.</div>
        </div>
        <button className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} disabled={busy !== null || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => void runArticleViewPreview()}>{busy === 'catalog-article-preview' ? 'Generating…' : `Preview ${formSampleLimit || 25} articles`}</button>
      </div>
      {articleViewPreview === null
        ? <div style={{ color: 'var(--text-muted)' }}>No article preview yet. Click the preview button above to see rendered article Markdown for multiple source rows.</div>
        : <DryRunPreview value={articleViewPreview} currentTargetSourceId={articleViewForm.target_source_id} />}
    </section>
    {(articleViewSaveResult !== null || articleViewApproveResult !== null) && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
      <div><h3 style={{ fontSize: 13 }}>Saved article view</h3><PreviewJson value={articleViewSaveResult} empty="No save result." /></div>
      <div><h3 style={{ fontSize: 13 }}>Approved compiled snapshot</h3><PreviewJson value={articleViewApproveResult} empty="No approve result." /></div>
    </div>}
  </section>;
}
