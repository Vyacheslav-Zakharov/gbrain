import { describe, expect, test } from 'bun:test';
import { advanceReviewCard, deferReviewCard, restoreReviewCard, shouldRefillReviewDeck } from '../portal/src/review/queue.ts';
import type { ReviewDeckCard } from '../portal/src/review/types.ts';

function card(id: number): ReviewDeckCard {
  return {
    assignment_id: id,
    round_id: id,
    target_type: 'take_proposal',
    target_id: id,
    source_id: 'shared',
    page_slug: `notes/${id}`,
    page_title: null,
    headline: `Card ${id}`,
    preview: '',
    evidence_count: 0,
    proposal_snapshot_hash: `hash-${id}`,
    due_at: '2026-08-05T00:00:00Z',
    proposed_at: '2026-08-04T00:00:00Z',
    policy_kind: 'shared',
    details_opened: false,
  };
}

describe('reviewer queue deferral', () => {
  test('moves the current card to the end without removing any assignment', () => {
    const original = [card(1), card(2), card(3)];
    const deferred = deferReviewCard(original);
    expect(deferred.map(item => item.assignment_id)).toEqual([2, 3, 1]);
    expect(original.map(item => item.assignment_id)).toEqual([1, 2, 3]);
  });

  test('one or zero cards remain available rather than disappearing', () => {
    expect(deferReviewCard([])).toEqual([]);
    expect(deferReviewCard([card(1)]).map(item => item.assignment_id)).toEqual([1]);
  });
});

describe('lazy review undo queue', () => {
  test('advances immediately and can restore exactly the last staged card', () => {
    const original = [card(1), card(2), card(3)];
    const advanced = advanceReviewCard(original);
    expect(advanced.current?.assignment_id).toBe(1);
    expect(advanced.remaining.map(item => item.assignment_id)).toEqual([2, 3]);
    expect(restoreReviewCard(advanced.current!, advanced.remaining).map(item => item.assignment_id)).toEqual([1, 2, 3]);
  });

  test('empty queues advance safely and restoration never duplicates the current card', () => {
    expect(advanceReviewCard([])).toEqual({ current: null, remaining: [] });
    expect(restoreReviewCard(card(2), [card(2), card(3)]).map(item => item.assignment_id)).toEqual([2, 3]);
  });
});

describe('review deck refill gate', () => {
  const exhaustedPartialBatch = {
    loading: false,
    busy: false,
    voteInFlight: false,
    hasPendingVote: false,
    hasFailedVote: false,
    cardCount: 0,
    reviewed: 50,
    total: 75,
  };

  test('waits for the final background vote before reloading a partial batch', () => {
    expect(shouldRefillReviewDeck({ ...exhaustedPartialBatch, voteInFlight: true })).toBe(false);
    expect(shouldRefillReviewDeck(exhaustedPartialBatch)).toBe(true);
  });

  test('never reloads over an undoable or failed vote', () => {
    expect(shouldRefillReviewDeck({ ...exhaustedPartialBatch, hasPendingVote: true })).toBe(false);
    expect(shouldRefillReviewDeck({ ...exhaustedPartialBatch, hasFailedVote: true })).toBe(false);
  });
});
