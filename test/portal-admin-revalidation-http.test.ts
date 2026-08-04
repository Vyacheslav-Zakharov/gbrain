import { describe, expect, test } from 'bun:test';
import { portalAdminAuthFailurePayload } from '../src/core/portal-admin-http';
import { shouldStartPortalAdminRevalidation } from '../admin/src/api';

describe('Portal-backed Admin freshness recovery', () => {
  test('server distinguishes an authorized Keycloak freshness boundary from real unauthorized states', () => {
    expect(portalAdminAuthFailurePayload(
      { state: 'revalidation_required', authMethod: 'keycloak' },
      true,
    )).toEqual({ error: 'portal_revalidation_required' });

    for (const [inspection, previouslyAuthorized] of [
      [{ state: 'revalidation_required' as const, authMethod: 'keycloak' as const }, false],
      [{ state: 'revalidation_required' as const, authMethod: 'fallback' as const }, true],
      [{ state: 'expired' as const, authMethod: 'keycloak' as const }, true],
      [{ state: 'revoked' as const, authMethod: 'keycloak' as const }, true],
      [{ state: 'valid' as const, authMethod: 'keycloak' as const }, true],
    ] as const) {
      expect(portalAdminAuthFailurePayload(inspection, previouslyAuthorized)).toEqual({
        error: 'Admin authentication required',
      });
    }
  });

  test('Admin SPA starts silent SSO only for the freshness-specific error', () => {
    expect(shouldStartPortalAdminRevalidation({ error: 'portal_revalidation_required' })).toBeTrue();
    expect(shouldStartPortalAdminRevalidation({ error: 'Admin authentication required' })).toBeFalse();
    expect(shouldStartPortalAdminRevalidation({ error: 'unauthorized' })).toBeFalse();
    expect(shouldStartPortalAdminRevalidation(null)).toBeFalse();
    expect(shouldStartPortalAdminRevalidation('portal_revalidation_required')).toBeFalse();
  });

  test('server and SPA are wired to the reason-specific recovery path', async () => {
    const serverSource = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    const adminSource = await Bun.file(new URL('../admin/src/api.ts', import.meta.url)).text();

    expect(serverSource).toContain('wasPortalAdminAuthorized(portalInspection)');
    expect(serverSource).toContain('portalAdminAuthFailurePayload(');
    expect(adminSource).toContain("window.location.assign('/login?return_to=%2Fadmin%2F')");
    expect(adminSource).toContain('shouldStartPortalAdminRevalidation(body)');
  });
});
