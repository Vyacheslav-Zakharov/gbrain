import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const databaseUrl = process.env.GBRAIN_TEST_POSTGRES_URL;
const suite = databaseUrl ? describe : describe.skip;
let engine: PostgresEngine;

suite('portal access-control PostgreSQL migration parity', () => {
  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine?.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw(`
      TRUNCATE portal_acl_audit, portal_access_request_grants, portal_access_requests,
               portal_source_grants, portal_users RESTART IDENTITY CASCADE
    `);
  });

  test('applies v138 and creates the same authority-plane tables and indexes', async () => {
    const version = await engine.executeRaw<{ value: string }>(
      `SELECT value FROM config WHERE key = 'version'`,
    );
    expect(Number(version[0]?.value)).toBe(138);

    const tables = await engine.executeRaw<{ table_name: string }>(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name LIKE 'portal_%'
       ORDER BY table_name
    `);
    expect(tables.map(row => row.table_name)).toEqual([
      'portal_access_request_grants',
      'portal_access_requests',
      'portal_acl_audit',
      'portal_source_grants',
      'portal_users',
    ]);

    const indexes = await engine.executeRaw<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'portal_access_requests_status_time_idx',
           'portal_source_grants_source_idx',
           'portal_acl_audit_subject_time_idx'
         )
       ORDER BY indexname
    `);
    expect(indexes.map(row => row.indexname)).toEqual([
      'portal_access_requests_status_time_idx',
      'portal_acl_audit_subject_time_idx',
      'portal_source_grants_source_idx',
    ].sort());
  });

  test('enforces grant invariants and transactional repository SQL on PostgreSQL', async () => {
    await engine.executeRaw(`
      INSERT INTO sources (id, name, local_path, config) VALUES
        ('pg-user', 'PG User', '/tmp/pg-user', '{}'::jsonb),
        ('shared', 'Shared', '/tmp/shared', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
    await engine.executeRaw(`
      INSERT INTO portal_users (email, personal_source_id, status)
      VALUES ('pg-user@avers.kz', 'pg-user', 'active')
    `);
    await expect(engine.executeRaw(`
      INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
      VALUES ('pg-user@avers.kz', 'shared', false, true)
    `)).rejects.toThrow();
  });
});
