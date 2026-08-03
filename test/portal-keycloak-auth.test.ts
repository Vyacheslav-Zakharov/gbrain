import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { exportJWK, SignJWT } from 'jose';
import {
  KeycloakOidcClient,
  PortalOidcTransactions,
  parseAdminFallbackDeadline,
  validatePortalIdentityClaims,
} from '../src/core/portal-keycloak-auth';

const ISSUER = 'https://auth.avb.kz/realms/avers';
const CLIENT_ID = 'gbrain-portal';

function baseClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'user-123',
    email: 'alice-example@avers.kz',
    email_verified: true,
    nonce: 'nonce-123',
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

describe('Portal Keycloak identity policy', () => {
  test('accepts only verified @avers.kz identities with issuer, audience, nonce and sub', () => {
    expect(validatePortalIdentityClaims(baseClaims(), {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonce: 'nonce-123',
    })).toEqual({ sub: 'user-123', email: 'alice-example@avers.kz' });

    for (const overrides of [
      { iss: 'https://evil.example/realms/avers' },
      { aud: 'other-client' },
      { azp: 'other-client' },
      { aud: [CLIENT_ID, 'other-client'], azp: undefined },
      { sub: '' },
      { email: 'alice-example@gmail.com' },
      { email_verified: false },
      { nonce: 'wrong' },
    ]) {
      expect(() => validatePortalIdentityClaims(baseClaims(overrides), {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        nonce: 'nonce-123',
      })).toThrow();
    }
  });

  test('binds state, nonce and PKCE S256 in single-use in-memory transactions', () => {
    const transactions = new PortalOidcTransactions(60_000);
    const tx = transactions.create({ returnTo: '/portal', prompt: 'none', browserBinding: 'browser-secret-a', now: 100 });
    expect(tx.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tx.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tx.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tx.codeChallenge).toBe(createHash('sha256').update(tx.codeVerifier).digest('base64url'));
    expect(transactions.consume(tx.state, 'browser-secret-a', 101)?.prompt).toBe('none');
    expect(transactions.consume(tx.state, 'browser-secret-a', 102)).toBeNull();
  });

  test('rejects login CSRF when callback browser binding differs', () => {
    const transactions = new PortalOidcTransactions(60_000);
    const tx = transactions.create({ returnTo: '/portal', prompt: 'normal', browserBinding: 'browser-secret-a', now: 100 });
    expect(JSON.stringify(tx)).not.toContain('browser-secret-a');
    expect(transactions.consume(tx.state, 'browser-secret-b', 101)).toBeNull();
    expect(transactions.consume(tx.state, 'browser-secret-a', 102)).toBeNull();
  });

  test('confines return_to to a local path and rejects encoded control bytes', () => {
    const transactions = new PortalOidcTransactions(60_000);
    expect(transactions.create({ returnTo: '/portal?tab=review', prompt: 'normal', browserBinding: 'browser-secret-long' }).returnTo).toBe('/portal?tab=review');
    for (const unsafe of [
      'https://evil.example/', '//evil.example/', '/\\evil',
      '/%0d%0aLocation:%20https://evil.example/', '/%25252f%25252fevil.example',
    ]) {
      expect(transactions.create({ returnTo: unsafe, prompt: 'normal', browserBinding: 'browser-secret-long' }).returnTo).toBe('/portal');
    }
  });

  test('verifies a signed id_token with jose and never accepts a bad nonce', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    const idToken = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    let jwksFetches = 0;
    const fetchFn = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
        });
      }
      if (url.endsWith('/protocol/openid-connect/certs')) {
        jwksFetches += 1;
        return Response.json({ keys: [jwk] });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = new KeycloakOidcClient({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: 'test-secret',
      redirectUri: 'https://gbrain.example/auth/keycloak/callback',
      fetchFn,
    });
    await expect(client.verifyIdToken(idToken, 'nonce-123')).resolves.toEqual({
      sub: 'user-123', email: 'alice-example@avers.kz',
    });
    await expect(client.verifyIdToken(idToken, 'wrong')).rejects.toThrow();

    const { exp: _exp, ...claimsWithoutExp } = baseClaims();
    const tokenWithoutExp = await new SignJWT(claimsWithoutExp)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .sign(privateKey);
    await expect(client.verifyIdToken(tokenWithoutExp, 'nonce-123')).rejects.toThrow();
    expect(jwksFetches).toBe(1);
  });

  test('retries transient discovery failures and rejects an unsafe logout endpoint', async () => {
    let discoveryCalls = 0;
    const fetchFn = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (!url.endsWith('/.well-known/openid-configuration')) throw new Error(`unexpected URL ${url}`);
      discoveryCalls += 1;
      if (discoveryCalls === 1) return new Response('temporary', { status: 503 });
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        end_session_endpoint: 'https://evil.example/logout',
      });
    }) as typeof fetch;
    const client = new KeycloakOidcClient({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: 'test-secret',
      redirectUri: 'https://gbrain.example/auth/keycloak/callback',
      fetchFn,
    });
    const tx = new PortalOidcTransactions().create({
      returnTo: '/portal', prompt: 'normal', browserBinding: 'browser-secret-long',
    });
    await expect(client.authorizationUrl(tx)).rejects.toThrow('oidc_unsafe_endpoint');
    expect(discoveryCalls).toBe(2);
  });

  test('applies the network timeout through response body parsing', async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: () => new Promise<never>(() => {}),
    }) as unknown as Response) as unknown as typeof fetch;
    const client = new KeycloakOidcClient({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: 'test-secret',
      redirectUri: 'https://gbrain.example/auth/keycloak/callback',
      fetchFn,
      requestTimeoutMs: 5,
    });
    const tx = new PortalOidcTransactions().create({
      returnTo: '/portal', prompt: 'normal', browserBinding: 'browser-secret-long',
    });
    await expect(client.authorizationUrl(tx)).rejects.toThrow('oidc_request_timeout');
  });
});

