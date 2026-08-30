import { describe, expect, test } from 'bun:test';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  P0B_SCHEMA_EXECUTION_STATE,
  runP0BGoogleSchema,
} from '../scripts/run-p0b-google-schema.ts';

const root = join(import.meta.dir, '..');
const packageDir = join(root, 'ops', 'p0b-google-schema');
const paths = {
  forward: join(packageDir, 'forward.sql.NOEXEC'),
  inverse: join(packageDir, 'inverse.sql.NOEXEC'),
  verify: join(packageDir, 'verify.sql.NOEXEC'),
  manifest: join(packageDir, 'manifest.template.json'),
  runner: join(root, 'scripts', 'run-p0b-google-schema.ts'),
  test: import.meta.path,
} as const;

const governedTables = [
  'p0b_google_bridge_state',
  'p0b_google_reconciler_checkpoint',
  'p0b_google_control_nonce_ledger',
  'p0b_google_embedding_provenance',
  'p0b_google_acl_rls_receipt',
] as const;

const namedConstraints = [
  'p0b_google_bridge_state_pkey',
  'p0b_google_bridge_state_singleton_ck',
  'p0b_google_bridge_state_identity_ck',
  'p0b_google_bridge_state_fingerprint_ck',
  'p0b_google_bridge_state_json_ck',
  'p0b_google_reconciler_checkpoint_pkey',
  'p0b_google_reconciler_checkpoint_state_fk',
  'p0b_google_reconciler_checkpoint_identity_ck',
  'p0b_google_reconciler_checkpoint_revision_ck',
  'p0b_google_reconciler_checkpoint_pass_ck',
  'p0b_google_reconciler_checkpoint_cursor_ck',
  'p0b_google_reconciler_checkpoint_fence_ck',
  'p0b_google_reconciler_checkpoint_lease_ck',
  'p0b_google_control_nonce_ledger_pkey',
  'p0b_google_control_nonce_ledger_state_fk',
  'p0b_google_control_nonce_ledger_action_ck',
  'p0b_google_control_nonce_ledger_nonce_ck',
  'p0b_google_control_nonce_ledger_state_fp_ck',
  'p0b_google_control_nonce_ledger_revision_ck',
  'p0b_google_embedding_provenance_pkey',
  'p0b_google_embedding_provenance_chunk_fk',
  'p0b_google_embedding_provenance_model_ck',
  'p0b_google_embedding_provenance_dims_ck',
  'p0b_google_embedding_provenance_hash_ck',
  'p0b_google_acl_rls_receipt_pkey',
  'p0b_google_acl_rls_receipt_state_fk',
  'p0b_google_acl_rls_receipt_identity_ck',
  'p0b_google_acl_rls_receipt_status_ck',
] as const;

