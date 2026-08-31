import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  P0B_SCHEMA_EXECUTION_STATE,
  runP0BGoogleSchema,
} from '../scripts/run-p0b-google-schema.ts';

const root = join(import.meta.dir, '..');
const packageDir = join(root, 'ops', 'p0b-google-schema');
const text = (name: string) => readFile(join(packageDir, name), 'utf8');

const requiredCatalogSurfaces = [
  'pg_attribute', 'pg_attrdef', 'pg_constraint', 'pg_get_constraintdef',
  'pg_index', 'pg_get_indexdef', 'pg_trigger', 'pg_get_triggerdef',
  'pg_policy', 'polpermissive', 'polroles', 'pg_get_expr',
  'aclexplode', 'acl.grantee = 0', 'is_grantable', 'relforcerowsecurity',
  'nspacl',
] as const;

describe('P0-B Google schema blocked candidate', () => {
  test('all retained SQL payloads are comments only', async () => {
    for (const name of ['forward.sql.NOEXEC', 'verify.sql.NOEXEC', 'inverse.sql.NOEXEC']) {
      const sql = await text(name);
      expect(sql.split(/\r?\n/).filter(Boolean).every(line => line.startsWith('--'))).toBe(true);
    }
  });
  test('runner is fail-closed before reading input or touching an engine', async () => {
    expect(P0B_SCHEMA_EXECUTION_STATE).toBe('BLOCKED_PREREQUISITES_NOEXEC');
    let reads = 0;
    const input = new Proxy({}, { get() { reads += 1; throw new Error('must not read'); } });
    await expect(runP0BGoogleSchema(input as never)).rejects.toThrow('P0B_SCHEMA_BLOCKED_DURABLE_NONCE_LAUNCHER_REQUIRED');
    expect(reads).toBe(0);
  });

  test('manifest binds exact v4C.3 relation identity and prerequisite bootstrap receipt', async () => {
    const manifest = JSON.parse(await text('manifest.json'));
    expect(manifest.execution_state).toBe('BLOCKED_PREREQUISITES_NOEXEC');
    expect(manifest.topology_receipt_sha256).toBe('067e7a1689a08ca73be2df7881ccef4b84ad1a78c02e9d20652712b3d8f60811');
    expect(manifest.baseline_relation_identity_sha256).toBe('5a5f074ee59c66440881c2a791a8b96c47fdec2783d87a7b8bd219e86fd4f655');
    expect(manifest.prerequisites.role_bootstrap_receipt).toBe('REQUIRED_NOT_PRESENT');
    expect(manifest.prerequisites.durable_nonce_launcher).toBe('REQUIRED_NOT_IMPLEMENTED');
  });

  test('forward rejects every prefix object and malformed partial/no-op state before success', async () => {
    const sql = await text('forward.sql.NOEXEC');
    expect(sql).toContain('P0B_V4C3_BASELINE_IDENTITY_MISMATCH');
    expect(sql).toContain('5a5f074ee59c66440881c2a791a8b96c47fdec2783d87a7b8bd219e86fd4f655');
    expect(sql).toContain("c.relname LIKE 'p0b_google_%'");
    expect(sql).toContain("c.relkind NOT IN ('r','i')");
    expect(sql).toContain('P0B_UNEXPECTED_PREFIX_OBJECT');
    expect(sql).toContain('P0B_PARTIAL_OR_CONFLICTING_SCHEMA');
    expect(sql).toContain('P0B_EXACT_SCHEMA_ATTESTATION_FAILED');
    expect(sql).not.toMatch(/CREATE\s+ROLE/i);
  });

  test('schema restores FK, canonical state, lease, fence, checkpoint, and nonce invariants', async () => {
    const sql = await text('forward.sql.NOEXEC');
    for (const marker of [
      'p0b_google_embedding_provenance_chunk_fk',
      'REFERENCES public.content_chunks(id) ON DELETE CASCADE',
      'p0b_google_bridge_state_json_ck',
      "state_json = current_setting('gbrain.p0b.initial_state_json')::jsonb",
      'p0b_google_reconciler_checkpoint_lease_ck',
      'p0b_google_reconciler_checkpoint_fence_ck',
      'p0b_google_control_nonce_ledger_nonce_ck',
      'octet_length(nonce) BETWEEN 32 AND 128',
    ]) expect(sql).toContain(marker);
  });

  test('verify compares complete catalog sets and derives both hashes from catalogs', async () => {
    const sql = await text('verify.sql.NOEXEC');
    for (const marker of requiredCatalogSurfaces) expect(sql).toContain(marker);
    expect(sql).toContain('digest(role_projection,\'sha256\')');
    expect(sql).toContain('digest(rls_projection,\'sha256\')');
    expect(sql).not.toContain("current_setting('gbrain.p0b.expected_role_policy_sha256') AS role_policy_sha256");
    expect(sql).not.toContain("current_setting('gbrain.p0b.expected_rls_policy_sha256') AS rls_policy_sha256");
    expect(sql).toContain('P0B_SCHEMA_ACL_SET_MISMATCH');
    expect(sql).toContain('P0B_TABLE_ACL_SET_MISMATCH');
    expect(sql).toContain('P0B_POLICY_SET_MISMATCH');
  });

  test('inverse requires exact canonical initial rows and full schema attestation before drops', async () => {
    const sql = await text('inverse.sql.NOEXEC');
    expect(sql).toContain("state_json = current_setting('gbrain.p0b.initial_state_json')::jsonb");
    expect(sql).toContain("schema_identity='gbrain:p0b:google-g768-control-postgres:v1'");
    expect(sql).toContain("revision=current_setting('gbrain.p0b.initial_checkpoint_revision')");
    expect(sql).toContain("fence_token='fence-00000000000000000000'");
    expect(sql).toContain('P0B_EXACT_SCHEMA_ATTESTATION_FAILED');
    expect(sql).toContain('P0B_PRESERVATION_PLAN_REQUIRED');
  });
});
