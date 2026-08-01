import { useCallback, useRef, useState } from 'react';
import { classifyGesture, gestureProgress, type GestureIntent } from './gestures';
import type { ReviewDeckCard } from './types';

interface Props {
  card: ReviewDeckCard;
  position: number;
  total: number;
  busy: boolean;
  reducedMotion: boolean;
  onIntent: (intent: GestureIntent) => void;
}

const TARGET_LABEL: Record<string, string> = {
  take_proposal: 'Утверждение',
  concept_proposal: 'Концепция',
};

function dueLabel(dueAt: string): string {
  const ms = Date.parse(dueAt) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'срок истёк';
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `осталось ${hours} ч`;
  return `осталось ${Math.round(hours / 24)} дн`;
}

/**
 * One reviewer card. Pointer Events drive a transform; the same three actions
 * are always available as real buttons, so the gesture is an accelerator and
 * never the only way to vote.
 */
export function SwipeCard({ card, position, total, busy, reducedMotion, onIntent }: Props) {
  const [delta, setDelta] = useState({ x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; at: number; handle: boolean } | null>(null);
  const suppressHandleClick = useRef(false);

  const reset = useCallback(() => { drag.current = null; setDelta({ x: 0, y: 0 }); }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>, fromHandle: boolean) => {
    if (busy || event.pointerType === 'mouse' && event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now(), handle: fromHandle };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    setDelta({ x: event.clientX - state.x, y: Math.max(0, event.clientY - state.y) });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>, cancelled = false) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const intent = classifyGesture({
      dx: event.clientX - state.x,
      dy: event.clientY - state.y,
      elapsedMs: Date.now() - state.at,
      fromDragHandle: state.handle,
      cancelled,
    });
    reset();
    if (state.handle && intent !== 'none') {
      suppressHandleClick.current = true;
      window.setTimeout(() => { suppressHandleClick.current = false; }, 0);
    }
    if (intent !== 'none') onIntent(intent);
  };

  const horizontal = Math.abs(delta.x) >= Math.abs(delta.y);
  const tint = horizontal ? gestureProgress(delta.x) : 0;
  const style = reducedMotion
    ? undefined
    : { transform: `translate(${delta.x}px, ${delta.y}px) rotate(${delta.x / 40}deg)` };

  return (
    <article
      className="review-card"
      style={style}
      aria-label={`Карточка ${position} из ${total}`}
      onPointerDown={event => onPointerDown(event, false)}
      onPointerMove={onPointerMove}
      onPointerUp={event => onPointerUp(event)}
      onPointerCancel={event => onPointerUp(event, true)}
    >
      {tint > 0.05 && (
        <div className={`review-tint ${delta.x > 0 ? 'approve' : 'reject'}`} style={{ opacity: tint }} aria-hidden="true">
          {delta.x > 0 ? 'Подтвердить' : 'Отклонить'}
        </div>
      )}
      <button
        type="button"
        className="review-drag-handle"
        aria-label="Открыть подробности"
        onPointerDown={event => { event.stopPropagation(); onPointerDown(event, true); }}
        onPointerMove={event => { event.stopPropagation(); onPointerMove(event); }}
        onPointerUp={event => { event.stopPropagation(); onPointerUp(event); }}
        onPointerCancel={event => { event.stopPropagation(); onPointerUp(event, true); }}
        onClick={() => {
          if (suppressHandleClick.current) { suppressHandleClick.current = false; return; }
          onIntent('details');
        }}
      >
        <span aria-hidden="true" />
      </button>
      <div className="review-card-meta">
        <span className="review-chip">{TARGET_LABEL[card.target_type] || card.target_type}</span>
        <span className="review-chip muted">{card.page_title || card.page_slug}</span>
        <span className="review-chip muted">{card.source_id}</span>
      </div>
      <p className="review-card-headline">{card.headline}</p>
      <dl className="review-card-facts">
        <div><dt>Фрагментов-подтверждений</dt><dd>{card.evidence_count}</dd></div>
        <div><dt>Срок</dt><dd>{dueLabel(card.due_at)}</dd></div>
        <div><dt>Режим</dt><dd>{card.policy_kind === 'personal' ? 'личная область' : 'общая область'}</dd></div>
      </dl>
      <p className="review-progress">{position} из {total}</p>
    </article>
  );
}
