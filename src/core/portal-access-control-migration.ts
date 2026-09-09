import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from './engine.ts';
import {
  normalizePortalPermissions,
  validatePortalEmail,
  writeJsonAtomically,
  type PortalUserPermissionsRecord,
} from './portal-access-control-json.ts';

const REQUEST_STATUSES = new Set([
  'pending', 'approved', 'approved_partial', 'rejected', 'already_granted',
] as const);

type RequestStatus = 'pending' | 'approved' | 'approved_partial' | 'rejected' | 'already_granted';

interface NormalizedUser {
  email: string;
  personalSourceId: string;
  status: 'active' | 'disabled';
  grants: Array<{ sourceId: string; canRead: boolean; canWrite: boolean }>;
  raw: PortalUserPermissionsRecord & Record<string, unknown>;
}

interface LegacyRequestGrant {
  sourceId: string;
  requestedRead: boolean;
  requestedWrite: boolean;
  approvedRead: boolean | null;
  approvedWrite: boolean | null;
  area: string;
}

interface NormalizedRequest {
  id: string;
  userEmail: string;
  reason: string;
  status: RequestStatus;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  grants: LegacyRequestGrant[];
  raw: Record<string, unknown>;
}

export interface PortalAccessControlMigrationSummary {
  users: number;
  grants: number;
  requests: number;
  requestGrants: number;
  pending: number;
  permissionsHash: string;
  requestsHash: string;
}

export interface PortalAccessControlSnapshot {
  users: NormalizedUser[];
  requests: NormalizedRequest[];
  summary: PortalAccessControlMigrationSummary;
}

export interface PortalAccessControlComparison {
  users: number;
  grants: number;
  requests: number;
  requestGrants: number;
  pending: number;
  total: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function readProtectedJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('access_control_source_not_regular_file');
  if ((stat.mode & 0o077) !== 0) throw new Error('access_control_source_permissions_too_broad');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('access_control_source_owner_mismatch');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sourceId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || !/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new Error('invalid_source_id');
  }
  return normalized;
}

function timestamp(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || Number.isNaN(Date.parse(text))) throw new Error(`invalid_${field}`);
  return new Date(text).toISOString();
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return timestamp(value, field);
}

