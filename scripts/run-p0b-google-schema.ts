import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReservedConnection } from '../src/core/engine.ts';
import { fingerprintP0BState } from '../src/core/p0b-additive-bridge.ts';

// This exact exported literal is the compile-time and runtime release fence.
// A separately reviewed finalization must change it before any input is read.
export const P0B_SCHEMA_EXECUTION_STATE = 'UNFINALIZED_NOEXEC' as const;
export const P0B_SCHEMA_PARENT_COMMIT = '8389f684d44492d04559bc3d876e302b6a0ec196';
const P0B_SCHEMA_CANDIDATE_COMMIT = 'REPLACE_WITH_FINAL_CANDIDATE_COMMIT_SHA';
export const PINNED_PACKAGE_DIRECTORY = fileURLToPath(
  new URL('../ops/p0b-google-schema/', import.meta.url),
);
export const ACTION_FILE = Object.freeze({
  FORWARD: 'forward.sql.NOEXEC',
  INVERSE: 'inverse.sql.NOEXEC',
  VERIFY: 'verify.sql.NOEXEC',
} as const);

const PACKAGE_KIND = 'gbrain-p0b-google-schema-noexec-v1';
const DIGEST_RE = /^[a-f0-9]{64}$/;

const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{2,127}$/;
const ROLE_RE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const NONCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$/;
const MAX_AUTHORIZATION_WINDOW_MS = 5 * 60 * 1000;
const INITIAL_STATE_FINGERPRINT = 'f58df3d1ad29e2901d947f6890fc21e6cc4771bfeb4f432942e052116070db78';
const INITIAL_CHECKPOINT_REVISION = '1366bb803287ce685bb96de2ba89f57a140b69e612cd7bcbf83145807dca11d7';

type Action = keyof typeof ACTION_FILE;

interface RunnerEngine {
  readonly kind: 'postgres' | 'pglite';
  readonly withReservedConnection: <T>(work: (connection: ReservedConnection) => Promise<T>) => Promise<T>;
}

export interface P0BSchemaRoleAuthority {
  readonly authenticity: 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED';
  readonly expected_candidate_commit_sha: string;
  readonly expected_package_root_sha256: string;
  readonly expected_manifest_semantic_sha256: string;
  readonly expected_migrator_role: string;
  readonly expected_owner_role: string;
  readonly allowed_actors: readonly string[];
  readonly now_epoch_ms: () => number;
}

export interface RunP0BGoogleSchemaInput {
  readonly engine: RunnerEngine;
  readonly action: Action;
  readonly manifest: unknown;
  readonly authorization: unknown;
  readonly role_authority: P0BSchemaRoleAuthority;
}

export interface P0BSchemaReceipt {
  readonly schema_version: 1;
  readonly status: 'P0B_SCHEMA_ACTION_OK';
  readonly action: Action;
  readonly candidate_commit_sha: string;
  readonly package_root_sha256: string;
  readonly manifest_semantic_sha256: string;
  readonly sql_file_sha256: string;
}

