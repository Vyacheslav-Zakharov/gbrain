import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import './AIReview.css';

type Status = 'pending' | 'accepted' | 'rejected' | 'superseded';

interface Proposal {
  id: number;
  source_id: string;
  page_slug: string;
  status: Status;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  model_id: string;
  proposed_at: string;
  page_title?: string | null;
  page_body?: string | null;
  promoted_row_num?: number | null;
}

interface Draft {
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string;
  since_date: string;
  source: string;
}

interface DetailPayload {
  proposal: Proposal;
  revisions: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

function asDraft(p: Proposal): Draft {
  return {
    claim_text: p.claim_text,
    kind: p.kind,
    holder: p.holder,
    weight: Number(p.weight),
    domain: p.domain ?? '',
    since_date: '',
    source: `take-proposal:${p.id}`,
  };
}

function changedFields(original: Draft, draft: Draft): string[] {
  return (Object.keys(draft) as Array<keyof Draft>).filter(key => String(original[key] ?? '') !== String(draft[key] ?? ''));
}

export function AIReviewPage() {
  const [status, setStatus] = useState<Status>('pending');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Proposal[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revisionId, setRevisionId] = useState<number | undefined>();
  const [llmComment, setLlmComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const detailRequest = useRef(0);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.aiReviewProposals({ status, q: query, limit: 200 });
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setError(null);
      if (!data.rows?.some((r: Proposal) => r.id === selectedId)) setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, query, selectedId]);

