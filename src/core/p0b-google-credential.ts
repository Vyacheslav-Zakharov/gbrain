import { constants, type Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

// Linux asm-generic O_CLOEXEC. Node sets CLOEXEC internally but does not expose
// the constant in its fs typings/runtime; keep it explicit for the reviewed ABI.
const LINUX_O_CLOEXEC = 0x80000;

export const P0B_GOOGLE_CREDENTIAL_FILE =
  '/run/credentials/gbrain-p0b-google-provider.service/google-generative-ai-api-key' as const;
export const P0B_GOOGLE_RUNTIME_EXECUTION_STATE = 'UNFINALIZED_NOEXEC' as const;

export const P0B_GOOGLE_CREDENTIAL_CONTRACT = Object.freeze({
  schema_version: 1,
  source: 'SYSTEMD_LOAD_CREDENTIAL_ONLY',
  path: P0B_GOOGLE_CREDENTIAL_FILE,
  open_flags: constants.O_RDONLY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC,
  owner_uid: 0,
  owner_gid: 0,
  mode: 0o400,
  max_bytes: 4096,
  argv_env_fallback: 'FORBIDDEN',
} as const);

interface CredentialStat {
  readonly file_type: unknown;
  readonly uid: unknown;
  readonly gid: unknown;
  readonly mode: unknown;
  readonly nlink: unknown;
  readonly size: unknown;
}

interface CredentialHandle {
  readonly descriptor: unknown;
  readonly stat: () => Promise<CredentialStat>;
  readonly close: () => Promise<void>;
}

export interface P0BGoogleCredentialStore {
  readonly open: (path: string, flags: number | readonly string[]) => Promise<CredentialHandle>;
}

export interface P0BGoogleCredentialFd {
  readonly fd: unknown;
  readonly byte_length: number;
}

export interface P0BGoogleCredentialPolicy {
  readonly owner_uid: number;
  readonly owner_gid: number;
  readonly mode: number;
  readonly max_bytes: number;
}

export interface P0BGoogleCredentialFileAdapter {
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
}

export const nodeP0BGoogleCredentialFileAdapter: P0BGoogleCredentialFileAdapter = Object.freeze({ open });

function statMode(stat: Stats): number {
  return stat.mode & 0o777;
}

function validNodeStat(stat: Stats, policy: P0BGoogleCredentialPolicy): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === policy.owner_uid
    && stat.gid === policy.owner_gid && statMode(stat) === policy.mode && stat.nlink === 1
    && Number.isSafeInteger(stat.size) && stat.size > 0 && stat.size <= policy.max_bytes;
}

function validateApiKey(bytes: Buffer): string {
  let length = bytes.byteLength;
  if (length > 0 && bytes[length - 1] === 0x0a) length -= 1;
  if (length > 0 && bytes[length - 1] === 0x0d) length -= 1;
  const value = bytes.subarray(0, length);
  if (value.byteLength < 16 || value.byteLength > 512
    || value.some(byte => byte < 0x21 || byte > 0x7e)) {
    throw new Error('P0B_CREDENTIAL_REJECTED');
  }
  return value.toString('ascii');
}

/**
 * Opens the fixed systemd credential with O_RDONLY|O_NOFOLLOW|O_CLOEXEC, fstats
 * and reads that same descriptor, bounds the read, and zeroes the temporary bytes.
 * Close failure is fatal after success and is attached to a primary failure otherwise.
 */
export async function withP0BGoogleCredentialSecret<T>(
  use: (apiKey: string) => Promise<T>,
  options: {
    readonly adapter?: P0BGoogleCredentialFileAdapter;
    readonly path?: string;
    readonly policy?: P0BGoogleCredentialPolicy;
  } = {},
): Promise<T> {
  const adapter = options.adapter ?? nodeP0BGoogleCredentialFileAdapter;
  const path = options.path ?? P0B_GOOGLE_CREDENTIAL_FILE;
  const policy = options.policy ?? P0B_GOOGLE_CREDENTIAL_CONTRACT;
  let handle: FileHandle | undefined;
  let secretBytes: Buffer | undefined;
  let result: T | undefined;
  let primary: unknown;
  try {
    handle = await adapter.open(path, P0B_GOOGLE_CREDENTIAL_CONTRACT.open_flags);
    if (!Number.isSafeInteger(handle.fd) || handle.fd < 0) throw new Error('P0B_CREDENTIAL_REJECTED');
    const stat = await handle.stat();
    if (!validNodeStat(stat, policy)) throw new Error('P0B_CREDENTIAL_REJECTED');
    secretBytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < secretBytes.byteLength) {
      const read = await handle.read(secretBytes, offset, secretBytes.byteLength - offset, offset);
      if (read.bytesRead <= 0) throw new Error('P0B_CREDENTIAL_REJECTED');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!validNodeStat(after, policy) || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      throw new Error('P0B_CREDENTIAL_REJECTED');
    }
    result = await use(validateApiKey(secretBytes));
  } catch (error) {
    primary = error instanceof Error && error.message.startsWith('P0B_')
      ? error : new Error('P0B_CREDENTIAL_REJECTED');
  } finally {
    secretBytes?.fill(0);
    if (handle !== undefined) {
      try { await handle.close(); }
      catch (closeError) {
        const closeFailure = new Error('P0B_CREDENTIAL_CLOSE_FAILED', { cause: closeError });
        if (primary === undefined) primary = closeFailure;
        else if (primary instanceof Error) Object.defineProperty(primary, 'cause', { value: closeFailure, configurable: true });
      }
    }
  }
  if (primary !== undefined) throw primary;
  return result as T;
}

function validLegacyStat(value: CredentialStat): value is CredentialStat & { size: number } {
  return value !== null && typeof value === 'object' && value.file_type === 'regular'
    && value.uid === P0B_GOOGLE_CREDENTIAL_CONTRACT.owner_uid
    && value.gid === P0B_GOOGLE_CREDENTIAL_CONTRACT.owner_gid
    && value.mode === P0B_GOOGLE_CREDENTIAL_CONTRACT.mode && value.nlink === 1
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= P0B_GOOGLE_CREDENTIAL_CONTRACT.max_bytes;
}

/** Legacy runner contract remains hard-fenced; the successor uses withP0BGoogleCredentialSecret. */
export async function withP0BGoogleCredential<T>(
  store: P0BGoogleCredentialStore,
  use: (credential: P0BGoogleCredentialFd) => Promise<T>,
): Promise<T> {
  if (P0B_GOOGLE_RUNTIME_EXECUTION_STATE === 'UNFINALIZED_NOEXEC') {
    throw new Error('P0B_GOOGLE_RUNTIME_UNFINALIZED_NOEXEC');
  }
  const handle = await store.open(P0B_GOOGLE_CREDENTIAL_FILE, P0B_GOOGLE_CREDENTIAL_CONTRACT.open_flags);
  try {
    const metadata = await handle.stat();
    if (!validLegacyStat(metadata)) throw new Error('P0B_CREDENTIAL_REJECTED');
    return await use(Object.freeze({ fd: handle.descriptor, byte_length: metadata.size }));
  } finally {
    await handle.close();
  }
}
