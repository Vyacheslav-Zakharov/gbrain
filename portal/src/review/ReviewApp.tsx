import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { portalApi, ReviewApiError } from '../api';
import { keyToIntent, prefersReducedMotion, type GestureIntent } from './gestures';
import { reasonsForTarget, reviewErrorMessage } from './reasons';
import { RejectReasonSheet } from './RejectReasonSheet';
import { SwipeCard } from './SwipeCard';
import type { PortalSession } from '../types';
import type { ReviewDeckCard, ReviewItemDetail } from './types';
import './review.css';

function newIdempotencyKey(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && 'randomUUID' in cryptoRef) return cryptoRef.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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
  const reducedMotion = useMemo(prefersReducedMotion, []);
  // One key per user ATTEMPT: a retry after a network error replays the same
  // key, so a flaky connection can never produce two votes.
  const attemptKey = useRef(newIdempotencyKey());

  const card = cards[0] ?? null;
  const reasons = useMemo(() => reasonsForTarget(card?.target_type ?? 'take_proposal'), [card?.target_type]);

  const loadDeck = useCallback(async () => {
    setLoading(true);
    setError('');
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
    if (!loading && !busy && cards.length === 0 && reviewed > 0 && reviewed < total) {
      void loadDeck();
    }
  }, [busy, cards.length, loadDeck, loading, reviewed, total]);

  const dropCard = useCallback(() => {
    setCards(prev => prev.slice(1));
    setReviewed(current => current + 1);
    setDetails(null);
    setSheetOpen(false);
    attemptKey.current = newIdempotencyKey();
  }, []);

  const submitVote = useCallback(async (decision: 'approve' | 'reject', reasonCode?: string, comment?: string) => {
    if (!card || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await portalApi.reviewVote(
        card.assignment_id,
        { decision, reason_code: reasonCode, comment, proposal_snapshot_hash: card.proposal_snapshot_hash },
        attemptKey.current,
      );
      setAnnouncement(
        result.round_status === 'finalized'
          ? `Голос сохранён. Решение принято: ${result.outcome === 'accepted' ? 'подтверждено' : 'отклонено'}.`
          : result.round_status === 'escalated'
            ? 'Голос сохранён. Решение передано администратору.'
            : 'Голос сохранён. Ожидаем остальных проверяющих.',
      );
      dropCard();
    } catch (err) {
      const code = err instanceof ReviewApiError ? err.code : undefined;
      const message = reviewErrorMessage(code, err instanceof Error ? err.message : 'Не удалось сохранить голос');
      setError(message);
      setAnnouncement(message);
      // A stale or reassigned card is gone for this reviewer; anything else
      // (network, 5xx) keeps the card so nothing is optimistically "done".
      if (code === 'stale_proposal' || code === 'round_closed' || code === 'round_escalated' || code === 'foreign_assignment') {
        dropCard();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, card, dropCard]);

  const openDetails = useCallback(async () => {
    if (!card || busy) return;
    try {
      const response = await portalApi.reviewItem(card.assignment_id);
      setDetails(response.item);
    } catch (err) {
      const code = err instanceof ReviewApiError ? err.code : undefined;
      setError(reviewErrorMessage(code, err instanceof Error ? err.message : 'Не удалось открыть подробности'));
    }
  }, [busy, card]);

  const handleIntent = useCallback((intent: GestureIntent) => {
    if (intent === 'approve') void submitVote('approve');
    else if (intent === 'reject') setSheetOpen(true);
    else if (intent === 'details') void openDetails();
  }, [openDetails, submitVote]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!card) return;
      if (details) {
        if (event.key === 'Escape') { event.preventDefault(); setDetails(null); }
        return;
      }
      if (sheetOpen) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const intent = keyToIntent(event.key);
      if (intent === 'none') return;
      event.preventDefault();
      handleIntent(intent);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, details, handleIntent, sheetOpen]);

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
        {!loading && !card && !error && (
          <div className="review-state">
            <p>На сегодня всё. Новые карточки появятся, когда система предложит их вашей области.</p>
            <button type="button" className="review-btn ghost" onClick={() => void loadDeck()}>Обновить</button>
          </div>
        )}

        {card && (
          <>
            {error && <p className="review-error" role="alert">{error}</p>}
            <SwipeCard
              card={card}
              position={reviewed + 1}
              total={total}
              busy={busy}
              reducedMotion={reducedMotion}
              onIntent={handleIntent}
            />
            <div className="review-actions">
              <button type="button" className="review-btn danger" disabled={busy} onClick={() => setSheetOpen(true)}>
                Отклонить
              </button>
              <button type="button" className="review-btn ghost" disabled={busy} onClick={() => void openDetails()}>
                Детали
              </button>
              <button type="button" className="review-btn approve" disabled={busy} onClick={() => void submitVote('approve')}>
                {busy ? 'Сохраняем…' : 'Подтвердить'}
              </button>
            </div>
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
            <h2 id="review-details-title" className="review-sheet-title">{details.page_title || details.page_slug}</h2>
            <pre className="review-details-body">{details.detail}</pre>
            <div className="review-sheet-actions">
              <button type="button" className="review-btn ghost" onClick={() => setDetails(null)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {sheetOpen && card && (
        <RejectReasonSheet
          reasons={reasons}
          busy={busy}
          onCancel={() => setSheetOpen(false)}
          onConfirm={(reasonCode, comment) => void submitVote('reject', reasonCode, comment)}
        />
      )}
    </div>
  );
}
