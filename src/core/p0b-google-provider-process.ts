import type { P0BGoogleCredentialFd } from './p0b-google-credential.ts';
import {
  P0B_GOOGLE_RUNTIME_EXECUTION_STATE,
  withP0BGoogleCredentialSecret,
} from './p0b-google-credential.ts';
import {
  createP0BGoogleUnixClient,
  createPinnedGoogleHttpsAdapter,
  denyByDefaultPeerCredentialAdapter,
  P0B_GOOGLE_DIMENSIONS,
  P0B_GOOGLE_MODEL,
  P0B_GOOGLE_SOCKET_PATH,
  startP0BGoogleProviderServer,
  type P0BGoogleLinuxPeerCredentialAdapter,
  type P0BGooglePeerPolicy,
} from './p0b-google-provider-protocol.ts';

export const P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT = Object.freeze({
  schema_version: 2,
  executable: '/usr/lib/gbrain/p0b-google-provider',
  protocol: 'AF_UNIX_LENGTH_PREFIXED_JSON_V1',
  socket_path: P0B_GOOGLE_SOCKET_PATH,
  action: 'GOOGLE_EMBED_FIXED',
  model: P0B_GOOGLE_MODEL,
  dimensions: P0B_GOOGLE_DIMENSIONS,
  shared_gateway: 'FORBIDDEN',
  environment_credentials: 'FORBIDDEN',
  peer_credentials: 'LINUX_SO_PEERCRED_REQUIRED_DENY_BY_DEFAULT',
} as const);

interface ProviderRequest {
  readonly schema_version: 1;
  readonly model: typeof P0B_GOOGLE_MODEL;
  readonly dimensions: typeof P0B_GOOGLE_DIMENSIONS;
  readonly inputs: readonly string[];
  readonly deadline_epoch_ms: number;
}

/**
 * Real successor client. It uses bounded byte framing over AF_UNIX and a random
 * 256-bit nonce. It is intentionally not wired into the fenced runner yet.
 */
export function createP0BGoogleProviderSocketProcess(options: { readonly socket_path?: string } = {}) {
  const client = createP0BGoogleUnixClient(options);
  return Object.freeze({
    async embed(request: ProviderRequest) {
      if (request.schema_version !== 1 || request.model !== P0B_GOOGLE_MODEL
        || request.dimensions !== P0B_GOOGLE_DIMENSIONS) throw new Error('P0B_PROVIDER_PROTOCOL');
      return await client.embed(request.inputs, request.deadline_epoch_ms);
    },
  });
}

/**
 * Production entrypoint. Deployment remains blocked at the first instruction.
 * The peer adapter argument exists because Node/Bun does not expose SO_PEERCRED;
 * an independently reviewed native adapter and stable UID/group policy are required.
 */
export async function runP0BGoogleProviderExecutable(options: {
  readonly peer_credentials?: P0BGoogleLinuxPeerCredentialAdapter;
  readonly peer_policy?: P0BGooglePeerPolicy;
} = {}): Promise<never> {
  if (P0B_GOOGLE_RUNTIME_EXECUTION_STATE === 'UNFINALIZED_NOEXEC') {
    throw new Error('P0B_GOOGLE_RUNTIME_UNFINALIZED_NOEXEC');
  }
  const peerPolicy = options.peer_policy;
  if (peerPolicy === undefined) throw new Error('P0B_PEER_POLICY_UNFINALIZED_NOEXEC');
  const server = await startP0BGoogleProviderServer({
    socket_path: P0B_GOOGLE_SOCKET_PATH,
    peer_credentials: options.peer_credentials ?? denyByDefaultPeerCredentialAdapter,
    peer_policy: peerPolicy,
    https: createPinnedGoogleHttpsAdapter(),
    with_api_key: use => withP0BGoogleCredentialSecret(use),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('close', resolve);
    server.once('error', reject);
  });
  throw new Error('P0B_PROVIDER_STOPPED');
}

/**
 * Compatibility surface for the original mock launcher contract. It remains
 * hard-fenced and never reads any caller-controlled value.
 */
export function createP0BGoogleProviderProcess(_launcher: unknown) {
  return Object.freeze({
    embedWithCredential: async (_credential: P0BGoogleCredentialFd, _value: unknown) => {
      throw new Error('P0B_GOOGLE_RUNTIME_UNFINALIZED_NOEXEC');
    },
  });
}
