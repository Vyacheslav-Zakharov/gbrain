export const PORTAL_ADMIN_CLIENT_ROLE = 'gbrain-admin' as const;
export const PORTAL_ADMIN_AUTHORIZATION_VERSION = 1 as const;

export type PortalAdminAuthMode = 'email' | 'either' | 'keycloak';

export interface PortalAdminSignals {
  authMethod?: 'keycloak' | 'fallback';
  authorizationVersion?: number;
  keycloakRole?: boolean;
  emailAllowlisted: boolean;
}

export interface PortalAdminDecision {
  authorized: boolean;
  emailAdmin: boolean;
  keycloakAdmin: boolean;
  mismatch: boolean;
}

export function resolvePortalAdminAuthMode(raw: string | undefined): PortalAdminAuthMode {
  if (raw === undefined) return 'email';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'email' || normalized === 'either' || normalized === 'keycloak') return normalized;
  throw new Error('invalid_admin_auth_mode');
}

export function resolvePortalAdminDecision(
  mode: PortalAdminAuthMode,
  signals: PortalAdminSignals,
): PortalAdminDecision {
  const keycloakBacked = signals.authMethod === 'keycloak';
  const emailAdmin = signals.emailAllowlisted === true;
  const keycloakAdmin = keycloakBacked
    && signals.authorizationVersion === PORTAL_ADMIN_AUTHORIZATION_VERSION
    && signals.keycloakRole === true;
  const selectedAuthority = mode === 'email'
    ? emailAdmin
    : mode === 'either'
      ? emailAdmin || keycloakAdmin
      : keycloakAdmin;
  const authorized = keycloakBacked && selectedAuthority;
  return {
    authorized,
    emailAdmin,
    keycloakAdmin,
    mismatch: emailAdmin !== keycloakAdmin,
  };
}
