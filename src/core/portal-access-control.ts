import type { BrainEngine } from './engine.ts';

export type PortalUserStatus = 'active' | 'disabled';
export type PortalRequestStatus = 'pending' | 'approved' | 'approved_partial' | 'rejected' | 'already_granted';

export interface PortalSourceGrant {
  sourceId: string;
  canRead: boolean;
  canWrite: boolean;
}

export interface PortalAccessUser {
  email: string;
  keycloakSub: string | null;
  personalSourceId: string;
  status: PortalUserStatus;
  version: number;
  grants: PortalSourceGrant[];
}

export interface PortalAccessRequestGrant {
  sourceId: string;
  requestedRead: boolean;
  requestedWrite: boolean;
  approvedRead: boolean | null;
  approvedWrite: boolean | null;
}

export interface PortalAccessRequest {
  id: string;
  userEmail: string;
  reason: string;
  status: PortalRequestStatus;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  version: number;
  grants: PortalAccessRequestGrant[];
}

export type PortalAccessControlErrorCode =
  | 'conflict'
  | 'identity_conflict'
  | 'invalid_email'
  | 'invalid_grant'
  | 'invalid_request_decision'
  | 'not_found'
  | 'unknown_source';

export class PortalAccessControlError extends Error {
  constructor(public readonly code: PortalAccessControlErrorCode, message: string = code) {
    super(message);
    this.name = 'PortalAccessControlError';
  }
}

interface PortalUserRow {
  email: string;
  keycloak_sub: string | null;
  personal_source_id: string;
  status: PortalUserStatus;
  version: number | string | bigint;
}

interface PortalRequestRow {
  id: string;
  user_email: string;
  reason: string;
  status: PortalRequestStatus;
  requested_at: string | Date;
  decided_by: string | null;
  decided_at: string | Date | null;
  rejection_reason: string | null;
  version: number | string | bigint;
}

function normalizeEmail(email: string): string {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new PortalAccessControlError('invalid_email');
  }
  return normalized;
}

function normalizeActor(value: string): string {
  const actor = String(value || '').trim();
  if (!actor || actor.length > 320 || /[\u0000-\u001f\u007f]/.test(actor)) {
    throw new PortalAccessControlError('invalid_email', 'invalid_actor');
  }
  return actor.includes('@') ? actor.toLowerCase() : actor;
}

function normalizeSourceId(sourceId: string): string {
  const normalized = String(sourceId || '').trim();
  if (!normalized || !/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new PortalAccessControlError('invalid_grant');
  }
  return normalized;
}

function asIso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

