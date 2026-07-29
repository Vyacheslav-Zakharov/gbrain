import React, { useMemo, useState } from 'react';
import { ArticleViewStatePanel } from './ArticleViewStatePanel';
import { ChangeIntelligenceEditor, type ChangeIntelligencePolicy } from './ChangeIntelligenceEditor';
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
type Tab = 'definition' | 'changes' | 'preview' | 'runs';

type Props = {
  busy: Busy;
  sources: Array<{ id: string; name: string }>;
  formSampleLimit: number;
  articleViewForm: ArticleViewForm;
  setArticleViewForm: React.Dispatch<React.SetStateAction<ArticleViewForm>>;
  articleChangePolicy: ChangeIntelligencePolicy;
  setArticleChangePolicy: React.Dispatch<React.SetStateAction<ChangeIntelligencePolicy>>;
  articleViewCurrentChainHash: string;
  selectedArticleViewRow: Record<string, unknown> | null;
  articleAvailableFields: string[];
  articleInputChoices: ArticleInputChoice[];
  articleSections: Record<string, string>;
  sectionLabels: Record<string, string>;
  requiredFrontmatter: string[];
  articleTemplate: unknown;
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
  return <button type="button" role="tab" aria-selected={active === tab} className="btn btn-secondary source-ingest-tab" onClick={() => onClick(tab)} style={{ borderColor: active === tab ? 'var(--accent)' : undefined }}>{children}</button>;
}

