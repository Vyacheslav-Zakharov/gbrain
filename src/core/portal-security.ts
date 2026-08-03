import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export type PortalSessionState = 'valid' | 'revalidation_required' | 'expired' | 'revoked';
export type PortalAuthMethod = 'keycloak' | 'fallback';

export interface PortalSessionIdentity {
  email: string;
  sub: string;
  authMethod: PortalAuthMethod;
}

export interface PortalSessionRecord extends PortalSessionIdentity {
  createdAt: number;
  expiresAt: number;
  lastValidatedAt: number;
  revokedAt?: number;
}

export interface PortalSessionInspection {
  state: PortalSessionState;
  email?: string;
  sub?: string;
  authMethod?: PortalAuthMethod;
  createdAt?: number;
  expiresAt?: number;
  lastValidatedAt?: number;
}

type SessionFile = Record<string, PortalSessionRecord>;

const TOKEN_RE = /^[a-f0-9]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ENCODED_BYTE_RE = /%[0-9a-f]{2}/i;
const PORTAL_FILE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.doc', '.docx', '.odt', '.xls', '.xlsx', '.csv', '.ppt', '.pptx',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.msg', '.eml',
]);

export function hashPortalSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class PortalSessionStore {
  private sessions: SessionFile;

  constructor(
    private readonly filePath: string,
    private readonly ttlMs = 8 * 60 * 60 * 1000,
    private readonly revalidationMs = 5 * 60 * 1000,
  ) {
    this.sessions = this.load();
    this.prune(Date.now(), false);
  }

  issue(identityRaw: string | PortalSessionIdentity, now = Date.now()): string {
    // String form remains for local tests/backward compatibility only. Production
    // Keycloak callers always supply the stable subject and auth method.
    const identity: PortalSessionIdentity = typeof identityRaw === 'string'
      ? { email: identityRaw, sub: `legacy:${identityRaw.trim().toLowerCase()}`, authMethod: 'fallback' }
      : identityRaw;
    const email = identity.email.trim().toLowerCase();
    const sub = identity.sub.trim();
    if (!/^[^@\s]+@avers\.kz$/.test(email) || !sub) throw new Error('invalid_portal_session_identity');
    if (identity.authMethod !== 'keycloak' && identity.authMethod !== 'fallback') throw new Error('invalid_portal_auth_method');
    const token = randomBytes(32).toString('hex');
    this.sessions[hashPortalSessionToken(token)] = {
      email,
      sub,
      authMethod: identity.authMethod,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastValidatedAt: now,
    };
    this.persist();
    return token;
  }

  inspect(tokenRaw: unknown, now = Date.now()): PortalSessionInspection {
    const token = typeof tokenRaw === 'string' ? tokenRaw : '';
    if (!TOKEN_RE.test(token)) return { state: 'revoked' };
    const record = this.sessions[hashPortalSessionToken(token)];
    if (!record || record.revokedAt) return { state: 'revoked' };
    const result = {
      email: record.email,
      sub: record.sub,
      authMethod: record.authMethod,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastValidatedAt: record.lastValidatedAt,
    };
    if (record.expiresAt <= now) return { state: 'expired', ...result };
    if (record.lastValidatedAt + this.revalidationMs <= now) return { state: 'revalidation_required', ...result };
    return { state: 'valid', ...result };
  }

  resolve(tokenRaw: unknown, now = Date.now()): string | null {
    const inspected = this.inspect(tokenRaw, now);
    return inspected.state === 'valid' ? inspected.email || null : null;
  }

  revalidate(tokenRaw: unknown, identityRaw: Pick<PortalSessionIdentity, 'email' | 'sub'>, now = Date.now()): boolean {
    const token = typeof tokenRaw === 'string' ? tokenRaw : '';
    if (!TOKEN_RE.test(token)) return false;
    const record = this.sessions[hashPortalSessionToken(token)];
    if (!record || record.authMethod !== 'keycloak' || record.revokedAt || record.expiresAt <= now) return false;
    const email = identityRaw.email.trim().toLowerCase();
    if (record.email !== email || record.sub !== identityRaw.sub.trim()) return false;
    record.lastValidatedAt = now;
    this.persist();
    return true;
  }

  revoke(tokenRaw: unknown, now = Date.now()): boolean {
    const token = typeof tokenRaw === 'string' ? tokenRaw : '';
    if (!TOKEN_RE.test(token)) return false;
    const key = hashPortalSessionToken(token);
    const record = this.sessions[key];
    if (!record || record.revokedAt) return false;
    record.revokedAt = now;
    this.persist();
    return true;
  }

  prune(now = Date.now(), persist = true): number {
    let removed = 0;
    for (const [key, record] of Object.entries(this.sessions)) {
      if (!record || typeof record.email !== 'string' || typeof record.sub !== 'string'
        || !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt)
        || !Number.isFinite(record.lastValidatedAt)
        || record.expiresAt <= now || !!record.revokedAt
        || (record.authMethod !== 'keycloak' && record.authMethod !== 'fallback')) {
        delete this.sessions[key];
        removed += 1;
      }
    }
    if (removed && persist) this.persist();
    return removed;
  }

  private load(): SessionFile {
    try {
      if (!existsSync(this.filePath)) return {};
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SessionFile : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.sessions, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.filePath);
    } finally {
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

export function portalSessionCookieName(secure: boolean): string {
  return secure ? '__Host-gbrain_portal' : 'gbrain_portal';
}

export function isSafePortalRelativePath(raw: unknown, allowRoot = false): boolean {
  if (typeof raw !== 'string' && raw != null) return false;
  const value = String(raw ?? '');
  if (!value) return allowRoot;
  if (CONTROL_RE.test(value) || value.includes('\\') || isAbsolute(value) || ENCODED_BYTE_RE.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) return false;
  return true;
}

export function isPortalFileAllowed(relativeRaw: unknown): boolean {
  const value = String(relativeRaw ?? '').toLowerCase();
  if (!isSafePortalRelativePath(value)) return false;
  const name = value.split('/').pop() || '';
  if (name === '.env' || name.startsWith('.env.') || /(?:^|[-_.])(secret|credential|private[-_]?key)(?:[-_.]|$)/i.test(name)) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && PORTAL_FILE_EXTENSIONS.has(name.slice(dot));
}

/** Resolve a user locator to an existing non-symlink path confined to root. */
export function resolvePortalPathSecure(rootRaw: string, relativeRaw: unknown, allowRoot = false): string | null {
  const relative = String(relativeRaw ?? '');
  if (!isSafePortalRelativePath(relative, allowRoot)) return null;
  try {
    const root = realpathSync(rootRaw);
    const target = relative ? resolve(root, relative) : root;
    if (target !== root && !target.startsWith(root + sep)) return null;

    let cursor = root;
    for (const segment of relative.split('/').filter(Boolean)) {
      cursor = join(cursor, segment);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) return null;
    }

    const realTarget = realpathSync(target);
    if (realTarget !== root && !realTarget.startsWith(root + sep)) return null;
    return realTarget;
  } catch {
    return null;
  }
}
