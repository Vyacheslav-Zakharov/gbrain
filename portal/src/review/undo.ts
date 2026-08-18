export const REVIEW_UNDO_WINDOW_MS = 20_000;

export function createUndoDeadline(nowMs = Date.now()): number {
  return nowMs + REVIEW_UNDO_WINDOW_MS;
}

export function isUndoDeadlineOpen(deadlineMs: number, nowMs = Date.now()): boolean {
  return nowMs < deadlineMs;
}

export function undoSecondsRemaining(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
}

export function canCancelPendingDecision(hasPending: boolean, isCommitting: boolean): boolean {
  return hasPending && !isCommitting;
}

export function shouldApplyDetailsResponse(
  requestId: number,
  currentRequestId: number,
  hasPendingDecision: boolean,
): boolean {
  return requestId === currentRequestId && !hasPendingDecision;
}
