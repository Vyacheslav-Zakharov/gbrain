import { describe, expect, test } from 'bun:test';
import { deferReviewCard } from '../portal/src/review/queue.ts';
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
