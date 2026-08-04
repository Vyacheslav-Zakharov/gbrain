import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyManagedPortalGrants,
  commitAccessControlJsonTransaction,
  normalizeRequestGrantDecisions,
  portalAccessRequestVersion,
  portalPermissionsVersion,
  recoverAccessControlJsonTransaction,
  validatePortalEmail,
} from '../src/core/portal-access-control-json';
import { readUserSourceGrant } from '../src/core/oauth-provider';

describe('Portal JSON access-control invariants', () => {
  const current = {
    source_id: 'alice-example',
    federated_read: ['alice-example', 'shared', 'internal-it', 'external-unmanaged'],
    federated_write: ['alice-example', 'internal-it'],
  };
  const managed = ['shared', 'internal-it', 'internal-hr'];

  test('validates and normalizes only corporate email identities', () => {
    expect(validatePortalEmail(' Alice@AVERS.KZ ')).toBe('alice@avers.kz');
    expect(() => validatePortalEmail('alice@example.test')).toThrow('invalid_portal_email');
    expect(() => validatePortalEmail('not-an-email')).toThrow('invalid_portal_email');
  });

  test('replaces only managed grants while preserving personal and unmanaged grants', () => {
    const updated = applyManagedPortalGrants(current, [
      { source_id: 'shared', read: true, write: false },
      { source_id: 'internal-it', read: false, write: false },
      { source_id: 'internal-hr', read: false, write: true },
    ], managed);
    expect(updated).toEqual({
      source_id: 'alice-example',
      federated_read: ['alice-example', 'external-unmanaged', 'shared', 'internal-hr'],
      federated_write: ['alice-example', 'internal-hr'],
    });
  });

  test('rejects unknown, duplicate, and malformed managed grants', () => {
    expect(() => applyManagedPortalGrants(current, [{ source_id: 'unknown', read: true, write: false }], managed)).toThrow('unknown_managed_source');
    expect(() => applyManagedPortalGrants(current, [
      { source_id: 'shared', read: true, write: false },
      { source_id: 'shared', read: false, write: false },
    ], managed)).toThrow('duplicate_managed_source');
    expect(() => applyManagedPortalGrants(current, [{ source_id: 'shared', read: 'yes' as unknown as boolean, write: false }], managed)).toThrow('invalid_grant_shape');
  });

  test('permission version is stable across array ordering but changes with authority', () => {
    const reordered = {
      ...current,
      federated_read: [...current.federated_read].reverse(),
      federated_write: [...current.federated_write].reverse(),
    };
    expect(portalPermissionsVersion(reordered)).toBe(portalPermissionsVersion(current));
    expect(portalPermissionsVersion({ ...current, federated_write: ['alice-example'] })).not.toBe(portalPermissionsVersion(current));
  });

  test('request approval decisions are complete and cannot exceed requested authority', () => {
    const requested = [{ read: true, write: false }, { read: true, write: true }];
    expect(normalizeRequestGrantDecisions(requested, [
      { index: 1, read: false, write: true },
      { index: 0, read: true, write: false },
    ])).toEqual([
      { index: 0, read: true, write: false },
      { index: 1, read: true, write: true },
    ]);
    expect(() => normalizeRequestGrantDecisions(requested, [{ index: 0, read: true, write: true }, { index: 1, read: true, write: false }])).toThrow('request_permission_escalation');
    expect(() => normalizeRequestGrantDecisions(requested, [{ index: 0, read: true, write: false }])).toThrow('invalid_request_grants');
    expect(() => normalizeRequestGrantDecisions(requested, [{ index: 0, read: true, write: false }, { index: 0, read: false, write: false }])).toThrow('duplicate_request_grant_index');
  });

  test('recovers both ACL files after a failure between atomic renames', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-access-control-'));
    const paths = {
      permissionsPath: join(root, 'user_permissions.json'),
      requestsPath: join(root, 'access_requests.json'),
      journalPath: join(root, 'access_control_transaction.json'),
    };
    const nextPermissions = { 'alice@avers.kz': { source_id: 'alice', federated_read: ['alice', 'shared'], federated_write: ['alice'] } };
    const nextRequests = [{ id: 'req-1', status: 'approved' }];
    try {
      writeFileSync(paths.permissionsPath, '{}\n');
      mkdirSync(paths.requestsPath);
      expect(() => commitAccessControlJsonTransaction(paths, nextPermissions, nextRequests)).toThrow();
      expect(existsSync(paths.journalPath)).toBe(true);
      rmSync(paths.requestsPath, { recursive: true });
      writeFileSync(paths.requestsPath, '[]\n');
      expect(recoverAccessControlJsonTransaction(paths)).toBe(true);
      expect(JSON.parse(readFileSync(paths.permissionsPath, 'utf8'))).toEqual(nextPermissions);
      expect(JSON.parse(readFileSync(paths.requestsPath, 'utf8'))).toEqual(nextRequests);
      expect(existsSync(paths.journalPath)).toBe(false);
      expect(statSync(paths.permissionsPath).mode & 0o777).toBe(0o600);
      expect(statSync(paths.requestsPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('OAuth ACL reads recover an unfinished approval transaction first', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-oauth-access-control-'));
    const brainDir = join(home, '.gbrain');
    const previousHome = process.env.HOME;
    mkdirSync(brainDir);
    const targetPermissions = {
      'alice@avers.kz': { source_id: 'alice', federated_read: ['alice', 'internal-it'], federated_write: ['alice'] },
    };
    const targetRequests = [{ id: 'req-oauth', status: 'approved' }];
    writeFileSync(join(brainDir, 'user_permissions.json'), '{}\n');
    writeFileSync(join(brainDir, 'access_requests.json'), '[]\n');
    writeFileSync(join(brainDir, 'access_control_transaction.json'), `${JSON.stringify({
      schema_version: 1,
      kind: 'approve_access_request',
      permissions: targetPermissions,
      requests: targetRequests,
    })}\n`);
    try {
      process.env.HOME = home;
      expect(readUserSourceGrant('alice@avers.kz')).toEqual({
        user_email: 'alice@avers.kz',
        source_id: 'alice',
        federated_read: ['alice', 'internal-it'],
        federated_write: ['alice'],
      });
      expect(JSON.parse(readFileSync(join(brainDir, 'access_requests.json'), 'utf8'))).toEqual(targetRequests);
      expect(existsSync(join(brainDir, 'access_control_transaction.json'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('request version changes when decision state changes', () => {
    const request = {
      id: 'req-1', email: 'alice@avers.kz', status: 'pending', requested_at: '2026-08-04T00:00:00Z',
      requests: [{ area: 'ИТ', source_id: 'internal-it', read: true, write: false }],
    };
    expect(portalAccessRequestVersion(request)).not.toBe(portalAccessRequestVersion({ ...request, status: 'approved' }));
  });
});