interface FileEntry { readonly path: string; readonly sha256: string }
interface InitialState {
  readonly state: 'DRAFT';
  readonly state_json: {
    readonly schema_version: 1;
    readonly state: 'DRAFT';
    readonly previous_search_column: 'embedding_ze';
    readonly consumed_nonces: readonly [];
    readonly rollback_target: null;
    readonly fingerprint: string;
  };
  readonly state_fingerprint: string;
  readonly checkpoint_revision: string;
  readonly fence_epoch: '0';
  readonly fence_token: 'fence-00000000000000000000';
  readonly lease_id: 'inactive';
  readonly lease_nonce: 'inactive';
  readonly lease_expires_at: '-infinity';
}
interface AclRlsManifest {
  readonly status: 'UNRATIFIED_BLOCKED';
  readonly role_policy_sha256: null;
  readonly rls_policy_sha256: null;
  readonly expected_policy_count: number;
  readonly rls_policy_catalog_digest: null;
  readonly content_chunks_acl_package_digest: null;
  readonly live_postgres_rehearsal: 'REQUIRED_NOT_PERFORMED';
  readonly role_authority_finalization: 'REQUIRED_NOT_PERFORMED';
}
interface Manifest {
  readonly schema_version: 1;
  readonly package_kind: typeof PACKAGE_KIND;
  readonly execution_state: typeof P0B_SCHEMA_EXECUTION_STATE;
  readonly parent_commit_sha: typeof P0B_SCHEMA_PARENT_COMMIT;
  readonly candidate_commit_sha: string;
  readonly package_root_sha256: string;
  readonly package_root_definition: string;
  readonly manifest_semantic_sha256: string;
  readonly files: Readonly<Record<Action, FileEntry>> & {
    readonly RUNNER: FileEntry;
    readonly STATIC_TEST: FileEntry;
    readonly MANIFEST_TEMPLATE: {
      readonly path: 'manifest.template.json';
      readonly digest_kind: 'CANONICAL_SEMANTIC_PROJECTION_SHA256';
    };
  };
  readonly initial_state: InitialState;
  readonly acl_rls: AclRlsManifest;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('P0B_INVALID_RECORD');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('P0B_INVALID_PROTOTYPE');
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).some(key => typeof key !== 'string')) throw new Error('P0B_INVALID_KEY');
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('P0B_INVALID_PROPERTY');
  }
  return record;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = dataRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('P0B_RECORD_SHAPE_MISMATCH');
  }
  return record;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new Error('P0B_INVALID_DIGEST');
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('P0B_INVALID_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = dataRecord(value);
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function parseFileEntry(value: unknown, expectedPath: string): FileEntry {
  const record = exactRecord(value, ['path', 'sha256']);
  if (record.path !== expectedPath) throw new Error('P0B_FILE_PATH_MISMATCH');
  return Object.freeze({ path: expectedPath, sha256: digest(record.sha256) });
}

function parseInitialState(value: unknown): InitialState {
  const record = exactRecord(value, [
    'state', 'state_json', 'state_fingerprint', 'checkpoint_revision', 'fence_epoch',
    'fence_token', 'lease_id', 'lease_nonce', 'lease_expires_at',
  ]);
  const stateJson = exactRecord(record.state_json, [
    'schema_version', 'state', 'previous_search_column', 'consumed_nonces',
    'rollback_target', 'fingerprint',
  ]);
  if (record.state !== 'DRAFT' || stateJson.schema_version !== 1 || stateJson.state !== 'DRAFT'
    || stateJson.previous_search_column !== 'embedding_ze' || !Array.isArray(stateJson.consumed_nonces)
    || stateJson.consumed_nonces.length !== 0 || stateJson.rollback_target !== null
    || stateJson.fingerprint !== INITIAL_STATE_FINGERPRINT
    || record.state_fingerprint !== INITIAL_STATE_FINGERPRINT
    || record.checkpoint_revision !== INITIAL_CHECKPOINT_REVISION
    || record.fence_epoch !== '0' || record.fence_token !== 'fence-00000000000000000000'
    || record.lease_id !== 'inactive' || record.lease_nonce !== 'inactive'
    || record.lease_expires_at !== '-infinity') throw new Error('P0B_INITIAL_STATE_MISMATCH');
  const computed = fingerprintP0BState({
    schema_version: 1,
    state: 'DRAFT',
    previous_search_column: 'embedding_ze',
    consumed_nonces: [],
    rollback_target: null,
  });
  if (computed !== INITIAL_STATE_FINGERPRINT) throw new Error('P0B_INITIAL_FINGERPRINT_MISMATCH');
  return Object.freeze({
    state: 'DRAFT',
    state_json: Object.freeze({
      schema_version: 1, state: 'DRAFT', previous_search_column: 'embedding_ze',
      consumed_nonces: Object.freeze([]) as readonly [], rollback_target: null,
      fingerprint: INITIAL_STATE_FINGERPRINT,
    }),
    state_fingerprint: INITIAL_STATE_FINGERPRINT,
    checkpoint_revision: INITIAL_CHECKPOINT_REVISION,
    fence_epoch: '0', fence_token: 'fence-00000000000000000000',
    lease_id: 'inactive', lease_nonce: 'inactive', lease_expires_at: '-infinity',
  });
}

function parseAclRls(value: unknown): AclRlsManifest {
  const record = exactRecord(value, [
    'status', 'role_policy_sha256', 'rls_policy_sha256', 'expected_policy_count',
    'rls_policy_catalog_digest', 'content_chunks_acl_package_digest',
    'live_postgres_rehearsal', 'role_authority_finalization',
  ]);
  // RATIFIED is intentionally not part of this lineage's accepted grammar.
  if (record.status !== 'UNRATIFIED_BLOCKED'
    || record.role_policy_sha256 !== null || record.rls_policy_sha256 !== null
    || record.expected_policy_count !== 0
    || record.rls_policy_catalog_digest !== null
    || record.content_chunks_acl_package_digest !== null
    || record.live_postgres_rehearsal !== 'REQUIRED_NOT_PERFORMED'
    || record.role_authority_finalization !== 'REQUIRED_NOT_PERFORMED') {
    throw new Error('P0B_UNRATIFIED_RECEIPT_MISMATCH');
  }
  return Object.freeze({
    status: 'UNRATIFIED_BLOCKED', role_policy_sha256: null, rls_policy_sha256: null,
    expected_policy_count: 0, rls_policy_catalog_digest: null,
    content_chunks_acl_package_digest: null,
    live_postgres_rehearsal: 'REQUIRED_NOT_PERFORMED',
    role_authority_finalization: 'REQUIRED_NOT_PERFORMED',
  });
}

function parseManifest(value: unknown): Manifest {
  const record = exactRecord(value, [
    'schema_version', 'package_kind', 'execution_state', 'parent_commit_sha',
    'candidate_commit_sha', 'package_root_sha256', 'package_root_definition',
    'manifest_semantic_sha256', 'files', 'initial_state', 'acl_rls',
  ]);
  if (record.schema_version !== 1 || record.package_kind !== PACKAGE_KIND
    || record.execution_state !== P0B_SCHEMA_EXECUTION_STATE
    || record.parent_commit_sha !== P0B_SCHEMA_PARENT_COMMIT
    || record.candidate_commit_sha !== P0B_SCHEMA_CANDIDATE_COMMIT
    || record.package_root_definition !== PACKAGE_ROOT_DEFINITION) {
    throw new Error('P0B_MANIFEST_IDENTITY_MISMATCH');
  }
  const files = exactRecord(record.files, [
    'FORWARD', 'INVERSE', 'VERIFY', 'RUNNER', 'STATIC_TEST', 'MANIFEST_TEMPLATE',
  ]);
  const manifestEntry = exactRecord(files.MANIFEST_TEMPLATE, ['path', 'digest_kind']);
  if (manifestEntry.path !== 'manifest.template.json'
    || manifestEntry.digest_kind !== 'CANONICAL_SEMANTIC_PROJECTION_SHA256') {
    throw new Error('P0B_MANIFEST_ENTRY_MISMATCH');
  }
  return Object.freeze({
    schema_version: 1,
    package_kind: PACKAGE_KIND,
    execution_state: P0B_SCHEMA_EXECUTION_STATE,
    parent_commit_sha: P0B_SCHEMA_PARENT_COMMIT,
    candidate_commit_sha: String(record.candidate_commit_sha),
    package_root_sha256: digest(record.package_root_sha256),
    package_root_definition: PACKAGE_ROOT_DEFINITION,
    manifest_semantic_sha256: digest(record.manifest_semantic_sha256),
    files: Object.freeze({
      FORWARD: parseFileEntry(files.FORWARD, ACTION_FILE.FORWARD),
      INVERSE: parseFileEntry(files.INVERSE, ACTION_FILE.INVERSE),
      VERIFY: parseFileEntry(files.VERIFY, ACTION_FILE.VERIFY),
      RUNNER: parseFileEntry(files.RUNNER, '../../scripts/run-p0b-google-schema.ts'),
      STATIC_TEST: parseFileEntry(files.STATIC_TEST, '../../test/p0b-google-schema-static.test.ts'),
      MANIFEST_TEMPLATE: Object.freeze({
        path: 'manifest.template.json' as const,
        digest_kind: 'CANONICAL_SEMANTIC_PROJECTION_SHA256' as const,
      }),
    }),
    initial_state: parseInitialState(record.initial_state),
    acl_rls: parseAclRls(record.acl_rls),
  });
}

const PACKAGE_ROOT_DEFINITION = 'SHA256 of canonical JSON containing manifest_semantic_sha256 plus raw SHA-256 entries for FORWARD, INVERSE, VERIFY, RUNNER, and STATIC_TEST; manifest semantic projection excludes package_root_sha256 and manifest_semantic_sha256';

function manifestSemanticDigest(manifest: Manifest): string {
  return sha256(canonicalJson({
    schema_version: manifest.schema_version,
    package_kind: manifest.package_kind,
    execution_state: manifest.execution_state,
    parent_commit_sha: manifest.parent_commit_sha,
    candidate_commit_sha: manifest.candidate_commit_sha,
    package_root_definition: manifest.package_root_definition,
    files: manifest.files,
    initial_state: manifest.initial_state,
    acl_rls: manifest.acl_rls,
  }));
}

function packageRootDigest(manifest: Manifest): string {
  return sha256(canonicalJson({
    manifest_semantic_sha256: manifest.manifest_semantic_sha256,
    files: {
      FORWARD: manifest.files.FORWARD,
      INVERSE: manifest.files.INVERSE,
      VERIFY: manifest.files.VERIFY,
      RUNNER: manifest.files.RUNNER,
      STATIC_TEST: manifest.files.STATIC_TEST,
    },
  }));
}

function parseRoleAuthority(value: P0BSchemaRoleAuthority): Readonly<P0BSchemaRoleAuthority> {
  const record = exactRecord(value, [
    'authenticity', 'expected_candidate_commit_sha', 'expected_package_root_sha256',
    'expected_manifest_semantic_sha256', 'expected_migrator_role', 'expected_owner_role',
    'allowed_actors', 'now_epoch_ms',
  ]);
  if (record.authenticity !== 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED'
    || record.expected_candidate_commit_sha !== P0B_SCHEMA_CANDIDATE_COMMIT
    || typeof record.expected_migrator_role !== 'string' || !ROLE_RE.test(record.expected_migrator_role)
    || typeof record.expected_owner_role !== 'string' || !ROLE_RE.test(record.expected_owner_role)
    || !Array.isArray(record.allowed_actors) || record.allowed_actors.length === 0
    || record.allowed_actors.some(actor => typeof actor !== 'string' || !ACTOR_RE.test(actor))
    || typeof record.now_epoch_ms !== 'function') throw new Error('P0B_ROLE_AUTHORITY_INVALID');
  return Object.freeze({
    authenticity: 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED',
    expected_candidate_commit_sha: P0B_SCHEMA_CANDIDATE_COMMIT,
    expected_package_root_sha256: digest(record.expected_package_root_sha256),
    expected_manifest_semantic_sha256: digest(record.expected_manifest_semantic_sha256),
    expected_migrator_role: record.expected_migrator_role,
    expected_owner_role: record.expected_owner_role,
    allowed_actors: Object.freeze([...(record.allowed_actors as string[])]),
    now_epoch_ms: record.now_epoch_ms as () => number,
  });
}

function validateAuthorization(
  value: unknown,
  action: Action,
  manifest: Manifest,
  manifestSemanticSha: string,
  authority: Readonly<P0BSchemaRoleAuthority>,
): void {
  const record = exactRecord(value, [
    'schema_version', 'action', 'candidate_commit_sha', 'package_root_sha256',
    'manifest_semantic_sha256', 'actor', 'issued_at_epoch_ms', 'expires_at_epoch_ms',
    'nonce', 'owner_go',
  ]);
  let now: number;
  try { now = authority.now_epoch_ms.call(authority); } catch { throw new Error('P0B_AUTHORITY_CLOCK_FAILED'); }
  if (!Number.isSafeInteger(now) || now < 0
    || record.schema_version !== 1 || record.action !== action
    || record.candidate_commit_sha !== manifest.candidate_commit_sha
    || record.package_root_sha256 !== manifest.package_root_sha256
    || record.manifest_semantic_sha256 !== manifestSemanticSha
    || typeof record.actor !== 'string' || !authority.allowed_actors.includes(record.actor)
    || !Number.isSafeInteger(record.issued_at_epoch_ms) || !Number.isSafeInteger(record.expires_at_epoch_ms)
    || (record.issued_at_epoch_ms as number) > now || (record.expires_at_epoch_ms as number) <= now
    || (record.expires_at_epoch_ms as number) - (record.issued_at_epoch_ms as number) > MAX_AUTHORIZATION_WINDOW_MS
    || typeof record.nonce !== 'string' || !NONCE_RE.test(record.nonce)
    || record.owner_go !== `AUTHORIZE_GBRAIN_P0B_SCHEMA_${action}`) {
    throw new Error('P0B_AUTHORIZATION_INVALID');
  }
}

async function readPinnedSql(action: Action, expectedSha: string): Promise<string> {
  const packageStat = await lstat(PINNED_PACKAGE_DIRECTORY);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new Error('P0B_PACKAGE_DIRECTORY_UNSAFE');
  const pinnedReal = await realpath(PINNED_PACKAGE_DIRECTORY);
  if (pinnedReal !== resolve(PINNED_PACKAGE_DIRECTORY)) throw new Error('P0B_PACKAGE_DIRECTORY_REDIRECTED');
  const path = join(PINNED_PACKAGE_DIRECTORY, ACTION_FILE[action]);
  if (dirname(path) !== resolve(PINNED_PACKAGE_DIRECTORY)) throw new Error('P0B_FILE_PATH_ESCAPE');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0) throw new Error('P0B_FILE_UNSAFE');
  if (await realpath(path) !== resolve(path)) throw new Error('P0B_FILE_REDIRECTED');
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedSha) throw new Error('P0B_FILE_CHECKSUM_MISMATCH');
  return bytes.toString('utf8');
}

