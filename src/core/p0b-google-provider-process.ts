import type { P0BGoogleCredentialFd } from './p0b-google-credential.ts';
import { P0B_GOOGLE_RUNTIME_EXECUTION_STATE } from './p0b-google-credential.ts';

export const P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT = Object.freeze({
  schema_version: 1,
  executable: '/usr/lib/gbrain/p0b-google-provider',
  protocol: 'STDIO_FRAMED_V1',
  action: 'GOOGLE_EMBED_FIXED',
  model: 'google:gemini-embedding-001',
  dimensions: 768,
  credential_fd: 3,
  shared_gateway: 'FORBIDDEN',
  environment_credentials: 'FORBIDDEN',
} as const);

interface ProviderRequest {
  readonly schema_version: 1;
  readonly model: 'google:gemini-embedding-001';
  readonly dimensions: 768;
  readonly inputs: readonly string[];
  readonly deadline_epoch_ms: number;
}

interface ProviderChild {
  readonly request: (frame: unknown) => Promise<unknown>;
  readonly terminate: () => Promise<void>;
}

interface ProviderLauncher {
  readonly launch: (request: unknown) => Promise<ProviderChild>;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) throw new Error('P0B_PROVIDER_PROTOCOL');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('P0B_PROVIDER_PROTOCOL');
  }
  return value;
}

function dense(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('P0B_PROVIDER_PROTOCOL');
  }
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new Error('P0B_PROVIDER_PROTOCOL');
  }
  return value;
}

function parseRequest(value: unknown): ProviderRequest {
  const request = exact(value, ['schema_version', 'model', 'dimensions', 'inputs', 'deadline_epoch_ms']);
  const inputs = dense(request.inputs);
  if (request.schema_version !== 1
    || request.model !== P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT.model
    || request.dimensions !== P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT.dimensions
    || !Number.isSafeInteger(request.deadline_epoch_ms) || (request.deadline_epoch_ms as number) <= 0
    || inputs.length === 0 || inputs.some(input => typeof input !== 'string')) {
    throw new Error('P0B_PROVIDER_PROTOCOL');
  }
  return Object.freeze({ ...request, inputs: Object.freeze([...inputs]) }) as unknown as ProviderRequest;
}

function parseResponse(value: unknown, requestId: string, count: number): { schema_version: 1; vectors: number[][] } {
  const response = exact(value, ['schema_version', 'request_id', 'vectors']);
  const rawVectors = dense(response.vectors);
  if (response.schema_version !== 1 || response.request_id !== requestId || rawVectors.length !== count) {
    throw new Error('P0B_PROVIDER_PROTOCOL');
  }
  const vectors = rawVectors.map(rawVector => {
    const vector = dense(rawVector);
    if (vector.length !== P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT.dimensions
      || vector.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
      throw new Error('P0B_PROVIDER_PROTOCOL');
    }
    return Object.freeze(vector.map(component => Object.is(component, -0) ? 0 : component)) as number[];
  });
  return Object.freeze({ schema_version: 1, vectors: Object.freeze(vectors) }) as { schema_version: 1; vectors: number[][] };
}

export function createP0BGoogleProviderProcess(launcher: ProviderLauncher) {
  let sequence = 0;
  return Object.freeze({
    embedWithCredential: async (credential: P0BGoogleCredentialFd, value: unknown) => {
      if (P0B_GOOGLE_RUNTIME_EXECUTION_STATE === 'UNFINALIZED_NOEXEC') {
        throw new Error('P0B_GOOGLE_RUNTIME_UNFINALIZED_NOEXEC');
      }
      const request = parseRequest(value);
      sequence += 1;
      if (!Number.isSafeInteger(sequence) || sequence > 99_999_999) throw new Error('P0B_PROVIDER_PROTOCOL');
      const requestId = `request-${String(sequence).padStart(8, '0')}`;
      let child: ProviderChild | undefined;
      try {
        child = await launcher.launch(Object.freeze({
          executable: P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT.executable,
          argv: Object.freeze([P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT.executable, '--stdio-framed-v1']),
          env: Object.freeze({}),
          credential_fd: P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT.credential_fd,
          credential: credential.fd,
          stdin: 'PIPE',
          stdout: 'PIPE',
          stderr: 'VALUE_FREE',
          shared_gateway: 'FORBIDDEN',
          network: 'GOOGLE_GENERATIVE_LANGUAGE_ONLY',
        }));
        const response = await child.request(Object.freeze({
          schema_version: 1,
          action: P0B_GOOGLE_PROVIDER_PROCESS_CONTRACT.action,
          request_id: requestId,
          model: request.model,
          dimensions: request.dimensions,
          inputs: request.inputs,
          deadline_epoch_ms: request.deadline_epoch_ms,
        }));
        return parseResponse(response, requestId, request.inputs.length);
      } catch (error) {
        if (error instanceof Error && error.message === 'P0B_PROVIDER_PROTOCOL') throw error;
        throw new Error('P0B_PROVIDER_PROTOCOL');
      } finally {
        if (child !== undefined) {
          try { await child.terminate(); } catch { /* child is already unusable */ }
        }
      }
    },
  });
}
