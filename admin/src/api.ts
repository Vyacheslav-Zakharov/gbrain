const BASE = '';

// v0.26.3 trust model (D11 + D12): the admin UI does NOT cache the
// bootstrap token in browser JS state. On 401, redirect to login —
// no auto-reauth via saved token, no localStorage/sessionStorage read.
// The HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (res.status === 401) {
    // No token cache to retry from. Redirect to login.
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// v0.36.1.0 (T15 / E6) — SVG fetch (text/plain payload, NOT JSON).
async function apiFetchText(path: string) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const api = {
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
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
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  // v0.41 D2 — live minion-jobs dashboard snapshot.
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
  sourceIngestOverview: () => apiFetch('/admin/api/source-ingest/overview'),
  sourceIngestCatalogTree: () => apiFetch('/admin/api/source-ingest/catalog/tree'),
  sourceIngestSchemaView: () => apiFetch('/admin/api/source-ingest/schema-view'),
  sourceIngestSchemaExplainType: (type: string) => apiFetch(`/admin/api/source-ingest/schema-view/type/${encodeURIComponent(type)}`),
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
