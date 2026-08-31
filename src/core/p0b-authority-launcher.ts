import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const LINUX_O_CLOEXEC = 0x80000;
const LINUX_O_DIRECTORY = 0x10000;

export const P0B_AUTHORITY_EXECUTION_STATE = 'OFFLINE_BUILTIN_INERT_ONLY_NOEXEC' as const;
export const P0B_AUTHORIZATION_CANONICAL_DOMAIN = 'P0B_AUTHORIZATION_V1\n' as const;
export const P0B_PACKAGE_DESCRIPTOR_CANONICAL_DOMAIN = 'P0B_PACKAGE_DESCRIPTOR_V1\n' as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const NONCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$/;
const ACTION_RE = /^[A-Z][A-Z0-9_]{7,127}$/;
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const LOGICAL_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const ARTIFACT_KIND_RE = /^[A-Z][A-Z0-9_]{7,127}$/;
const HEX_SIGNATURE_RE = /^[a-f0-9]{128}$/;

class P0BFailure extends Error {
  constructor(code: string) { super(code); }
}

function fail(code: string): never { throw new P0BFailure(code); }

export interface P0BAuthorizationActor {
  readonly uid: number;
  readonly gid: number;
  readonly name: string;
}

export interface P0BAuthorization {
  readonly schema_version: 1;
  readonly action: string;
  readonly actor: P0BAuthorizationActor;
  readonly package_root_sha256: string;
  readonly package_descriptor_sha256: string;
  readonly nonce: string;
  readonly issued_at_epoch_ms: number;
  readonly not_before_epoch_ms: number;
  readonly expires_at_epoch_ms: number;
}

export interface P0BPackageDescriptorArtifact {
  readonly logical_name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface P0BPackageDescriptor {
  readonly schema_version: 1;
  readonly artifact_kind: string;
  readonly base_commit_sha: string;
  readonly execution_state: typeof P0B_AUTHORITY_EXECUTION_STATE;
  readonly production_mutation_authorized: false;
  readonly package_root_definition: string;
  readonly artifacts: readonly P0BPackageDescriptorArtifact[];
  readonly security_properties: readonly string[];
  readonly blockers: readonly string[];
  readonly provenance: Readonly<{
    catalog_artifact_path: string;
    basis: 'UNVERIFIED_TRANSCRIPTION';
    referenced_source_path: string;
  }>;
}

export interface P0BAuthorityPolicy {
  readonly owner_uid: number;
  readonly owner_gid: number;
  readonly max_authorization_bytes: number;
  readonly max_validity_ms: number;
  readonly max_future_skew_ms: number;
}

export interface P0BAuthorityLaunchRequest {
  readonly authority_directory: string;
  readonly authorization_file: string;
  readonly expected_action: string;
  readonly expected_package_root_sha256: string;
  readonly expected_package_descriptor: P0BPackageDescriptor;
  readonly expected_actor: P0BAuthorizationActor;
  readonly policy?: P0BAuthorityPolicy;
}

export interface P0BAuthorityLauncherDependencies {
  readonly clock: { readonly now_epoch_ms: () => unknown };
  readonly package_verifier: { readonly verify_root_sha256: () => Promise<unknown> };
  readonly signature_verifier: {
    readonly verify: (input: Readonly<{
      algorithm: 'ed25519';
      key_id: string;
      signature: Buffer;
      message: Buffer;
    }>) => Promise<unknown>;
  };
}

const DEFAULT_POLICY: P0BAuthorityPolicy = Object.freeze({
  owner_uid: 0,
  owner_gid: 0,
  max_authorization_bytes: 16 * 1024,
  max_validity_ms: 5 * 60 * 1000,
  max_future_skew_ms: 5_000,
});

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!plain(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  return value;
}

function safeNonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedText(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}

function parseActor(value: unknown): P0BAuthorizationActor {
  const actor = exact(value, ['uid', 'gid', 'name'], 'P0B_AUTHORIZATION_SCHEMA_REJECTED');
  if (!safeNonnegative(actor.uid) || !safeNonnegative(actor.gid)
    || typeof actor.name !== 'string' || !ACTOR_RE.test(actor.name)) fail('P0B_AUTHORIZATION_SCHEMA_REJECTED');
  return Object.freeze({ uid: actor.uid, gid: actor.gid, name: actor.name }) as P0BAuthorizationActor;
}

function parseAuthorization(value: unknown): P0BAuthorization {
  const authorization = exact(value, [
    'schema_version', 'action', 'actor', 'package_root_sha256', 'package_descriptor_sha256', 'nonce',
    'issued_at_epoch_ms', 'not_before_epoch_ms', 'expires_at_epoch_ms',
  ], 'P0B_AUTHORIZATION_SCHEMA_REJECTED');
  if (authorization.schema_version !== 1
    || typeof authorization.action !== 'string' || !ACTION_RE.test(authorization.action)
    || typeof authorization.package_root_sha256 !== 'string' || !SHA256_RE.test(authorization.package_root_sha256)
    || typeof authorization.package_descriptor_sha256 !== 'string' || !SHA256_RE.test(authorization.package_descriptor_sha256)
    || typeof authorization.nonce !== 'string' || !NONCE_RE.test(authorization.nonce)
    || !safeNonnegative(authorization.issued_at_epoch_ms)
    || !safeNonnegative(authorization.not_before_epoch_ms)
    || !safeNonnegative(authorization.expires_at_epoch_ms)) fail('P0B_AUTHORIZATION_SCHEMA_REJECTED');
  return Object.freeze({
    schema_version: 1,
    action: authorization.action,
    actor: parseActor(authorization.actor),
    package_root_sha256: authorization.package_root_sha256,
    package_descriptor_sha256: authorization.package_descriptor_sha256,
    nonce: authorization.nonce,
    issued_at_epoch_ms: authorization.issued_at_epoch_ms,
    not_before_epoch_ms: authorization.not_before_epoch_ms,
    expires_at_epoch_ms: authorization.expires_at_epoch_ms,
  }) as P0BAuthorization;
}

function parseStringList(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
    || value.some((entry) => !boundedText(entry))) fail(code);
  return Object.freeze([...value]) as readonly string[];
}

