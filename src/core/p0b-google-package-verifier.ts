import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const LINUX_O_CLOEXEC = 0x80000;

export const P0B_PACKAGE_ROOT_ALGORITHM =
  'sha256(UTF8("P0B_PACKAGE_ROOT_V1\\n") || for each bytewise-sorted relative path: UTF8(path) || NUL || UTF8(lowercase_file_sha256) || LF)' as const;
export const P0B_PACKAGE_VERIFIER_SECURITY_SCOPE = 'OFFLINE_ADVISORY_NO_OPENAT2_DEPLOYMENT_AUTHORITY' as const;

export interface P0BPackageManifest {
  readonly schema_version: 1;
  readonly root_sha256: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface P0BPackageVerificationPolicy {
  readonly owner_uid: number;
  readonly owner_gid: number;
  readonly max_file_bytes: number;
  readonly max_files: number;
}

const SHA_RE = /^[a-f0-9]{64}$/;
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

function validateRelativePath(path: string): void {
  if (!PATH_RE.test(path) || isAbsolute(path) || path.includes('//')
    || path.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('P0B_PACKAGE_PATH_REJECTED');
  }
}

export function computeP0BPackageRoot(fileHashes: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  hash.update('P0B_PACKAGE_ROOT_V1\n', 'utf8');
  const paths = Object.keys(fileHashes).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  for (const path of paths) {
    validateRelativePath(path);
    const digest = fileHashes[path];
    if (!SHA_RE.test(digest)) throw new Error('P0B_PACKAGE_HASH_REJECTED');
    hash.update(path, 'utf8'); hash.update(Buffer.from([0])); hash.update(digest, 'ascii'); hash.update('\n', 'ascii');
  }
  return hash.digest('hex');
}

async function collectRegularFiles(root: string, policy: P0BPackageVerificationPolicy, current = ''): Promise<string[]> {
  const directory = join(root, current);
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || directoryStat.uid !== policy.owner_uid || directoryStat.gid !== policy.owner_gid
    || (directoryStat.mode & 0o022) !== 0) throw new Error('P0B_PACKAGE_DIRECTORY_REJECTED');
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = current === '' ? entry.name : `${current}/${entry.name}`;
    validateRelativePath(path);
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error('P0B_PACKAGE_SYMLINK_REJECTED');
    if (stat.isDirectory()) files.push(...await collectRegularFiles(root, policy, path));
    else if (stat.isFile()) files.push(path);
    else throw new Error('P0B_PACKAGE_FILE_TYPE_REJECTED');
  }
  return files;
}

async function hashSameDescriptor(handle: FileHandle, maxBytes: number): Promise<string> {
  const before = await handle.stat();
  if (!before.isFile() || before.size < 0 || before.size > maxBytes || before.nlink !== 1) {
    throw new Error('P0B_PACKAGE_FILE_REJECTED');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)));
  let offset = 0;
  try {
    while (offset < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - offset), offset);
      if (result.bytesRead <= 0) throw new Error('P0B_PACKAGE_FILE_CHANGED');
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
  } finally { buffer.fill(0); }
  const after = await handle.stat();
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error('P0B_PACKAGE_FILE_CHANGED');
  }
  return hash.digest('hex');
}

export async function verifyP0BImmutablePackage(
  root: string,
  manifest: P0BPackageManifest,
  policy: P0BPackageVerificationPolicy = {
    owner_uid: 0, owner_gid: 0, max_file_bytes: 4 * 1024 * 1024, max_files: 64,
  },
): Promise<Readonly<Record<string, string>>> {
  if (!isAbsolute(root) || root !== resolve(root)) throw new Error('P0B_PACKAGE_ROOT_REJECTED');
  if (manifest.schema_version !== 1 || !SHA_RE.test(manifest.root_sha256)
    || Object.getPrototypeOf(manifest.files) !== Object.prototype) {
    throw new Error('P0B_PACKAGE_MANIFEST_REJECTED');
  }
  const suppliedRootStat = await lstat(root);
  if (suppliedRootStat.isSymbolicLink() || !suppliedRootStat.isDirectory()) throw new Error('P0B_PACKAGE_ROOT_REJECTED');
  const rootReal = await realpath(root);
  if (rootReal !== resolve(root)) throw new Error('P0B_PACKAGE_ROOT_REJECTED');
  const rootStat = await lstat(rootReal);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== policy.owner_uid
    || rootStat.gid !== policy.owner_gid || (rootStat.mode & 0o022) !== 0) {
    throw new Error('P0B_PACKAGE_ROOT_REJECTED');
  }
  const diskFiles = await collectRegularFiles(rootReal, policy);
  const expected = Object.keys(manifest.files);
  if (expected.length < 1 || expected.length > policy.max_files || diskFiles.length !== expected.length
    || [...diskFiles].sort().some((path, index) => path !== [...expected].sort()[index])) {
    throw new Error('P0B_PACKAGE_FILE_SET_MISMATCH');
  }
  const hashes: Record<string, string> = Object.create(null);
  for (const path of expected) {
    validateRelativePath(path);
    if (!SHA_RE.test(manifest.files[path])) throw new Error('P0B_PACKAGE_MANIFEST_REJECTED');
    const absolute = join(rootReal, ...path.split('/'));
    const rel = relative(rootReal, absolute);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('P0B_PACKAGE_PATH_REJECTED');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC);
    try {
      const stat = await handle.stat();
      if (stat.uid !== policy.owner_uid || stat.gid !== policy.owner_gid || (stat.mode & 0o022) !== 0) {
        throw new Error('P0B_PACKAGE_FILE_REJECTED');
      }
      const digest = await hashSameDescriptor(handle, policy.max_file_bytes);
      if (digest !== manifest.files[path]) throw new Error('P0B_PACKAGE_HASH_MISMATCH');
      hashes[path] = digest;
    } finally { await handle.close(); }
  }
  const rootDigest = computeP0BPackageRoot(hashes);
  if (rootDigest !== manifest.root_sha256) throw new Error('P0B_PACKAGE_ROOT_HASH_MISMATCH');
  return Object.freeze({ ...hashes });
}
