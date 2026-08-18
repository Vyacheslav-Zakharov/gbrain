import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { portalApi, ReviewApiError } from '../api';
import { keyToIntent, prefersReducedMotion, type GestureIntent } from './gestures';
import { isTerminalReviewError, reasonsForTarget, reviewErrorMessage } from './reasons';
import { advanceReviewCard, deferReviewCard, restoreReviewCard, shouldRefillReviewDeck } from './queue';
import {
  canCancelPendingDecision,
  createUndoDeadline,
  isUndoDeadlineOpen,
  REVIEW_UNDO_WINDOW_MS,
  shouldApplyDetailsResponse,
  undoSecondsRemaining,
} from './undo';
import { RejectReasonSheet } from './RejectReasonSheet';
import { SwipeCard } from './SwipeCard';
import { ReviewVoteRetryExhaustedError, submitReviewVoteWithRetry } from './vote-retry';
import type { PortalSession } from '../types';
import type { ReviewDeckCard, ReviewItemDetail } from './types';
import './review.css';

function newIdempotencyKey(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && 'randomUUID' in cryptoRef) return cryptoRef.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

interface PendingVote {
  card: ReviewDeckCard;
  assignmentId: number;
  decision: 'approve' | 'reject' | 'abstain';
  reasonCode?: string;
  comment?: string;
  proposalSnapshotHash: string;
  idempotencyKey: string;
  deadlineMs: number;
}

