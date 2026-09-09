import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JWTPayload, type JSONWebKeySet } from 'jose';
import { PORTAL_ADMIN_CLIENT_ROLE } from './portal-admin-rbac.ts';

export const DEFAULT_KEYCLOAK_ISSUER = 'https://auth.avb.kz/realms/avers';
export const DEFAULT_KEYCLOAK_CLIENT_ID = 'gbrain-portal';
export const DEFAULT_KEYCLOAK_CALLBACK_PATH = '/auth/keycloak/callback';

export interface PortalOidcIdentity {
  sub: string;
  email: string;
  isAdmin: boolean;
}

export interface PortalOidcPolicy {
  issuer: string;
  clientId: string;
  nonce: string;
}

export interface PortalOidcTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  returnTo: string;
  prompt: 'none' | 'normal';
  createdAt: number;
  existingSessionToken?: string;
}

type CreateTransactionInput = Pick<PortalOidcTransaction, 'returnTo' | 'prompt'> & {
  browserBinding: string;
  now?: number;
  existingSessionToken?: string;
};

interface PortalOidcTransactionRecord extends PortalOidcTransaction {
  browserBindingHash: string;
}

function randomBase64Url(): string {
  return randomBytes(32).toString('base64url');
}

export function normalizePortalReturnTo(value: string): string {
  let decoded = value;
  for (let depth = 0; depth <= 3; depth += 1) {
    if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) {
      return '/portal';
    }
    if (depth === 3) return value;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return value;
      decoded = next;
    } catch {
      return '/portal';
    }
  }
  return '/portal';
}

export class PortalOidcTransactions {
  private readonly transactions = new Map<string, PortalOidcTransactionRecord>();

  constructor(private readonly ttlMs = 10 * 60 * 1_000, private readonly maxEntries = 1_000) {}

  create(input: CreateTransactionInput): PortalOidcTransaction {
    const now = input.now ?? Date.now();
    if (input.browserBinding.length < 16) throw new Error('oidc_invalid_browser_binding');
    this.prune(now);
    const codeVerifier = randomBase64Url();
    const transaction: PortalOidcTransaction = {
      state: randomBase64Url(),
      nonce: randomBase64Url(),
      codeVerifier,
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      returnTo: normalizePortalReturnTo(input.returnTo),
      prompt: input.prompt,
      createdAt: now,
      existingSessionToken: input.existingSessionToken,
    };
    this.transactions.set(transaction.state, {
      ...transaction,
      browserBindingHash: createHash('sha256').update(input.browserBinding).digest('hex'),
    });
    while (this.transactions.size > this.maxEntries) {
      const oldest = this.transactions.keys().next().value;
      if (!oldest) break;
      this.transactions.delete(oldest);
    }
    return transaction;
  }

  consume(state: unknown, browserBinding: unknown, now = Date.now()): PortalOidcTransaction | null {
    if (typeof state !== 'string' || !state) return null;
    const transaction = this.transactions.get(state);
    this.transactions.delete(state);
    if (!transaction || transaction.createdAt + this.ttlMs <= now) return null;
    if (typeof browserBinding !== 'string' || !browserBinding) return null;
    const actual = Buffer.from(createHash('sha256').update(browserBinding).digest('hex'), 'hex');
    const expected = Buffer.from(transaction.browserBindingHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const { browserBindingHash: _browserBindingHash, ...publicTransaction } = transaction;
    return publicTransaction;
  }

  private prune(now: number): void {
    for (const [state, transaction] of this.transactions) {
      if (transaction.createdAt + this.ttlMs <= now) this.transactions.delete(state);
    }
  }
}

export function validatePortalIdentityClaims(payload: JWTPayload, policy: PortalOidcPolicy): PortalOidcIdentity {
  if (payload.iss !== policy.issuer) throw new Error('oidc_invalid_issuer');
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(policy.clientId)) throw new Error('oidc_invalid_audience');
  if (payload.azp !== undefined && payload.azp !== policy.clientId) throw new Error('oidc_invalid_authorized_party');
  if (audience.length > 1 && payload.azp !== policy.clientId) throw new Error('oidc_invalid_authorized_party');
  if (payload.nonce !== policy.nonce) throw new Error('oidc_invalid_nonce');
  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!sub) throw new Error('oidc_missing_sub');
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (!Number.isFinite(payload.iat) || Number(payload.iat) > nowSeconds + 60) throw new Error('oidc_invalid_iat');
  if (!Number.isFinite(payload.exp)) throw new Error('oidc_missing_exp');
  if (payload.email_verified !== true) throw new Error('oidc_email_not_verified');
  if (!/^[^@\s]+@avers\.kz$/.test(email)) throw new Error('oidc_email_not_allowed');
  const resourceAccess = payload.resource_access;
  const clientAccess = policy.clientId === DEFAULT_KEYCLOAK_CLIENT_ID
    && resourceAccess && typeof resourceAccess === 'object' && !Array.isArray(resourceAccess)
    ? (resourceAccess as Record<string, unknown>)[DEFAULT_KEYCLOAK_CLIENT_ID]
    : undefined;
  const rolesRaw = clientAccess && typeof clientAccess === 'object' && !Array.isArray(clientAccess)
    ? (clientAccess as Record<string, unknown>).roles
    : undefined;
  const roles = Array.isArray(rolesRaw) && rolesRaw.every((role) => typeof role === 'string')
    ? rolesRaw as string[]
    : [];
  return { sub, email, isAdmin: roles.includes(PORTAL_ADMIN_CLIENT_ROLE) };
}