describe('admin fallback deadline', () => {
  test('is one fail-closed absolute deadline for bootstrap and magic-link sessions', () => {
    const now = Date.parse('2026-08-03T10:00:00Z');
    expect(parseAdminFallbackDeadline('2026-08-03T11:00:00Z', now)).toBe(Date.parse('2026-08-03T11:00:00Z'));
    expect(parseAdminFallbackDeadline(undefined, now)).toBeNull();
    expect(parseAdminFallbackDeadline('not-a-date', now)).toBeNull();
    expect(parseAdminFallbackDeadline('2026-08-03T09:00:00Z', now)).toBeNull();
  });

  test('gates both fallback entry points, clamps expiry, and records authMethod', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    expect(source).toContain('process.env.GBRAIN_ADMIN_FALLBACK_UNTIL');
    expect(source).toContain("res.status(410).json({ error: 'admin_fallback_expired' })");
    expect(source).toContain("Math.min(Date.now() + 24 * 60 * 60 * 1000, fallbackUntil)");
    expect(source).toContain("authMethod: 'bootstrap_fallback'");
    expect(source).toContain("authMethod: 'magic_link_fallback'");
    expect(source).toContain("authMethod: 'keycloak_bridge'");
    expect(source).toContain("session.authMethod !== 'keycloak_bridge'");
    expect(source).toContain('adminFallbackDeadline()');
    expect(source).toContain('backingPortalToken');
    expect(source).toContain('portalSessions.inspect(session.backingPortalToken)');
  });

  test('admin UI offers corporate SSO and explains expired fallback', async () => {
    const loginSource = await Bun.file(new URL('../admin/src/pages/Login.tsx', import.meta.url)).text();
    expect(loginSource).toContain('href="/login?return_to=/admin/"');
    expect(loginSource).toContain('Войти через корпоративный SSO');
    expect(loginSource).toContain('admin_fallback_expired');
  });
});
