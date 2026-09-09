import type { ReviewRejectReason, ReviewTargetType } from './types';

/**
 * Presentation mirror of `src/core/ai-review-reasons.ts`. The server is the
 * authority — it revalidates every code and comment requirement — but the deck
 * needs the labels offline while a vote is in flight. Parity is pinned by
 * `test/portal-review-ui-contract.test.ts`.
 */
export const REVIEW_REJECT_REASONS: ReviewRejectReason[] = [
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
];

export function reasonsForTarget(targetType: ReviewTargetType): ReviewRejectReason[] {
  return REVIEW_REJECT_REASONS.filter(r => r.scope === 'both' || r.scope === targetType);
}

/** Russian copy for the machine-stable error codes the vote endpoint returns. */
export const REVIEW_ERROR_MESSAGES: Record<string, string> = {
  foreign_assignment: 'Эта карточка назначена другому проверяющему.',
  source_access_revoked: 'Доступ к источнику отозван. Обратитесь к администратору.',
  round_closed: 'Проверка по этой карточке уже закрыта.',
  round_escalated: 'Срок голосования истёк, карточка передана администратору.',
  stale_proposal: 'Источник изменился, карточка отправлена на перепроверку.',
  concurrent_vote: 'Голос уже был сохранён в другой вкладке.',
  reason_code_required: 'Выберите причину отклонения.',
  reason_comment_required: 'Для этой причины нужен комментарий.',
  reason_comment_too_long: 'Комментарий слишком длинный.',
  not_found: 'Карточка не найдена.',
};

export function reviewErrorMessage(code: string | undefined, fallback: string): string {
  return (code && REVIEW_ERROR_MESSAGES[code]) || fallback;
}

const TERMINAL_REVIEW_ERROR_CODES = new Set([
  'stale_proposal',
  'round_closed',
  'round_escalated',
  'foreign_assignment',
  'concurrent_vote',
  'source_access_revoked',
  'not_found',
]);

export function isTerminalReviewError(code: string | undefined): boolean {
  return Boolean(code && TERMINAL_REVIEW_ERROR_CODES.has(code));
}
