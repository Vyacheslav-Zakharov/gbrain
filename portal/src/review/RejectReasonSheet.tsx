import { useEffect, useRef, useState } from 'react';
import type { ReviewRejectReason } from './types';

interface Props {
  reasons: ReviewRejectReason[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reasonCode: string, comment: string) => void;
}

/**
 * Mandatory bottom sheet for a reject. A left swipe opens this; nothing is
 * sent until a reason is chosen, so an accidental swipe costs one tap to undo.
 */
export function RejectReasonSheet({ reasons, busy, onCancel, onConfirm }: Props) {
  const [reasonCode, setReasonCode] = useState('');
  const [comment, setComment] = useState('');
  const sheetRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const selected = reasons.find(r => r.code === reasonCode);
  const commentMissing = Boolean(selected?.commentRequired) && !comment.trim();
  const canConfirm = Boolean(selected) && !commentMissing && !busy;

  return (
    <div className="review-sheet-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="review-sheet" role="dialog" aria-modal="true" aria-labelledby="review-sheet-title" ref={sheetRef}>
        <h2 id="review-sheet-title" className="review-sheet-title">Причина отклонения</h2>
        <p className="review-sheet-hint">Причина обязательна: она попадает в аудит и в отчёт по качеству знаний.</p>
        <div className="review-reason-list" role="radiogroup" aria-label="Причина отклонения">
          {reasons.map((reason, index) => (
            <button
              key={reason.code}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              role="radio"
              aria-checked={reasonCode === reason.code}
              className={`review-reason ${reasonCode === reason.code ? 'selected' : ''}`}
              onClick={() => setReasonCode(reason.code)}
            >
              <span>{reason.label}</span>
              {reason.commentRequired && <span className="review-reason-flag">нужен комментарий</span>}
            </button>
          ))}
        </div>
        <label className="review-comment-label" htmlFor="review-comment">
          Комментарий{selected?.commentRequired ? ' (обязателен)' : ' (необязателен)'}
        </label>
        <textarea
          id="review-comment"
          className="review-comment"
          rows={3}
          maxLength={2000}
          value={comment}
          onChange={event => setComment(event.target.value)}
          aria-invalid={commentMissing}
          aria-describedby={commentMissing ? 'review-comment-error' : undefined}
        />
        {commentMissing && <div id="review-comment-error" className="review-error">Для выбранной причины комментарий обязателен.</div>}
        <div className="review-sheet-actions">
          <button type="button" className="review-btn ghost" onClick={onCancel} disabled={busy}>Отмена</button>
          <button
            type="button"
            className="review-btn danger"
            disabled={!canConfirm}
            onClick={() => canConfirm && onConfirm(reasonCode, comment.trim())}
          >
            {busy ? 'Сохраняем…' : 'Отклонить'}
          </button>
        </div>
      </div>
    </div>
  );
}
