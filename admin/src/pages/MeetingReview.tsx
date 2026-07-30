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
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [field, setField] = useState<DraftField>('canonical_markdown');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const detailRequest = useRef(0);

  const load = useCallback(async () => {
    try {
      const data = await api.meetingReviewItems({ status, q: query, limit: 200 });
      setRows(data.rows || []); setTotal(data.total || 0); setError('');
      if (selected && !(data.rows || []).some((row: Item) => row.id === selected)) setSelected(null);
    } catch (e) { setRows([]); setTotal(0); setError(e instanceof Error ? e.message : String(e)); }
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
  const choose = (id: string) => { if (dirty && !confirm('Отменить несохранённые изменения?')) return; setSelected(id); };

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
      await load(); setSelected(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const reject = async () => {
    if (!selected) return;
    const reason = prompt('Причина отклонения (необязательно):');
    if (reason === null) return;
    setBusy('reject'); setError('');
    try { await api.meetingReviewReject(selected, reason); await load(); setSelected(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const refresh = async () => {
    setBusy('refresh'); setError(''); setNotice('');
    try { const result = await api.meetingReviewRefresh(); setNotice(`Preview поставлен в очередь: job #${result.job_id}. Обновите список после завершения.`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  return <div className="ai-review">
    <header className="ai-review-header"><div><h1>Проверка встреч</h1><p>Preview не публикуется. Принятие фиксирует проверенный Markdown и ставит controlled ingest в Minions.</p></div><div className="ai-review-count">{total} · {STATUS_LABELS[status].toLowerCase()}</div></header>
    <div className="ai-review-toolbar">
      <div className="ai-review-tabs">{(['pending', 'accepted', 'rejected'] as Status[]).map(value => <button key={value} className={status === value ? 'active' : ''} onClick={() => { if (!dirty || confirm('Отменить несохранённые изменения?')) { setStatus(value); setSelected(null); } }}>{STATUS_LABELS[value]}</button>)}</div>
      <input aria-label="Поиск встреч" placeholder="Поиск" value={query} onChange={e => setQuery(e.target.value)} />
      <button disabled={Boolean(busy)} onClick={refresh}>Обновить preview</button>
    </div>
    {error && <div className="ai-review-error">{error}</div>}
    {notice && <div className="ai-review-receipt">{notice}</div>}
    <div className="ai-review-grid">
      <div className="proposal-list">{rows.map(row => <button key={row.id} className={selected === row.id ? 'selected' : ''} onClick={() => choose(row.id)}><b>{row.date} · {row.topic}</b><small>{row.source} · {row.id}{row.job_id ? ` · job #${row.job_id}` : ''}</small></button>)}</div>
      <div className="proposal-detail">{detail ? <>
        <h2>{detail.item.topic}</h2><p><code>{detail.item.source}:{detail.item.slug}</code></p>
        <p>{detail.item.route_reason}</p>
        {(detail.item.needs_review.length > 0 || detail.item.created_stubs.length > 0) && <details open><summary>Safety gate</summary><pre>{JSON.stringify({ needs_review: detail.item.needs_review, planned_stubs: detail.item.created_stubs }, null, 2)}</pre></details>}
        <div className="ai-review-tabs">{(Object.keys(FIELD_LABELS) as DraftField[]).map(value => <button key={value} disabled={!draft[value] && value !== 'canonical_markdown'} className={field === value ? 'active' : ''} onClick={() => setField(value)}>{FIELD_LABELS[value]}</button>)}</div>
        <textarea rows={28} value={draft[field]} disabled={detail.item.status !== 'pending'} onChange={e => setDraft(current => ({ ...current, [field]: e.target.value }))} />
        {detail.item.status === 'pending' && <>
          <div className="llm-revision"><textarea rows={3} placeholder="Комментарий для LLM: что исправить в выбранном документе" value={comment} onChange={e => setComment(e.target.value)} /><button disabled={Boolean(busy) || !comment.trim()} onClick={revise}>Создать LLM revision</button></div>
          <div className="review-actions"><button disabled={Boolean(busy)} onClick={reject}>Отклонить</button><button className="primary" disabled={Boolean(busy) || !draft.canonical_markdown.trim()} onClick={accept}>Принять и поставить ingest</button></div>
        </>}
        <details><summary>История ({detail.revisions.length} revisions / {detail.events.length} events)</summary><pre>{JSON.stringify({ revisions: detail.revisions, events: detail.events }, null, 2)}</pre></details>
      </> : <p>Выберите встречу для проверки.</p>}</div>
    </div>
  </div>;
}