async function setLocal(tx: ReservedConnection, name: string, value: string): Promise<void> {
  const rows = await tx.executeRaw<{ configured: string }>(
    'SELECT set_config($1, $2, true) AS configured', [name, value],
  );
  if (rows.length !== 1 || rows[0]?.configured !== value) throw new Error('P0B_TRANSACTION_SETTING_FAILED');
}

async function preflight(connection: ReservedConnection, authority: Readonly<P0BSchemaRoleAuthority>): Promise<void> {
  const rows = await connection.executeRaw<{
    server_version_num: string;
    current_user: string;
    session_user: string;
    current_role: string;
    vector_extension_count: string;
    vector_type_count: string;
    migrator_is_owner_member: boolean;
  }>(`
SELECT
  current_setting('server_version_num') AS server_version_num,
  current_user::text AS current_user,
  session_user::text AS session_user,
  current_role::text AS current_role,
  (SELECT count(*)::text FROM pg_extension WHERE extname = 'vector') AS vector_extension_count,
  (SELECT count(*)::text FROM pg_type WHERE oid = to_regtype('vector')) AS vector_type_count,
  pg_has_role($1, $2, 'MEMBER') AS migrator_is_owner_member
`.trim(), [authority.expected_migrator_role, authority.expected_owner_role]);
  const row = rows[0];
  if (rows.length !== 1 || !row || Number.parseInt(row.server_version_num, 10) < 160000
    || Number.parseInt(row.server_version_num, 10) >= 170000
    || row.current_user !== authority.expected_owner_role
    || row.current_role !== authority.expected_owner_role
    || row.session_user !== authority.expected_migrator_role
    || row.vector_extension_count !== '1' || row.vector_type_count !== '1'
    || row.migrator_is_owner_member !== true) throw new Error('P0B_POSTGRES_PREFLIGHT_FAILED');
}

