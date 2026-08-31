export const P0B_GOOGLE_CREDENTIAL_FILE =
  '/run/credentials/gbrain-p0b-google-bridge.service/google-generative-ai-api-key' as const;
export const P0B_GOOGLE_RUNTIME_EXECUTION_STATE = 'UNFINALIZED_NOEXEC' as const;

export const P0B_GOOGLE_CREDENTIAL_CONTRACT = Object.freeze({
  schema_version: 1,
  source: 'SYSTEMD_LOAD_CREDENTIAL_ONLY',
  path: P0B_GOOGLE_CREDENTIAL_FILE,
  open_flags: Object.freeze(['READ_ONLY', 'NO_FOLLOW', 'CLOSE_ON_EXEC'] as const),
  owner_uid: 0,
  owner_gid: 0,
  mode: 0o400,
  credential_fd: 3,
  max_bytes: 65_536,
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
  readonly open: (path: string, flags: readonly string[]) => Promise<CredentialHandle>;
}

export interface P0BGoogleCredentialFd {
  readonly fd: unknown;
  readonly byte_length: number;
}

function validStat(value: CredentialStat): value is CredentialStat & { size: number } {
  return value !== null
    && typeof value === 'object'
    && value.file_type === 'regular'
    && value.uid === P0B_GOOGLE_CREDENTIAL_CONTRACT.owner_uid
    && value.gid === P0B_GOOGLE_CREDENTIAL_CONTRACT.owner_gid
    && value.mode === P0B_GOOGLE_CREDENTIAL_CONTRACT.mode
    && value.nlink === 1
    && Number.isSafeInteger(value.size)
    && (value.size as number) > 0
    && (value.size as number) <= P0B_GOOGLE_CREDENTIAL_CONTRACT.max_bytes;
}

/**
 * Opens exactly systemd's fixed credential path with no-follow semantics, validates
 * root-owned metadata, lends only an opaque descriptor token, and always closes.
 * Secret bytes are deliberately never materialized in this process.
 */
export async function withP0BGoogleCredential<T>(
  store: P0BGoogleCredentialStore,
  use: (credential: P0BGoogleCredentialFd) => Promise<T>,
): Promise<T> {
  if (P0B_GOOGLE_RUNTIME_EXECUTION_STATE === 'UNFINALIZED_NOEXEC') {
    throw new Error('P0B_GOOGLE_RUNTIME_UNFINALIZED_NOEXEC');
  }
  let handle: CredentialHandle;
  try {
    handle = await store.open(
      P0B_GOOGLE_CREDENTIAL_FILE,
      P0B_GOOGLE_CREDENTIAL_CONTRACT.open_flags,
    );
  } catch {
    throw new Error('P0B_CREDENTIAL_REJECTED');
  }
  try {
    const metadata = await handle.stat();
    if (!validStat(metadata)) throw new Error('P0B_CREDENTIAL_REJECTED');
    return await use(Object.freeze({ fd: handle.descriptor, byte_length: metadata.size }));
  } catch (error) {
    if (error instanceof Error && error.message === 'P0B_CREDENTIAL_REJECTED') throw error;
    throw error;
  } finally {
    try { await handle.close(); } catch { /* fail-safe close attempt; preserve primary result */ }
  }
}
