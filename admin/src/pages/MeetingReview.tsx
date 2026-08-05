import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import './AIReview.css';

type Status = 'pending' | 'accepted' | 'rejected';
type ReviewClass = 'ready' | 'exception';
type View = ReviewClass | 'accepted' | 'rejected';
type DraftField = 'canonical_markdown' | 'shared_markdown' | 'split_markdown';
type Draft = Record<DraftField, string>;
type Attention = { kind: string; title: string; detail: string; action: string; value?: string };

type Item = {
  id: string;
  topic: string;
  date: string;
  slug: string;
  source: string;
  split_source: string | null;
  shared_stub?: boolean;
  status: Status;
  route_reason: string;
  review_class: ReviewClass;
  attention: Attention[];
  needs_review: Array<Record<string, unknown>>;
  created_stubs: string[];
  job_id?: number;
  draft?: Draft;
};

type Detail = { item: Item; revisions: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> };
type Counts = Record<ReviewClass, number>;

const VIEW_LABELS: Record<View, string> = {
  exception: 'Требуют решения',
  ready: 'Готовы автоматически',
  accepted: 'Приняты ранее',
  rejected: 'Отклонены',
};
const FIELD_LABELS: Record<DraftField, string> = {
  canonical_markdown: 'Закрытый документ',
  shared_markdown: 'Сокращённый общий документ',
  split_markdown: 'Профильная выжимка',
};
const EMPTY_DRAFT: Draft = { canonical_markdown: '', shared_markdown: '', split_markdown: '' };
const SOURCE_LABELS: Record<string, string> = {
  shared: 'Общая база знаний',
  'internal-management': 'Закрытая база руководства',
  'internal-hr': 'Закрытая кадровая база',
  'internal-it': 'Закрытая ИТ-база',
  'internal-sales-marketing': 'Закрытая коммерческая база',
  'internal-finance': 'Закрытая финансовая база',
};

function sourceLabel(source: string) { return SOURCE_LABELS[source] || source; }

function publicationTarget(item: Item) {
  const targets = [sourceLabel(item.source)];
  if (item.split_source && item.split_source !== item.source) targets.push(sourceLabel(item.split_source));
  if (item.source !== 'shared' && item.shared_stub) targets.push('сокращённая страница в общей базе');
  return targets.join(' + ');
}

function itemStatusLabel(item: Item) {
  if (item.status === 'accepted') return 'Принята ранее';
  if (item.status === 'rejected') return 'Отклонена';
  return item.review_class === 'exception' ? 'Нужно решение' : 'Готово автоматически';
}

function requestFilter(view: View) {
  if (view === 'accepted' || view === 'rejected') return { status: view };
  return { status: 'pending', review_class: view };
}