export async function runP0BGoogleSchema(input: RunP0BGoogleSchemaInput): Promise<P0BSchemaReceipt> {
  if (P0B_SCHEMA_EXECUTION_STATE === 'UNFINALIZED_NOEXEC') {
    throw new Error('P0B_SCHEMA_UNFINALIZED_NOEXEC');
  }
  if (input.engine.kind !== 'postgres') throw new Error('P0B_POSTGRES_REQUIRED');
  if (!(input.action in ACTION_FILE)) throw new Error('P0B_ACTION_INVALID');
  const action = input.action;
  const manifest = parseManifest(input.manifest);
  const manifestSemanticSha = manifestSemanticDigest(manifest);
  if (manifestSemanticSha !== manifest.manifest_semantic_sha256) throw new Error('P0B_MANIFEST_SEMANTIC_DIGEST_MISMATCH');
  if (packageRootDigest(manifest) !== manifest.package_root_sha256) throw new Error('P0B_PACKAGE_ROOT_MISMATCH');
  const roleAuthority = parseRoleAuthority(input.role_authority);
  if (roleAuthority.expected_candidate_commit_sha !== manifest.candidate_commit_sha
    || roleAuthority.expected_package_root_sha256 !== manifest.package_root_sha256
    || roleAuthority.expected_manifest_semantic_sha256 !== manifestSemanticSha) throw new Error('P0B_AUTHORITY_BINDING_MISMATCH');
  validateAuthorization(input.authorization, action, manifest, manifestSemanticSha, roleAuthority);
  const sql = await readPinnedSql(action, manifest.files[action].sha256);

  await input.engine.withReservedConnection(async connection => {
    await preflight(connection, roleAuthority);
    await connection.transactionRaw(async tx => {
      await setLocal(tx, 'search_path', 'pg_catalog, public');
      const searchPathRows = await tx.executeRaw<{ search_path: string }>(
        "SELECT current_setting('search_path') AS search_path",
      );
      if (searchPathRows.length !== 1 || searchPathRows[0]?.search_path !== 'pg_catalog, public') {
        throw new Error('P0B_SEARCH_PATH_ATTESTATION_FAILED');
      }
      const settings: ReadonlyArray<readonly [string, string]> = [
        ['gbrain.p0b.initial_state_json', JSON.stringify(manifest.initial_state.state_json)],
        ['gbrain.p0b.initial_state_fingerprint', manifest.initial_state.state_fingerprint],
        ['gbrain.p0b.initial_checkpoint_revision', manifest.initial_state.checkpoint_revision],
        ['gbrain.p0b.initial_fence_epoch', manifest.initial_state.fence_epoch],
        ['gbrain.p0b.initial_fence_token', manifest.initial_state.fence_token],
        ['gbrain.p0b.expected_migrator_role', roleAuthority.expected_migrator_role],
        ['gbrain.p0b.expected_owner_role', roleAuthority.expected_owner_role],
        ['gbrain.p0b.candidate_commit_sha', manifest.candidate_commit_sha],
        ['gbrain.p0b.package_root_sha256', manifest.package_root_sha256],
        ['gbrain.p0b.manifest_semantic_sha256', manifestSemanticSha],
        ['gbrain.p0b.expected_role_policy_sha256', manifest.acl_rls.role_policy_sha256 ?? 'UNRATIFIED'],
        ['gbrain.p0b.expected_rls_policy_sha256', manifest.acl_rls.rls_policy_sha256 ?? 'UNRATIFIED'],
        ['gbrain.p0b.expected_rls_policy_count', String(manifest.acl_rls.expected_policy_count)],
      ];
      for (const [name, value] of settings) await setLocal(tx, name, value);
      const rows = await tx.executeRaw<Record<string, unknown>>(sql);
      if (action === 'VERIFY') {
        const row = rows[0];
        if (rows.length !== 1 || !row || row.status !== 'P0B_VERIFY_OK'
          || row.schema_version !== 1
          || row.candidate_commit_sha !== manifest.candidate_commit_sha
          || row.package_root_sha256 !== manifest.package_root_sha256
          || row.manifest_semantic_sha256 !== manifestSemanticSha) throw new Error('P0B_VERIFY_RECEIPT_INVALID');
      }
    });
  });

  return Object.freeze({
    schema_version: 1,
    status: 'P0B_SCHEMA_ACTION_OK',
    action,
    candidate_commit_sha: manifest.candidate_commit_sha,
    package_root_sha256: manifest.package_root_sha256,
    manifest_semantic_sha256: manifestSemanticSha,
    sql_file_sha256: manifest.files[action].sha256,
  });
}
