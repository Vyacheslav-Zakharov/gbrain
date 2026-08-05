const BASE = '';
export const ADMIN_REQUEST_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const abortFromUpstream = () => controller.abort();
  upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timer = window.setTimeout(() => controller.abort(), ADMIN_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(path, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !upstreamSignal?.aborted) {
      throw new Error('Превышено время ожидания ответа. Проверьте соединение и повторите запрос.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

export function adminApiErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const payload = body as { message?: unknown; error?: unknown };
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  }
  return `HTTP ${status}`;
}

export function shouldStartPortalAdminRevalidation(body: unknown): boolean {
  return Boolean(
    body
    && typeof body === 'object'
    && (body as { error?: unknown }).error === 'portal_revalidation_required',
  );
}

export type PortalAdminRevalidationFence = {
  claim(): boolean;
  started(): boolean;
};

export function createPortalAdminRevalidationFence(): PortalAdminRevalidationFence {
  let navigationStarted = false;
  return {
    claim: () => {
      if (navigationStarted) return false;
      navigationStarted = true;
      return true;
    },
    started: () => navigationStarted,
  };
}

export type PortalAdminUnauthorizedAction = 'revalidate' | 'wait' | 'login';

export function portalAdminUnauthorizedAction(
  body: unknown,
  fence: PortalAdminRevalidationFence,
): PortalAdminUnauthorizedAction {
  if (shouldStartPortalAdminRevalidation(body)) {
    return fence.claim() ? 'revalidate' : 'wait';
  }
  return fence.started() ? 'wait' : 'login';
}

const portalAdminRevalidationFence = createPortalAdminRevalidationFence();

async function handleAdminUnauthorized(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}));
  const action = portalAdminUnauthorizedAction(body, portalAdminRevalidationFence);

  if (action === 'revalidate') {
    // Concurrent Admin loads can all cross the same freshness boundary. Claim
    // one navigation before creating an OIDC transaction so later 401 handlers
    // cannot overwrite its browser-binding cookie or switch to local #login.
    window.location.assign('/login?return_to=%2Fadmin%2F');
  }
  if (action !== 'login') {
    throw new Error('Portal revalidation required');
  }

  // Real unauthorized states (missing/revoked/no-role/fallback) must not enter
  // an automatic redirect loop.
  window.location.hash = '#login';
  throw new Error('Unauthorized');
}

// v0.26.3 trust model (D11 + D12): the admin UI does NOT cache the
// bootstrap token in browser JS state. Generic 401 responses still go to the
// local login screen. Only the server-classified Keycloak freshness boundary
// starts a top-level prompt=none revalidation; no browser token cache is read.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (res.status === 401) {
    await handleAdminUnauthorized(res);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(adminApiErrorMessage(body, res.status));
  }
  return res.json();
}

