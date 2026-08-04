export type PortalAdminAuthInspection = {
  state: string;
  authMethod?: string;
};

export type PortalAdminAuthFailurePayload = {
  error: 'portal_revalidation_required' | 'Admin authentication required';
};

/**
 * Classify an unauthenticated Admin request without granting authority.
 * Only a Keycloak-backed Portal session at its freshness boundary whose last
 * server-stored signed projection was authorized may trigger the SPA's silent
 * SSO recovery path. Revoked, expired, fallback, no-role, and ordinary
 * unauthorized sessions stay on the normal login path.
 */
export function portalAdminAuthFailurePayload(
  inspection: PortalAdminAuthInspection,
  previouslyAuthorized: boolean,
): PortalAdminAuthFailurePayload {
  if (
    inspection.state === 'revalidation_required'
    && inspection.authMethod === 'keycloak'
    && previouslyAuthorized
  ) {
    return { error: 'portal_revalidation_required' };
  }
  return { error: 'Admin authentication required' };
}
