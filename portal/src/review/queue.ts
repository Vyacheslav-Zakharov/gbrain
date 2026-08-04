import type { ReviewDeckCard } from './types';

/**
 * Move the current card to the end of the in-memory reviewer queue.
 * This is navigation only: it never changes assignment state or writes a vote.
 */
export function deferReviewCard(cards: readonly ReviewDeckCard[]): ReviewDeckCard[] {
  if (cards.length <= 1) return [...cards];
  return [...cards.slice(1), cards[0]!];
}