export function ReviewApp() {
  const [session, setSession] = useState<PortalSession | null>(null);
  const [cards, setCards] = useState<ReviewDeckCard[]>([]);
  const [total, setTotal] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [details, setDetails] = useState<ReviewItemDetail | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pendingVote, setPendingVote] = useState<PendingVote | null>(null);
  const [failedVote, setFailedVote] = useState<PendingVote | null>(null);
  const [failedCode, setFailedCode] = useState<string | null>(null);
  const [voteInFlight, setVoteInFlight] = useState(false);
  const [terminalNotice, setTerminalNotice] = useState('');
  const [undoSeconds, setUndoSeconds] = useState(REVIEW_UNDO_WINDOW_MS / 1_000);
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const committingVote = useRef(false);
  const stagingVote = useRef(false);
  const commitPromiseRef = useRef<Promise<boolean> | null>(null);
  const pendingVoteRef = useRef<PendingVote | null>(null);
  const detailsRequestId = useRef(0);

  const card = cards[0] ?? null;
  const reasons = useMemo(() => reasonsForTarget(card?.target_type ?? 'take_proposal'), [card?.target_type]);

  const loadDeck = useCallback(async () => {
    setLoading(true);
    setError('');
    setTerminalNotice('');
    try {
      const [sessionData, deck] = await Promise.all([portalApi.session(), portalApi.reviewDeck(100)]);
      setSession(sessionData);
      setCards(deck.cards);
      setTotal(Math.max(deck.total, deck.cards.length));
      setReviewed(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить очередь');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDeck(); }, [loadDeck]);
  useEffect(() => {
    if (shouldRefillReviewDeck({
      loading,
      busy,
      voteInFlight,
      hasPendingVote: Boolean(pendingVote),
      hasFailedVote: Boolean(failedVote),
      cardCount: cards.length,
      reviewed,
      total,
    })) {
      void loadDeck();
    }
  }, [busy, cards.length, failedVote, loadDeck, loading, pendingVote, reviewed, total, voteInFlight]);

  const finishVote = useCallback(() => {
    pendingVoteRef.current = null;
    setPendingVote(null);
    setFailedVote(null);
    setFailedCode(null);
  }, []);

  const deferCard = useCallback(() => {
    if (!card || busy || failedVote) return;
    detailsRequestId.current += 1;
    setDetails(null);
    setSheetOpen(false);
    setError('');
    setCards(deferReviewCard);
    setAnnouncement(cards.length > 1
      ? 'Карточка отложена в конец очереди. Голос не отправлен.'
      : 'Карточка отложена, но других карточек сейчас нет. Голос не отправлен.');
  }, [busy, card, cards.length, failedVote]);

  const commitVote = useCallback(async (pending: PendingVote): Promise<boolean> => {
    if (committingVote.current) return false;
    committingVote.current = true;
    setVoteInFlight(true);
    setFailedVote(null);
    setFailedCode(null);
    setError('');
    setTerminalNotice('');
    try {
      const result = await submitReviewVoteWithRetry(() => portalApi.reviewVote(
        pending.assignmentId,
        {
          decision: pending.decision,
          reason_code: pending.reasonCode,
          comment: pending.comment,
          proposal_snapshot_hash: pending.proposalSnapshotHash,
        },
        pending.idempotencyKey,
      ), {
        onRetry: () => setAnnouncement('Связь прервалась. Повторяем сохранение решения автоматически…'),
      });
      setAnnouncement(
        pending.decision === 'abstain'
          ? result.round_status === 'escalated'
            ? 'Ответ «Не могу оценить» сохранён. Решение передано администратору.'
            : 'Ответ «Не могу оценить» сохранён. Он не поддерживает ни одну сторону.'
          : result.round_status === 'finalized'
            ? `Голос сохранён. Решение принято: ${result.outcome === 'accepted' ? 'подтверждено' : 'отклонено'}.`
            : result.round_status === 'escalated'
              ? 'Голос сохранён. Решение передано администратору.'
              : 'Голос сохранён. Ожидаем остальных проверяющих.',
      );
      finishVote();
      return true;
    } catch (err) {
      if (err instanceof ReviewVoteRetryExhaustedError) {
        const message = 'Решение пока не сохранено. Причина и комментарий сохранены — повторите отправку.';
        setFailedVote(pending);
        setFailedCode(null);
        setError('');
        setAnnouncement(message);
        return false;
      }
      const code = err instanceof ReviewApiError ? err.code : undefined;
      const message = reviewErrorMessage(code, err instanceof Error ? err.message : 'Не удалось сохранить голос');
      setError(message);
      setAnnouncement(message);
      // A stale or reassigned staged card is no longer actionable. Any other
      // failure retains the exact immutable payload for explicit retry/edit.
      if (isTerminalReviewError(code)) {
        setError('');
        setTerminalNotice(message);
        finishVote();
        return true;
      }
      setFailedVote(pending);
      setFailedCode(code ?? null);
      return false;
    } finally {
      committingVote.current = false;
      setVoteInFlight(false);
    }
  }, [finishVote]);

  const commitPendingVoteNow = useCallback(async (): Promise<boolean> => {
    const pending = pendingVoteRef.current;
    if (!pending) return commitPromiseRef.current ? await commitPromiseRef.current : true;

    pendingVoteRef.current = null;
    setPendingVote(current => current === pending ? null : current);
    const operation = commitVote(pending);
    commitPromiseRef.current = operation;
    try {
      return await operation;
    } finally {
      if (commitPromiseRef.current === operation) commitPromiseRef.current = null;
    }
  }, [commitVote]);

  const stageVote = useCallback(async (
    decision: 'approve' | 'reject' | 'abstain',
    reasonCode?: string,
    comment?: string,
  ) => {
    if (!card || busy || failedVote || stagingVote.current) return;
    stagingVote.current = true;
    const selectedCard = card;
    const waitingForPrevious = Boolean(pendingVoteRef.current || commitPromiseRef.current);
    if (waitingForPrevious) setBusy(true);
    try {
      if (!await commitPendingVoteNow()) return;
      setSheetOpen(false);
      const deadlineMs = createUndoDeadline();
      const pending: PendingVote = {
        card: selectedCard,
        assignmentId: selectedCard.assignment_id,
        decision,
        reasonCode,
        comment,
        proposalSnapshotHash: selectedCard.proposal_snapshot_hash,
        idempotencyKey: newIdempotencyKey(),
        deadlineMs,
      };
      pendingVoteRef.current = pending;
      detailsRequestId.current += 1;
      setPendingVote(pending);
      setUndoSeconds(undoSecondsRemaining(deadlineMs));
      setCards(current => {
        if (current[0]?.assignment_id !== selectedCard.assignment_id) return current;
        return advanceReviewCard(current).remaining;
      });
      setReviewed(current => current + 1);
      setDetails(null);
      setSheetOpen(false);
      setError('');
      setAnnouncement(`${decision === 'abstain' ? 'Ответ' : 'Решение'} подготовлено. Следующая карточка уже доступна; вернуться можно в течение ${REVIEW_UNDO_WINDOW_MS / 1_000} секунд.`);
    } finally {
      if (waitingForPrevious) setBusy(false);
      stagingVote.current = false;
    }
  }, [busy, card, commitPendingVoteNow, failedVote]);

  const cancelPendingVote = useCallback(() => {
    const pending = pendingVoteRef.current;
    if (!pending || !canCancelPendingDecision(true, committingVote.current)) return;
    if (!isUndoDeadlineOpen(pending.deadlineMs)) {
      void commitPendingVoteNow();
      return;
    }
    pendingVoteRef.current = null;
    detailsRequestId.current += 1;
    setPendingVote(null);
    setCards(current => restoreReviewCard(pending.card, current));
    setReviewed(current => Math.max(0, current - 1));
    setDetails(null);
    setSheetOpen(false);
    setError('');
    setUndoSeconds(REVIEW_UNDO_WINDOW_MS / 1_000);
    setAnnouncement('Возвращаем предыдущую карточку. Решение не было отправлено.');
  }, [commitPendingVoteNow]);

  const cancelFailedVote = useCallback(() => {
    if (!failedVote) return;
    detailsRequestId.current += 1;
    setFailedVote(null);
    setFailedCode(null);
    setError('');
    setCards(current => restoreReviewCard(failedVote.card, current));
    setReviewed(current => Math.max(0, current - 1));
    setDetails(null);
    setSheetOpen(false);
    setAnnouncement('Неотправленное решение отменено. Карточка возвращена для нового решения.');
  }, [failedVote]);

  const retryFailedVote = useCallback(async () => {
    if (!failedVote || busy) return;
    setBusy(true);
    try {
      await commitVote(failedVote);
    } finally {
      setBusy(false);
    }
  }, [busy, commitVote, failedVote]);

  useEffect(() => {
    if (!pendingVote) return;
    let committed = false;
    const tick = () => {
      const remaining = undoSecondsRemaining(pendingVote.deadlineMs);
      setUndoSeconds(remaining);
      if (remaining === 0 && !committed) {
        committed = true;
        void commitPendingVoteNow();
      }
    };
    tick();
    const timer = window.setInterval(tick, 200);
    return () => window.clearInterval(timer);
  }, [commitPendingVoteNow, pendingVote]);

  const openDetails = useCallback(async () => {
    if (!card || busy || failedVote) return;
    const requestId = ++detailsRequestId.current;
    try {
      const response = await portalApi.reviewItem(card.assignment_id);
      if (!shouldApplyDetailsResponse(requestId, detailsRequestId.current, false)) return;
      setDetails(response.item);
    } catch (err) {
      if (!shouldApplyDetailsResponse(requestId, detailsRequestId.current, false)) return;
      const code = err instanceof ReviewApiError ? err.code : undefined;
      setError(reviewErrorMessage(code, err instanceof Error ? err.message : 'Не удалось открыть подробности'));
    }
  }, [busy, card, failedVote]);

  const handleIntent = useCallback((intent: GestureIntent) => {
    if (intent === 'approve') stageVote('approve');
    else if (intent === 'reject' && !failedVote) setSheetOpen(true);
    else if (intent === 'details') void openDetails();
  }, [failedVote, openDetails, stageVote]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!card) return;
      if (details) {
        if (event.key === 'Escape') { event.preventDefault(); setDetails(null); }
        return;
      }
      if (sheetOpen || busy || failedVote) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const intent = keyToIntent(event.key);
      if (intent === 'none') return;
      event.preventDefault();
      handleIntent(intent);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, card, details, failedVote, handleIntent, sheetOpen]);

  const reviewStatus = pendingVote ? (
    <div className="review-undo">
      <span>
        {pendingVote.decision === 'approve' ? 'Подтверждение' : pendingVote.decision === 'reject' ? 'Отклонение' : 'Ответ «Не могу оценить»'} будет отправлено через{' '}
        <strong>{undoSeconds} сек.</strong>
      </span>
      <button type="button" disabled={busy} onClick={cancelPendingVote}>← Назад</button>
    </div>
  ) : failedVote && !busy ? (
    <div className="review-undo">
      <span>
        {failedCode === 'unauthenticated'
          ? 'Сессия истекла. Решение и комментарий сохранены в этой вкладке.'
          : 'Решение не отправлено. Причина и комментарий сохранены.'}
      </span>
      {failedCode === 'unauthenticated' && <a className="review-undo-link" href="/login" target="_blank" rel="noreferrer">Войти в новой вкладке</a>}
      <button type="button" onClick={() => void retryFailedVote()}>Повторить сохранение</button>
      <button type="button" onClick={cancelFailedVote}>Изменить решение</button>
    </div>
  ) : null;

  return (
    <div className={`review-app ${reducedMotion ? 'reduced-motion' : ''}`}>
      <header className="review-header">
        <a className="review-back" href="/portal">← База знаний</a>
        <h1 className="review-title">Оценка знаний</h1>
        <span className="review-user">{session?.email || ''}</span>
      </header>

      <div className="review-live" role="status" aria-live="polite">{announcement}</div>

      <main className="review-main">
        {loading && <p className="review-state">Загружаем очередь…</p>}
        {!loading && error && !card && <p className="review-state review-error">{error}</p>}
        {!loading && !card && voteInFlight && <p className="review-state">Сохраняем решение…</p>}
        {!loading && !card && !error && !voteInFlight && !pendingVote && !failedVote && (
          <div className="review-state">
            <p>На сегодня всё. Новые карточки появятся, когда система предложит их вашей области.</p>
            <button type="button" className="review-btn ghost" onClick={() => void loadDeck()}>Обновить</button>
          </div>
        )}

        {!details && !sheetOpen && reviewStatus}
        {terminalNotice && <p className="review-notice" role="status">{terminalNotice}</p>}

        {card && (
          <>
            {error && <p className="review-error" role="alert">{error}</p>}
            <SwipeCard
              card={card}
              position={reviewed + 1}
              total={total}
              busy={busy || Boolean(failedVote)}
              reducedMotion={reducedMotion}
              onIntent={handleIntent}
            />
            <div className="review-actions">
              <button type="button" className="review-btn danger" disabled={busy || Boolean(failedVote)} onClick={() => setSheetOpen(true)}>
                Отклонить
              </button>
              <button type="button" className="review-btn ghost" disabled={busy || Boolean(failedVote)} onClick={() => void openDetails()}>
                Детали
              </button>
              <button type="button" className="review-btn approve" disabled={busy || Boolean(failedVote)} onClick={() => void stageVote('approve')}>
                {busy ? 'Сохраняем…' : 'Подтвердить'}
              </button>
            </div>
            <div className="review-actions review-actions-secondary">
              <button type="button" className="review-btn ghost" disabled={busy || Boolean(failedVote)} onClick={deferCard}>
                Отложить
              </button>
              <button type="button" className="review-btn ghost" disabled={busy || Boolean(failedVote)} onClick={() => void stageVote('abstain')}>
                Не могу оценить
              </button>
            </div>
            <p className="review-hint">
              «Отложить» переносит карточку в конец очереди без голоса. «Не могу оценить» завершает вашу проверку без поддержки ни одной из сторон.
            </p>
            <p className="review-hint">
              Жесты: вправо — подтвердить, влево — причина отклонения, вниз от полоски — детали.
              Клавиши: <kbd>→</kbd>, <kbd>←</kbd>, <kbd>↓</kbd>.
            </p>
          </>
        )}
      </main>

      {details && (
        <div className="review-sheet-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setDetails(null); }}>
          <div className="review-sheet" role="dialog" aria-modal="true" aria-labelledby="review-details-title">
            <h2 id="review-details-title" className="review-sheet-title">{details.headline}</h2>
            {reviewStatus}
            <div className="review-details-scroll">
              <section className="review-provenance" aria-labelledby="review-provenance-title">
              <h3 id="review-provenance-title">
                {details.target_type === 'take_proposal' ? 'Источник утверждения' : 'Происхождение концепции'}
              </h3>
              <dl>
                <div><dt>Область</dt><dd>{details.provenance.source_id}</dd></div>
                <div>
                  <dt>{details.target_type === 'take_proposal' ? 'Документ' : 'Целевая страница'}</dt>
                  <dd>{details.provenance.page_title || details.provenance.page_slug}</dd>
                </div>
                <div><dt>Путь</dt><dd>{details.provenance.page_slug}</dd></div>
                <div><dt>Предложено</dt><dd>{new Date(details.provenance.proposed_at).toLocaleString('ru-RU')}</dd></div>
              </dl>
              {details.target_type === 'concept_proposal' && details.provenance.supporting_sources.length > 0 && (
                <div className="review-supporting-sources">
                  <h4>Утверждения-основания</h4>
                  <ul>
                    {details.provenance.supporting_sources.map((source, index) => (
                      <li key={`${source.source_id}:${source.page_slug}:${index}`}>
                        {source.claim && <span>{source.claim}</span>}
                        <code>{source.source_id} · {source.page_slug}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {details.target_type === 'concept_proposal' && details.evidence_count === 0 && details.provenance.supporting_sources.length === 0 && (
                <p className="review-provenance-warning">Фрагменты-основания для этой концепции не были сохранены.</p>
              )}
              </section>
              <h3 className="review-details-heading">
                {details.target_type === 'take_proposal' ? 'Текст страницы-источника' : 'Текст предлагаемой концепции'}
              </h3>
              <pre className="review-details-body">{details.detail || 'Исходный текст не найден.'}</pre>
            </div>
            <div className="review-sheet-actions">
              <button type="button" className="review-btn ghost" onClick={() => setDetails(null)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {sheetOpen && card && (
        <RejectReasonSheet
          reasons={reasons}
          busy={busy || Boolean(failedVote)}
          status={reviewStatus}
          onCancel={() => setSheetOpen(false)}
          onConfirm={(reasonCode, comment) => stageVote('reject', reasonCode, comment)}
        />
      )}
    </div>
  );
}