export function parseAdminFallbackDeadline(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface KeycloakOidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

export class KeycloakOidcClient {
  private discoveryPromise?: Promise<OidcDiscovery>;
  private jwksCache?: { value: JSONWebKeySet; expiresAt: number };
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: KeycloakOidcClientOptions) {
    if (options.issuer !== DEFAULT_KEYCLOAK_ISSUER) throw new Error('invalid_keycloak_issuer');
    if (!options.clientId || !options.clientSecret || !options.redirectUri) throw new Error('incomplete_keycloak_config');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async requestJson<T>(
    input: URL | RequestInfo,
    init: RequestInit = {},
    retryGet = false,
  ): Promise<{ ok: boolean; status: number; body?: T }> {
    const attempts = retryGet ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = (async () => {
        const response = await this.fetchFn(input, { ...init, signal: controller.signal });
        const body = response.ok ? await response.json() as T : undefined;
        return { ok: response.ok, status: response.status, body };
      })();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('oidc_request_timeout'));
        }, this.options.requestTimeoutMs ?? 10_000);
      });
      try {
        const result = await Promise.race([operation, timeout]);
        if (retryGet && result.status >= 500 && attempt + 1 < attempts) continue;
        return result;
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= attempts) throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('oidc_request_failed');
  }

  private async discovery(): Promise<OidcDiscovery> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = (async () => {
        const response = await this.requestJson<Partial<OidcDiscovery>>(
          `${this.options.issuer}/.well-known/openid-configuration`,
          { headers: { Accept: 'application/json' } },
          true,
        );
        if (!response.ok) throw new Error(`oidc_discovery_failed:${response.status}`);
        const body = response.body || {};
        if (body.issuer !== this.options.issuer || !body.authorization_endpoint || !body.token_endpoint || !body.jwks_uri) {
          throw new Error('oidc_invalid_discovery');
        }
        const endpoints = [body.authorization_endpoint, body.token_endpoint, body.jwks_uri];
        if (body.end_session_endpoint) endpoints.push(body.end_session_endpoint);
        for (const endpoint of endpoints) {
          const parsed = new URL(endpoint);
          if (parsed.protocol !== 'https:' || parsed.origin !== new URL(this.options.issuer).origin) throw new Error('oidc_unsafe_endpoint');
        }
        return body as OidcDiscovery;
      })();
    }
    try {
      return await this.discoveryPromise;
    } catch (error) {
      this.discoveryPromise = undefined;
      throw error;
    }
  }

  private async jwks(forceRefresh = false): Promise<JSONWebKeySet> {
    const now = Date.now();
    if (!forceRefresh && this.jwksCache && this.jwksCache.expiresAt > now) return this.jwksCache.value;
    const discovery = await this.discovery();
    const response = await this.requestJson<JSONWebKeySet>(
      discovery.jwks_uri,
      { headers: { Accept: 'application/json' } },
      true,
    );
    if (!response.ok) throw new Error(`oidc_jwks_failed:${response.status}`);
    const value = response.body;
    if (!value || !Array.isArray(value.keys)) throw new Error('oidc_invalid_jwks');
    this.jwksCache = { value, expiresAt: now + 5 * 60 * 1_000 };
    return value;
  }

  async authorizationUrl(transaction: PortalOidcTransaction): Promise<string> {
    const discovery = await this.discovery();
    const url = new URL(discovery.authorization_endpoint);
    const params: Record<string, string> = {
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: transaction.codeChallenge,
      code_challenge_method: 'S256',
    };
    if (transaction.prompt === 'none') params.prompt = 'none';
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<{ idToken: string }> {
    if (!code || !codeVerifier) throw new Error('oidc_missing_code');
    const discovery = await this.discovery();
    const response = await this.requestJson<{ id_token?: unknown }>(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        redirect_uri: this.options.redirectUri,
        code,
        code_verifier: codeVerifier,
      }),
    });
    if (!response.ok) throw new Error(`oidc_token_exchange_failed:${response.status}`);
    const body = response.body || {};
    if (typeof body.id_token !== 'string' || !body.id_token) throw new Error('oidc_missing_id_token');
    // Deliberately return only the ID token in memory. Provider access/refresh
    // tokens are neither returned to the browser nor passed to session storage.
    return { idToken: body.id_token };
  }

  async verifyIdToken(idToken: string, nonce: string): Promise<PortalOidcIdentity> {
    const verify = async (forceRefresh: boolean): Promise<JWTPayload> => {
      const jwks = await this.jwks(forceRefresh);
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
        issuer: this.options.issuer,
        audience: this.options.clientId,
        algorithms: ['RS256', 'PS256', 'ES256'],
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
        clockTolerance: 5,
      });
      return payload;
    };

    let payload: JWTPayload;
    try {
      payload = await verify(false);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== 'ERR_JWKS_NO_MATCHING_KEY' && code !== 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') throw error;
      payload = await verify(true);
    }
    return validatePortalIdentityClaims(payload, {
      issuer: this.options.issuer,
      clientId: this.options.clientId,
      nonce,
    });
  }

  async logoutUrl(postLogoutRedirectUri: string): Promise<string | null> {
    const discovery = await this.discovery();
    if (!discovery.end_session_endpoint) return null;
    const url = new URL(discovery.end_session_endpoint);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    return url.toString();
  }
}