export function ArticleViewEditor({ busy, sources, formSampleLimit, articleViewForm, setArticleViewForm, articleChangePolicy, setArticleChangePolicy, articleViewCurrentChainHash, selectedArticleViewRow, articleAvailableFields, articleInputChoices, articleSections, sectionLabels, requiredFrontmatter, articleTemplate, articleViewPreview, articleViewRuns, articleViewRunResult, articleViewSaveResult, articleViewApproveResult, setActiveSection, seedArticleViewFromCurrent, runArticleViewPreview, saveArticleView, deleteArticleView, approveArticleView, loadArticleViewRuns, runArticleViewBatch, invalidateArticleViewPreview, insertFieldToken, updateArticleSection, DryRunPreview, PreviewJson, studioSectionStyle }: Props) {
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
    const generatedFrontmatter = new Set(['type', 'title', 'source_id', 'status']);
    for (const key of requiredFrontmatter) if (!generatedFrontmatter.has(key)) missing.push(`frontmatter.${key}`);
    if (Object.values(articleSections).every(v => !String(v || '').trim())) missing.push('article_template_sections');
    return missing;
  }, [articleViewForm, articleSections, requiredFrontmatter]);
  const canApprove = Boolean(articleViewForm.article_view_id && articleViewCurrentChainHash && missingRequired.length === 0);

  return <section style={studioSectionStyle('article_views')}>
    <h2 className="section-title">4. Публикация (Article view)</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      Полный цикл публикации: настройка → предпросмотр → защищённое утверждение → история запусков. Этот поток заменяет прежний Review для публикаций.
    </p>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={seedArticleViewFromCurrent}>Заполнить из текущего входа</button>
      <button className={`${articleViewCurrentChainHash || tab === 'preview' ? 'btn btn-secondary' : 'btn btn-primary'} source-ingest-context-primary`} disabled={busy !== null || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => { setTab('preview'); void runArticleViewPreview(); }}>{busy === 'catalog-article-preview' ? 'Собираем превью…' : 'Собрать превью'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => void saveArticleView()}>{busy === 'catalog-article-view' ? 'Сохраняем…' : 'Сохранить публикацию'}</button>
      <button className="btn btn-danger" disabled={busy !== null || !articleViewForm.article_view_id} onClick={() => void deleteArticleView()}>{busy === 'catalog-article-view-delete' ? 'Удаляем…' : 'Удалить публикацию'}</button>
      <button className={`${articleViewCurrentChainHash ? 'btn btn-primary' : 'btn btn-secondary'} source-ingest-context-primary`} disabled={busy !== null || !canApprove} onClick={() => void approveArticleView()}>{busy === 'catalog-article-approve' ? 'Фиксируем…' : 'Зафиксировать snapshot'}</button>
      <span style={{ color: articleViewCurrentChainHash ? 'var(--success)' : 'var(--text-muted)', alignSelf: 'center' }}>{articleViewCurrentChainHash ? `chain ${articleViewCurrentChainHash.slice(0, 12)}…` : 'Для утверждения сначала выполните предпросмотр.'}</span>
    </div>
    <div role="tablist" aria-label="Разделы публикации" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      <TabButton tab="definition" active={tab} onClick={setTab}>Определение</TabButton>
      <TabButton tab="changes" active={tab} onClick={setTab}>Изменения</TabButton>
      <TabButton tab="preview" active={tab} onClick={setTab}>Превью</TabButton>
      <TabButton tab="runs" active={tab} onClick={setTab}>Запуски</TabButton>
    </div>
    {missingRequired.length > 0 && <div style={{ padding: 10, borderRadius: 8, background: 'rgba(245, 158, 11, 0.12)', color: 'var(--warning)', marginBottom: 12 }}>Не заполнены обязательные поля: <code>{missingRequired.join(', ')}</code>. Черновик можно сохранить, но утверждение будет недоступно.</div>}
    <ArticleViewStatePanel row={selectedArticleViewRow} previewHash={articleViewCurrentChainHash} />

    {tab === 'definition' && <div className="source-ingest-article-definition" style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 14, alignItems: 'start', marginTop: 12 }}>
      <aside style={{ position: 'sticky', top: 90, border: '1px solid var(--border)', borderRadius: 8, padding: 10, maxHeight: 'calc(100vh - 118px)', overflow: 'auto', background: 'rgba(15,23,42,0.55)' }}>
        <h3 style={{ fontSize: 13, marginBottom: 6 }}>Поля входа</h3>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>Вход: <code>{articleViewForm.input_kind}</code> · <code>{articleViewForm.input_id || '—'}</code>. Нажатие вставляет поле в активный раздел шаблона.</div>
        {articleAvailableFields.length === 0 && <div style={{ color: 'var(--warning)', fontSize: 12 }}>Поля не найдены. Выполните предпросмотр источника или преобразования либо задайте явные алиасы SELECT.</div>}
        {articleAvailableFields.map(field => <button key={field} type="button" className="btn btn-secondary" draggable onDragStart={e => e.dataTransfer.setData('text/plain', `{{ ${field} }}`)} onClick={() => insertFieldToken(field)} style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left', padding: '6px 8px' }}><code>{field}</code></button>)}
      </aside>
      <div style={{ minWidth: 0 }}>
        <div className="source-ingest-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <label>ID публикации<input value={articleViewForm.article_view_id} onChange={e => setArticleViewForm(prev => ({ ...prev, article_view_id: e.target.value }))} placeholder="av-equipment" /></label>
          <label>Название<input value={articleViewForm.display_name} onChange={e => setArticleViewForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="Equipment articles" /></label>
          <label>Тип входа<select value={articleViewForm.input_kind} onChange={e => { setArticleViewForm(prev => ({ ...prev, input_kind: e.target.value === 'transform_view' ? 'transform_view' : 'base_view' })); invalidateArticleViewPreview(); }}><option value="base_view">base_view</option><option value="transform_view">transform_view</option></select></label>
          <label>ID входа<select value={`${articleViewForm.input_kind}:${articleViewForm.input_id}`} onChange={e => { const [kind, id] = e.target.value.split(':', 2); setArticleViewForm(prev => ({ ...prev, input_kind: kind === 'transform_view' ? 'transform_view' : 'base_view', input_id: id || e.target.value })); invalidateArticleViewPreview(); }}><option value={`${articleViewForm.input_kind}:${articleViewForm.input_id}`}>{articleViewForm.input_kind} · {articleViewForm.input_id || 'manual'}</option>{articleInputChoices.map(choice => <option key={`${choice.kind}:${choice.id}`} value={`${choice.kind}:${choice.id}`}>{choice.label}</option>)}</select><input value={articleViewForm.input_id} onChange={e => { setArticleViewForm(prev => ({ ...prev, input_id: e.target.value })); invalidateArticleViewPreview(); }} placeholder="tv-vehicles-clean" style={{ marginTop: 6 }} /></label>
          <label>Тип GBrain<input value={articleViewForm.gbrain_type} onChange={e => { setArticleViewForm(prev => ({ ...prev, gbrain_type: e.target.value })); invalidateArticleViewPreview(); }} placeholder="equipment" /></label>
          <label>Целевой источник GBrain<select value={articleViewForm.target_source_id} onChange={e => { setArticleViewForm(prev => ({ ...prev, target_source_id: e.target.value })); invalidateArticleViewPreview(); }}>{sources.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}</select>{articleViewForm.target_source_id === 'shared' && <span style={{ display: 'block', color: 'var(--warning)', fontSize: 12 }}>shared — корпоративный канон, доступный всем федеративным читателям.</span>}</label>
          <label style={{ gridColumn: '1 / -1' }}>Шаблон slug<input value={articleViewForm.slug_template} onChange={e => { setArticleViewForm(prev => ({ ...prev, slug_template: e.target.value })); invalidateArticleViewPreview(); }} placeholder="source-ingest/vehicles/{{ vehicleID | slugify }}" /></label>
          <label>Поле внешнего ID<input value={articleViewForm.external_id_field} onChange={e => { setArticleViewForm(prev => ({ ...prev, external_id_field: e.target.value })); invalidateArticleViewPreview(); }} placeholder="vehicleID" /></label>
          <label>Поле названия<input value={articleViewForm.display_name_field} onChange={e => { setArticleViewForm(prev => ({ ...prev, display_name_field: e.target.value })); invalidateArticleViewPreview(); }} placeholder="govNumber" /></label>
          <details style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <summary>Дополнительные настройки</summary>
            <div className="source-ingest-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
              <label>Поля естественного ключа<textarea rows={3} value={articleViewForm.natural_key_fields_text} onChange={e => { setArticleViewForm(prev => ({ ...prev, natural_key_fields_text: e.target.value })); invalidateArticleViewPreview(); }} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} /></label>
              <label>Статус<select value={articleViewForm.status} onChange={e => setArticleViewForm(prev => ({ ...prev, status: e.target.value }))}><option value="draft">draft</option><option value="reviewed">reviewed</option><option value="active">active</option><option value="paused">paused</option></select></label>
              <label>Политика актуальности<select value={articleViewForm.freshness_policy} onChange={e => { setArticleViewForm(prev => ({ ...prev, freshness_policy: e.target.value })); invalidateArticleViewPreview(); }}><option value="manual">вручную</option><option value="P1D">ежедневно</option><option value="P7D">еженедельно</option><option value="P30D">каждые 30 дней</option></select></label>
              <label>Классификация<input value={articleViewForm.classification} onChange={e => { setArticleViewForm(prev => ({ ...prev, classification: e.target.value })); invalidateArticleViewPreview(); }} placeholder="shared" /></label>
              <label style={{ alignSelf: 'end' }}><input type="checkbox" checked={articleViewForm.pii} onChange={e => { setArticleViewForm(prev => ({ ...prev, pii: e.target.checked })); invalidateArticleViewPreview(); }} style={{ marginRight: 8 }} />Содержит PII</label>
            </div>
          </details>
          <div style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Разделы статьи из schema-template</h3>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
              Источник: <code>{val(asObj(articleTemplate).template_page) || 'fallback'}</code>; обязательный frontmatter: {requiredFrontmatter.length ? requiredFrontmatter.map(key => <code key={key} style={{ marginLeft: 4 }}>{key}</code>) : '—'}.
            </div>
            <div className="source-ingest-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{Object.entries(articleSections).map(([key, value]) => <label key={`article-view-${key}`} style={{ display: 'block' }}>{sectionLabels[key] || key}<textarea rows={key === 'links' || key === 'notes' ? 4 : 2} value={value} onFocus={() => setActiveSection(key)} onDrop={e => { e.preventDefault(); const token = e.dataTransfer.getData('text/plain'); if (token) updateArticleSection(key, `${value}${value ? ' ' : ''}${token}`); }} onDragOver={e => e.preventDefault()} onChange={e => updateArticleSection(key, e.target.value)} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} /></label>)}</div>
          </div>
        </div>
      </div>
    </div>}

    {tab === 'changes' && <ChangeIntelligenceEditor
      policy={articleChangePolicy}
      setPolicy={setArticleChangePolicy}
      availableFields={articleAvailableFields}
      gbrainType={articleViewForm.gbrain_type}
      invalidate={invalidateArticleViewPreview}
    />}

    {tab === 'preview' && <section style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'rgba(15, 23, 42, 0.34)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div><h3 style={{ fontSize: 15, margin: 0 }}>Предпросмотр статей</h3><div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>Dry-run формирует Markdown для {formSampleLimit || 25} строк и возвращает chain hash, необходимый для утверждения.</div></div>
        <button className={`${articleViewCurrentChainHash ? 'btn btn-secondary' : 'btn btn-primary'} source-ingest-context-primary`} disabled={busy !== null || !articleViewForm.input_id || !articleViewForm.slug_template || !articleViewForm.external_id_field} onClick={() => void runArticleViewPreview()}>{busy === 'catalog-article-preview' ? 'Собираем…' : `Проверить ${formSampleLimit || 25} статей`}</button>
      </div>
      {articleViewPreview === null ? <div style={{ color: 'var(--text-muted)' }}>Предпросмотр статей ещё не выполнен.</div> : <DryRunPreview value={articleViewPreview} currentTargetSourceId={articleViewForm.target_source_id} />}
      {(articleViewSaveResult !== null || articleViewApproveResult !== null) && <details style={{ marginTop: 12 }}><summary>Технические детали</summary><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}><div><h3 style={{ fontSize: 13 }}>Сохранение публикации</h3><PreviewJson value={articleViewSaveResult} empty="Нет результата сохранения." /></div><div><h3 style={{ fontSize: 13 }}>Зафиксированный snapshot</h3><PreviewJson value={articleViewApproveResult} empty="Нет результата фиксации." /></div></div></details>}
    </section>}

    {tab === 'runs' && <section style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id} onClick={() => void loadArticleViewRuns()}>{busy === 'catalog-article-runs' ? 'Загружаем…' : 'Загрузить запуски'}</button>
        <button className="btn btn-secondary" disabled={busy !== null || !articleViewForm.article_view_id || selectedArticleViewRow?.stale === true} onClick={() => void runArticleViewBatch(20, false)}>Пробный запуск (20)</button>
        <button className="btn btn-primary" disabled={busy !== null || !articleViewForm.article_view_id || selectedArticleViewRow?.stale === true} onClick={() => void runArticleViewBatch(undefined, true)}>Запустить только изменившиеся</button>
        {selectedArticleViewRow?.stale === true && <span style={{ color: 'var(--warning)', alignSelf: 'center' }}>Публикация устарела: повторите предпросмотр и утверждение перед пакетным запуском.</span>}
      </div>
      <table><thead><tr><th>run_id</th><th>завершён</th><th>всего</th><th>успешно</th><th>без изменений</th><th>пропущено</th><th>ошибки</th></tr></thead><tbody>{rows.map(row => <tr key={String(row.run_id)}><td className="mono">{val(row.run_id)}</td><td>{val(row.finished_at)}</td><td>{val(row.total)}</td><td>{val(row.success)}</td><td>{val(row.unchanged)}</td><td>{val(row.skipped)}</td><td>{val(row.failed)}</td></tr>)}</tbody></table>
      <details style={{ marginTop: 12 }}><summary>Технические детали</summary><PreviewJson value={articleViewRunResult} empty="В этой UI-сессии запусков ещё не было." /></details>
    </section>}
  </section>;
}
