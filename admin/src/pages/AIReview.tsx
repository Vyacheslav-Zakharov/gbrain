import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { formatChangedDraftFields } from '../review-diff';
import './AIReview.css';

type Status = 'pending' | 'accepted' | 'rejected' | 'superseded' | 'deferred';

const STATUS_LABELS: Record<Status, string> = {
  pending: 'Ожидают',
  accepted: 'Приняты',
  rejected: 'Отклонены',
  superseded: 'Заменены',
  deferred: 'Отложены',
};

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
  draft_revision_id?: number | null;
  draft_claim_text?: string | null;
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
  active_draft?: { revision_id: number; draft: Draft } | null;
  review_governance?: {
    managed: boolean;
    state: 'legacy_manual' | 'pending_assignment' | 'round';
    round_id: number | null;
    round_status: string | null;
  };
}

function asDraft(p: Proposal): Draft {
  return {
    claim_text: p.claim_text,
    kind: p.kind,
    holder: p.holder,
    weight: Number(p.weight),
    domain: p.domain ?? '',
    since_date: '',
    source: '',
  };
}

function normalizeDraft(draft: Draft): Draft {
  return {
    ...draft,
    domain: draft.domain ?? '',
    since_date: draft.since_date ?? '',
    source: draft.source ?? '',
  };
}

function changedFields(original: Draft, draft: Draft): string[] {
  return (Object.keys(draft) as Array<keyof Draft>).filter(key => String(original[key] ?? '') !== String(draft[key] ?? ''));
}

