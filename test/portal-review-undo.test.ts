import { describe, expect, test } from 'bun:test';
import {
  REVIEW_UNDO_WINDOW_MS,
  canCancelPendingDecision,
  createUndoDeadline,
  shouldApplyDetailsResponse,
  undoSecondsRemaining,
} from '../portal/src/review/undo.ts';

describe('review decision undo window', () => {
  test('lasts exactly fifteen seconds', () => {
    expect(REVIEW_UNDO_WINDOW_MS).toBe(15_000);
    expect(createUndoDeadline(10_000)).toBe(25_000);
  });

  test('shows a ceiling countdown and reaches zero only at expiry', () => {
    const deadline = createUndoDeadline(10_000);
    expect(undoSecondsRemaining(deadline, 10_000)).toBe(15);
    expect(undoSecondsRemaining(deadline, 10_001)).toBe(15);
    expect(undoSecondsRemaining(deadline, 24_001)).toBe(1);
    expect(undoSecondsRemaining(deadline, 25_000)).toBe(0);
    expect(undoSecondsRemaining(deadline, 30_000)).toBe(0);
  });

  test('never announces cancellation after submission has started', () => {
    expect(canCancelPendingDecision(true, false)).toBe(true);
    expect(canCancelPendingDecision(true, true)).toBe(false);
    expect(canCancelPendingDecision(false, false)).toBe(false);
  });

  test('a late details response cannot cover a staged decision', () => {
    expect(shouldApplyDetailsResponse(4, 4, false)).toBe(true);
    expect(shouldApplyDetailsResponse(4, 5, false)).toBe(false);
    expect(shouldApplyDetailsResponse(4, 4, true)).toBe(false);
  });
});