import type { PortalUserPermissionsRecord } from './portal-access-control-json.ts';
import { normalizePortalPermissions } from './portal-access-control-json.ts';
import type { PortalAccessControlRepository, PortalAccessUser } from './portal-access-control.ts';

export type PortalAclMode = 'json' | 'compare' | 'db';

export interface PortalAuthorityPermissions {
  source_id: string;
  federated_read: string[];
  federated_write: string[];
}

export interface PortalAclMismatchEvent {
  kind: 'user_grants' | 'reviewer_map';
}

type JsonRecord = (PortalUserPermissionsRecord & { active?: boolean; disabled?: boolean }) | null | undefined;

export function parsePortalAclMode(value: string | undefined): PortalAclMode {
  const normalized = String(value ?? 'json').trim().toLowerCase();
  if (normalized === 'json' || normalized === 'compare' || normalized === 'db') return normalized;
  throw new Error('invalid_portal_acl_mode');
}

function fromDbUser(user: PortalAccessUser | null): PortalAuthorityPermissions | null {
  if (!user || user.status !== 'active') return null;
  const read = user.grants.filter(grant => grant.canRead).map(grant => grant.sourceId).sort();
  const write = user.grants.filter(grant => grant.canWrite).map(grant => grant.sourceId).sort();
  if (!read.includes(user.personalSourceId) || !write.includes(user.personalSourceId)) return null;
  if (write.some(sourceId => !read.includes(sourceId))) return null;
  return {
    source_id: user.personalSourceId,
    federated_read: read,
    federated_write: write,
  };
}

function fromJsonRecord(record: JsonRecord): PortalAuthorityPermissions | null {
  if (!record || record.active === false || record.disabled === true) return null;
  try {
    return normalizePortalPermissions(record);
  } catch {
    return null;
  }
}

function samePermissions(a: PortalAuthorityPermissions | null, b: PortalAuthorityPermissions | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function canonicalPermissionMap(value: Record<string, PortalAuthorityPermissions>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

export class PortalAccessControlAuthority {
  private readonly mode: PortalAclMode;
  private readonly repository: PortalAccessControlRepository;
  private readonly jsonReader: (email: string) => JsonRecord | Promise<JsonRecord>;
  private readonly jsonListReader?: () => Record<string, JsonRecord> | Promise<Record<string, JsonRecord>>;
  private readonly onMismatch: (event: PortalAclMismatchEvent) => void;

  constructor(options: {
    mode: PortalAclMode;
    repository: PortalAccessControlRepository;
    jsonReader: (email: string) => JsonRecord | Promise<JsonRecord>;
    jsonListReader?: () => Record<string, JsonRecord> | Promise<Record<string, JsonRecord>>;
    onMismatch?: (event: PortalAclMismatchEvent) => void;
  }) {
    this.mode = options.mode;
    this.repository = options.repository;
    this.jsonReader = options.jsonReader;
    this.jsonListReader = options.jsonListReader;
    this.onMismatch = options.onMismatch ?? (() => undefined);
  }

  async getUserPermissions(emailRaw: string): Promise<PortalAuthorityPermissions | null> {
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!email) return null;
    if (this.mode === 'db') return fromDbUser(await this.repository.getUser(email));

    const json = fromJsonRecord(await this.jsonReader(email));
    if (this.mode === 'compare') {
      let db: PortalAuthorityPermissions | null = null;
      try {
        db = fromDbUser(await this.repository.getUser(email));
      } catch {
        this.onMismatch({ kind: 'user_grants' });
        return json;
      }
      if (!samePermissions(json, db)) this.onMismatch({ kind: 'user_grants' });
    }
    return json;
  }

  async getWriteSourceIds(email: string): Promise<string[]> {
    const permissions = await this.getUserPermissions(email);
    return permissions?.federated_write ?? [];
  }

  async listReviewerPermissions(): Promise<Record<string, PortalAuthorityPermissions>> {
    if (this.mode === 'db') {
      const result: Record<string, PortalAuthorityPermissions> = {};
      for (const user of await this.repository.listUsers()) {
        const permissions = fromDbUser(user);
        if (permissions) result[user.email] = permissions;
      }
      return result;
    }

    const raw = this.jsonListReader ? await this.jsonListReader() : {};
    const result: Record<string, PortalAuthorityPermissions> = {};
    for (const [emailRaw, record] of Object.entries(raw)) {
      const permissions = fromJsonRecord(record);
      if (permissions) result[emailRaw.trim().toLowerCase()] = permissions;
    }
    if (this.mode === 'compare') {
      const db: Record<string, PortalAuthorityPermissions> = {};
      try {
        for (const user of await this.repository.listUsers()) {
          const permissions = fromDbUser(user);
          if (permissions) db[user.email] = permissions;
        }
        if (canonicalPermissionMap(result) !== canonicalPermissionMap(db)) this.onMismatch({ kind: 'reviewer_map' });
      } catch {
        this.onMismatch({ kind: 'reviewer_map' });
      }
    }
    return result;
  }
}
