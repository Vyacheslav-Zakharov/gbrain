import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface PortalUserPermissionsRecord {
  source_id?: string;
  federated_read?: string[];
  federated_write?: string[];
}

export interface ManagedPortalGrant {
  source_id: string;
  read: boolean;
  write: boolean;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function normalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('invalid_permissions_shape');
  }
  return Array.from(new Set(value.map(item => item.trim()))).sort();
}

export interface AccessControlJsonTransactionPaths {
  permissionsPath: string;
  requestsPath: string;
  journalPath: string;
}

interface AccessControlJsonTransaction {
  schema_version: 1;
  kind: 'approve_access_request';
  permissions: Record<string, PortalUserPermissionsRecord>;
  requests: unknown[];
}

export function writeJsonAtomically(filePath: string, value: unknown): void {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tempPath, filePath);
  } finally {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* keep the original write error */ }
  }
}

function parseAccessControlTransaction(value: unknown): AccessControlJsonTransaction {
  const transaction = value as Partial<AccessControlJsonTransaction> | null;
  if (!transaction || transaction.schema_version !== 1 || transaction.kind !== 'approve_access_request') {
    throw new Error('invalid_access_control_transaction');
  }
  if (!transaction.permissions || typeof transaction.permissions !== 'object' || Array.isArray(transaction.permissions) || !Array.isArray(transaction.requests)) {
    throw new Error('invalid_access_control_transaction');
  }
  return transaction as AccessControlJsonTransaction;
}

export function recoverAccessControlJsonTransaction(paths: AccessControlJsonTransactionPaths): boolean {
  if (!existsSync(paths.journalPath)) return false;
  const transaction = parseAccessControlTransaction(JSON.parse(readFileSync(paths.journalPath, 'utf8')));
  writeJsonAtomically(paths.permissionsPath, transaction.permissions);
  writeJsonAtomically(paths.requestsPath, transaction.requests);
  unlinkSync(paths.journalPath);
  return true;
}

export function commitAccessControlJsonTransaction(
  paths: AccessControlJsonTransactionPaths,
  permissions: Record<string, PortalUserPermissionsRecord>,
  requests: unknown[],
): void {
  recoverAccessControlJsonTransaction(paths);
  const transaction: AccessControlJsonTransaction = {
    schema_version: 1,
    kind: 'approve_access_request',
    permissions,
    requests,
  };
  writeJsonAtomically(paths.journalPath, transaction);
  writeJsonAtomically(paths.permissionsPath, permissions);
  writeJsonAtomically(paths.requestsPath, requests);
  unlinkSync(paths.journalPath);
}

export function validatePortalEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^@\s]+@avers\.kz$/.test(email)) throw new Error('invalid_portal_email');
  return email;
}

export function normalizeRequestGrantDecisions(
  requestedRows: Array<{ read?: unknown; write?: unknown }>,
  grantsRaw: unknown,
): Array<{ index: number; read: boolean; write: boolean }> {
  if (!Array.isArray(requestedRows) || !Array.isArray(grantsRaw) || grantsRaw.length !== requestedRows.length) {
    throw new Error('invalid_request_grants');
  }
  const seen = new Set<number>();
  const decisions = grantsRaw.map((raw): { index: number; read: boolean; write: boolean } => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_request_grant_shape');
    const grant = raw as Record<string, unknown>;
    if (!Number.isInteger(grant.index) || typeof grant.read !== 'boolean' || typeof grant.write !== 'boolean') {
      throw new Error('invalid_request_grant_shape');
    }
    const index = grant.index as number;
    if (index < 0 || index >= requestedRows.length) throw new Error('invalid_request_grant_index');
    if (seen.has(index)) throw new Error('duplicate_request_grant_index');
    seen.add(index);
    const requested = requestedRows[index];
    if (grant.write && requested.write !== true) throw new Error('request_permission_escalation');
    if (grant.read && requested.read !== true && requested.write !== true) throw new Error('request_permission_escalation');
    return { index, read: grant.read || grant.write, write: grant.write };
  });
  if (seen.size !== requestedRows.length) throw new Error('incomplete_request_grants');
  return decisions.sort((a, b) => a.index - b.index);
}

export function normalizePortalPermissions(value: PortalUserPermissionsRecord): Required<PortalUserPermissionsRecord> {
  const sourceId = typeof value?.source_id === 'string' ? value.source_id.trim() : '';
  if (!sourceId) throw new Error('invalid_permissions_shape');
  const read = normalizedStringArray(value.federated_read);
  const write = normalizedStringArray(value.federated_write);
  if (!read.includes(sourceId) || !write.includes(sourceId) || write.some(source => !read.includes(source))) {
    throw new Error('invalid_permissions_invariant');
  }
  return { source_id: sourceId, federated_read: read, federated_write: write };
}

export function portalPermissionsVersion(value: PortalUserPermissionsRecord): string {
  return stableHash(normalizePortalPermissions(value));
}

export function applyManagedPortalGrants(
  currentRaw: PortalUserPermissionsRecord,
  grantsRaw: ManagedPortalGrant[],
  managedSourceIdsRaw: string[],
): Required<PortalUserPermissionsRecord> {
  const current = normalizePortalPermissions(currentRaw);
  if (!Array.isArray(grantsRaw) || !Array.isArray(managedSourceIdsRaw)) throw new Error('invalid_grants');
  const managedSourceIds = managedSourceIdsRaw.map(source => source.trim()).filter(Boolean);
  const allowed = new Set(managedSourceIds);
  if (allowed.size !== managedSourceIds.length) throw new Error('invalid_managed_sources');

  const seen = new Set<string>();
  const normalizedGrants = grantsRaw.map(grant => {
    if (!grant || typeof grant.source_id !== 'string' || typeof grant.read !== 'boolean' || typeof grant.write !== 'boolean') {
      throw new Error('invalid_grant_shape');
    }
    const sourceId = grant.source_id.trim();
    if (!allowed.has(sourceId)) throw new Error('unknown_managed_source');
    if (seen.has(sourceId)) throw new Error('duplicate_managed_source');
    seen.add(sourceId);
    return { source_id: sourceId, read: grant.read || grant.write, write: grant.write };
  });

  const read = current.federated_read.filter(source => !allowed.has(source));
  const write = current.federated_write.filter(source => !allowed.has(source));
  if (!read.includes(current.source_id)) read.unshift(current.source_id);
  if (!write.includes(current.source_id)) write.unshift(current.source_id);

  for (const grant of normalizedGrants) {
    if (grant.read) read.push(grant.source_id);
    if (grant.write) write.push(grant.source_id);
  }

  return {
    source_id: current.source_id,
    federated_read: Array.from(new Set(read)),
    federated_write: Array.from(new Set(write)),
  };
}

export function portalAccessRequestVersion(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_access_request');
  const request = value as Record<string, unknown>;
  return stableHash({
    id: request.id,
    email: request.email,
    status: request.status,
    requested_at: request.requested_at,
    requests: request.requests,
    decided_at: request.decided_at ?? null,
    decided_by: request.decided_by ?? null,
    approved_requests: request.approved_requests ?? null,
    denied_requests: request.denied_requests ?? null,
    rejection_reason: request.rejection_reason ?? null,
  });
}
