import { describe, expect, test } from 'bun:test';
import {
  classifyGesture,
  gestureProgress,
  keyToIntent,
  SWIPE_THRESHOLD_PX,
} from '../portal/src/review/gestures.ts';

function drag(dx: number, dy: number, elapsedMs = 300, fromDragHandle = false) {
  return classifyGesture({ dx, dy, elapsedMs, fromDragHandle });
}

describe('swipe classification', () => {
  test('a committed right drag approves and a committed left drag rejects', () => {
    expect(drag(SWIPE_THRESHOLD_PX, 4)).toBe('approve');
    expect(drag(-SWIPE_THRESHOLD_PX, -4)).toBe('reject');
  });

  test('a short drag below the threshold does nothing', () => {
    expect(drag(SWIPE_THRESHOLD_PX - 1, 0, 1_000)).toBe('none');
    expect(drag(-20, 0, 1_000)).toBe('none');
  });

  test('a fast flick commits at half the distance', () => {
    expect(drag(40, 0, 50)).toBe('approve');
    expect(drag(40, 0, 5_000)).toBe('none');
  });

  test('a diagonal drag is refused rather than guessed', () => {
    expect(drag(80, 80)).toBe('none');
    expect(drag(-80, 70)).toBe('none');
  });

  test('a downward drag opens details only from the drag handle', () => {
    expect(drag(0, 100, 300, true)).toBe('details');
    expect(drag(0, 100, 300, false)).toBe('none');
  });

  test('an upward drag is never a decision', () => {
    expect(drag(0, -140, 200, true)).toBe('none');
  });

  test('a cancelled pointer always resets', () => {
    expect(classifyGesture({ dx: 300, dy: 0, elapsedMs: 100, fromDragHandle: true, cancelled: true })).toBe('none');
  });

  test('non-finite input cannot produce a vote', () => {
    expect(classifyGesture({ dx: Number.NaN, dy: Number.NaN, elapsedMs: 10, fromDragHandle: true })).toBe('none');
  });
});

describe('tint progress', () => {
  test('scales 0..1 across the threshold and clamps', () => {
    expect(gestureProgress(0)).toBe(0);
    expect(gestureProgress(SWIPE_THRESHOLD_PX / 2)).toBeCloseTo(0.5, 5);
    expect(gestureProgress(-SWIPE_THRESHOLD_PX * 4)).toBe(1);
    expect(gestureProgress(Number.NaN)).toBe(0);
  });
});

describe('keyboard parity', () => {
  test('arrow keys mirror the three gestures and nothing else does', () => {
    expect(keyToIntent('ArrowRight')).toBe('approve');
    expect(keyToIntent('ArrowLeft')).toBe('reject');
    expect(keyToIntent('ArrowDown')).toBe('details');
    expect(keyToIntent('ArrowUp')).toBe('none');
    expect(keyToIntent('Enter')).toBe('none');
    expect(keyToIntent(' ')).toBe('none');
  });
});
