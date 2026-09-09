import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MIGRATIONS } from '../../src/core/migrate.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('portal access-control schema migration v138', () => {
  test('reserves v138 for the complete DB authority plane', () => {
    const migration = MIGRATIONS.find(item => item.version === 138);
    expect(migration?.name).toBe('portal_access_control_db_authority');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS portal_users');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS portal_source_grants');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS portal_access_requests');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS portal_access_request_grants');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS portal_acl_audit');
  });

  test('creates all five tables and required indexes in PGLite', async () => {
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
      SELECT indexname
        FROM pg_indexes
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

  test('enforces write implies read for grants and approved request decisions', async () => {
    await engine.executeRaw(`
      INSERT INTO sources (id, name, local_path, config) VALUES
        ('alice-source', 'Alice', '/tmp/alice-source', '{}'::jsonb),
        ('shared', 'Shared', '/tmp/shared', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
    await engine.executeRaw(`
      INSERT INTO portal_users (email, personal_source_id, status)
      VALUES ('alice@example.test', 'alice-source', 'active')
    `);

    await expect(engine.executeRaw(`
      INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
      VALUES ('alice@example.test', 'shared', false, true)
    `)).rejects.toThrow();

    await engine.executeRaw(`
      INSERT INTO portal_access_requests (id, user_email, status, requested_at)
      VALUES ('req-1', 'alice@example.test', 'pending', now())
    `);
    await expect(engine.executeRaw(`
      INSERT INTO portal_access_request_grants (
        request_id, source_id, requested_read, requested_write, approved_read, approved_write
      ) VALUES ('req-1', 'shared', true, true, false, true)
    `)).rejects.toThrow();
  });

  test('enforces immutable identity, personal grant, and append-only audit in SQL', async () => {
    await engine.executeRaw(`
      UPDATE portal_users SET keycloak_sub = 'kc-alice' WHERE email = 'alice@example.test'
    `);
    await expect(engine.executeRaw(`
      UPDATE portal_users SET keycloak_sub = 'kc-other' WHERE email = 'alice@example.test'
    `)).rejects.toThrow();
    await engine.executeRaw(`
      INSERT INTO portal_source_grants (user_email, source_id, can_read, can_write)
      VALUES ('alice@example.test', 'alice-source', true, true)
      ON CONFLICT (user_email, source_id) DO NOTHING
    `);
    await expect(engine.executeRaw(`
      DELETE FROM portal_source_grants
       WHERE user_email = 'alice@example.test' AND source_id = 'alice-source'
    `)).rejects.toThrow();
    await engine.executeRaw(`
      INSERT INTO portal_acl_audit (actor_email, subject_email, action, after_state)
      VALUES ('admin@example.test', 'alice@example.test', 'test', '{"version":1}'::jsonb)
    `);
    await expect(engine.executeRaw(`UPDATE portal_acl_audit SET action = 'changed'`)).rejects.toThrow();
    await expect(engine.executeRaw(`DELETE FROM portal_acl_audit`)).rejects.toThrow();
  });
});