async function text(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

function expectNoDangerousPayload(value: string): void {
  expect(value).not.toMatch(/postgres(?:ql)?:\/\//i);
  expect(value).not.toMatch(/(?:password|api[_-]?key|client[_-]?secret)\s*[=:]/i);
  expect(value).not.toMatch(/\bHNSW\b/i);
  expect(value).not.toMatch(/\bDROP\b[^;]*\bCASCADE\b/i);
  expect(value).not.toMatch(/\bCREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i);
  expect(value).not.toMatch(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i);
  expect(value).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i);
}

function expectQualifiedDdl(sql: string): void {
  expect(sql).not.toMatch(/^\s*(?:ALTER|CREATE|DROP)\s+TABLE\s+(?!public\.)p0b_google_/im);
  expect(sql).not.toMatch(/^\s*(?:ALTER|CREATE|DROP)\s+(?:TABLE\s+)?(?!public\.)content_chunks\b/im);
  expect(sql).not.toMatch(/^\s*(?:CREATE|DROP)\s+INDEX\s+(?!public\.)idx_content_chunks_p0b_g768_keyset\b/im);
}

describe('offline governed P0-B schema NOEXEC template', () => {
  test('exports an exact unconditional execution gate and performs zero engine calls', async () => {
    expect(P0B_SCHEMA_EXECUTION_STATE).toBe('UNFINALIZED_NOEXEC');
    let inputReads = 0;
    let reservedCalls = 0;
    const poisonedInput = new Proxy({}, {
      get() {
        inputReads += 1;
        throw new Error('INPUT_MUST_NOT_BE_READ');
      },
    });
    const engine = {
      kind: 'postgres' as const,
      async withReservedConnection() {
        reservedCalls += 1;
        throw new Error('ENGINE_MUST_NOT_BE_CALLED');
      },
    };

    await expect(runP0BGoogleSchema(poisonedInput as never)).rejects.toThrow('P0B_SCHEMA_UNFINALIZED_NOEXEC');
    await expect(runP0BGoogleSchema({ engine } as never)).rejects.toThrow('P0B_SCHEMA_UNFINALIZED_NOEXEC');
    expect(inputReads).toBe(0);
    expect(reservedCalls).toBe(0);
  });

  test('is six regular non-executable files outside the migration chain', async () => {
    expect(Object.values(paths)).toHaveLength(6);
    for (const path of Object.values(paths)) {
      const stat = await lstat(path);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o111).toBe(0);
    }
    const migrate = await text(join(root, 'src', 'core', 'migrate.ts'));
    const config = await text(join(root, 'src', 'core', 'config.ts'));
    expect(migrate).not.toContain('p0b-google-schema');
    expect(migrate).not.toContain('embedding_g768');
    expect(config).not.toContain('p0b-google-schema');
  });

  test('forward is PG16-valid, qualified, ACL-blocked, and exactly attests full core shape', async () => {
    const sql = await text(paths.forward);
    expectNoDangerousPayload(sql);
    expectQualifiedDdl(sql);
    expect(sql).toContain("(state_json - ARRAY[");
    expect(sql).toContain(") = '{}'::jsonb");
    expect(sql).not.toContain('jsonb_object_length');
    expect(sql).toContain('P0B_CONTENT_CHUNKS_ACL_ATTESTATION_REQUIRED');
    expect(sql).toContain('P0B_EXACT_CORE_ATTESTATION');
    expect(sql).toContain('P0B_PARTIAL_OR_CONFLICTING_SCHEMA');
    expect(sql).toContain('expected_columns');
    expect(sql).toContain('expected_constraints');
    expect(sql).toContain('pg_get_constraintdef');
    expect(sql).toContain('relacl');
    expect(sql).toContain('aclexplode');
    expect(sql).toContain('pg_trigger');
    expect(sql).toContain('tgisinternal');
    expect(sql).toContain('public.idx_content_chunks_p0b_g768_keyset');
    expect(sql).toContain('ALTER TABLE public.content_chunks ADD COLUMN embedding_g768 vector(768)');
    for (const table of governedTables) expect(sql).toContain(`CREATE TABLE public.${table}`);
    for (const constraint of namedConstraints) expect(sql).toContain(constraint);
  });

  test('inverse duplicates exact core attestation before qualified destructive statements', async () => {
    const sql = await text(paths.inverse);
    expectNoDangerousPayload(sql);
    expectQualifiedDdl(sql);
    const attestation = sql.indexOf('P0B_EXACT_CORE_ATTESTATION');
    const firstDrop = sql.indexOf('DROP INDEX public.idx_content_chunks_p0b_g768_keyset');
    expect(attestation).toBeGreaterThan(-1);
    expect(firstDrop).toBeGreaterThan(attestation);
    for (const marker of [
      'expected_columns', 'expected_constraints', 'pg_get_constraintdef', 'relacl',
      'aclexplode', 'pg_trigger', 'tgisinternal', 'P0B_PRESERVATION_PLAN_NOT_IMPLEMENTED',
      "'ACTIVE'", "'COMPENSATING'", 'lease_expires_at > clock_timestamp()',
      'embedding_g768 IS NOT NULL', 'indisvalid', 'indisready',
    ]) expect(sql).toContain(marker);
    for (const constraint of namedConstraints) expect(sql).toContain(constraint);
    for (const table of governedTables) expect(sql).toContain(`DROP TABLE public.${table}`);
    expect(sql).toContain('ALTER TABLE public.content_chunks DROP COLUMN embedding_g768');
  });

  test('verify has no reachable success and requires a future SQL-derived ACL/RLS verifier', async () => {
    const sql = await text(paths.verify);
    expectNoDangerousPayload(sql);
    expect(sql).toContain('P0B_ACL_RLS_VERIFIER_NOT_FINALIZED');
    expect(sql).toContain('P0B_POLICY_CATALOG_DIGEST_REQUIRED');
    expect(sql).not.toContain('P0B_VERIFY_OK');
    expect(sql).not.toMatch(/acl_status\s*=\s*'RATIFIED'/);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
  });

  test('runner keeps future implementation internal and pins/readbacks exact search_path', async () => {
    const source = await text(paths.runner);
    expectNoDangerousPayload(source);
    expect(source).toContain("export const P0B_SCHEMA_EXECUTION_STATE = 'UNFINALIZED_NOEXEC' as const");
    expect(source).toContain("throw new Error('P0B_SCHEMA_UNFINALIZED_NOEXEC')");
    expect(source).toContain("'search_path', 'pg_catalog, public'");
    expect(source).toContain("current_setting('search_path')");
    expect(source).toContain('P0B_SEARCH_PATH_ATTESTATION_FAILED');
    expect(source).toContain('manifest_semantic_sha256');
    expect(source).not.toContain('manifest_sha256');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('process.argv');
    expect(source).not.toContain('new PostgresEngine');
    expect(source.match(/export\s+async\s+function\s+/g)).toEqual(['export async function ']);
  });

  test('manifest is an honest six-file unfinalized template with deterministic non-circular root semantics', async () => {
    const manifestText = await text(paths.manifest);
    expectNoDangerousPayload(manifestText);
    const manifest = JSON.parse(manifestText) as Record<string, any>;
    expect(manifest.execution_state).toBe('UNFINALIZED_NOEXEC');
    expect(manifest.parent_commit_sha).toBe('8389f684d44492d04559bc3d876e302b6a0ec196');
    expect(manifest.candidate_commit_sha).toBe('REPLACE_WITH_FINAL_CANDIDATE_COMMIT_SHA');
    expect(manifest.acl_rls.status).toBe('UNRATIFIED_BLOCKED');
    expect(manifest.acl_rls).toMatchObject({
      live_postgres_rehearsal: 'REQUIRED_NOT_PERFORMED',
      role_authority_finalization: 'REQUIRED_NOT_PERFORMED',
      rls_policy_catalog_digest: null,
      content_chunks_acl_package_digest: null,
    });
    expect(Object.keys(manifest.files).sort()).toEqual([
      'FORWARD', 'INVERSE', 'MANIFEST_TEMPLATE', 'RUNNER', 'STATIC_TEST', 'VERIFY',
    ]);
    expect(manifest.package_root_definition).toContain('manifest semantic projection');
    expect(manifest.package_root_definition).toContain('raw SHA-256');
    expect(manifest.manifest_semantic_sha256).toContain('REPLACE_WITH_');
    expect(manifest).not.toHaveProperty('manifest_sha256');
    for (const [name, file] of Object.entries(manifest.files) as Array<[string, any]>) {
      expect(file.path).toBeString();
      expect(file.path).not.toBe('');
      if (name === 'MANIFEST_TEMPLATE') {
        expect(file.digest_kind).toBe('CANONICAL_SEMANTIC_PROJECTION_SHA256');
      } else {
        expect(file.sha256).toContain('REPLACE_WITH_');
      }
    }
  });
});
