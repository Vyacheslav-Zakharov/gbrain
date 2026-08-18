interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

export const DEFAULT_REVIEW_VOTE_RETRY_DELAYS_MS = [500, 1_500] as const;

export class ReviewVoteRetryExhaustedError extends Error {
  constructor(public readonly cause: unknown) {
    super('Не удалось сохранить решение после повторных попыток');
    this.name = 'ReviewVoteRetryExhaustedError';
  }
}

function isTransientVoteError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  const status = Number((error as { status?: unknown }).status);
  return Number.isFinite(status) && status >= 500;
}

/**
 * Retry only transport failures and 5xx responses. The caller supplies one
 * idempotent operation, so a lost success response replays the same vote key.
 */
export async function submitReviewVoteWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delaysMs = options.delaysMs ?? DEFAULT_REVIEW_VOTE_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientVoteError(error)) throw error;
      const delay = delaysMs[attempt];
      if (delay === undefined) throw new ReviewVoteRetryExhaustedError(error);
      options.onRetry?.(attempt + 1);
      await sleep(delay);
    }
  }
}