export function AIReviewPage() {
  const [status, setStatus] = useState<Status>('pending');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  const [rows, setRows] = useState<Proposal[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revisionId, setRevisionId] = useState<number | undefined>();
  const [llmComment, setLlmComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const detailRequest = useRef(0);
  const listRequest = useRef(0);

  const loadList = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const data = await api.aiReviewProposals({ status, q: query, source_id: sourceFilter, limit: 200 });
      if (request !== listRequest.current) return;
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      if (status === 'pending' && !query && !sourceFilter) {
        window.dispatchEvent(new CustomEvent('gbrain:ai-review-pending-count', { detail: Number(data.total ?? 0) }));
      }
      setSourceOptions(current => [...new Set([...current, ...(data.rows ?? []).map((row: Proposal) => row.source_id)])].sort());
      setPageError(null);
      if (!data.rows?.some((r: Proposal) => r.id === selectedId)) setSelectedId(null);
    } catch (e) {
      if (request !== listRequest.current) return;
      setRows([]);
      setTotal(0);
      setSelectedId(null);
      setDetail(null);
      setDraft(null);
      setPageError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [status, query, sourceFilter, selectedId]);

  const loadDetail = useCallback(async (id: number) => {
    const request = ++detailRequest.current;
    try {
      const data = await api.aiReviewProposal(id) as DetailPayload;
      if (request !== detailRequest.current) return;
      setDetail(data);
      setDraft(data.active_draft ? normalizeDraft(data.active_draft.draft) : asDraft(data.proposal));
      setRevisionId(data.active_draft?.revision_id);
      setReceipt(null);
      setPageError(null);
    } catch (e) {
      if (request !== detailRequest.current) return;
      setPageError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { const timer = setTimeout(loadList, 180); return () => clearTimeout(timer); }, [loadList]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); else { setDetail(null); setDraft(null); } }, [selectedId, loadDetail]);

  const original = useMemo(() => detail ? asDraft(detail.proposal) : null, [detail]);
  const diff = useMemo(() => original && draft ? changedFields(original, draft) : [], [original, draft]);
  const diffText = useMemo(() => original && draft ? formatChangedDraftFields(original, draft, diff) : '', [original, draft, diff]);

  const select = (id: number) => {
    if (diff.length > 0 && !confirm('Отменить несохранённые изменения черновика?')) return;
    setSelectedId(id);
    setMobileDetail(true);
  };

  const changeStatus = (value: Status) => {
    if (diff.length > 0 && !confirm('Отменить несохранённые изменения черновика?')) return;
    setRows([]); setTotal(null); setPageError(null); setActionError(null);
    setSelectedId(null); setMobileDetail(false); setStatus(value);
  };

  const changeQuery = (value: string) => {
    if (diff.length > 0 && !confirm('Отменить несохранённые изменения черновика?')) return;
    setSelectedId(null); setMobileDetail(false); setQuery(value);
  };

  const changeSource = (value: string) => {
    if (diff.length > 0 && !confirm('Отменить несохранённые изменения черновика?')) return;
    setSelectedId(null);
    setMobileDetail(false);
    setSourceFilter(value);
  };

  const updateDraft = (key: keyof Draft, value: string | number) => {
    setDraft(current => current ? { ...current, [key]: value } : current);
    setRevisionId(undefined);
  };

  const llmRevise = async () => {
    if (!detail || !llmComment.trim()) return;
    setBusy('llm');
    setActionError(null);
    try {
      const result = await api.aiReviewLlmRevision(detail.proposal.id, llmComment);
      setDraft(normalizeDraft({ ...asDraft(detail.proposal), ...result.draft }));
      setRevisionId(result.revision_id);
      setActionError(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    if (!detail || !draft) return;
    if (!confirm(`Принять предложение #${detail.proposal.id} и записать его в ${detail.proposal.source_id}:${detail.proposal.page_slug}?`)) return;
    setBusy('accept');
    setActionError(null);
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
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!detail) return;
    const reason = prompt('Причина отклонения (необязательно):') ?? undefined;
    if (reason === undefined) return;
    setBusy('reject');
    setActionError(null);
    try {
      await api.aiReviewReject(detail.proposal.id, reason);
      await loadList();
      setMobileDetail(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const defer = async () => {
    if (!detail) return;
    const reason = prompt('Причина отсрочки (необязательно):', 'Ограничение текущей review capacity') ?? undefined;
    if (reason === undefined) return;
    setBusy('defer');
    setActionError(null);
    try {
      await api.aiReviewDefer(detail.proposal.id, reason);
      await loadList();
      setMobileDetail(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!detail) return;
    if (!confirm(`Вернуть предложение #${detail.proposal.id} в очередь ожидания?`)) return;
    setBusy('restore');
    setActionError(null);
    try {
      await api.aiReviewRestore(detail.proposal.id, 'Явное восстановление оператором');
      await loadList();
      setMobileDetail(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ai-review">
      <header className="ai-review-header">
        <div>
          <h1>Проверка AI-предложений</h1>
          <p>AI готовит предложения и черновики. Каноническое знание меняется только после явного принятия человеком.</p>
        </div>
        <div className="ai-review-count" aria-busy={total === null}>{total === null ? '…' : total} · {STATUS_LABELS[status].toLowerCase()}</div>
      </header>

      <div className="ai-review-toolbar">
        <div className="ai-review-tabs">
          {(['pending', 'deferred', 'accepted', 'rejected', 'superseded'] as Status[]).map(value => (
            <button key={value} className={status === value ? 'active' : ''} onClick={() => changeStatus(value)}>{STATUS_LABELS[value]}</button>
          ))}
        </div>
        <label className="toolbar-field">
          <span className="sr-only">Фильтр по источнику</span>
          <select aria-label="Фильтр по источнику" value={sourceFilter} onChange={e => changeSource(e.target.value)}>
            <option value="">Все источники</option>
            {sourceOptions.map(source => <option key={source} value={source}>{source}</option>)}
          </select>
        </label>
        <input value={query} onChange={e => changeQuery(e.target.value)} placeholder="Поиск по тексту или пути страницы" aria-label="Поиск предложений" />
        <button onClick={loadList}>Обновить</button>
      </div>

      {pageError && <div className="ai-review-error" role="alert"><span>{pageError}</span><button onClick={() => setPageError(null)} aria-label="Закрыть сообщение">×</button></div>}

      <div className={`ai-review-grid ${mobileDetail ? 'show-detail' : ''}`}>
        <section className="proposal-list" aria-label="Очередь предложений">
          {loading && <div className="empty-state" aria-busy="true"><span className="loading-spinner" />Загружаем предложения…</div>}
          {!loading && rows.length === 0 && <div className="empty-state"><strong>Здесь пока нет предложений</strong><span>Измените статус, источник или поисковый запрос.</span></div>}
          {rows.map(row => (
            <button key={row.id} className={`proposal-row ${selectedId === row.id ? 'selected' : ''}`} onClick={() => select(row.id)}>
              <div className="proposal-row-top"><span>#{row.id}</span><span>{row.source_id}</span><span>{Number(row.weight).toFixed(2)}</span></div>
              <strong>{row.draft_claim_text ?? row.claim_text}</strong>
              <div className="proposal-row-meta">{row.page_slug} · {row.kind} · {row.holder}</div>
              {row.draft_revision_id && <span className="draft-badge">Есть русский черновик · revision #{row.draft_revision_id}</span>}
            </button>
          ))}
        </section>

        <section className="proposal-detail" aria-label="Карточка предложения">
          <button className="mobile-back" onClick={() => setMobileDetail(false)}>← К очереди</button>
          {!detail || !draft || !original ? <div className="empty-state"><strong>Выберите предложение</strong><span>Карточка и действия появятся здесь.</span></div> : <>
            <div className="detail-title">
              <div><span className={`status-pill ${detail.proposal.status}`}>{STATUS_LABELS[detail.proposal.status]}</span> #{detail.proposal.id}</div>
              <code>{detail.proposal.source_id}:{detail.proposal.page_slug}</code>
            </div>

            <div className="review-form">
              <label className={diff.includes('claim_text') ? 'changed' : ''}>Текст утверждения
                <textarea value={draft.claim_text} onChange={e => updateDraft('claim_text', e.target.value)} rows={4} disabled={detail.proposal.status !== 'pending'} />
              </label>
              <div className="field-grid">
                <label className={diff.includes('kind') ? 'changed' : ''}>Тип<input value={draft.kind} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('kind', e.target.value)} /></label>
                <label className={diff.includes('holder') ? 'changed' : ''}>Владелец<input value={draft.holder} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('holder', e.target.value)} /></label>
                <label className={diff.includes('weight') ? 'changed' : ''}>Вес уверенности<input type="number" min="0" max="1" step="0.05" value={draft.weight} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('weight', Number(e.target.value))} /></label>
                <label className={diff.includes('domain') ? 'changed' : ''}>Область<input value={draft.domain} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('domain', e.target.value)} /></label>
                <label className={diff.includes('since_date') ? 'changed' : ''}>Действует с<input value={draft.since_date} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('since_date', e.target.value)} placeholder="ГГГГ-ММ-ДД" /></label>
                <label className={diff.includes('source') ? 'changed' : ''}>Дополнительный источник<input value={draft.source} disabled={detail.proposal.status !== 'pending'} onChange={e => updateDraft('source', e.target.value)} placeholder="Необязательно; ссылка или примечание" /></label>
              </div>
            </div>

            {diff.length > 0 && <div className="diff-card">
              <strong>Изменения черновика</strong><span>{diff.join(', ')}</span>
              <pre>{diffText}</pre>
            </div>}

            {detail.proposal.status === 'pending' && <div className="llm-box">
              <label>Попросить LLM изменить только текст — метаданные сохраняются
                <textarea value={llmComment} onChange={e => setLlmComment(e.target.value)} rows={3} placeholder="Например: переведи на русский, уточни или сократи…" />
              </label>
              <button onClick={llmRevise} disabled={busy !== null || !llmComment.trim()}>{busy === 'llm' ? 'Готовим черновик…' : 'Создать revision'}</button>
              {revisionId && <span>Черновик revision #{revisionId}; проверьте изменения перед принятием.</span>}
            </div>}

            {actionError && <div className="ai-review-inline-error" role="alert"><span>{actionError}</span><button onClick={() => setActionError(null)} aria-label="Закрыть сообщение">×</button></div>}

            {detail.review_governance?.managed && (
          <div className="receipt">
            Это предложение управляется коллективной проверкой
            {detail.review_governance.round_id ? ` (раунд #${detail.review_governance.round_id})` : ''}.
            {' '}<a href="#review-rounds">Открыть голоса и решение</a>.
          </div>
        )}
        {detail.proposal.status === 'pending' && !detail.review_governance?.managed && <div className="review-actions">
              <button className="reject" onClick={reject} disabled={busy !== null}>{busy === 'reject' ? 'Отклоняем…' : 'Отклонить'}</button>
              <button onClick={defer} disabled={busy !== null}>{busy === 'defer' ? 'Откладываем…' : 'Отложить'}</button>
              <button className="accept" onClick={accept} disabled={busy !== null}>{busy === 'accept' ? 'Записываем и проверяем…' : diff.length ? 'Принять изменённый черновик' : 'Принять'}</button>
            </div>}

            {(detail.proposal.status === 'deferred' || detail.proposal.status === 'rejected') && <div className="review-actions">
              <button onClick={restore} disabled={busy !== null}>{busy === 'restore' ? 'Восстанавливаем…' : 'Вернуть в ожидающие'}</button>
            </div>}

            {receipt && <div className="receipt"><strong>Подтверждение публикации</strong><pre>{JSON.stringify(receipt, null, 2)}</pre></div>}

            <details className="source-context"><summary>Контекст источника</summary><pre>{detail.proposal.page_body ?? 'Недоступно'}</pre></details>
            <details><summary>История аудита ({detail.events.length})</summary><pre>{JSON.stringify(detail.events, null, 2)}</pre></details>
          </>}
        </section>
      </div>
    </div>
  );
}
