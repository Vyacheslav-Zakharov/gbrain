/**
 * Pure swipe/keyboard classification for the reviewer deck.
 *
 * Kept free of React and DOM so the thresholds are unit-testable and the
 * component only has to translate Pointer Events into these inputs.
 *
 * Note that a `reject` intent NEVER submits a vote on its own — the caller
 * opens the mandatory Russian reason sheet first. `details` is not a vote.
 */

export type GestureIntent = 'approve' | 'reject' | 'details' | 'none';

/** Distance a drag must travel before it counts as a decision. */
export const SWIPE_THRESHOLD_PX = 72;
/** A short flick commits at half the distance if it is fast enough. */
export const SWIPE_FLICK_VELOCITY = 0.5; // px per ms
/** The dominant axis must beat the other by this factor (kills diagonals). */
export const SWIPE_AXIS_RATIO = 1.4;

export interface GestureInput {
  /** Horizontal travel in px; positive is right. */
  dx: number;
  /** Vertical travel in px; positive is down. */
  dy: number;
  elapsedMs: number;
  /**
   * A downward gesture is only honored from the card's drag handle, so normal
   * vertical scrolling and pull-to-refresh keep working on the card body.
   */
  fromDragHandle: boolean;
  /** A cancelled pointer (pointercancel, escape) always resets. */
  cancelled?: boolean;
}

function committed(distance: number, elapsedMs: number): boolean {
  if (distance >= SWIPE_THRESHOLD_PX) return true;
  const velocity = elapsedMs > 0 ? distance / elapsedMs : 0;
  return distance >= SWIPE_THRESHOLD_PX / 2 && velocity >= SWIPE_FLICK_VELOCITY;
}

export function classifyGesture(input: GestureInput): GestureIntent {
  if (input.cancelled) return 'none';
  const dx = Number.isFinite(input.dx) ? input.dx : 0;
  const dy = Number.isFinite(input.dy) ? input.dy : 0;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (absX >= absY * SWIPE_AXIS_RATIO && committed(absX, input.elapsedMs)) {
    return dx > 0 ? 'approve' : 'reject';
  }
  if (dy > 0 && absY >= absX * SWIPE_AXIS_RATIO && committed(absY, input.elapsedMs)) {
    return input.fromDragHandle ? 'details' : 'none';
  }
  return 'none';
}

/** 0..1 tint strength for the progressive approve/reject overlay. */
export function gestureProgress(delta: number): number {
  const value = Math.abs(Number.isFinite(delta) ? delta : 0) / SWIPE_THRESHOLD_PX;
  return Math.max(0, Math.min(1, value));
}

/** Keyboard parity for the three gestures. Returns 'none' for anything else. */
export function keyToIntent(key: string): GestureIntent {
  if (key === 'ArrowRight') return 'approve';
  if (key === 'ArrowLeft') return 'reject';
  if (key === 'ArrowDown') return 'details';
  return 'none';
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
