import type {
  ContextResponse,
  FileResponse,
  PortalSession,
  PortalSource,
  SearchResult,
  TreeResponse,
} from './types';
import type {
  ReviewDeckCard,
  ReviewItemDetail,
  ReviewRejectReason,
  ReviewSummary,
  ReviewVoteResponse,
} from './review/types';

/** Machine-stable code from the review API, carried alongside the message. */
export class ReviewApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = 'ReviewApiError';
  }
}

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Требуется вход');
  }
  if (!response.ok) {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: string };
      throw new Error(parsed.error || `HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(body || `HTTP ${response.status}`);
      throw error;
    }
  }
  return response.json() as Promise<T>;
}

function qs(values: Record<string, string>): string {
  const params = new URLSearchParams(values);
  return params.toString();
}

export const portalApi = {
  logout: async () => {
    const response = await fetch('/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok && response.status !== 401) throw new Error(`HTTP ${response.status}`);
  },
  session: () => requestJson<PortalSession>('/portal/api/session'),
  sources: async () => (await requestJson<{ sources: PortalSource[] }>('/portal/api/sources')).sources,
  tree: (source: string, path: string, signal?: AbortSignal) =>
    requestJson<TreeResponse>(`/portal/api/tree?${qs({ source, path })}`, signal),
  file: (source: string, path: string, signal?: AbortSignal) =>
    requestJson<FileResponse>(`/portal/api/file?${qs({ source, path })}`, signal),
  search: async (query: string, signal?: AbortSignal) =>
    (await requestJson<{ results: SearchResult[] }>(`/portal/api/search?${qs({ q: query })}`, signal)).results,
  resolveLink: (link: string, currentSource: string) =>
    requestJson<{ found: boolean; source?: string; path?: string }>(
      `/portal/api/resolve-link?${qs({ link, currentSource })}`,
    ),
  context: (source: string, path: string, signal?: AbortSignal) =>
    requestJson<ContextResponse>(`/portal/api/context?${qs({ source, path })}`, signal),
  downloadUrl: (source: string, path: string) => `/portal/download?${qs({ source, path })}`,
  reviewSummary: () => requestJson<ReviewSummary>('/portal/api/review/summary'),
  reviewDeck: (limit = 10, signal?: AbortSignal) =>
    requestJson<{ cards: ReviewDeckCard[]; total: number }>(`/portal/api/review/deck?${qs({ limit: String(limit) })}`, signal),
  reviewItem: (assignmentId: number, signal?: AbortSignal) =>
    requestJson<{ item: ReviewItemDetail; reasons: ReviewRejectReason[] }>(`/portal/api/review/items/${assignmentId}`, signal),
  /**
   * The idempotency key belongs to ONE user attempt: a retry after a network
   * error replays the same key so a double-tap can never become two votes.
   */
  reviewVote: async (
    assignmentId: number,
    body: { decision: 'approve' | 'reject'; reason_code?: string; comment?: string; proposal_snapshot_hash: string },
    idempotencyKey: string,
  ): Promise<ReviewVoteResponse> => {
    const response = await fetch(`/portal/api/review/items/${assignmentId}/vote`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      window.location.assign('/login');
      throw new ReviewApiError('Требуется вход', 'unauthenticated', 401);
    }
    const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (!response.ok) {
      throw new ReviewApiError(payload.message || `HTTP ${response.status}`, payload.error || 'unknown', response.status);
    }
    return payload as unknown as ReviewVoteResponse;
  },
};
