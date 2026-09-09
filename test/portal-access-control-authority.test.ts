import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PortalAccessControlRepository } from '../src/core/portal-access-control.ts';
import {
  PortalAccessControlAuthority,
  parsePortalAclMode,
} from '../src/core/portal-access-control-authority.ts';

let engine: PGLiteEngine;
let repository: PortalAccessControlRepository;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repository = new PortalAccessControlRepository(engine);
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await engine.executeRaw(`
    TRUNCATE portal_acl_audit, portal_access_request_grants, portal_access_requests,
             portal_source_grants, portal_users RESTART IDENTITY CASCADE
  `);
  await engine.executeRaw(`
    INSERT INTO sources (id, name, config)
    VALUES ('alice', 'Alice', '{}'::jsonb), ('shared', 'Shared', '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
  await repository.provisionUser({
    email: 'alice@avers.kz', keycloakSub: 'sub-alice', personalSourceId: 'alice',
  });
  await repository.replaceManagedGrants({
    email: 'alice@avers.kz', expectedVersion: 1,
    grants: [{ sourceId: 'shared', canRead: true, canWrite: false }],
  }, 'admin@avers.kz');
});

const jsonGrant = {
  source_id: 'alice',
  federated_read: ['alice', 'shared'],
  federated_write: ['alice'],
};

describe('PortalAccessControlAuthority', () => {
  test('accepts only explicit json, compare, and db modes', () => {
    expect(parsePortalAclMode(undefined)).toBe('json');
    expect(parsePortalAclMode('compare')).toBe('compare');
    expect(parsePortalAclMode('db')).toBe('db');
    expect(() => parsePortalAclMode('dual-write')).toThrow('invalid_portal_acl_mode');
  });

  test('uses JSON as authority in json and compare modes', async () => {
    const json = new PortalAccessControlAuthority({
      mode: 'json', repository, jsonReader: () => jsonGrant,
    });
    expect(await json.getUserPermissions('alice@avers.kz')).toEqual(jsonGrant);

    const mismatches: string[] = [];
    const compare = new PortalAccessControlAuthority({
      mode: 'compare', repository,
      jsonReader: () => ({ ...jsonGrant, federated_write: ['alice', 'shared'] }),
      onMismatch: event => mismatches.push(event.kind),
    });
    expect((await compare.getUserPermissions('alice@avers.kz'))?.federated_write).toEqual(['alice', 'shared']);
    expect(mismatches).toEqual(['user_grants']);
  });

  test('uses DB only in db mode and fails closed for missing or disabled users', async () => {
    const authority = new PortalAccessControlAuthority({
      mode: 'db', repository,
      jsonReader: () => { throw new Error('JSON must not be read'); },
    });
    expect(await authority.getUserPermissions('alice@avers.kz')).toEqual(jsonGrant);
    expect(await authority.getWriteSourceIds('alice@avers.kz')).toEqual(['alice']);
    expect(await authority.getUserPermissions('missing@avers.kz')).toBeNull();

    await engine.executeRaw(`UPDATE portal_users SET status = 'disabled' WHERE email = 'alice@avers.kz'`);
    expect(await authority.getUserPermissions('alice@avers.kz')).toBeNull();
    expect(await authority.getWriteSourceIds('alice@avers.kz')).toEqual([]);
  });

  test('lists only active DB users for reviewer resolution', async () => {
    const authority = new PortalAccessControlAuthority({ mode: 'db', repository, jsonReader: () => null });
    expect(await authority.listReviewerPermissions()).toEqual({
      'alice@avers.kz': {
        source_id: 'alice',
        federated_read: ['alice', 'shared'],
        federated_write: ['alice'],
      },
    });
    await engine.executeRaw(`UPDATE portal_users SET status = 'disabled' WHERE email = 'alice@avers.kz'`);
    expect(await authority.listReviewerPermissions()).toEqual({});
  });
});
