export const REVIEW_UNDO_WINDOW_MS = 15_000;

export function createUndoDeadline(nowMs = Date.now()): number {
  return nowMs + REVIEW_UNDO_WINDOW_MS;
}

export function undoSecondsRemaining(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
}
