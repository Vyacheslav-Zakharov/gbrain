import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import './AIReview.css';

type Row = {
  id: number; source_id: string; page_slug: string; status: string;
  proposed_markdown: string; source_atoms: Array<{ source_id: string; slug: string; title?: string }>;
  current_page_body?: string | null; destination_content_hash?: string | null;
};
type Detail = { proposal: Row; revisions: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> };

export function ConceptReviewPage() {
  const [status, setStatus] = useState('pending');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [revision, setRevision] = useState<number>();
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [error, setError] = useState('');
  const detailRequest = useRef(0);

  const load = async () => {
    try {
      const result = await api.aiReviewConcepts({ status, q: query, limit: 200 });
      setRows(result.rows || []); setTotal(result.total || 0); setError('');
    } catch (e: any) {
      setRows([]); setTotal(0); setSelected(null); setDetail(null);
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  useEffect(() => { load().catch(() => undefined); }, [status, query]);
  useEffect(() => {
    if (selected == null) { setDetail(null); return; }
    const request = ++detailRequest.current;
    setOverwrite(false); setRevision(undefined);
    api.aiReviewConcept(selected).then((value: Detail) => {
      if (request !== detailRequest.current) return;
      setDetail(value); setMarkdown(value.proposal.proposed_markdown);
    }).catch(e => request === detailRequest.current && setError(e.message));
  }, [selected]);

  const choose = (id: number) => { setSelected(id); setMobileDetail(true); setError(''); };
  const finish = async () => { setSelected(null); setDetail(null); setMobileDetail(false); setOverwrite(false); setRevision(undefined); await load(); };
  const askLlm = async () => {
    if (!selected) return; const comment = prompt('Комментарий для LLM (публикации не будет)'); if (!comment) return;
    setBusy(true); try { const r = await api.aiReviewConceptLlmRevision(selected, comment); setMarkdown(r.proposed_markdown); setRevision(r.revision_id); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const accept = async () => {
    if (!selected || !detail || !confirm(`Опубликовать concept ${detail.proposal.page_slug}?`)) return;
    setBusy(true); try {
      let revisionId = revision;
      if (markdown !== detail.proposal.proposed_markdown && revisionId == null) {
        const saved = await api.aiReviewConceptManualRevision(selected, markdown);
        revisionId = saved.revision_id; setRevision(revisionId);
      }
      await api.aiReviewConceptAccept(selected, markdown, revisionId, overwrite); await finish();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const reject = async () => {
    if (!selected) return; const reason = prompt('Причина отклонения'); if (reason == null) return;
    setBusy(true); try { await api.aiReviewConceptReject(selected, reason); await finish(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return <div className="ai-review-page">
    <div className="ai-review-toolbar"><h2>Проверка концепций</h2><select value={status} onChange={e => { setRows([]); setTotal(0); setError(''); setSelected(null); setDetail(null); setMobileDetail(false); setOverwrite(false); setStatus(e.target.value); }}><option value="pending">Ожидают</option><option value="accepted">Приняты</option><option value="rejected">Отклонены</option></select><input placeholder="Поиск" aria-label="Поиск концепций" value={query} onChange={e => setQuery(e.target.value)} /><span>{rows.length}/{total}</span></div>
    {error && <div className="ai-review-error">{error}</div>}
    <div className={`ai-review-grid ${mobileDetail ? 'show-detail' : ''}`}>
      <div className="proposal-list">{rows.map(row => <button key={row.id} className={selected === row.id ? 'selected' : ''} onClick={() => choose(row.id)}><b>#{row.id} {row.page_slug}</b><small>{row.source_id} · {row.status}</small></button>)}</div>
      <div className="proposal-detail">{detail ? <>
        <button className="mobile-back" onClick={() => setMobileDetail(false)}>← Очередь</button>
        <h3>{detail.proposal.page_slug}</h3>
        <p>Источники: {detail.proposal.source_atoms?.map(a => a.slug).join(', ') || 'нет'} · Revisions: {detail.revisions.length} · Аудит: {detail.events.length}</p>
        {detail.proposal.current_page_body && <details><summary>Текущая каноническая страница</summary><pre>{detail.proposal.current_page_body}</pre></details>}
        <details><summary>Исходное AI-предложение</summary><pre>{detail.proposal.proposed_markdown}</pre></details>
        <textarea rows={24} value={markdown} disabled={detail.proposal.status !== 'pending'} onChange={e => { setMarkdown(e.target.value); setRevision(undefined); }} />
        {detail.proposal.status === 'pending' && <><label><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> Разрешить перезапись, если целевая страница создана вручную или изменилась после генерации предложения</label><div className="review-actions"><button disabled={busy} onClick={askLlm}>Создать LLM revision</button><button disabled={busy} onClick={reject}>Отклонить</button><button className="primary" disabled={busy} onClick={accept}>Принять и опубликовать</button></div></>}
      </> : <p>Выберите предложение концепции</p>}</div>
    </div>
  </div>;
}
