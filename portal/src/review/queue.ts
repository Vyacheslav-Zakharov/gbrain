import type { ReviewDeckCard } from './types';

export function advanceReviewCard(cards: readonly ReviewDeckCard[]): {
  current: ReviewDeckCard | null;
  remaining: ReviewDeckCard[];
} {
  return {
    current: cards[0] ?? null,
    remaining: cards.length > 0 ? [...cards.slice(1)] : [],
  };
}

export function restoreReviewCard(
  card: ReviewDeckCard,
  cards: readonly ReviewDeckCard[],
): ReviewDeckCard[] {
  if (cards.some(item => item.assignment_id === card.assignment_id)) return [...cards];
  return [card, ...cards];
}

/**
 * Move the current card to the end of the in-memory reviewer queue.
 * This is navigation only: it never changes assignment state or writes a vote.
 */
export function deferReviewCard(cards: readonly ReviewDeckCard[]): ReviewDeckCard[] {
  if (cards.length <= 1) return [...cards];
  return [...cards.slice(1), cards[0]!];
}

export function shouldRefillReviewDeck(input: {
  loading: boolean;
  busy: boolean;
  voteInFlight: boolean;
  hasPendingVote: boolean;
  hasFailedVote: boolean;
  cardCount: number;
  reviewed: number;
  total: number;
}): boolean {
  return !input.loading
    && !input.busy
    && !input.voteInFlight
    && !input.hasPendingVote
    && !input.hasFailedVote
    && input.cardCount === 0
    && input.reviewed > 0
    && input.reviewed < input.total;
}
