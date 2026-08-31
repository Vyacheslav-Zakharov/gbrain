import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', 'ops', 'p0b-google-role-bootstrap');
const text = (name: string) => readFile(join(dir, name), 'utf8');

describe('P0-B role bootstrap root/postgres NOEXEC candidate', () => {
  test('all retained SQL payloads are comments only', async () => {
    for (const name of ['forward.sql.NOEXEC', 'verify.sql.NOEXEC', 'inverse.sql.NOEXEC']) {
      const sql = await text(name);
      expect(sql.split(/\r?\n/).filter(Boolean).every(line => line.startsWith('--'))).toBe(true);
    }
  });
  test('is explicitly root/postgres-only and non-executable through gbrain', async () => {
    const manifest = JSON.parse(await text('manifest.json'));
    expect(manifest.execution_state).toBe('ROOT_POSTGRES_NOEXEC_CANDIDATE');
    expect(manifest.required_os_identity).toBe('root');
    expect(manifest.required_database_session_user).toBe('postgres');
    expect(manifest.current_gbrain_connection_can_execute).toBe(false);
    expect(manifest.authorization_nonce_claim).toBe('REQUIRES_SEPARATE_ROOT_COMMITTED_CLAIM');
  });

  test('pins complete role posture and PG16 membership options', async () => {
    const sql = await text('forward.sql.NOEXEC');
    for (const marker of [
      'CREATE ROLE gbrain_p0b_owner NOLOGIN NOINHERIT',
      'CREATE ROLE gbrain_p0b_runtime LOGIN NOINHERIT',
      'CREATE ROLE gbrain_p0b_migrator LOGIN NOINHERIT',
      'NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1',
      'GRANT gbrain_p0b_owner TO gbrain_p0b_migrator WITH INHERIT FALSE, SET TRUE',
      'GRANT USAGE ON SCHEMA public TO gbrain_p0b_runtime',
      'GRANT USAGE, CREATE ON SCHEMA public TO gbrain_p0b_owner',
    ]) expect(sql).toContain(marker);
  });

  test('verify includes PUBLIC OID0, exact schema ACL, roles, memberships, and derived receipt digest', async () => {
    const sql = await text('verify.sql.NOEXEC');
    for (const marker of [
      'rolinherit', 'rolconnlimit', 'rolvaliduntil', 'admin_option',
      'inherit_option', 'set_option', "CASE WHEN acl.grantee=0 THEN 'PUBLIC'",
      'nspacl', 'aclexplode', 'P0B_BOOTSTRAP_ROLE_SET_MISMATCH',
      'P0B_BOOTSTRAP_MEMBERSHIP_SET_MISMATCH', 'P0B_BOOTSTRAP_SCHEMA_ACL_SET_MISMATCH',
      "digest(role_projection,'sha256')", 'P0B_ROLE_BOOTSTRAP_VERIFY_OK',
    ]) expect(sql).toContain(marker);
  });

  test('inverse refuses dependencies and restores exact v4C.3 public schema ACL', async () => {
    const sql = await text('inverse.sql.NOEXEC');
    expect(sql).toContain('P0B_BOOTSTRAP_DEPENDENCIES_PRESENT');
    expect(sql).toContain('REVOKE ALL ON SCHEMA public FROM gbrain_p0b_runtime');
    expect(sql).toContain('REVOKE ALL ON SCHEMA public FROM gbrain_p0b_owner');
    expect(sql).toContain('DROP ROLE gbrain_p0b_runtime');
    expect(sql).toContain('DROP ROLE gbrain_p0b_migrator');
    expect(sql).toContain('DROP ROLE gbrain_p0b_owner');
  });
});