  const loadDetail = useCallback(async (id: number) => {
    const request = ++detailRequest.current;
    try {
      const data = await api.aiReviewProposal(id) as DetailPayload;
      if (request !== detailRequest.current) return;
      setDetail(data);
      setDraft(asDraft(data.proposal));
      setRevisionId(undefined);
      setReceipt(null);
      setError(null);
    } catch (e) {
      if (request !== detailRequest.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { const timer = setTimeout(loadList, 180); return () => clearTimeout(timer); }, [loadList]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); else { setDetail(null); setDraft(null); } }, [selectedId, loadDetail]);

  const original = useMemo(() => detail ? asDraft(detail.proposal) : null, [detail]);
  const diff = useMemo(() => original && draft ? changedFields(original, draft) : [], [original, draft]);

  const select = (id: number) => {
    if (diff.length > 0 && !confirm('Discard unsaved draft changes?')) return;
    setSelectedId(id);
    setMobileDetail(true);
  };

  const changeStatus = (value: Status) => {
    if (diff.length > 0 && !confirm('Discard unsaved draft changes?')) return;
    setSelectedId(null); setMobileDetail(false); setStatus(value);
  };

  const changeQuery = (value: string) => {
    if (diff.length > 0 && !confirm('Discard unsaved draft changes?')) return;
    setSelectedId(null); setMobileDetail(false); setQuery(value);
  };

  const updateDraft = (key: keyof Draft, value: string | number) => {
    setDraft(current => current ? { ...current, [key]: value } : current);
    setRevisionId(undefined);
  };

  const llmRevise = async () => {
    if (!detail || !llmComment.trim()) return;
    setBusy('llm');
    try {
      const result = await api.aiReviewLlmRevision(detail.proposal.id, llmComment);
      setDraft({ ...asDraft(detail.proposal), ...result.draft });
      setRevisionId(result.revision_id);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    if (!detail || !draft) return;
    if (!confirm(`Accept proposal #${detail.proposal.id} and write it to ${detail.proposal.source_id}:${detail.proposal.page_slug}?`)) return;
    setBusy('accept');
    try {
      let appliedRevision = revisionId;
      if (!appliedRevision && diff.length > 0) {
        const saved = await api.aiReviewManualRevision(detail.proposal.id, draft);
        appliedRevision = saved.revision_id;
      }
      const result = await api.aiReviewAccept(detail.proposal.id, draft, appliedRevision);
      setReceipt(result.publication ?? null);
      await loadList();
      if (status === 'pending') setMobileDetail(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!detail) return;
    const reason = prompt('Reason for rejection (optional):') ?? undefined;
    if (reason === undefined) return;
    setBusy('reject');
    try {
      await api.aiReviewReject(detail.proposal.id, reason);
      await loadList();
      setMobileDetail(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ai-review">
      <header className="ai-review-header">
        <div>
          <h1>AI Review</h1>
          <p>Human approval gate for proposed knowledge. LLM revisions remain drafts until explicit acceptance.</p>
        </div>
        <div className="ai-review-count">{total} {status}</div>
      </header>

      <div className="ai-review-toolbar">
        <div className="ai-review-tabs">
          {(['pending', 'accepted', 'rejected', 'superseded'] as Status[]).map(value => (
            <button key={value} className={status === value ? 'active' : ''} onClick={() => changeStatus(value)}>{value}</button>
          ))}
        </div>
        <input value={query} onChange={e => changeQuery(e.target.value)} placeholder="Search claims or page slugs" />
        <button onClick={loadList}>Refresh</button>
      </div>

      {error && <div className="ai-review-error">{error}</div>}

      <div className={`ai-review-grid ${mobileDetail ? 'show-detail' : ''}`}>
        <section className="proposal-list" aria-label="Proposal queue">
          {loading && <div className="empty-state">Loading…</div>}
          {!loading && rows.length === 0 && <div className="empty-state">No proposals in this view.</div>}
          {rows.map(row => (
            <button key={row.id} className={`proposal-row ${selectedId === row.id ? 'selected' : ''}`} onClick={() => select(row.id)}>
              <div className="proposal-row-top"><span>#{row.id}</span><span>{row.source_id}</span><span>{Number(row.weight).toFixed(2)}</span></div>
              <strong>{row.claim_text}</strong>
              <div className="proposal-row-meta">{row.page_slug} · {row.kind} · {row.holder}</div>
            </button>
          ))}
        </section>

        <section className="proposal-detail" aria-label="Proposal detail">
          <button className="mobile-back" onClick={() => setMobileDetail(false)}>← Queue</button>
          {!detail || !draft || !original ? <div className="empty-state">Select a proposal.</div> : <>
            <div className="detail-title">
              <div><span className={`status-pill ${detail.proposal.status}`}>{detail.proposal.status}</span> #{detail.proposal.id}</div>
              <code>{detail.proposal.source_id}:{detail.proposal.page_slug}</code>
            </div>

            <div className="review-form">
              <label className={diff.includes('claim_text') ? 'changed' : ''}>Claim
                <textarea value={draft.claim_text} onChange={e => updateDraft('claim_text', e.target.value)} rows={4} disabled={detail.proposal.status !== 'pending'} />
              </label>
              <div className="field-grid">
                <label className={diff.includes('kind') ? 'changed' : ''}>Kind<input value={draft.kind} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('kind', e.target.value)} /></label>
                <label className={diff.includes('holder') ? 'changed' : ''}>Holder<input value={draft.holder} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('holder', e.target.value)} /></label>
                <label className={diff.includes('weight') ? 'changed' : ''}>Weight<input type="number" min="0" max="1" step="0.05" value={draft.weight} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('weight', Number(e.target.value))} /></label>
                <label className={diff.includes('domain') ? 'changed' : ''}>Domain<input value={draft.domain} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('domain', e.target.value)} /></label>
                <label className={diff.includes('since_date') ? 'changed' : ''}>Since<input value={draft.since_date} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('since_date', e.target.value)} placeholder="YYYY-MM-DD" /></label>
                <label className={diff.includes('source') ? 'changed' : ''}>Evidence/source<input value={draft.source} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('source', e.target.value)} /></label>
              </div>
            </div>

            {diff.length > 0 && <div className="diff-card">
              <strong>Draft diff</strong><span>{diff.join(', ')}</span>
              <pre>- {JSON.stringify(original, null, 2)}\n+ {JSON.stringify(draft, null, 2)}</pre>
            </div>}

            {detail.proposal.status === 'pending' && <div className="llm-box">
              <label>Ask LLM to revise — returns a draft only
                <textarea value={llmComment} onChange={e => setLlmComment(e.target.value)} rows={3} placeholder="Clarify the claim, preserve evidence, change holder…" />
              </label>
              <button onClick={llmRevise} disabled={busy !== null || !llmComment.trim()}>{busy === 'llm' ? 'Revising…' : 'Generate revision'}</button>
              {revisionId && <span>Draft revision #{revisionId}; review the diff before accepting.</span>}
            </div>}

            {detail.proposal.status === 'pending' && <div className="review-actions">
              <button className="reject" onClick={reject} disabled={busy !== null}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
              <button className="accept" onClick={accept} disabled={busy !== null}>{busy === 'accept' ? 'Writing & verifying…' : diff.length ? 'Accept edited draft' : 'Accept'}</button>
            </div>}

            {receipt && <div className="receipt"><strong>Publication receipt</strong><pre>{JSON.stringify(receipt, null, 2)}</pre></div>}

            <details className="source-context"><summary>Source context</summary><pre>{detail.proposal.page_body ?? 'Unavailable'}</pre></details>
            <details><summary>Audit history ({detail.events.length})</summary><pre>{JSON.stringify(detail.events, null, 2)}</pre></details>
          </>}
        </section>
      </div>
    </div>
  );
}