export function MeetingReviewPage() {
  const [view, setView] = useState<View>('exception');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Counts>({ exception: 0, ready: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [field, setField] = useState<DraftField>('canonical_markdown');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const detailRequest = useRef(0);

  const load = useCallback(async () => {
    try {
      const data = await api.meetingReviewItems({ ...requestFilter(view), q: query, limit: 200 });
      setRows(data.rows || []); setTotal(data.total || 0);
      if (view === 'exception' || view === 'ready') setCounts(data.counts || { exception: 0, ready: 0 });
      setError('');
      if (selected && !(data.rows || []).some((row: Item) => row.id === selected)) setSelected(null);
    } catch (e) { setRows([]); setTotal(0); setCounts({ exception: 0, ready: 0 }); setError(e instanceof Error ? e.message : String(e)); }
  }, [view, query, selected]);

  const loadDetail = useCallback(async (id: string) => {
    const request = ++detailRequest.current;
    try {
      const data = await api.meetingReviewItem(id) as Detail;
      if (request !== detailRequest.current) return;
      setDetail(data); setDraft({ ...EMPTY_DRAFT, ...(data.item.draft || {}) }); setError(''); setNotice('');
      setField(data.item.draft?.canonical_markdown ? 'canonical_markdown' : data.item.draft?.shared_markdown ? 'shared_markdown' : 'split_markdown');
    } catch (e) { if (request === detailRequest.current) setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(load, 180); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { if (selected) void loadDetail(selected); else setDetail(null); }, [selected, loadDetail]);

  const choose = (id: string) => { setSelected(id); setMobileDetail(true); setError(''); };
  const reject = async () => {
    if (!selected) return;
    const reason = prompt('Почему встречу не следует публиковать?');
    if (reason === null) return;
    setBusy('reject'); setError('');
    try { await api.meetingReviewReject(selected, reason); await load(); setSelected(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const refresh = async () => {
    setBusy('refresh'); setError(''); setNotice('');
    try { const result = await api.meetingReviewRefresh(); setNotice(`Предпросмотр поставлен в очередь: задание #${result.job_id}. После завершения обновите список.`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  return <div className="ai-review meeting-review">
    <header className="ai-review-header"><div><h1>Проверка встреч</h1><p>Ручное решение требуется только для конкретных исключений. Встречи без замечаний публикуются автоматически по безопасной процедуре.</p></div><div className="ai-review-count">{VIEW_LABELS[view]}: {total}</div></header>
    <div className="ai-review-toolbar">
      <div className="ai-review-tabs" role="group" aria-label="Состояние встреч">{(['exception', 'ready', 'accepted', 'rejected'] as View[]).map(value => <button type="button" key={value} className={view === value ? 'active' : ''} onClick={() => { setView(value); setSelected(null); setMobileDetail(false); }}>{VIEW_LABELS[value]}{value === 'exception' || value === 'ready' ? ` (${counts[value]})` : ''}</button>)}</div>
      <input aria-label="Поиск встреч" placeholder="Поиск по теме, дате или источнику" value={query} onChange={e => { setSelected(null); setMobileDetail(false); setQuery(e.target.value); }} />
      <button type="button" disabled={Boolean(busy)} onClick={refresh}>{busy === 'refresh' ? 'Обновляем…' : 'Обновить предпросмотр'}</button>
    </div>
    {error && <div className="ai-review-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Закрыть сообщение">×</button></div>}
    {notice && <div className="receipt" role="status">{notice}</div>}
    <div className={`ai-review-grid ${mobileDetail ? 'show-detail' : ''}`}>
      <section className="proposal-list" aria-label="Очередь встреч">
        {rows.length === 0 && <div className="empty-state"><strong>В этой категории встреч нет</strong><span>Измените фильтр или поисковый запрос.</span></div>}
        {rows.map(row => <button type="button" key={row.id} className={`proposal-row ${selected === row.id ? 'selected' : ''}`} onClick={() => choose(row.id)}>
          <div className="proposal-row-top"><span>{row.date}</span><span>{sourceLabel(row.source)}</span><span>{itemStatusLabel(row)}</span></div>
          <strong>{row.topic}</strong>
          <div className="proposal-row-preview">{row.review_class === 'exception' ? row.attention[0]?.title || 'Требуется проверка' : 'Проверки пройдены · действий не требуется'}</div>
          <div className="proposal-row-meta">{row.slug}{row.job_id ? ` · job #${row.job_id}` : ''}</div>
        </button>)}
      </section>
      <section className="proposal-detail" aria-label="Карточка встречи">{detail ? <>
        <button type="button" className="mobile-back" onClick={() => setMobileDetail(false)}>← К очереди</button>
        <div className="detail-title"><div><span className={`status-pill ${detail.item.review_class}`}>{itemStatusLabel(detail.item)}</span> <strong>{detail.item.topic}</strong></div><code>{detail.item.source}:{detail.item.slug}</code></div>
        {detail.item.review_class === 'ready' ? <div className="meeting-verdict ready"><strong>Проверки пройдены</strong><span>Ошибок, неподтверждённых сущностей и запланированных новых страниц нет.</span><b>Действий не требуется — встреча будет опубликована автоматически.</b></div> : <div className="meeting-verdict exception"><strong>Что требует решения</strong>{detail.item.attention.map((item, index) => <div className="meeting-attention" key={`${item.kind}:${item.value || index}`}><b>{item.title}</b><span>{item.detail}</span><em>Что сделать: {item.action}</em>{item.value && <code>{item.value}</code>}</div>)}</div>}
        <div className="concept-evidence-summary"><strong>Куда будет опубликовано</strong><span>{publicationTarget(detail.item)}</span></div>
        <div className="ai-review-tabs meeting-document-tabs" role="group" aria-label="Документ встречи">{(Object.keys(FIELD_LABELS) as DraftField[]).map(value => <button type="button" key={value} disabled={!draft[value] && value !== 'canonical_markdown'} className={field === value ? 'active' : ''} onClick={() => setField(value)}>{FIELD_LABELS[value]}</button>)}</div>
        <div className="review-form"><label>{FIELD_LABELS[field]}<textarea rows={22} value={draft[field]} readOnly /></label></div>
        {detail.item.status === 'pending' && detail.item.review_class === 'exception' && <div className="review-actions"><span className="review-action-note">Редактирование текста не устраняет проблему сопоставления, конфиденциальности или маршрута. Сначала выполните указанное действие и обновите предпросмотр.</span><button type="button" className="reject" disabled={Boolean(busy)} onClick={reject}>{busy === 'reject' ? 'Отклоняем…' : 'Не публиковать'}</button></div>}
        <details className="source-context"><summary>История ({detail.revisions.length} версий / {detail.events.length} событий)</summary><pre>{JSON.stringify({ revisions: detail.revisions, events: detail.events }, null, 2)}</pre></details>
      </> : <div className="empty-state"><strong>Выберите встречу</strong><span>Причина, требуемое действие и документы появятся здесь.</span></div>}</section>
    </div>
  </div>;
}
