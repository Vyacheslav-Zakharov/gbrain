import { describe, expect, test } from 'bun:test';
import { ReviewApiError } from '../portal/src/api.ts';
import {
  DEFAULT_REVIEW_VOTE_RETRY_DELAYS_MS,
  ReviewVoteRetryExhaustedError,
  submitReviewVoteWithRetry,
} from '../portal/src/review/vote-retry.ts';

describe('review vote transient retry', () => {
  test('retries a transient network failure and returns the successful response', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const retries: number[] = [];
    const result = await submitReviewVoteWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return { saved: true };
      },
      {
        delaysMs: [250, 500],
        sleep: async ms => { delays.push(ms); },
        onRetry: attempt => { retries.push(attempt); },
      },
    );

    expect(result).toEqual({ saved: true });
    expect(attempts).toBe(2);
    expect(delays).toEqual([250]);
    expect(retries).toEqual([1]);
  });

  test('retries a server error but not a validation or authentication error', async () => {
    let serverAttempts = 0;
    await expect(submitReviewVoteWithRetry(
      async () => {
        serverAttempts += 1;
        throw new ReviewApiError('temporary', 'unknown', 503);
      },
      { delaysMs: [1], sleep: async () => {} },
    )).rejects.toBeInstanceOf(ReviewVoteRetryExhaustedError);
    expect(serverAttempts).toBe(2);

    let clientAttempts = 0;
    await expect(submitReviewVoteWithRetry(
      async () => {
        clientAttempts += 1;
        throw new ReviewApiError('invalid', 'reason_code_required', 400);
      },
      { delaysMs: [1, 2], sleep: async () => {} },
    )).rejects.toMatchObject({ status: 400 });
    expect(clientAttempts).toBe(1);
  });

  test('uses three total attempts by default and reports exhaustion without losing the cause', async () => {
    expect(DEFAULT_REVIEW_VOTE_RETRY_DELAYS_MS).toEqual([500, 1_500]);
    let attempts = 0;
    const cause = new TypeError('Failed to fetch');
    let exhausted: unknown;
    try {
      await submitReviewVoteWithRetry(
        async () => { attempts += 1; throw cause; },
        { delaysMs: DEFAULT_REVIEW_VOTE_RETRY_DELAYS_MS, sleep: async () => {} },
      );
    } catch (error) {
      exhausted = error;
    }
    expect(attempts).toBe(3);
    expect(exhausted).toBeInstanceOf(ReviewVoteRetryExhaustedError);
    expect((exhausted as ReviewVoteRetryExhaustedError).cause).toBe(cause);
  });

  test('never retries 401 or 409 responses', async () => {
    for (const status of [401, 409]) {
      let attempts = 0;
      await expect(submitReviewVoteWithRetry(async () => {
        attempts += 1;
        throw new ReviewApiError('stop', status === 401 ? 'unauthenticated' : 'round_closed', status);
      }, { delaysMs: [1, 2], sleep: async () => {} })).rejects.toMatchObject({ status });
      expect(attempts).toBe(1);
    }
  });
});