function parsePackageDescriptor(value: unknown): P0BPackageDescriptor {
  const code = 'P0B_PACKAGE_DESCRIPTOR_REJECTED';
  const descriptor = exact(value, [
    'schema_version', 'artifact_kind', 'base_commit_sha', 'execution_state',
    'production_mutation_authorized', 'package_root_definition', 'artifacts',
    'security_properties', 'blockers', 'provenance',
  ], code);
  if (descriptor.schema_version !== 1
    || typeof descriptor.artifact_kind !== 'string' || !ARTIFACT_KIND_RE.test(descriptor.artifact_kind)
    || typeof descriptor.base_commit_sha !== 'string' || !GIT_SHA_RE.test(descriptor.base_commit_sha)
    || descriptor.execution_state !== P0B_AUTHORITY_EXECUTION_STATE
    || descriptor.production_mutation_authorized !== false
    || !boundedText(descriptor.package_root_definition)) fail(code);
  if (!Array.isArray(descriptor.artifacts) || descriptor.artifacts.length < 1 || descriptor.artifacts.length > 32) fail(code);
  const artifacts = descriptor.artifacts.map((entry) => {
    const artifact = exact(entry, ['logical_name', 'path', 'sha256', 'bytes'], code);
    if (typeof artifact.logical_name !== 'string' || !LOGICAL_NAME_RE.test(artifact.logical_name)
      || typeof artifact.path !== 'string' || !SAFE_PATH_RE.test(artifact.path) || artifact.path.startsWith('/') || artifact.path.includes('..')
      || typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)
      || !safeNonnegative(artifact.bytes)) fail(code);
    return Object.freeze({ logical_name: artifact.logical_name, path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes });
  });
  if (new Set(artifacts.map((entry) => entry.logical_name)).size !== artifacts.length) fail(code);
  const provenance = exact(descriptor.provenance,
    ['catalog_artifact_path', 'basis', 'referenced_source_path'], code);
  if (typeof provenance.catalog_artifact_path !== 'string' || !SAFE_PATH_RE.test(provenance.catalog_artifact_path)
    || provenance.basis !== 'UNVERIFIED_TRANSCRIPTION'
    || typeof provenance.referenced_source_path !== 'string' || !SAFE_PATH_RE.test(provenance.referenced_source_path)) fail(code);
  return Object.freeze({
    schema_version: 1,
    artifact_kind: descriptor.artifact_kind,
    base_commit_sha: descriptor.base_commit_sha,
    execution_state: P0B_AUTHORITY_EXECUTION_STATE,
    production_mutation_authorized: false,
    package_root_definition: descriptor.package_root_definition,
    artifacts: Object.freeze(artifacts),
    security_properties: parseStringList(descriptor.security_properties, code),
    blockers: parseStringList(descriptor.blockers, code),
    provenance: Object.freeze({
      catalog_artifact_path: provenance.catalog_artifact_path,
      basis: 'UNVERIFIED_TRANSCRIPTION' as const,
      referenced_source_path: provenance.referenced_source_path,
    }),
  }) as P0BPackageDescriptor;
}

