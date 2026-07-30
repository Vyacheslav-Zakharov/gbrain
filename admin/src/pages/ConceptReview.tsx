import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import './AIReview.css';

type Status = 'pending' | 'accepted' | 'rejected' | 'superseded' | 'deferred';

const STATUS_LABELS: Record<Status, string> = {
  pending: 'Ожидают',
  accepted: 'Приняты',
  rejected: 'Отклонены',
  superseded: 'Заменены',
  deferred: 'Отложены',
};

type Row = {
  id: number;
  source_id: string;
  page_slug: string;
  status: Status;
  proposed_markdown: string;
  draft_proposed_markdown?: string | null;
  draft_revision_id?: number | null;
  source_atoms: Array<{ source_id: string; slug: string; title?: string }>;
  current_page_body?: string | null;
  destination_content_hash?: string | null;
};

type Detail = {
  proposal: Row;
  revisions: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  active_draft?: { revision_id: number; proposed_markdown: string } | null;
};

function markdownTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
  return match?.[1]?.trim() || fallback.split('/').pop()?.replace(/-/g, ' ') || fallback;
}

function markdownPreview(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/[#*_`>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ConceptReviewPage() {
  const [status, setStatus] = useState<Status>('pending');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [revision, setRevision] = useState<number>();
  const [llmComment, setLlmComment] = useState('Переведи концепцию на русский язык, сохрани смысл и все подтверждённые источниками детали.');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionError, setActionError] = useState('');
  const listRequest = useRef(0);
  const detailRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const result = await api.aiReviewConcepts({ status, q: query, limit: 200 });
      if (request !== listRequest.current) return;
      const nextRows = (result.rows || []) as Row[];
      const nextTotal = Number(result.total || 0);
      setRows(nextRows);
      setTotal(nextTotal);
      setPageError('');
      if (status === 'pending' && !query) {
        window.dispatchEvent(new CustomEvent('gbrain:concept-review-pending-count', { detail: nextTotal }));
      }
      if (!nextRows.some(row => row.id === selected)) setSelected(null);
    } catch (error) {
      if (request !== listRequest.current) return;
      setRows([]);
      setTotal(0);
      setSelected(null);
      setDetail(null);
      setPageError(errorMessage(error));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [query, selected, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (selected == null) {
      setDetail(null);
      setMarkdown('');
      return;
    }
    const request = ++detailRequest.current;
    setOverwrite(false);
    setActionError('');
    void api.aiReviewConcept(selected).then((value: Detail) => {
      if (request !== detailRequest.current) return;
      setDetail(value);
      setMarkdown(value.active_draft?.proposed_markdown ?? value.proposal.proposed_markdown);
      setRevision(value.active_draft?.revision_id);
      setPageError('');
    }).catch(error => {
      if (request === detailRequest.current) setPageError(errorMessage(error));
    });
  }, [selected]);

  const choose = (id: number) => {
    setSelected(id);
    setMobileDetail(true);
    setActionError('');
  };

  const finish = async () => {
    setSelected(null);
    setDetail(null);
    setMobileDetail(false);
    setOverwrite(false);
    setRevision(undefined);
    await load();
  };

  const askLlm = async () => {
    if (!selected || !llmComment.trim()) return;
    setBusy('llm');
    setActionError('');
    try {
      const result = await api.aiReviewConceptLlmRevision(selected, llmComment);
      setMarkdown(result.proposed_markdown);
      setRevision(result.revision_id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    if (!selected || !detail || !confirm(`Опубликовать концепцию ${detail.proposal.page_slug}?`)) return;
    setBusy('accept');
    setActionError('');
    try {
      let revisionId = revision;
      const activeBase = detail.active_draft?.proposed_markdown ?? detail.proposal.proposed_markdown;
      if (markdown !== activeBase || revisionId == null) {
        const saved = await api.aiReviewConceptManualRevision(selected, markdown);
        revisionId = saved.revision_id;
        setRevision(revisionId);
      }
      await api.aiReviewConceptAccept(selected, markdown, revisionId, overwrite);
      await finish();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!selected) return;
    const reason = prompt('Причина отклонения (необязательно):');
    if (reason == null) return;
    setBusy('reject');
    setActionError('');
    try {
      await api.aiReviewConceptReject(selected, reason);
      await finish();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = (value: Status) => {
    setRows([]);
    setTotal(null);
    setSelected(null);
    setDetail(null);
    setMobileDetail(false);
    setOverwrite(false);
    setPageError('');
    setActionError('');
    setStatus(value);
  };

  return (
    <div className="ai-review">
      <header className="ai-review-header">
        <div>
          <h1>Проверка концепций</h1>
          <p>AI формирует черновики концепций. Публикация в каноническое знание выполняется только после проверки человеком.</p>
        </div>
        <div className="ai-review-count" aria-live="polite" aria-busy={total === null}>
          {status === 'pending' ? `Ожидают проверки: ${total ?? '…'}` : `${STATUS_LABELS[status]}: ${total ?? '…'}`}
        </div>
      </header>

      <div className="ai-review-toolbar">
        <div className="ai-review-tabs" role="group" aria-label="Статус концепций">
          {(['pending', 'accepted', 'rejected', 'superseded', 'deferred'] as Status[]).map(value => (
            <button type="button" key={value} className={status === value ? 'active' : ''} onClick={() => changeStatus(value)}>{STATUS_LABELS[value]}</button>
          ))}
        </div>
        <input
          placeholder="Поиск по названию, тексту или пути"
          aria-label="Поиск концепций"
          value={query}
          onChange={event => { setSelected(null); setQuery(event.target.value); }}
        />
        <button type="button" onClick={() => void load()}>Обновить</button>
      </div>

      {pageError && <div className="ai-review-error" role="alert"><span>{pageError}</span><button type="button" onClick={() => setPageError('')} aria-label="Закрыть сообщение">×</button></div>}

      <div className={`ai-review-grid ${mobileDetail ? 'show-detail' : ''}`}>
        <section className="proposal-list" aria-label="Очередь концепций">
          {loading && <div className="empty-state" aria-busy="true"><span className="loading-spinner" />Загружаем концепции…</div>}
          {!loading && rows.length === 0 && <div className="empty-state"><strong>В этом статусе концепций нет</strong><span>Измените фильтр или поисковый запрос.</span></div>}
          {rows.map(row => {
            const reviewMarkdown = row.draft_proposed_markdown ?? row.proposed_markdown;
            return (
              <button type="button" key={row.id} className={`proposal-row ${selected === row.id ? 'selected' : ''}`} onClick={() => choose(row.id)}>
                <div className="proposal-row-top"><span>#{row.id}</span><span>{row.source_id}</span><span>{STATUS_LABELS[row.status]}</span></div>
                <strong>{markdownTitle(reviewMarkdown, row.page_slug)}</strong>
                <div className="proposal-row-preview">{markdownPreview(reviewMarkdown) || 'Описание отсутствует'}</div>
                <div className="proposal-row-meta">{row.page_slug}</div>
                {row.draft_revision_id && <span className="draft-badge">Есть русский черновик · revision #{row.draft_revision_id}</span>}
              </button>
            );
          })}
        </section>

        <section className="proposal-detail" aria-label="Карточка концепции">
          <button type="button" className="mobile-back" onClick={() => setMobileDetail(false)}>← К очереди</button>
          {!detail ? <div className="empty-state"><strong>Выберите концепцию</strong><span>Описание, источники и действия появятся здесь.</span></div> : <>
            <div className="detail-title">
              <div><span className={`status-pill ${detail.proposal.status}`}>{STATUS_LABELS[detail.proposal.status]}</span> #{detail.proposal.id}</div>
              <code>{detail.proposal.source_id}:{detail.proposal.page_slug}</code>
            </div>

            <div className="concept-evidence-summary">
              <strong>Основание концепции</strong>
              <span>{detail.proposal.source_atoms?.length || 0} атомов · {detail.revisions.length} revisions · {detail.events.length} событий аудита</span>
            </div>

            <div className="review-form">
              <label>Проверяемый черновик Markdown
                <textarea rows={22} value={markdown} disabled={detail.proposal.status !== 'pending'} onChange={event => { setMarkdown(event.target.value); setRevision(undefined); }} />
              </label>
            </div>

            {detail.proposal.status === 'pending' && <div className="llm-box">
              <label>Комментарий для LLM — публикации не будет
                <textarea rows={3} value={llmComment} onChange={event => setLlmComment(event.target.value)} />
              </label>
              <button type="button" onClick={askLlm} disabled={busy !== null || !llmComment.trim()}>{busy === 'llm' ? 'Готовим черновик…' : 'Создать LLM revision'}</button>
              {revision && <span>Активный черновик revision #{revision}; проверьте его перед принятием.</span>}
            </div>}

            {detail.proposal.status === 'pending' && <label className="overwrite-option"><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} /> Разрешить перезапись только если целевая страница была создана вручную или изменилась после генерации</label>}

            {actionError && <div className="ai-review-inline-error" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError('')} aria-label="Закрыть сообщение">×</button></div>}

            {detail.proposal.status === 'pending' && <div className="review-actions">
              <button type="button" className="reject" disabled={busy !== null} onClick={reject}>{busy === 'reject' ? 'Отклоняем…' : 'Отклонить'}</button>
              <button type="button" className="accept" disabled={busy !== null || !markdown.trim()} onClick={accept}>{busy === 'accept' ? 'Публикуем и проверяем…' : 'Принять и опубликовать'}</button>
            </div>}

            {detail.proposal.current_page_body && <details className="source-context"><summary>Текущая каноническая страница</summary><pre>{detail.proposal.current_page_body}</pre></details>}
            <details className="source-context"><summary>Исходное AI-предложение</summary><pre>{detail.proposal.proposed_markdown}</pre></details>
            <details className="source-context"><summary>Исходные атомы ({detail.proposal.source_atoms?.length || 0})</summary><pre>{JSON.stringify(detail.proposal.source_atoms, null, 2)}</pre></details>
            <details><summary>История аудита ({detail.events.length})</summary><pre>{JSON.stringify(detail.events, null, 2)}</pre></details>
          </>}
        </section>
      </div>
    </div>
  );
}