async function assertKnownSources(engine: BrainEngine, sourceIds: string[]): Promise<void> {
  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) return;
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = ANY($1::text[])`,
    [unique],
  );
  const known = new Set(rows.map(row => row.id));
  const missing = unique.find(sourceId => !known.has(sourceId));
  if (missing) throw new PortalAccessControlError('unknown_source', `unknown_source:${missing}`);
}

async function appendAudit(
  engine: BrainEngine,
  input: {
    actorEmail: string;
    subjectEmail: string;
    action: string;
    requestId?: string;
    beforeState: unknown;
    afterState: unknown;
  },
): Promise<void> {
  await engine.executeRaw(`
    INSERT INTO portal_acl_audit (
      actor_email, subject_email, action, request_id, before_state, after_state
    ) VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)
  `, [
    input.actorEmail,
    input.subjectEmail,
    input.action,
    input.requestId ?? null,
    JSON.stringify(input.beforeState),
    JSON.stringify(input.afterState),
  ]);
}

export class PortalAccessControlRepository {
  constructor(private readonly engine: BrainEngine) {}

  async getUser(email: string, engine: BrainEngine = this.engine): Promise<PortalAccessUser | null> {
    const normalizedEmail = normalizeEmail(email);
    const rows = await engine.executeRaw<PortalUserRow>(`
      SELECT email, keycloak_sub, personal_source_id, status, version
        FROM portal_users
       WHERE email = $1
    `, [normalizedEmail]);
    const row = rows[0];
    if (!row) return null;
    const grants = await engine.executeRaw<{
      source_id: string;
      can_read: boolean;
      can_write: boolean;
    }>(`
      SELECT source_id, can_read, can_write
        FROM portal_source_grants
       WHERE user_email = $1
       ORDER BY source_id
    `, [normalizedEmail]);
    return {
      email: row.email,
      keycloakSub: row.keycloak_sub,
      personalSourceId: row.personal_source_id,
      status: row.status,
      version: Number(row.version),
      grants: grants.map(grant => ({
        sourceId: grant.source_id,
        canRead: grant.can_read,
        canWrite: grant.can_write,
      })),
    };
  }

  async listUsers(): Promise<PortalAccessUser[]> {
    const rows = await this.engine.executeRaw<{ email: string }>(
      `SELECT email FROM portal_users ORDER BY email`,
    );
    const users = await Promise.all(rows.map(row => this.getUser(row.email)));
    return users.filter((user): user is PortalAccessUser => user !== null);
  }

  async provisionUser(input: {
    email: string;
    keycloakSub: string;
    personalSourceId: string;
  }): Promise<PortalAccessUser> {
    const email = normalizeEmail(input.email);
    const personalSourceId = normalizeSourceId(input.personalSourceId);
    const keycloakSub = String(input.keycloakSub || '').trim();
    if (!keycloakSub) throw new PortalAccessControlError('identity_conflict');

    return this.engine.transaction(async tx => {
      await assertKnownSources(tx, [personalSourceId]);
      const existing = await tx.executeRaw<PortalUserRow>(`
        SELECT email, keycloak_sub, personal_source_id, status, version
          FROM portal_users
         WHERE email = $1
         FOR UPDATE
      `, [email]);
      const row = existing[0];
      if (row) {
        if ((row.keycloak_sub && row.keycloak_sub !== keycloakSub) || row.personal_source_id !== personalSourceId) {
          throw new PortalAccessControlError('identity_conflict');
        }
        if (!row.keycloak_sub) {
          await tx.executeRaw(`
            UPDATE portal_users
               SET keycloak_sub = $2,
                   last_login_at = now(),
                   updated_at = now()
             WHERE email = $1
          `, [email, keycloakSub]);
          await appendAudit(tx, {
            actorEmail: email,
            subjectEmail: email,
            action: 'bind_keycloak_identity',
            beforeState: { ...row, keycloak_sub: null },
            afterState: { ...row, keycloak_sub: keycloakSub },
          });
        } else {
          await tx.executeRaw(`
            UPDATE portal_users SET last_login_at = now(), updated_at = now() WHERE email = $1
          `, [email]);
        }
        const current = await this.getUser(email, tx);
        if (!current) throw new PortalAccessControlError('not_found');
        return current;
      }

      await tx.executeRaw(`
        INSERT INTO portal_users (email, keycloak_sub, personal_source_id, status)
        VALUES ($1, $2, $3, 'active')
      `, [email, keycloakSub, personalSourceId]);
      await tx.executeRaw(`
        INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
        VALUES ($1, $2, true, true)
      `, [email, personalSourceId]);
      const created = await this.getUser(email, tx);
      if (!created) throw new PortalAccessControlError('not_found');
      await appendAudit(tx, {
        actorEmail: email,
        subjectEmail: email,
        action: 'provision_user',
        beforeState: null,
        afterState: created,
      });
      return created;
    });
  }

  async replaceManagedGrants(input: {
    email: string;
    expectedVersion: number;
    managedSourceIds?: string[];
    grants: PortalSourceGrant[];
  }, actorEmail: string): Promise<PortalAccessUser> {
    const email = normalizeEmail(input.email);
    const actor = normalizeActor(actorEmail);
    const normalized = input.grants.map(grant => ({
      sourceId: normalizeSourceId(grant.sourceId),
      canRead: grant.canRead === true,
      canWrite: grant.canWrite === true,
    }));
    if (new Set(normalized.map(grant => grant.sourceId)).size !== normalized.length) {
      throw new PortalAccessControlError('invalid_grant', 'duplicate_source');
    }
    if (normalized.some(grant => grant.canWrite && !grant.canRead)) {
      throw new PortalAccessControlError('invalid_grant', 'write_requires_read');
    }
    const managedSourceIds = input.managedSourceIds?.map(normalizeSourceId);
    const managedSet = managedSourceIds ? new Set(managedSourceIds) : null;
    if (managedSet && normalized.some(grant => !managedSet.has(grant.sourceId))) {
      throw new PortalAccessControlError('invalid_grant', 'unmanaged_source');
    }

    return this.engine.transaction(async tx => {
      const locked = await tx.executeRaw<PortalUserRow>(`
        SELECT email, keycloak_sub, personal_source_id, status, version
          FROM portal_users
         WHERE email = $1
         FOR UPDATE
      `, [email]);
      const row = locked[0];
      if (!row) throw new PortalAccessControlError('not_found');
      if (Number(row.version) !== input.expectedVersion) {
        throw new PortalAccessControlError('conflict');
      }
      await assertKnownSources(tx, [row.personal_source_id, ...normalized.map(grant => grant.sourceId)]);
      const before = await this.getUser(email, tx);
      if (!before) throw new PortalAccessControlError('not_found');

      const grants = new Map<string, PortalSourceGrant>();
      if (managedSet) {
        for (const grant of before.grants) {
          if (!managedSet.has(grant.sourceId)) grants.set(grant.sourceId, grant);
        }
      }
      for (const grant of normalized) grants.set(grant.sourceId, grant);
      grants.set(row.personal_source_id, {
        sourceId: row.personal_source_id,
        canRead: true,
        canWrite: true,
      });
      await tx.executeRaw(`
        DELETE FROM portal_source_grants
         WHERE user_email = $1 AND source_id <> $2
      `, [email, row.personal_source_id]);
      for (const grant of grants.values()) {
        if (!grant.canRead && !grant.canWrite) continue;
        await tx.executeRaw(`
          INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_email, source_id) DO UPDATE SET
            can_read = EXCLUDED.can_read,
            can_write = EXCLUDED.can_write,
            updated_at = now()
        `, [email, grant.sourceId, grant.canRead, grant.canWrite]);
      }
      await tx.executeRaw(`
        UPDATE portal_users
           SET version = version + 1,
               updated_at = now()
         WHERE email = $1
      `, [email]);
      const after = await this.getUser(email, tx);
      if (!after) throw new PortalAccessControlError('not_found');
      await appendAudit(tx, {
        actorEmail: actor,
        subjectEmail: email,
        action: 'replace_managed_grants',
        beforeState: before,
        afterState: after,
      });
      return after;
    });
  }

  async getRequest(requestId: string, engine: BrainEngine = this.engine): Promise<PortalAccessRequest | null> {
    const id = String(requestId || '').trim();
    const rows = await engine.executeRaw<PortalRequestRow>(`
      SELECT id, user_email, reason, status, requested_at, decided_by,
             decided_at, rejection_reason, version
        FROM portal_access_requests
       WHERE id = $1
    `, [id]);
    const row = rows[0];
    if (!row) return null;
    const grants = await engine.executeRaw<{
      source_id: string;
      requested_read: boolean;
      requested_write: boolean;
      approved_read: boolean | null;
      approved_write: boolean | null;
    }>(`
      SELECT source_id, requested_read, requested_write, approved_read, approved_write
        FROM portal_access_request_grants
       WHERE request_id = $1
       ORDER BY source_id
    `, [id]);
    return {
      id: row.id,
      userEmail: row.user_email,
      reason: row.reason,
      status: row.status,
      requestedAt: asIso(row.requested_at)!,
      decidedBy: row.decided_by,
      decidedAt: asIso(row.decided_at),
      rejectionReason: row.rejection_reason,
      version: Number(row.version),
      grants: grants.map(grant => ({
        sourceId: grant.source_id,
        requestedRead: grant.requested_read,
        requestedWrite: grant.requested_write,
        approvedRead: grant.approved_read,
        approvedWrite: grant.approved_write,
      })),
    };
  }

  async listRequests(status?: PortalRequestStatus): Promise<PortalAccessRequest[]> {
    const rows = status
      ? await this.engine.executeRaw<{ id: string }>(`
          SELECT id FROM portal_access_requests WHERE status = $1 ORDER BY requested_at DESC
        `, [status])
      : await this.engine.executeRaw<{ id: string }>(`
          SELECT id FROM portal_access_requests ORDER BY requested_at DESC
        `);
    const requests = await Promise.all(rows.map(row => this.getRequest(row.id)));
    return requests.filter((request): request is PortalAccessRequest => request !== null);
  }

  async createRequest(input: {
    id: string;
    email: string;
    reason: string;
    grants: Array<{
      sourceId: string;
      requestedRead: boolean;
      requestedWrite: boolean;
    }>;
    requestedAt?: string;
  }): Promise<PortalAccessRequest> {
    const id = String(input.id || '').trim();
    const email = normalizeEmail(input.email);
    if (!id || id.length > 200) throw new PortalAccessControlError('invalid_request_decision', 'invalid_request_id');
    const grants = input.grants.map(grant => ({
      sourceId: normalizeSourceId(grant.sourceId),
      requestedRead: grant.requestedRead === true || grant.requestedWrite === true,
      requestedWrite: grant.requestedWrite === true,
    }));
    if (grants.length === 0 || new Set(grants.map(grant => grant.sourceId)).size !== grants.length) {
      throw new PortalAccessControlError('invalid_request_decision', 'invalid_request_grants');
    }
    const requestedAt = input.requestedAt ? new Date(input.requestedAt) : new Date();
    if (Number.isNaN(requestedAt.getTime())) {
      throw new PortalAccessControlError('invalid_request_decision', 'invalid_requested_at');
    }

    return this.engine.transaction(async tx => {
      const users = await tx.executeRaw<PortalUserRow>(`
        SELECT email, keycloak_sub, personal_source_id, status, version
          FROM portal_users
         WHERE email = $1
         FOR UPDATE
      `, [email]);
      if (!users[0] || users[0].status !== 'active') throw new PortalAccessControlError('not_found');
      await assertKnownSources(tx, grants.map(grant => grant.sourceId));
      await tx.executeRaw(`
        INSERT INTO portal_access_requests (id, user_email, reason, status, requested_at)
        VALUES ($1, $2, $3, 'pending', $4::timestamptz)
      `, [id, email, String(input.reason || '').trim().slice(0, 2000), requestedAt.toISOString()]);
      for (const grant of grants) {
        await tx.executeRaw(`
          INSERT INTO portal_access_request_grants (
            request_id, source_id, requested_read, requested_write
          ) VALUES ($1, $2, $3, $4)
        `, [id, grant.sourceId, grant.requestedRead, grant.requestedWrite]);
      }
      const created = await this.getRequest(id, tx);
      if (!created) throw new PortalAccessControlError('not_found');
      await appendAudit(tx, {
        actorEmail: email,
        subjectEmail: email,
        action: 'request_access',
        requestId: id,
        beforeState: null,
        afterState: created,
      });
      return created;
    });
  }

  async decideRequest(input: {
    requestId: string;
    expectedVersion: number;
    decision: 'approved' | 'approved_partial' | 'rejected';
    rejectionReason?: string;
    grants: Array<{
      sourceId: string;
      approvedRead: boolean;
      approvedWrite: boolean;
    }>;
  }, actorEmail: string): Promise<PortalAccessRequest> {
    const requestId = String(input.requestId || '').trim();
    const actor = normalizeActor(actorEmail);
    if (input.decision === 'rejected' && !String(input.rejectionReason || '').trim()) {
      throw new PortalAccessControlError('invalid_request_decision', 'rejection_reason_required');
    }

    return this.engine.transaction(async tx => {
      const locked = await tx.executeRaw<PortalRequestRow>(`
        SELECT id, user_email, reason, status, requested_at, decided_by,
               decided_at, rejection_reason, version
          FROM portal_access_requests
         WHERE id = $1
         FOR UPDATE
      `, [requestId]);
      const row = locked[0];
      if (!row) throw new PortalAccessControlError('not_found');
      if (Number(row.version) !== input.expectedVersion) throw new PortalAccessControlError('conflict');
      if (row.status !== 'pending') throw new PortalAccessControlError('conflict', 'request_not_pending');

      const before = await this.getRequest(requestId, tx);
      if (!before) throw new PortalAccessControlError('not_found');
      const requestedBySource = new Map(before.grants.map(grant => [grant.sourceId, grant]));
      if (new Set(input.grants.map(grant => grant.sourceId)).size !== input.grants.length) {
        throw new PortalAccessControlError('invalid_request_decision', 'duplicate_source');
      }
      if (input.grants.length !== before.grants.length) {
        throw new PortalAccessControlError('invalid_request_decision', 'incomplete_decision');
      }
      let approvedCapabilities = 0;
      let requestedCapabilities = 0;
      for (const decision of input.grants) {
        const sourceId = normalizeSourceId(decision.sourceId);
        const requested = requestedBySource.get(sourceId);
        if (!requested) throw new PortalAccessControlError('invalid_request_decision', 'unknown_request_source');
        if (decision.approvedWrite && !decision.approvedRead) {
          throw new PortalAccessControlError('invalid_request_decision', 'write_requires_read');
        }
        if (decision.approvedRead && !requested.requestedRead) {
          throw new PortalAccessControlError('invalid_request_decision', 'read_not_requested');
        }
        if (decision.approvedWrite && !requested.requestedWrite) {
          throw new PortalAccessControlError('invalid_request_decision', 'write_not_requested');
        }
        if (requested.requestedRead) requestedCapabilities += 1;
        if (requested.requestedWrite) requestedCapabilities += 1;
        if (decision.approvedRead) approvedCapabilities += 1;
        if (decision.approvedWrite) approvedCapabilities += 1;
      }
      const decisionShapeIsValid = input.decision === 'rejected'
        ? approvedCapabilities === 0
        : input.decision === 'approved'
          ? approvedCapabilities === requestedCapabilities
          : approvedCapabilities > 0 && approvedCapabilities < requestedCapabilities;
      if (!decisionShapeIsValid) {
        throw new PortalAccessControlError('invalid_request_decision', 'decision_status_mismatch');
      }
      await assertKnownSources(tx, input.grants.map(grant => grant.sourceId));

      for (const decision of input.grants) {
        await tx.executeRaw(`
          UPDATE portal_access_request_grants
             SET approved_read = $3,
                 approved_write = $4
           WHERE request_id = $1 AND source_id = $2
        `, [requestId, decision.sourceId, decision.approvedRead, decision.approvedWrite]);
      }

      if (input.decision !== 'rejected') {
        const userRows = await tx.executeRaw<PortalUserRow>(`
          SELECT email, keycloak_sub, personal_source_id, status, version
            FROM portal_users
           WHERE email = $1
           FOR UPDATE
        `, [row.user_email]);
        const user = userRows[0];
        if (!user) throw new PortalAccessControlError('not_found');
        for (const decision of input.grants) {
          if (!decision.approvedRead && !decision.approvedWrite) continue;
          await tx.executeRaw(`
            INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_email, source_id) DO UPDATE SET
              can_read = portal_source_grants.can_read OR EXCLUDED.can_read,
              can_write = portal_source_grants.can_write OR EXCLUDED.can_write,
              updated_at = now()
          `, [row.user_email, decision.sourceId, decision.approvedRead, decision.approvedWrite]);
        }
        await tx.executeRaw(`
          UPDATE portal_users SET version = version + 1, updated_at = now() WHERE email = $1
        `, [row.user_email]);
      }

      await tx.executeRaw(`
        UPDATE portal_access_requests
           SET status = $2,
               decided_by = $3,
               decided_at = now(),
               rejection_reason = $4,
               version = version + 1
         WHERE id = $1
      `, [requestId, input.decision, actor, input.decision === 'rejected' ? input.rejectionReason!.trim() : null]);
      const after = await this.getRequest(requestId, tx);
      if (!after) throw new PortalAccessControlError('not_found');
      await appendAudit(tx, {
        actorEmail: actor,
        subjectEmail: row.user_email,
        action: input.decision === 'rejected' ? 'reject_access_request' : 'approve_access_request',
        requestId,
        beforeState: before,
        afterState: after,
      });
      return after;
    });
  }
}