export function canonicalizeP0BAuthorization(value: unknown): Buffer {
  const authorization = parseAuthorization(value);
  const canonical = JSON.stringify({
    schema_version: authorization.schema_version,
    action: authorization.action,
    actor: { uid: authorization.actor.uid, gid: authorization.actor.gid, name: authorization.actor.name },
    package_root_sha256: authorization.package_root_sha256,
    package_descriptor_sha256: authorization.package_descriptor_sha256,
    nonce: authorization.nonce,
    issued_at_epoch_ms: authorization.issued_at_epoch_ms,
    not_before_epoch_ms: authorization.not_before_epoch_ms,
    expires_at_epoch_ms: authorization.expires_at_epoch_ms,
  });
  return Buffer.from(`${P0B_AUTHORIZATION_CANONICAL_DOMAIN}${canonical}`, 'utf8');
}

export function canonicalizeP0BPackageDescriptor(value: unknown): Buffer {
  const descriptor = parsePackageDescriptor(value);
  const canonical = JSON.stringify({
    schema_version: descriptor.schema_version,
    artifact_kind: descriptor.artifact_kind,
    base_commit_sha: descriptor.base_commit_sha,
    execution_state: descriptor.execution_state,
    production_mutation_authorized: descriptor.production_mutation_authorized,
    package_root_definition: descriptor.package_root_definition,
    artifacts: descriptor.artifacts.map((artifact) => ({
      logical_name: artifact.logical_name, path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes,
    })),
    security_properties: descriptor.security_properties,
    blockers: descriptor.blockers,
    provenance: descriptor.provenance,
  });
  return Buffer.from(`${P0B_PACKAGE_DESCRIPTOR_CANONICAL_DOMAIN}${canonical}`, 'utf8');
}

export function hashP0BPackageDescriptor(value: unknown): string {
  const canonical = canonicalizeP0BPackageDescriptor(value);
  try { return createHash('sha256').update(canonical).digest('hex'); }
  finally { canonical.fill(0); }
}

function parseEnvelope(value: unknown) {
  const envelope = exact(value, ['schema_version', 'authorization', 'signature'], 'P0B_AUTHORIZATION_SCHEMA_REJECTED');
  const signature = exact(envelope.signature, ['algorithm', 'key_id', 'signature_hex'], 'P0B_AUTHORIZATION_SCHEMA_REJECTED');
  if (envelope.schema_version !== 1 || signature.algorithm !== 'ed25519'
    || typeof signature.key_id !== 'string' || !KEY_ID_RE.test(signature.key_id)
    || typeof signature.signature_hex !== 'string' || !HEX_SIGNATURE_RE.test(signature.signature_hex)) fail('P0B_AUTHORIZATION_SCHEMA_REJECTED');
  return Object.freeze({
    authorization: parseAuthorization(envelope.authorization),
    signature: Object.freeze({
      algorithm: 'ed25519' as const,
      key_id: signature.key_id,
      signature: Buffer.from(signature.signature_hex, 'hex'),
    }),
  });
}

function readClock(dependencies: P0BAuthorityLauncherDependencies): number {
  let value: unknown;
  try { value = dependencies.clock.now_epoch_ms.call(dependencies.clock); }
  catch { fail('P0B_CLOCK_REJECTED'); }
  if (!safeNonnegative(value)) fail('P0B_CLOCK_REJECTED');
  return value;
}

