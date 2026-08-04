import { describe, expect, test } from 'bun:test';
import {
  resolvePortalAdminAuthMode,
  resolvePortalAdminDecision,
} from '../src/core/portal-admin-rbac';

const keycloakSignals = {
  authMethod: 'keycloak' as const,
  authorizationVersion: 1,
  keycloakRole: true,
  emailAllowlisted: false,
};

describe('Portal Admin staged RBAC resolver', () => {
  test('defaults to email mode and rejects unknown config values', () => {
    expect(resolvePortalAdminAuthMode(undefined)).toBe('email');
    expect(resolvePortalAdminAuthMode(' email ')).toBe('email');
    expect(resolvePortalAdminAuthMode('either')).toBe('either');
    expect(resolvePortalAdminAuthMode('keycloak')).toBe('keycloak');
    expect(() => resolvePortalAdminAuthMode('realm-role')).toThrow('invalid_admin_auth_mode');
    expect(() => resolvePortalAdminAuthMode('')).toThrow('invalid_admin_auth_mode');
  });

  test('email mode keeps the allowlist authoritative and exposes shadow mismatch', () => {
    expect(resolvePortalAdminDecision('email', keycloakSignals)).toEqual({
      authorized: false,
      emailAdmin: false,
      keycloakAdmin: true,
      mismatch: true,
    });
    expect(resolvePortalAdminDecision('email', {
      ...keycloakSignals, emailAllowlisted: true, keycloakRole: false,
    }).authorized).toBeTrue();
  });

  test('either mode accepts allowlist or exact projected role', () => {
    expect(resolvePortalAdminDecision('either', keycloakSignals).authorized).toBeTrue();
    expect(resolvePortalAdminDecision('either', {
      ...keycloakSignals, keycloakRole: false, emailAllowlisted: true,
    }).authorized).toBeTrue();
    expect(resolvePortalAdminDecision('either', {
      ...keycloakSignals, keycloakRole: false, emailAllowlisted: false,
    }).authorized).toBeFalse();
  });

  test('never converts a fallback Portal session into an Admin bridge', () => {
    for (const mode of ['email', 'either', 'keycloak'] as const) {
      expect(resolvePortalAdminDecision(mode, {
        authMethod: 'fallback',
        authorizationVersion: 1,
        keycloakRole: false,
        emailAllowlisted: true,
      }).authorized).toBeFalse();
    }
  });

  test('server resolves every Keycloak bridge request through the staged policy', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    expect(source).toContain('process.env.GBRAIN_ADMIN_AUTH_MODE');
    expect(source).toContain('resolvePortalAdminDecision(adminAuthMode');
    expect(source).toContain('isAdmin: resolveAdminFromPortalInspection(inspectPortalSession(req)).authorized');
    expect(source).toContain('portalSessions.inspect(session.backingPortalToken)');
    expect(source).toContain('authorizationVersion');
    expect(source).toContain('keycloakRole');
    expect(source).not.toContain('isAdminEmail(backingInspection.email)');
    expect(source).not.toContain('if (isAdminEmail(portalEmail))');
  });

  test('keycloak mode ignores email and fails closed for stale, fallback or legacy projections', () => {
    expect(resolvePortalAdminDecision('keycloak', keycloakSignals).authorized).toBeTrue();
    for (const signals of [
      { ...keycloakSignals, keycloakRole: false, emailAllowlisted: true },
      { ...keycloakSignals, authorizationVersion: 0, emailAllowlisted: true },
      { ...keycloakSignals, authMethod: 'fallback' as const, emailAllowlisted: true },
    ]) {
      expect(resolvePortalAdminDecision('keycloak', signals).authorized).toBeFalse();
    }
  });
});
