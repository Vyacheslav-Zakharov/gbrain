import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  PortalAccessControlError,
  PortalAccessControlRepository,
} from '../src/core/portal-access-control.ts';

let engine: PGLiteEngine;
let repository: PortalAccessControlRepository;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repository = new PortalAccessControlRepository(engine);
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
      ('alice-source', 'Alice personal', '{}'::jsonb),
      ('shared', 'Shared', '{}'::jsonb),
      ('internal-it', 'Internal IT', '{}'::jsonb),
      ('external-unmanaged', 'External unmanaged', '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
});

describe('PortalAccessControlRepository', () => {
  test('provisions a stable Keycloak identity with mandatory personal R/W', async () => {
    const user = await repository.provisionUser({
      email: 'Alice@Example.Test',
      keycloakSub: 'kc-alice',
      personalSourceId: 'alice-source',
    });

    expect(user.email).toBe('alice@example.test');
    expect(user.keycloakSub).toBe('kc-alice');
    expect(user.version).toBe(1);
    expect(user.grants).toEqual([
      { sourceId: 'alice-source', canRead: true, canWrite: true },
    ]);

    await expect(repository.provisionUser({
      email: 'alice@example.test',
      keycloakSub: 'different-sub',
      personalSourceId: 'alice-source',
    })).rejects.toMatchObject({ code: 'identity_conflict' });
  });

  test('binds an imported null Keycloak subject exactly once and audits it', async () => {
    await engine.executeRaw(`
      INSERT INTO portal_users (email, keycloak_sub, personal_source_id, status)
      VALUES ('alice@example.test', NULL, 'alice-source', 'active')
    `);
    await engine.executeRaw(`
      INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
      VALUES ('alice@example.test', 'alice-source', true, true)
    `);

    const bound = await repository.provisionUser({
      email: 'alice@example.test', keycloakSub: 'kc-alice', personalSourceId: 'alice-source',
    });
    expect(bound.keycloakSub).toBe('kc-alice');
    expect(await engine.executeRaw(`SELECT id FROM portal_acl_audit WHERE action = 'bind_keycloak_identity'`)).toHaveLength(1);
    await expect(repository.provisionUser({
      email: 'alice@example.test', keycloakSub: 'kc-other', personalSourceId: 'alice-source',
    })).rejects.toMatchObject({ code: 'identity_conflict' });
  });

  test('replaces managed grants transactionally, preserves personal R/W, and audits the change', async () => {
    await repository.provisionUser({
      email: 'alice@example.test',
      keycloakSub: 'kc-alice',
      personalSourceId: 'alice-source',
    });
    await engine.executeRaw(`
      INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
      VALUES ('alice@example.test', 'external-unmanaged', true, false)
    `);

    const updated = await repository.replaceManagedGrants({
      email: 'alice@example.test',
      expectedVersion: 1,
      managedSourceIds: ['shared', 'internal-it'],
      grants: [
        { sourceId: 'shared', canRead: true, canWrite: false },
        { sourceId: 'internal-it', canRead: true, canWrite: true },
      ],
    }, 'admin@example.test');

    expect(updated.version).toBe(2);
    expect(updated.grants).toEqual([
      { sourceId: 'alice-source', canRead: true, canWrite: true },
      { sourceId: 'external-unmanaged', canRead: true, canWrite: false },
      { sourceId: 'internal-it', canRead: true, canWrite: true },
      { sourceId: 'shared', canRead: true, canWrite: false },
    ]);

    const audit = await engine.executeRaw<{
      actor_email: string;
      subject_email: string;
      action: string;
      before_state: unknown;
      after_state: unknown;
    }>(`
      SELECT actor_email, subject_email, action, before_state, after_state
        FROM portal_acl_audit
       WHERE action = 'replace_managed_grants'
    `);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe('admin@example.test');
    expect(audit[0]?.subject_email).toBe('alice@example.test');
    expect(audit[0]?.action).toBe('replace_managed_grants');
    expect(audit[0]?.before_state).toBeTruthy();
    expect(audit[0]?.after_state).toBeTruthy();
  });

  test('fails closed on stale versions, unknown sources, and write without read', async () => {
    await repository.provisionUser({
      email: 'alice@example.test',
      keycloakSub: 'kc-alice',
      personalSourceId: 'alice-source',
    });

    const cases = [
      () => repository.replaceManagedGrants({
        email: 'alice@example.test', expectedVersion: 2, grants: [],
      }, 'admin@example.test'),
      () => repository.replaceManagedGrants({
        email: 'alice@example.test', expectedVersion: 1,
        grants: [{ sourceId: 'missing-source', canRead: true, canWrite: false }],
      }, 'admin@example.test'),
      () => repository.replaceManagedGrants({
        email: 'alice@example.test', expectedVersion: 1,
        grants: [{ sourceId: 'shared', canRead: false, canWrite: true }],
      }, 'admin@example.test'),
    ];

    const expectedCodes: PortalAccessControlError['code'][] = ['conflict', 'unknown_source', 'invalid_grant'];
    for (let i = 0; i < cases.length; i += 1) {
      try {
        await cases[i]!();
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(PortalAccessControlError);
        expect((error as PortalAccessControlError).code).toBe(expectedCodes[i]);
      }
    }

    expect((await repository.getUser('alice@example.test'))?.version).toBe(1);
    const audit = await engine.executeRaw(`
      SELECT id FROM portal_acl_audit WHERE action <> 'provision_user'
    `);
    expect(audit).toHaveLength(0);
  });

  test('creates a pending request and audit atomically', async () => {
    await repository.provisionUser({
      email: 'alice@example.test',
      keycloakSub: 'kc-alice',
      personalSourceId: 'alice-source',
    });
    const created = await repository.createRequest({
      id: 'req-create',
      email: 'alice@example.test',
      reason: 'Need shared',
      grants: [{ sourceId: 'shared', requestedRead: true, requestedWrite: false }],
    });
    expect(created.status).toBe('pending');
    expect(created.version).toBe(1);
    expect(created.grants).toEqual([{
      sourceId: 'shared', requestedRead: true, requestedWrite: false,
      approvedRead: null, approvedWrite: null,
    }]);
    const audit = await engine.executeRaw<{ action: string }>(
      `SELECT action FROM portal_acl_audit WHERE request_id = 'req-create'`,
    );
    expect(audit).toEqual([{ action: 'request_access' }]);
  });

  test('decides a request, updates grants, and appends audit in one transaction', async () => {
    await repository.provisionUser({
      email: 'alice@example.test',
      keycloakSub: 'kc-alice',
      personalSourceId: 'alice-source',
    });
    await engine.executeRaw(`
      INSERT INTO portal_access_requests (id, user_email, reason, status, requested_at)
      VALUES ('req-1', 'alice@example.test', 'Need shared access', 'pending', now())
    `);
    await engine.executeRaw(`
      INSERT INTO portal_access_request_grants (
        request_id, source_id, requested_read, requested_write
      ) VALUES ('req-1', 'shared', true, true)
    `);

    const decided = await repository.decideRequest({
      requestId: 'req-1',
      expectedVersion: 1,
      decision: 'approved',
      grants: [{ sourceId: 'shared', approvedRead: true, approvedWrite: true }],
    }, 'admin@example.test');

    expect(decided.status).toBe('approved');
    expect(decided.version).toBe(2);
    expect((await repository.getUser('alice@example.test'))?.grants).toContainEqual({
      sourceId: 'shared', canRead: true, canWrite: true,
    });
    const audit = await engine.executeRaw<{ request_id: string; action: string }>(
      `SELECT request_id, action FROM portal_acl_audit WHERE request_id = 'req-1'`
    );
    expect(audit).toEqual([{ request_id: 'req-1', action: 'approve_access_request' }]);
  });
});