function validateWindow(authorization: P0BAuthorization, now: number, policy: P0BAuthorityPolicy): void {
  if (authorization.issued_at_epoch_ms > now + policy.max_future_skew_ms
    || authorization.not_before_epoch_ms > now
    || authorization.not_before_epoch_ms < authorization.issued_at_epoch_ms) fail('P0B_AUTHORIZATION_FUTURE');
  if (authorization.expires_at_epoch_ms <= now) fail('P0B_AUTHORIZATION_EXPIRED');
  if (authorization.expires_at_epoch_ms <= authorization.not_before_epoch_ms
    || authorization.expires_at_epoch_ms - authorization.issued_at_epoch_ms > policy.max_validity_ms) fail('P0B_AUTHORIZATION_WINDOW_REJECTED');
}

function sameActor(left: P0BAuthorizationActor, right: P0BAuthorizationActor): boolean {
  return left.uid === right.uid && left.gid === right.gid && left.name === right.name;
}

async function closePreserving(handle: FileHandle, primary: unknown): Promise<void> {
  try { await handle.close(); }
  catch { if (primary === undefined) fail('P0B_FILESYSTEM_CLOSE_FAILED'); }
}

async function readBoundedSameDescriptor(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  let before;
  try { before = await handle.stat({ bigint: true }); }
  catch { fail('P0B_FILESYSTEM_STAT_FAILED'); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maxBytes)) fail('P0B_AUTHORIZATION_FILE_REJECTED');
  const bytes = Buffer.alloc(Number(before.size));
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      let read;
      try { read = await handle.read(bytes, offset, bytes.byteLength - offset, offset); }
      catch { fail('P0B_FILESYSTEM_READ_FAILED'); }
      if (read.bytesRead <= 0) fail('P0B_AUTHORIZATION_FILE_CHANGED');
      offset += read.bytesRead;
    }
    let after;
    try { after = await handle.stat({ bigint: true }); }
    catch { fail('P0B_FILESYSTEM_STAT_FAILED'); }
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail('P0B_AUTHORIZATION_FILE_CHANGED');
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

async function writeAll(handle: FileHandle, value: unknown, code: string, truncate: boolean): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  try {
    if (truncate) {
      try { await handle.truncate(0); }
      catch { fail(code); }
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      let written;
      try { written = await handle.write(bytes, offset, bytes.byteLength - offset, offset); }
      catch { fail(code); }
      if (written.bytesWritten <= 0) fail(code);
      offset += written.bytesWritten;
    }
    try { await handle.sync(); }
    catch { fail('P0B_FILESYSTEM_FILE_SYNC_FAILED'); }
  } finally { bytes.fill(0); }
}

async function syncDirectory(directory: FileHandle): Promise<void> {
  try { await directory.sync(); }
  catch { fail('P0B_FILESYSTEM_DIRECTORY_SYNC_FAILED'); }
}

async function createDurableExclusive(
  path: string,
  value: unknown,
  directory: FileHandle,
  collisionCode: string,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0o600);
  } catch (error: any) {
    if (error?.code === 'EEXIST') fail(collisionCode);
    fail('P0B_FILESYSTEM_OPEN_FAILED');
  }
  let primary: unknown;
  try {
    await writeAll(handle, value, 'P0B_FILESYSTEM_WRITE_FAILED', false);
  } catch (error) { primary = error; throw error; }
  finally { await closePreserving(handle, primary); }
  await syncDirectory(directory);
}

async function reserveReceipt(path: string, reserved: unknown, directory: FileHandle): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0o600);
  } catch (error: any) {
    if (error?.code === 'EEXIST') fail('P0B_RECEIPT_ALREADY_EXISTS');
    fail('P0B_FILESYSTEM_OPEN_FAILED');
  }
  try {
    await writeAll(handle, reserved, 'P0B_FILESYSTEM_WRITE_FAILED', false);
    await syncDirectory(directory);
    return handle;
  } catch (error) {
    await closePreserving(handle, error);
    throw error;
  }
}

function validatePolicy(policy: P0BAuthorityPolicy): void {
  if (!safeNonnegative(policy.owner_uid) || !safeNonnegative(policy.owner_gid)
    || !Number.isSafeInteger(policy.max_authorization_bytes) || policy.max_authorization_bytes < 256 || policy.max_authorization_bytes > 1024 * 1024
    || !Number.isSafeInteger(policy.max_validity_ms) || policy.max_validity_ms < 1 || policy.max_validity_ms > 24 * 60 * 60 * 1000
    || !safeNonnegative(policy.max_future_skew_ms) || policy.max_future_skew_ms > 60_000) fail('P0B_AUTHORITY_POLICY_REJECTED');
}