function normalizeUsers(value: unknown): NormalizedUser[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_permissions_shape');
  }
  const users = new Map<string, NormalizedUser>();
  for (const [rawEmail, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const email = validatePortalEmail(rawEmail);
    if (users.has(email)) throw new Error('duplicate_normalized_email');
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      throw new Error('invalid_permissions_shape');
    }
    const raw = rawValue as PortalUserPermissionsRecord & Record<string, unknown>;
    const permissions = normalizePortalPermissions(raw);
    const read = new Set(permissions.federated_read);
    const write = new Set(permissions.federated_write);
    const grants = [...read].sort().map(id => ({
      sourceId: sourceId(id),
      canRead: true,
      canWrite: write.has(id),
    }));
    users.set(email, {
      email,
      personalSourceId: permissions.source_id,
      status: raw.active === false || raw.disabled === true ? 'disabled' : 'active',
      grants,
      raw: structuredClone(raw),
    });
  }
  return [...users.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function normalizedRequestGrant(value: unknown): { area: string; sourceId: string; read: boolean; write: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_access_request_grant');
  const row = value as Record<string, unknown>;
  const write = row.write === true;
  const read = row.read === true || write;
  if (!read) throw new Error('invalid_access_request_grant');
  return {
    area: typeof row.area === 'string' ? row.area : '',
    sourceId: sourceId(row.source_id),
    read,
    write,
  };
}

function decisionActor(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const actor = typeof value === 'string' ? value.trim() : '';
  if (!actor || actor.length > 320 || /[\u0000-\u001f\u007f]/.test(actor)) {
    throw new Error('invalid_decision_actor');
  }
  return actor.toLowerCase();
}

function normalizeRequests(value: unknown, users: NormalizedUser[]): NormalizedRequest[] {
  if (!Array.isArray(value)) throw new Error('invalid_access_requests_shape');
  const userEmails = new Set(users.map(user => user.email));
  const seenIds = new Set<string>();
  return value.map(rawValue => {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      throw new Error('invalid_access_request');
    }
    const raw = rawValue as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || seenIds.has(id)) throw new Error('duplicate_or_invalid_request_id');
    seenIds.add(id);
    const email = validatePortalEmail(raw.email);
    if (!userEmails.has(email)) throw new Error('request_user_missing');
    const status = raw.status as RequestStatus;
    if (!REQUEST_STATUSES.has(status)) throw new Error('invalid_access_request_status');
    if (!Array.isArray(raw.requests) || raw.requests.length === 0) throw new Error('invalid_access_request_grants');
    const requested = raw.requests
      .map(normalizedRequestGrant)
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    if (new Set(requested.map(grant => grant.sourceId)).size !== requested.length) {
      throw new Error('duplicate_access_request_source');
    }
    const approvedRows = Array.isArray(raw.approved_requests)
      ? raw.approved_requests.map(normalizedRequestGrant)
      : (status === 'approved' || status === 'already_granted' ? requested : []);
    const approved = new Map(approvedRows.map(grant => [grant.sourceId, grant]));
    for (const grant of approved.values()) {
      const original = requested.find(item => item.sourceId === grant.sourceId);
      if (!original || (grant.write && !original.write) || (grant.read && !original.read)) {
        throw new Error('request_permission_escalation');
      }
    }
    return {
      id,
      userEmail: email,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      status,
      requestedAt: timestamp(raw.requested_at, 'requested_at'),
      decidedBy: decisionActor(raw.decided_by ?? raw.approved_by),
      decidedAt: nullableTimestamp(raw.decided_at ?? raw.approved_at, 'decided_at'),
      rejectionReason: typeof raw.rejection_reason === 'string' ? raw.rejection_reason : null,
      grants: requested.map(grant => {
        const decision = approved.get(grant.sourceId);
        return {
          sourceId: grant.sourceId,
          requestedRead: grant.read,
          requestedWrite: grant.write,
          approvedRead: status === 'pending' ? null : decision?.read === true,
          approvedWrite: status === 'pending' ? null : decision?.write === true,
          area: grant.area,
        };
      }),
      raw: structuredClone(raw),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function loadPortalAccessControlJson(paths: {
  permissionsPath: string;
  requestsPath: string;
}): PortalAccessControlSnapshot {
  const permissionsRaw = readProtectedJson(paths.permissionsPath);
  const requestsRaw = readProtectedJson(paths.requestsPath);
  const users = normalizeUsers(permissionsRaw);
  const requests = normalizeRequests(requestsRaw, users);
  return {
    users,
    requests,
    summary: {
      users: users.length,
      grants: users.reduce((sum, user) => sum + user.grants.length, 0),
      requests: requests.length,
      requestGrants: requests.reduce((sum, request) => sum + request.grants.length, 0),
      pending: requests.filter(request => request.status === 'pending').length,
      permissionsHash: hash(users.map(({ raw: _raw, ...user }) => user)),
      requestsHash: hash(requests.map(({ raw: _raw, ...request }) => request)),
    },
  };
}

async function compareSnapshot(engine: BrainEngine, snapshot: PortalAccessControlSnapshot): Promise<PortalAccessControlComparison> {
  const dbUsers = await engine.executeRaw<{
    email: string;
    personal_source_id: string;
    status: string;
  }>(`SELECT email, personal_source_id, status FROM portal_users ORDER BY email`);
  const dbGrants = await engine.executeRaw<{
    user_email: string;
    source_id: string;
    can_read: boolean;
    can_write: boolean;
  }>(`SELECT user_email, source_id, can_read, can_write FROM portal_source_grants ORDER BY user_email, source_id`);
  const dbRequests = await engine.executeRaw<{
    id: string;
    user_email: string;
    reason: string;
    status: string;
    requested_at: string | Date;
    decided_by: string | null;
    decided_at: string | Date | null;
    rejection_reason: string | null;
  }>(`
    SELECT id, user_email, reason, status, requested_at, decided_by, decided_at, rejection_reason
      FROM portal_access_requests ORDER BY id
  `);
  const dbRequestGrants = await engine.executeRaw<{
    request_id: string;
    source_id: string;
    requested_read: boolean;
    requested_write: boolean;
    approved_read: boolean | null;
    approved_write: boolean | null;
  }>(`
    SELECT request_id, source_id, requested_read, requested_write, approved_read, approved_write
      FROM portal_access_request_grants ORDER BY request_id, source_id
  `);

  const expectedUsers = snapshot.users.map(user => ({
    email: user.email, personal_source_id: user.personalSourceId, status: user.status,
  }));
  const expectedGrants = snapshot.users.flatMap(user => user.grants.map(grant => ({
    user_email: user.email,
    source_id: grant.sourceId,
    can_read: grant.canRead,
    can_write: grant.canWrite,
  }))).sort((a, b) => `${a.user_email}\0${a.source_id}`.localeCompare(`${b.user_email}\0${b.source_id}`));
  const expectedRequests = snapshot.requests.map(request => ({
    id: request.id,
    user_email: request.userEmail,
    reason: request.reason,
    status: request.status,
    requested_at: new Date(request.requestedAt).toISOString(),
    decided_by: request.decidedBy,
    decided_at: request.decidedAt ? new Date(request.decidedAt).toISOString() : null,
    rejection_reason: request.rejectionReason,
  }));
  const actualRequests = dbRequests.map(request => ({
    ...request,
    requested_at: new Date(request.requested_at).toISOString(),
    decided_at: request.decided_at ? new Date(request.decided_at).toISOString() : null,
  }));
  const expectedRequestGrants = snapshot.requests.flatMap(request => request.grants.map(grant => ({
    request_id: request.id,
    source_id: grant.sourceId,
    requested_read: grant.requestedRead,
    requested_write: grant.requestedWrite,
    approved_read: grant.approvedRead,
    approved_write: grant.approvedWrite,
  }))).sort((a, b) => `${a.request_id}\0${a.source_id}`.localeCompare(`${b.request_id}\0${b.source_id}`));

  const result = {
    users: canonical(dbUsers) === canonical(expectedUsers) ? 0 : 1,
    grants: canonical(dbGrants) === canonical(expectedGrants) ? 0 : 1,
    requests: canonical(actualRequests) === canonical(expectedRequests) ? 0 : 1,
    requestGrants: canonical(dbRequestGrants) === canonical(expectedRequestGrants) ? 0 : 1,
    pending: dbRequests.filter(request => request.status === 'pending').length === snapshot.summary.pending ? 0 : 1,
  };
  return { ...result, total: Object.values(result).reduce((sum, count) => sum + count, 0) };
}

export async function comparePortalAccessControlSnapshot(
  engine: BrainEngine,
  snapshot: PortalAccessControlSnapshot,
): Promise<PortalAccessControlComparison> {
  return compareSnapshot(engine, snapshot);
}

export async function applyPortalAccessControlSnapshot(
  engine: BrainEngine,
  snapshot: PortalAccessControlSnapshot,
  actorEmailRaw: string,
): Promise<{ applied: boolean } & PortalAccessControlMigrationSummary> {
  const actorEmail = validatePortalEmail(actorEmailRaw);
  return engine.transaction(async tx => {
    const counts = await tx.executeRaw<{ users: number | string; requests: number | string }>(`
      SELECT (SELECT count(*) FROM portal_users) AS users,
             (SELECT count(*) FROM portal_access_requests) AS requests
    `);
    if (Number(counts[0]?.users ?? 0) > 0 || Number(counts[0]?.requests ?? 0) > 0) {
      const comparison = await compareSnapshot(tx, snapshot);
      if (comparison.total !== 0) throw new Error('portal_access_control_db_mismatch');
      return { applied: false, ...snapshot.summary };
    }

    const knownRows = await tx.executeRaw<{ id: string }>(`SELECT id FROM sources`);
    const known = new Set(knownRows.map(row => row.id));
    const allSources = [
      ...snapshot.users.flatMap(user => user.grants.map(grant => grant.sourceId)),
      ...snapshot.requests.flatMap(request => request.grants.map(grant => grant.sourceId)),
    ];
    const missing = allSources.find(id => !known.has(id));
    if (missing) throw new Error(`unknown_source:${missing}`);

    for (const user of snapshot.users) {
      await tx.executeRaw(`
        INSERT INTO portal_users (email, personal_source_id, status)
        VALUES ($1, $2, $3)
      `, [user.email, user.personalSourceId, user.status]);
      for (const grant of user.grants) {
        await tx.executeRaw(`
          INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
          VALUES ($1, $2, $3, $4)
        `, [user.email, grant.sourceId, grant.canRead, grant.canWrite]);
      }
      await tx.executeRaw(`
        INSERT INTO portal_acl_audit (
          actor_email, subject_email, action, before_state, after_state
        ) VALUES ($1, $2, 'import_legacy_user', NULL, $3::text::jsonb)
      `, [actorEmail, user.email, JSON.stringify(user.raw)]);
    }

    for (const request of snapshot.requests) {
      await tx.executeRaw(`
        INSERT INTO portal_access_requests (
          id, user_email, reason, status, requested_at, decided_by, decided_at,
          rejection_reason
        ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz, $8)
      `, [
        request.id, request.userEmail, request.reason, request.status,
        request.requestedAt, request.decidedBy, request.decidedAt, request.rejectionReason,
      ]);
      for (const grant of request.grants) {
        await tx.executeRaw(`
          INSERT INTO portal_access_request_grants (
            request_id, source_id, requested_read, requested_write, approved_read, approved_write
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          request.id, grant.sourceId, grant.requestedRead, grant.requestedWrite,
          grant.approvedRead, grant.approvedWrite,
        ]);
      }
      await tx.executeRaw(`
        INSERT INTO portal_acl_audit (
          actor_email, subject_email, action, request_id, before_state, after_state
        ) VALUES ($1, $2, 'import_legacy_request', $3, NULL, $4::text::jsonb)
      `, [actorEmail, request.userEmail, request.id, JSON.stringify(request.raw)]);
    }
    return { applied: true, ...snapshot.summary };
  });
}

export async function exportPortalAccessControlJson(
  engine: BrainEngine,
  paths: { permissionsPath: string; requestsPath: string },
): Promise<{ users: number; requests: number }> {
  for (const directory of new Set([dirname(paths.permissionsPath), dirname(paths.requestsPath)])) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_export_directory');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('unsafe_export_directory_owner');
    }
    if ((stat.mode & 0o077) !== 0) throw new Error('unsafe_export_directory_permissions');
  }
  const users = await engine.executeRaw<{
    email: string;
    personal_source_id: string;
    status: 'active' | 'disabled';
  }>(`SELECT email, personal_source_id, status FROM portal_users ORDER BY email`);
  const grants = await engine.executeRaw<{
    user_email: string;
    source_id: string;
    can_read: boolean;
    can_write: boolean;
  }>(`SELECT user_email, source_id, can_read, can_write FROM portal_source_grants ORDER BY user_email, source_id`);
  const permissions: Record<string, unknown> = {};
  for (const user of users) {
    const own = grants.filter(grant => grant.user_email === user.email);
    permissions[user.email] = {
      source_id: user.personal_source_id,
      federated_read: own.filter(grant => grant.can_read).map(grant => grant.source_id),
      federated_write: own.filter(grant => grant.can_write).map(grant => grant.source_id),
      ...(user.status === 'disabled' ? { active: false } : {}),
    };
  }

  const requests = await engine.executeRaw<{
    id: string;
    user_email: string;
    reason: string;
    status: RequestStatus;
    requested_at: string | Date;
    decided_by: string | null;
    decided_at: string | Date | null;
    rejection_reason: string | null;
  }>(`
    SELECT id, user_email, reason, status, requested_at, decided_by, decided_at, rejection_reason
      FROM portal_access_requests ORDER BY requested_at, id
  `);
  const requestGrants = await engine.executeRaw<{
    request_id: string;
    source_id: string;
    requested_read: boolean;
    requested_write: boolean;
    approved_read: boolean | null;
    approved_write: boolean | null;
  }>(`
    SELECT request_id, source_id, requested_read, requested_write, approved_read, approved_write
      FROM portal_access_request_grants ORDER BY request_id, source_id
  `);
  const rawAudits = await engine.executeRaw<{ request_id: string; after_state: Record<string, unknown> }>(`
    SELECT DISTINCT ON (request_id) request_id, after_state
      FROM portal_acl_audit
     WHERE action = 'import_legacy_request' AND request_id IS NOT NULL
     ORDER BY request_id, created_at DESC, id DESC
  `);
  const rawById = new Map(rawAudits.map(row => [row.request_id, row.after_state]));
  const exportedRequests = requests.map(request => {
    const raw = structuredClone(rawById.get(request.id) ?? {}) as Record<string, unknown>;
    const own = requestGrants.filter(grant => grant.request_id === request.id);
    const rawRows = Array.isArray(raw.requests) ? raw.requests as Array<Record<string, unknown>> : [];
    const areaBySource = new Map(rawRows.map(row => [String(row.source_id || ''), String(row.area || '')]));
    const rows = own.map(grant => ({
      area: areaBySource.get(grant.source_id) || grant.source_id,
      source_id: grant.source_id,
      read: grant.requested_read,
      write: grant.requested_write,
    }));
    const approvedRows = own.filter(grant => grant.approved_read || grant.approved_write).map(grant => ({
      area: areaBySource.get(grant.source_id) || grant.source_id,
      source_id: grant.source_id,
      read: grant.approved_read === true,
      write: grant.approved_write === true,
    }));
    const deniedRows = own.filter(grant => grant.approved_read === false || grant.approved_write === false).map(grant => ({
      area: areaBySource.get(grant.source_id) || grant.source_id,
      source_id: grant.source_id,
      read: grant.requested_read && grant.approved_read !== true,
      write: grant.requested_write && grant.approved_write !== true,
    })).filter(grant => grant.read || grant.write);
    return {
      ...raw,
      id: request.id,
      email: request.user_email,
      reason: request.reason,
      status: request.status,
      requested_at: new Date(request.requested_at).toISOString(),
      requests: rows,
      decided_by: request.decided_by,
      decided_at: request.decided_at ? new Date(request.decided_at).toISOString() : null,
      rejection_reason: request.rejection_reason,
      ...(request.status === 'pending' ? {} : {
        approved_requests: approvedRows,
        denied_requests: deniedRows,
      }),
    };
  });

  writeJsonAtomically(paths.permissionsPath, permissions);
  writeJsonAtomically(paths.requestsPath, exportedRequests);
  const exportedSnapshot = loadPortalAccessControlJson(paths);
  const comparison = await compareSnapshot(engine, exportedSnapshot);
  if (comparison.total !== 0) throw new Error('portal_access_control_export_verification_failed');
  return { users: users.length, requests: requests.length };
}