// v0.36.1.0 (T15 / E6) — SVG fetch (text/plain payload, NOT JSON).
async function apiFetchText(path: string) {
  const res = await fetchWithTimeout(`${BASE}${path}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    await handleAdminUnauthorized(res);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const api = {
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
  accessControlPermissions: () => apiFetch('/admin/api/permissions'),
  accessControlSavePermissions: (email: string, payload: { grants: Array<{ source_id: string; read: boolean; write: boolean }>; expected_version: string }) =>
    apiFetch(`/admin/api/permissions/${encodeURIComponent(email)}`, { method: 'POST', body: JSON.stringify(payload) }),
  accessControlRequests: () => apiFetch('/admin/api/access-requests'),
  accessControlApproveRequest: (id: string, payload: { grants: Array<{ index: number; read: boolean; write: boolean }>; expected_version: string }) =>
    apiFetch(`/admin/api/access-requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify(payload) }),
  accessControlRejectRequest: (id: string, expected_version: string, reason = '') =>
    apiFetch(`/admin/api/access-requests/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ expected_version, reason }) }),
  stats: () => apiFetch('/admin/api/stats'),
  health: () => apiFetch('/admin/api/health-indicators'),
  agents: () => apiFetch('/admin/api/agents'),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  apiKeys: () => apiFetch('/admin/api/api-keys'),
  createApiKey: (name: string) => apiFetch('/admin/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (name: string) => apiFetch('/admin/api/api-keys/revoke', { method: 'POST', body: JSON.stringify({ name }) }),
  updateClientTtl: (clientId: string, tokenTtl: number | null) => apiFetch('/admin/api/update-client-ttl', { method: 'POST', body: JSON.stringify({ clientId, tokenTtl }) }),
  revokeClient: (clientId: string) => apiFetch('/admin/api/revoke-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
  // v0.36.1.0 (T15 / E6) — calibration endpoints.
  calibrationProfile: (holder?: string) =>
    apiFetch(`/admin/api/calibration/profile${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  startCalibration: () => apiFetch('/admin/api/calibration/run', { method: 'POST' }),
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  // v0.41 D2 — live minion-jobs dashboard snapshot.
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
  activityRuns: (filters: { period?: string; since?: string; until?: string; source?: string; name?: string; status?: string; limit?: number; offset?: number; export?: boolean } = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') qs.set(key, String(value));
    }
    return apiFetch(`/admin/api/activity/runs?${qs.toString()}`);
  },
  meetingReviewItems: (params: { status?: string; review_class?: 'ready' | 'exception'; q?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') qs.set(key, String(value));
    return apiFetch(`/admin/api/meeting-review/items?${qs.toString()}`);
  },
  meetingReviewItem: (id: string) => apiFetch(`/admin/api/meeting-review/items/${encodeURIComponent(id)}`),
  meetingReviewManualRevision: (id: string, draft: object) => apiFetch(`/admin/api/meeting-review/items/${encodeURIComponent(id)}/revisions/manual`, { method: 'POST', body: JSON.stringify({ draft }) }),
  meetingReviewLlmRevision: (id: string, field: string, comment: string) => apiFetch(`/admin/api/meeting-review/items/${encodeURIComponent(id)}/revisions/llm`, { method: 'POST', body: JSON.stringify({ field, comment }) }),
  // Backward-compatible client surface only: the server endpoint is a fail-closed 409 kill switch.
  meetingReviewAccept: (id: string, draft: object, revision_id?: number) => apiFetch(`/admin/api/meeting-review/items/${encodeURIComponent(id)}/accept`, { method: 'POST', body: JSON.stringify({ draft, revision_id }) }),
  meetingReviewReject: (id: string, reason?: string) => apiFetch(`/admin/api/meeting-review/items/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  meetingReviewRefresh: () => apiFetch('/admin/api/meeting-review/refresh', { method: 'POST' }),
  aiReviewProposals: (params: { status?: string; q?: string; source_id?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') qs.set(key, String(value));
    }
    return apiFetch(`/admin/api/ai-review/proposals?${qs.toString()}`);
  },
  aiReviewProposal: (id: number) => apiFetch(`/admin/api/ai-review/proposals/${id}`),
  aiReviewManualRevision: (id: number, draft: object) => apiFetch(`/admin/api/ai-review/proposals/${id}/revisions/manual`, {
    method: 'POST', body: JSON.stringify({ draft }),
  }),
  aiReviewLlmRevision: (id: number, comment: string, model?: string) => apiFetch(`/admin/api/ai-review/proposals/${id}/revisions/llm`, {
    method: 'POST', body: JSON.stringify({ comment, model }),
  }),
  aiReviewAccept: (id: number, draft: object, revision_id?: number) => apiFetch(`/admin/api/ai-review/proposals/${id}/accept`, {
    method: 'POST', body: JSON.stringify({ draft, revision_id }),
  }),
  aiReviewReject: (id: number, reason?: string) => apiFetch(`/admin/api/ai-review/proposals/${id}/reject`, {
    method: 'POST', body: JSON.stringify({ reason }),
  }),
  aiReviewDefer: (id: number, reason?: string) => apiFetch(`/admin/api/ai-review/proposals/${id}/defer`, {
    method: 'POST', body: JSON.stringify({ reason }),
  }),
  aiReviewRestore: (id: number, reason?: string) => apiFetch(`/admin/api/ai-review/proposals/${id}/restore`, {
    method: 'POST', body: JSON.stringify({ reason }),
  }),
  // Multi-reviewer rounds. Finalize is available only for escalated rounds and
  // always carries a mandatory override reason (revalidated server-side).
  reviewRounds: (params: { status?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') qs.set(key, String(value));
    return apiFetch(`/admin/api/ai-review/rounds?${qs.toString()}`);
  },
  reviewRound: (id: number) => apiFetch(`/admin/api/ai-review/rounds/${id}`),
  reviewRoundFinalize: (id: number, action: 'accepted' | 'rejected', reason: string) =>
    apiFetch(`/admin/api/ai-review/rounds/${id}/finalize`, { method: 'POST', body: JSON.stringify({ action, reason }) }),
  reviewRoundOpen: (target_type: string, target_id: number) =>
    apiFetch('/admin/api/ai-review/rounds', { method: 'POST', body: JSON.stringify({ target_type, target_id }) }),
  aiReviewConcepts: (params: { status?: string; q?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') qs.set(key, String(value));
    return apiFetch(`/admin/api/ai-review/concepts?${qs.toString()}`);
  },
  aiReviewConcept: (id: number) => apiFetch(`/admin/api/ai-review/concepts/${id}`),
  aiReviewConceptManualRevision: (id: number, proposed_markdown: string) => apiFetch(`/admin/api/ai-review/concepts/${id}/revisions/manual`, { method: 'POST', body: JSON.stringify({ proposed_markdown }) }),
  aiReviewConceptLlmRevision: (id: number, comment: string) => apiFetch(`/admin/api/ai-review/concepts/${id}/revisions/llm`, { method: 'POST', body: JSON.stringify({ comment }) }),
  aiReviewConceptAccept: (id: number, proposed_markdown: string, revision_id?: number, allow_overwrite_existing = false) => apiFetch(`/admin/api/ai-review/concepts/${id}/accept`, { method: 'POST', body: JSON.stringify({ proposed_markdown, revision_id, allow_overwrite_existing }) }),
  aiReviewConceptReject: (id: number, reason?: string) => apiFetch(`/admin/api/ai-review/concepts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  sourceIngestOverview: () => apiFetch('/admin/api/source-ingest/overview'),
  sourceIngestCatalogTree: () => apiFetch('/admin/api/source-ingest/catalog/tree'),
  sourceIngestSchemaView: () => apiFetch('/admin/api/source-ingest/schema-view'),
  sourceIngestSchemaExplainType: (type: string) => apiFetch(`/admin/api/source-ingest/schema-view/type/${encodeURIComponent(type)}`),
  sourceIngestSchemaTypeCard: (type: string) => apiFetch(`/admin/api/source-ingest/schema-view/type-card/${encodeURIComponent(type)}`),
  sourceIngestSchemaProposalCreate: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/schema-view/proposal', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestArticleTemplate: (type: string) => apiFetch(`/admin/api/source-ingest/article-template/${encodeURIComponent(type)}`),
  sourceIngestSaveCatalogConnector: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/connector', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestDeleteCatalogConnector: (connector_id: string, confirm_token?: string, force?: boolean) => apiFetch('/admin/api/source-ingest/catalog/connector/delete', { method: 'POST', body: JSON.stringify({ connector_id, confirm_token, force }) }),
  sourceIngestCatalogDeleteImpact: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/delete-impact', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestConnectorListObjects: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/connector/list-objects', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestCatalogConnectorTest: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/connector/test', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestSaveBaseView: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/base-view', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestDeleteBaseView: (base_view_id: string, confirm_token?: string, force?: boolean) => apiFetch('/admin/api/source-ingest/catalog/base-view/delete', { method: 'POST', body: JSON.stringify({ base_view_id, confirm_token, force }) }),
  sourceIngestDiscoverBaseView: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/base-view/discover', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestExecuteBaseView: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/base-view/execute', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestSaveTransformView: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/transform-view', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestDeleteTransformView: (transform_view_id: string, confirm_token?: string, force?: boolean) => apiFetch('/admin/api/source-ingest/catalog/transform-view/delete', { method: 'POST', body: JSON.stringify({ transform_view_id, confirm_token, force }) }),
  sourceIngestExecuteTransformView: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/transform-view/execute', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestSaveArticleView: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/article-view', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestDeleteArticleView: (article_view_id: string) => apiFetch('/admin/api/source-ingest/catalog/article-view/delete', { method: 'POST', body: JSON.stringify({ article_view_id }) }),
  sourceIngestArticleViewDryRun: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/article-view/dry-run', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestApproveArticleView: (article_view_id: string, current_chain_hash?: string) => apiFetch('/admin/api/source-ingest/catalog/article-view/approve', { method: 'POST', body: JSON.stringify({ article_view_id, current_chain_hash }) }),
  sourceIngestRunArticleView: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/catalog/article-view/run', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestArticleViewRuns: (article_view_id: string, limit = 20) => apiFetch(`/admin/api/source-ingest/catalog/article-view/${encodeURIComponent(article_view_id)}/runs?limit=${limit}`),
  sourceIngestRefreshReport: (profile_id?: string) => apiFetch('/admin/api/source-ingest/refresh-report', { method: 'POST', body: JSON.stringify({ profile_id }) }),
  sourceIngestSaveConfig: (config: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/save-config', { method: 'POST', body: JSON.stringify({ config }) }),
  sourceIngestSaveSecret: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/save-secret', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestDeleteSecret: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/delete-secret', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestSecretAudit: (config_id?: string) => apiFetch(`/admin/api/source-ingest/secret-audit${config_id ? `?config_id=${encodeURIComponent(config_id)}` : ''}`),
  sourceIngestTestConnection: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/test-connection', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestDiscover: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/discover', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestDraft: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/draft', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestDryRun: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/dry-run', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestTransformPreview: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/transform-preview', { method: 'POST', body: JSON.stringify(payload) }),
  sourceIngestApproveProfile: (payload: Record<string, unknown>) => apiFetch('/admin/api/source-ingest/approve-profile', { method: 'POST', body: JSON.stringify(payload) }),
};