async function launchInner(request: P0BAuthorityLaunchRequest, dependencies: P0BAuthorityLauncherDependencies) {
  const policy = request.policy ?? DEFAULT_POLICY;
  validatePolicy(policy);
  if (!isAbsolute(request.authority_directory) || request.authority_directory !== resolve(request.authority_directory)
    || !FILE_RE.test(request.authorization_file) || !ACTION_RE.test(request.expected_action)
    || !SHA256_RE.test(request.expected_package_root_sha256)) fail('P0B_AUTHORITY_REQUEST_REJECTED');
  const expectedActor = parseActor(request.expected_actor);
  const expectedDescriptorSha256 = hashP0BPackageDescriptor(request.expected_package_descriptor);

  if (typeof process.geteuid !== 'function' || typeof process.getegid !== 'function') {
    fail('P0B_IDENTITY_UNAVAILABLE');
  }
  const uid = process.geteuid();
  const gid = process.getegid();
  if (uid === 0) fail('P0B_ROOT_EXECUTION_BLOCKED_NOEXEC');
  if (uid !== expectedActor.uid || gid !== expectedActor.gid) fail('P0B_ACTOR_MISMATCH');

  let suppliedStat;
  try { suppliedStat = await lstat(request.authority_directory, { bigint: true }); }
  catch { fail('P0B_FILESYSTEM_METADATA_FAILED'); }
  if (!suppliedStat.isDirectory() || suppliedStat.isSymbolicLink()) fail('P0B_AUTHORITY_DIRECTORY_REJECTED');
  let canonicalDirectory: string;
  try { canonicalDirectory = await realpath(request.authority_directory); }
  catch { fail('P0B_FILESYSTEM_REALPATH_FAILED'); }
  if (canonicalDirectory !== request.authority_directory) fail('P0B_AUTHORITY_DIRECTORY_REJECTED');
  let directory: FileHandle;
  try { directory = await open(canonicalDirectory, constants.O_RDONLY | constants.O_NOFOLLOW | LINUX_O_DIRECTORY | LINUX_O_CLOEXEC); }
  catch { fail('P0B_FILESYSTEM_OPEN_FAILED'); }

  let directoryPrimary: unknown;
  try {
    let openedStat;
    try { openedStat = await directory.stat({ bigint: true }); }
    catch { fail('P0B_FILESYSTEM_STAT_FAILED'); }
    if (openedStat.dev !== suppliedStat.dev || openedStat.ino !== suppliedStat.ino
      || !openedStat.isDirectory() || openedStat.uid !== BigInt(policy.owner_uid) || openedStat.gid !== BigInt(policy.owner_gid)
      || (openedStat.mode & 0o022n) !== 0n) fail('P0B_AUTHORITY_DIRECTORY_REJECTED');

    const pinnedDirectory = `/proc/self/fd/${directory.fd}`;
    const authorizationPath = `${pinnedDirectory}/${request.authorization_file}`;
    let authorizationHandle: FileHandle;
    try {
      authorizationHandle = await open(authorizationPath, constants.O_RDONLY | constants.O_EXCL
        | constants.O_NOFOLLOW | LINUX_O_CLOEXEC);
    } catch { fail('P0B_AUTHORIZATION_FILE_REJECTED'); }
    let authorizationPrimary: unknown;
    let bytes: Buffer | undefined;
    let envelope: ReturnType<typeof parseEnvelope>;
    try {
      let stat;
      try { stat = await authorizationHandle.stat({ bigint: true }); }
      catch { fail('P0B_FILESYSTEM_STAT_FAILED'); }
      const permissionMode = Number(stat.mode & 0o7777n);
      if (stat.uid !== BigInt(policy.owner_uid) || stat.gid !== BigInt(policy.owner_gid)
        || (permissionMode !== 0o400 && permissionMode !== 0o600)) fail('P0B_AUTHORIZATION_FILE_REJECTED');
      bytes = await readBoundedSameDescriptor(authorizationHandle, policy.max_authorization_bytes);
      try { envelope = parseEnvelope(JSON.parse(bytes.toString('utf8'))); }
      catch (error) {
        if (error instanceof P0BFailure) throw error;
        fail('P0B_AUTHORIZATION_SCHEMA_REJECTED');
      }
    } catch (error) { authorizationPrimary = error; throw error; }
    finally {
      bytes?.fill(0);
      await closePreserving(authorizationHandle, authorizationPrimary);
    }

    const authorization = envelope.authorization;
    if (authorization.action !== request.expected_action
      || authorization.package_root_sha256 !== request.expected_package_root_sha256
      || authorization.package_descriptor_sha256 !== expectedDescriptorSha256
      || !sameActor(authorization.actor, expectedActor)) fail('P0B_AUTHORIZATION_BINDING_MISMATCH');

    validateWindow(authorization, readClock(dependencies), policy);
    const canonical = canonicalizeP0BAuthorization(authorization);
    try {
      let signatureValid: unknown;
      try {
        signatureValid = await dependencies.signature_verifier.verify(Object.freeze({
          algorithm: envelope.signature.algorithm,
          key_id: envelope.signature.key_id,
          signature: Buffer.from(envelope.signature.signature),
          message: Buffer.from(canonical),
        }));
      } catch { fail('P0B_SIGNATURE_VERIFIER_FAILED'); }
      if (signatureValid !== true) fail('P0B_AUTHORIZATION_SIGNATURE_REJECTED');

      let verifiedPackageRoot: unknown;
      try { verifiedPackageRoot = await dependencies.package_verifier.verify_root_sha256(); }
      catch { fail('P0B_PACKAGE_VERIFIER_FAILED'); }
      if (verifiedPackageRoot !== request.expected_package_root_sha256) fail('P0B_PACKAGE_ROOT_MISMATCH');

      const finalNow = readClock(dependencies);
      validateWindow(authorization, finalNow, policy);
      const claim = Object.freeze({
        schema_version: 1,
        status: 'CLAIMED',
        nonce: authorization.nonce,
        action: authorization.action,
        actor: authorization.actor,
        package_root_sha256: authorization.package_root_sha256,
        package_descriptor_sha256: authorization.package_descriptor_sha256,
        authorization_sha256: createHash('sha256').update(canonical).digest('hex'),
        signature_sha256: createHash('sha256').update(envelope.signature.signature).digest('hex'),
        claimed_at_epoch_ms: finalNow,
      });
      await createDurableExclusive(`${pinnedDirectory}/${authorization.nonce}.claim.json`, claim, directory,
        'P0B_AUTHORIZATION_REPLAYED');

      const reserved = Object.freeze({
        schema_version: 1,
        outcome: 'INCOMPLETE',
        code: 'P0B_RECEIPT_RESERVED',
        crash_semantics: 'A durable INCOMPLETE receipt means the nonce was claimed but terminal inert-child finalization did not complete; never retry.',
        nonce: authorization.nonce,
        action: authorization.action,
        actor: authorization.actor,
        package_root_sha256: authorization.package_root_sha256,
        package_descriptor_sha256: authorization.package_descriptor_sha256,
        reserved_at_epoch_ms: finalNow,
      });
      const receiptHandle = await reserveReceipt(`${pinnedDirectory}/${authorization.nonce}.receipt.json`, reserved, directory);
      let receiptPrimary: unknown;
      try {
        // This is the only child result. It is closed over by this module and performs no I/O.
        const receipt = Object.freeze({
          schema_version: 1,
          outcome: 'SUCCESS',
          code: 'INERT_NOEXEC',
          nonce: authorization.nonce,
          action: authorization.action,
          actor: authorization.actor,
          package_root_sha256: authorization.package_root_sha256,
          package_descriptor_sha256: authorization.package_descriptor_sha256,
          finalized_at_epoch_ms: readClock(dependencies),
        });
        await writeAll(receiptHandle, receipt, 'P0B_RECEIPT_FINALIZE_FAILED', true);
        await syncDirectory(directory);
        return receipt;
      } catch (error) { receiptPrimary = error; throw error; }
      finally { await closePreserving(receiptHandle, receiptPrimary); }
    } finally { canonical.fill(0); }
  } catch (error) { directoryPrimary = error; throw error; }
  finally { await closePreserving(directory, directoryPrimary); }
}

export async function launchP0BAuthorityAction(
  request: P0BAuthorityLaunchRequest,
  dependencies: P0BAuthorityLauncherDependencies,
) {
  try { return await launchInner(request, dependencies); }
  catch (error) {
    if (error instanceof P0BFailure) throw new Error(error.message);
    throw new Error('P0B_INTERNAL_BOUNDARY_FAILED');
  }
}
