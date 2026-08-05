import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  applyPortalAccessControlSnapshot,
  comparePortalAccessControlSnapshot,
  exportPortalAccessControlJson,
  loadPortalAccessControlJson,
} from '../src/core/portal-access-control-migration.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`
    TRUNCATE portal_acl_audit,
             portal_access_request_grants,
             portal_access_requests,
             portal_source_grants,
             portal_users
    RESTART IDENTITY CASCADE
  `);
  await engine.executeRaw(`
    INSERT INTO sources (id, name, config)
    VALUES
      ('alice', 'Alice personal', '{}'::jsonb),
      ('bob', 'Bob personal', '{}'::jsonb),
      ('shared', 'Shared', '{}'::jsonb),
      ('internal-it', 'Internal IT', '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-acl-migration-'));
  const permissionsPath = join(dir, 'user_permissions.json');
  const requestsPath = join(dir, 'access_requests.json');
  writeFileSync(permissionsPath, JSON.stringify({
    'Alice@avers.kz': {
      source_id: 'alice',
      federated_read: ['alice', 'shared', 'internal-it'],
      federated_write: ['alice', 'internal-it'],
    },
    'bob@avers.kz': {
      source_id: 'bob',
      federated_read: ['bob', 'shared'],
      federated_write: ['bob'],
    },
  }, null, 2));
  writeFileSync(requestsPath, JSON.stringify([
    {
      id: 'req-pending',
      email: 'bob@avers.kz',
      reason: 'Need IT',
      status: 'pending',
      requested_at: '2026-08-01T10:00:00.000Z',
      requests: [{ area: 'ит', source_id: 'internal-it', read: true, write: false }],
      approved_at: null,
    },
    {
      id: 'req-partial',
      email: 'alice@avers.kz',
      reason: 'Need shared and IT',
      status: 'approved_partial',
      requested_at: '2026-07-01T10:00:00.000Z',
      decided_at: '2026-07-02T10:00:00.000Z',
      decided_by: 'admin-session-unattributed',
      requests: [
        { area: 'shared', source_id: 'shared', read: true, write: true },
        { area: 'ит', source_id: 'internal-it', read: true, write: true },
      ],
      approved_requests: [
        { area: 'ит', source_id: 'internal-it', read: true, write: true },
      ],
      denied_requests: [
        { area: 'shared', source_id: 'shared', read: true, write: true },
      ],
    },
  ], null, 2));
  chmodSync(permissionsPath, 0o600);
  chmodSync(requestsPath, 0o600);
  return { dir, permissionsPath, requestsPath };
}

describe('portal access-control JSON to DB migration', () => {
  test('loads deterministic normalized snapshot and reports counts/hashes only', () => {
    const paths = fixture();
    const snapshot = loadPortalAccessControlJson(paths);
    expect(snapshot.summary).toEqual({
      users: 2,
      grants: 5,
      requests: 2,
      requestGrants: 3,
      pending: 1,
      permissionsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(snapshot.summary)).not.toContain('@avers.kz');
  });

  test('applies atomically, remains idempotent, and compares with zero mismatches', async () => {
    const snapshot = loadPortalAccessControlJson(fixture());
    const first = await applyPortalAccessControlSnapshot(engine, snapshot, 'migration@avers.kz');
    const second = await applyPortalAccessControlSnapshot(engine, snapshot, 'migration@avers.kz');
    expect(first).toEqual({ applied: true, ...snapshot.summary });
    expect(second).toEqual({ applied: false, ...snapshot.summary });

    const comparison = await comparePortalAccessControlSnapshot(engine, snapshot);
    expect(comparison).toEqual({
      users: 0,
      grants: 0,
      requests: 0,
      requestGrants: 0,
      pending: 0,
      total: 0,
    });
    await engine.executeRaw(`UPDATE portal_access_requests SET reason = 'shadow drift' WHERE id = 'req-pending'`);
    const drift = await comparePortalAccessControlSnapshot(engine, snapshot);
    expect(drift.requests).toBe(1);
    expect(drift.total).toBeGreaterThan(0);
    await engine.executeRaw(`UPDATE portal_access_requests SET reason = 'Need IT' WHERE id = 'req-pending'`);
    const pending = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM portal_access_requests WHERE status = 'pending'`,
    );
    expect(pending).toEqual([{ id: 'req-pending' }]);
  });

  test('aborts the whole apply on an invalid grant without partial rows', async () => {
    const paths = fixture();
    const permissions = JSON.parse(readFileSync(paths.permissionsPath, 'utf8'));
    permissions['bob@avers.kz'].federated_write.push('shared');
    permissions['bob@avers.kz'].federated_read = ['bob'];
    writeFileSync(paths.permissionsPath, JSON.stringify(permissions));
    chmodSync(paths.permissionsPath, 0o600);

    expect(() => loadPortalAccessControlJson(paths)).toThrow('invalid_permissions_invariant');
    const users = await engine.executeRaw(`SELECT email FROM portal_users`);
    expect(users).toHaveLength(0);
  });

  test('exports rollback JSON with restrictive modes and readable normalized state', async () => {
    const snapshot = loadPortalAccessControlJson(fixture());
    await applyPortalAccessControlSnapshot(engine, snapshot, 'migration@avers.kz');
    const outRoot = mkdtempSync(join(tmpdir(), 'gbrain-acl-export-'));
    const outDir = join(outRoot, 'new-secure-export-directory');
    const permissionsPath = join(outDir, 'user_permissions.export.json');
    const requestsPath = join(outDir, 'access_requests.export.json');
    const result = await exportPortalAccessControlJson(engine, { permissionsPath, requestsPath });

    expect(result.users).toBe(2);
    expect(result.requests).toBe(2);
    expect(statSync(permissionsPath).mode & 0o777).toBe(0o600);
    expect(statSync(requestsPath).mode & 0o777).toBe(0o600);
    const exportedRequests = JSON.parse(readFileSync(requestsPath, 'utf8'));
    expect(exportedRequests.find((row: any) => row.id === 'req-pending').status).toBe('pending');
    expect(exportedRequests.find((row: any) => row.id === 'req-partial').status).toBe('approved_partial');
  });
});
