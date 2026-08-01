/**
 * Stable reject-reason taxonomy for multi-reviewer AI Review.
 *
 * The CODE is the stored identity; the Russian label is presentation only.
 * Never persist the Russian string as the sole identifier — labels get
 * reworded, codes do not. Portal mirrors this list in
 * `portal/src/review/reasons.ts`; `test/portal-review-ui-contract.test.ts`
 * pins the two in sync.
 */

export type ReviewTargetType = 'take_proposal' | 'concept_proposal';

export interface RejectReasonDef {
  code: string;
  /** Russian label shown to reviewers and to Admin. */
  label: string;
  /** A free-text comment is mandatory before the vote is accepted. */
  commentRequired: boolean;
  /** Which decks may use this code. `both` = take and concept. */
  scope: 'both' | 'concept_proposal';
}

export const REJECT_REASONS: readonly RejectReasonDef[] = [
  { code: 'unsupported_by_sources', label: 'Не подтверждается источниками', commentRequired: false, scope: 'both' },
  { code: 'contradicts_evidence', label: 'Противоречит фактам или документам', commentRequired: true, scope: 'both' },
  { code: 'outdated', label: 'Устарело', commentRequired: false, scope: 'both' },
  { code: 'duplicate', label: 'Дубликат', commentRequired: false, scope: 'both' },
  { code: 'too_generic', label: 'Слишком общее или бесполезное', commentRequired: false, scope: 'both' },
  { code: 'wrong_context', label: 'Неверная область или контекст', commentRequired: false, scope: 'both' },
  { code: 'bad_wording', label: 'Смысл возможен, но формулировка неверна', commentRequired: false, scope: 'both' },
  { code: 'privacy_or_access', label: 'Нарушает конфиденциальность или доступ', commentRequired: true, scope: 'both' },
  { code: 'other', label: 'Другая причина', commentRequired: true, scope: 'both' },
  { code: 'weak_synthesis', label: 'Источники не складываются в одну концепцию', commentRequired: false, scope: 'concept_proposal' },
  { code: 'manual_page_conflict', label: 'Конфликтует с вручную курируемой страницей', commentRequired: true, scope: 'concept_proposal' },
  { code: 'insufficient_novelty', label: 'Не добавляет нового знания', commentRequired: false, scope: 'concept_proposal' },
] as const;

export const MAX_REJECT_COMMENT_CHARS = 2000;

export function rejectReasonsFor(targetType: ReviewTargetType): RejectReasonDef[] {
  return REJECT_REASONS.filter(r => r.scope === 'both' || r.scope === targetType);
}

export interface RejectReasonValidation {
  ok: boolean;
  /** Machine-stable error code; the HTTP layer maps it to 422. */
  error?: 'reason_code_required' | 'reason_code_unknown' | 'reason_comment_required' | 'reason_comment_too_long';
  reasonCode?: string;
  comment?: string | null;
}

/**
 * Fail-closed validation of a reject vote's reason. An approve vote carries no
 * reason at all; callers must not run this for approvals.
 */
export function validateRejectReason(
  targetType: ReviewTargetType,
  reasonCodeRaw: unknown,
  commentRaw: unknown,
): RejectReasonValidation {
  const reasonCode = typeof reasonCodeRaw === 'string' ? reasonCodeRaw.trim() : '';
  if (!reasonCode) return { ok: false, error: 'reason_code_required' };
  const def = rejectReasonsFor(targetType).find(r => r.code === reasonCode);
  if (!def) return { ok: false, error: 'reason_code_unknown' };
  const comment = typeof commentRaw === 'string' ? commentRaw.trim() : '';
  if (def.commentRequired && !comment) return { ok: false, error: 'reason_comment_required' };
  if (comment.length > MAX_REJECT_COMMENT_CHARS) return { ok: false, error: 'reason_comment_too_long' };
  return { ok: true, reasonCode, comment: comment || null };
}
