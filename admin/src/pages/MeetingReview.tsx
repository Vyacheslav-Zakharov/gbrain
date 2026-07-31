import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import './AIReview.css';

type Status = 'pending' | 'accepted' | 'rejected';
type DraftField = 'canonical_markdown' | 'shared_markdown' | 'split_markdown';
type Draft = Record<DraftField, string>;

type Item = {
  id: string;
  topic: string;
  date: string;
  slug: string;
  source: string;
  split_source: string | null;
  status: Status;
  route_reason: string;
  needs_review: Array<Record<string, unknown>>;
  created_stubs: string[];
  job_id?: number;
  draft?: Draft;
};

type Detail = { item: Item; revisions: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> };

const STATUS_LABELS: Record<Status, string> = { pending: 'Ожидают', accepted: 'Приняты', rejected: 'Отклонены' };
const FIELD_LABELS: Record<DraftField, string> = {
  canonical_markdown: 'Закрытая canonical page',
  shared_markdown: 'Shared stub',
  split_markdown: 'Профильная выжимка',
};
const EMPTY_DRAFT: Draft = { canonical_markdown: '', shared_markdown: '', split_markdown: '' };

export function MeetingReviewPage() {
  const [status, setStatus] = useState<Status>('pending');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Item[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [field, setField] = useState<DraftField>('canonical_markdown');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const data = await api.meetingReviewItems({ status, q: query, limit: 200 });
      if (request !== listRequest.current) return;
      setRows(data.rows || []); setTotal(Number(data.total || 0)); setError('');
      if (selected && !(data.rows || []).some((row: Item) => row.id === selected)) setSelected(null);
    } catch (e) {
      if (request !== listRequest.current) return;
      setRows([]); setTotal(0); setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [status, query, selected]);

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

  const original = useMemo(() => ({ ...EMPTY_DRAFT, ...(detail?.item.draft || {}) }), [detail]);
  const dirty = useMemo(() => JSON.stringify(original) !== JSON.stringify(draft), [original, draft]);
  const clearSelection = () => {
    detailRequest.current += 1;
    setSelected(null);
    setDetail(null);
    setDraft(EMPTY_DRAFT);
    setComment('');
    setMobileDetail(false);
  };
  const choose = (id: string) => {
    if (dirty && !confirm('Отменить несохранённые изменения?')) return;
    setSelected(id);
    setMobileDetail(true);
    setError('');
  };

  const revise = async () => {
    if (!selected || !comment.trim()) return;
    setBusy('llm'); setError(''); setNotice('');
    try {
      const result = await api.meetingReviewLlmRevision(selected, field, comment);
      setDraft({ ...EMPTY_DRAFT, ...result.draft }); setNotice(`LLM revision #${result.revision_id} создана. Проверьте diff перед принятием.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const accept = async () => {
    if (!selected || !detail) return;
    if (!draft.canonical_markdown.trim()) { setError('Canonical Markdown пуст. Сначала обновите preview.'); return; }
    if (!confirm(`Принять встречу ${detail.item.date} «${detail.item.topic}» и поставить ingest в очередь?`)) return;
    setBusy('accept'); setError(''); setNotice('');
    try {
      if (dirty) await api.meetingReviewManualRevision(selected, draft);
      const result = await api.meetingReviewAccept(selected, draft);
      setNotice(`Встреча принята. Minions job #${result.job_id} поставлен в очередь.`);
      clearSelection(); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const reject = async () => {
    if (!selected) return;
    const reason = prompt('Причина отклонения (необязательно):');
    if (reason === null) return;
    setBusy('reject'); setError('');
    try { await api.meetingReviewReject(selected, reason); clearSelection(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const refresh = async () => {
    setBusy('refresh'); setError(''); setNotice('');
    try { const result = await api.meetingReviewRefresh(); setNotice(`Preview поставлен в очередь: job #${result.job_id}. Обновите список после завершения.`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  return <div className="ai-review meeting-review">
    <header className="ai-review-header"><div><h1>Проверка встреч</h1><p>Предпросмотр не публикуется. Принятие фиксирует проверенный Markdown и ставит управляемый импорт в очередь Minions.</p></div><div className="ai-review-count" aria-live="polite" aria-busy={total === null}>{status === 'pending' ? `Ожидают проверки: ${total ?? '…'}` : `${STATUS_LABELS[status]}: ${total ?? '…'}`}</div></header>
    <div className="ai-review-toolbar">
      <div className="ai-review-tabs" role="group" aria-label="Статус встреч">{(['pending', 'accepted', 'rejected'] as Status[]).map(value => <button type="button" key={value} className={status === value ? 'active' : ''} onClick={() => { if (!dirty || confirm('Отменить несохранённые изменения?')) { clearSelection(); setRows([]); setTotal(null); setStatus(value); } }}>{STATUS_LABELS[value]}</button>)}</div>
      <input aria-label="Поиск встреч" placeholder="Поиск по теме, дате или источнику" value={query} onChange={e => { if (dirty && !confirm('Отменить несохранённые изменения?')) return; clearSelection(); setRows([]); setTotal(null); setQuery(e.target.value); }} />
      <button type="button" disabled={Boolean(busy)} onClick={refresh}>{busy === 'refresh' ? 'Обновляем…' : 'Обновить предпросмотр'}</button>
    </div>
    {error && <div className="ai-review-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Закрыть сообщение">×</button></div>}
    {notice && <div className="receipt" role="status">{notice}</div>}
    <div className={`ai-review-grid ${mobileDetail ? 'show-detail' : ''}`}>
      <section className="proposal-list" aria-label="Очередь встреч">
        {loading && <div className="empty-state" aria-busy="true"><span className="loading-spinner" />Загружаем встречи…</div>}
        {!loading && rows.length === 0 && <div className="empty-state"><strong>В этом статусе встреч нет</strong><span>Измените фильтр или поисковый запрос.</span></div>}
        {rows.map(row => <button type="button" key={row.id} className={`proposal-row ${selected === row.id ? 'selected' : ''}`} onClick={() => choose(row.id)}>
          <div className="proposal-row-top"><span>{row.date}</span><span>{row.source}</span><span>{STATUS_LABELS[row.status]}</span></div>
          <strong>{row.topic}</strong>
          <div className="proposal-row-preview">{row.route_reason || 'Маршрут импорта будет показан в карточке встречи.'}</div>
          <div className="proposal-row-meta">{row.slug}{row.job_id ? ` · job #${row.job_id}` : ''}</div>
        </button>)}
      </section>
      <section className="proposal-detail" aria-label="Карточка встречи">{detail ? <>
        <button type="button" className="mobile-back" onClick={() => setMobileDetail(false)}>← К очереди</button>
        <div className="detail-title"><div><span className={`status-pill ${detail.item.status}`}>{STATUS_LABELS[detail.item.status]}</span> <strong>{detail.item.topic}</strong></div><code>{detail.item.source}:{detail.item.slug}</code></div>
        <div className="concept-evidence-summary"><strong>Маршрут импорта</strong><span>{detail.item.route_reason}</span></div>
        {(detail.item.needs_review.length > 0 || detail.item.created_stubs.length > 0) && <details className="source-context" open><summary>Проверка безопасности</summary><pre>{JSON.stringify({ needs_review: detail.item.needs_review, planned_stubs: detail.item.created_stubs }, null, 2)}</pre></details>}
        <div className="ai-review-tabs meeting-document-tabs" role="group" aria-label="Документ встречи">{(Object.keys(FIELD_LABELS) as DraftField[]).map(value => <button type="button" key={value} disabled={!draft[value] && value !== 'canonical_markdown'} className={field === value ? 'active' : ''} onClick={() => setField(value)}>{FIELD_LABELS[value]}</button>)}</div>
        <div className="review-form"><label>{FIELD_LABELS[field]}<textarea rows={22} value={draft[field]} disabled={detail.item.status !== 'pending'} onChange={e => setDraft(current => ({ ...current, [field]: e.target.value }))} /></label></div>
        {detail.item.status === 'pending' && <>
          <div className="llm-box"><label>Комментарий для LLM — публикации не будет<textarea rows={3} placeholder="Что исправить в выбранном документе" value={comment} onChange={e => setComment(e.target.value)} /></label><button type="button" disabled={Boolean(busy) || !comment.trim()} onClick={revise}>{busy === 'llm' ? 'Готовим черновик…' : 'Создать LLM revision'}</button></div>
          <div className="review-actions"><button type="button" className="reject" disabled={Boolean(busy)} onClick={reject}>{busy === 'reject' ? 'Отклоняем…' : 'Отклонить'}</button><button type="button" className="accept" disabled={Boolean(busy) || !draft.canonical_markdown.trim()} onClick={accept}>{busy === 'accept' ? 'Ставим в очередь…' : 'Принять и поставить импорт'}</button></div>
        </>}
        <details className="source-context"><summary>История ({detail.revisions.length} revisions / {detail.events.length} events)</summary><pre>{JSON.stringify({ revisions: detail.revisions, events: detail.events }, null, 2)}</pre></details>
      </> : <div className="empty-state"><strong>Выберите встречу</strong><span>Документы, маршрут и действия появятся здесь.</span></div>}</section>
    </div>
  </div>;
}
