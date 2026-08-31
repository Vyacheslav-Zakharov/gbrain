import { randomBytes } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

export const P0B_GOOGLE_SOCKET_PATH = '/run/gbrain-p0b-google/provider.sock' as const;
export const P0B_GOOGLE_MODEL = 'google:gemini-embedding-001' as const;
export const P0B_GOOGLE_DIMENSIONS = 768 as const;
export const P0B_GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com' as const;
export const P0B_GOOGLE_PATH = '/v1beta/models/gemini-embedding-001:batchEmbedContents' as const;

export const P0B_GOOGLE_WIRE_LIMITS = Object.freeze({
  header_bytes: 4,
  max_request_bytes: 96 * 1024,
  max_response_bytes: 512 * 1024,
  max_inputs: 16,
  max_input_utf8_bytes: 16 * 1024,
  max_aggregate_input_utf8_bytes: 64 * 1024,
  max_error_utf8_bytes: 256,
  min_deadline_lead_ms: 1,
  max_deadline_lead_ms: 120_000,
} as const);

export interface P0BGooglePeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

/** Linux implementations must obtain SO_PEERCRED from this accepted socket. */
export interface P0BGoogleLinuxPeerCredentialAdapter {
  readonly getPeerCredentials: (socket: Socket) => Promise<P0BGooglePeerCredentials>;
}

export const denyByDefaultPeerCredentialAdapter: P0BGoogleLinuxPeerCredentialAdapter = Object.freeze({
  async getPeerCredentials() {
    throw new Error('P0B_PEER_CREDENTIAL_ADAPTER_UNAVAILABLE');
  },
});

export interface P0BGooglePeerPolicy {
  readonly authorized_uid: number;
  readonly authorized_gid?: number;
}

export interface P0BGoogleHttpsRequest {
  readonly origin: typeof P0B_GOOGLE_ORIGIN;
  readonly path: typeof P0B_GOOGLE_PATH;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}

export interface P0BGoogleHttpsResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export interface P0BGoogleHttpsAdapter {
  readonly request: (request: P0BGoogleHttpsRequest) => Promise<P0BGoogleHttpsResponse>;
}

interface WireRequest {
  readonly schema_version: 1;
  readonly action: 'GOOGLE_EMBED_FIXED';
  readonly request_nonce: string;
  readonly model: typeof P0B_GOOGLE_MODEL;
  readonly dimensions: typeof P0B_GOOGLE_DIMENSIONS;
  readonly inputs: readonly string[];
  readonly deadline_epoch_ms: number;
}

interface WireSuccess {
  readonly schema_version: 1;
  readonly request_nonce: string;
  readonly ok: true;
  readonly vectors: readonly (readonly number[])[];
}

const NONCE_RE = /^[a-f0-9]{64}$/;

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
  if (Object.keys(value).some((key, index) => key !== String(index))) {
    throw new Error('P0B_PROVIDER_PROTOCOL');
  }
  return value;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function parseP0BGoogleWireRequest(value: unknown, nowEpochMs: number): WireRequest {
  const request = exact(value, [
    'schema_version', 'action', 'request_nonce', 'model', 'dimensions', 'inputs', 'deadline_epoch_ms',
  ]);
  const inputs = dense(request.inputs);
  if (request.schema_version !== 1 || request.action !== 'GOOGLE_EMBED_FIXED'
    || request.model !== P0B_GOOGLE_MODEL || request.dimensions !== P0B_GOOGLE_DIMENSIONS
    || typeof request.request_nonce !== 'string' || !NONCE_RE.test(request.request_nonce)
    || !Number.isSafeInteger(request.deadline_epoch_ms)
    || (request.deadline_epoch_ms as number) < nowEpochMs + P0B_GOOGLE_WIRE_LIMITS.min_deadline_lead_ms
    || (request.deadline_epoch_ms as number) > nowEpochMs + P0B_GOOGLE_WIRE_LIMITS.max_deadline_lead_ms
    || inputs.length < 1 || inputs.length > P0B_GOOGLE_WIRE_LIMITS.max_inputs
    || inputs.some(input => typeof input !== 'string' || input.length === 0
      || utf8Bytes(input) > P0B_GOOGLE_WIRE_LIMITS.max_input_utf8_bytes)
    || inputs.reduce<number>((sum, input) => sum + utf8Bytes(input as string), 0)
      > P0B_GOOGLE_WIRE_LIMITS.max_aggregate_input_utf8_bytes) {
    throw new Error('P0B_PROVIDER_PROTOCOL');
  }
  return Object.freeze({ ...request, inputs: Object.freeze([...inputs]) }) as unknown as WireRequest;
}

function parseWireSuccess(value: unknown, nonce: string, count: number): WireSuccess {
  const response = exact(value, ['schema_version', 'request_nonce', 'ok', 'vectors']);
  const vectors = dense(response.vectors);
  if (response.schema_version !== 1 || response.request_nonce !== nonce || response.ok !== true
    || vectors.length !== count) throw new Error('P0B_PROVIDER_PROTOCOL');
  const parsed = vectors.map(raw => {
    const vector = dense(raw);
    if (vector.length !== P0B_GOOGLE_DIMENSIONS
      || vector.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
      throw new Error('P0B_PROVIDER_PROTOCOL');
    }
    return Object.freeze(vector.map(component => Object.is(component, -0) ? 0 : component as number));
  });
  return Object.freeze({ schema_version: 1, request_nonce: nonce, ok: true, vectors: Object.freeze(parsed) });
}

function encodeFrame(value: unknown, maxBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength === 0 || body.byteLength > maxBytes) throw new Error('P0B_FRAME_TOO_LARGE');
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

async function readOneFrame(socket: Socket, maxBytes: number, signal: AbortSignal, requireEnd = false): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const header = Buffer.alloc(4); let headerOffset = 0;
    let body: Buffer | undefined; let bodyOffset = 0; let parsed: unknown; let complete = false;
    const finish = (error?: Error, value?: unknown) => {
      socket.off('data', onData); socket.off('error', onError); socket.off('end', onEnd);
      signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(value);
    };
    const onError = () => finish(new Error('P0B_PROVIDER_IO'));
    const onEnd = () => complete && requireEnd ? finish(undefined, parsed) : finish(new Error('P0B_PROVIDER_TRUNCATED'));
    const onAbort = () => { socket.destroy(); finish(new Error('P0B_PROVIDER_DEADLINE')); };
    const onData = (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk) || chunk.byteLength === 0) { finish(new Error('P0B_FRAME_TOO_LARGE')); return; }
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (complete) { finish(new Error('P0B_PROVIDER_TRAILING_BYTES')); return; }
        if (headerOffset < 4) {
          const count = Math.min(4 - headerOffset, chunk.byteLength - offset);
          chunk.copy(header, headerOffset, offset, offset + count); headerOffset += count; offset += count;
          if (headerOffset === 4) {
            const expected = header.readUInt32BE(0);
            if (expected === 0 || expected > maxBytes) { finish(new Error('P0B_FRAME_TOO_LARGE')); return; }
            body = Buffer.allocUnsafe(expected);
          }
          continue;
        }
        const count = Math.min(body!.byteLength - bodyOffset, chunk.byteLength - offset);
        chunk.copy(body!, bodyOffset, offset, offset + count); bodyOffset += count; offset += count;
        if (bodyOffset === body!.byteLength) {
          try { parsed = JSON.parse(body!.toString('utf8')); complete = true; }
          catch { finish(new Error('P0B_PROVIDER_PROTOCOL')); return; }
          if (!requireEnd) { finish(undefined, parsed); return; }
        }
      }
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('data', onData); socket.once('error', onError); socket.once('end', onEnd);
    if (signal.aborted) onAbort();
  });
}

function guardNoTrailingData(socket: Socket): { assert: () => void; dispose: () => void } {
  let trailing = false;
  const onData = () => { trailing = true; socket.destroy(); };
  socket.on('data', onData);
  return { assert() { if (trailing || socket.readableLength > 0) throw new Error('P0B_PROVIDER_TRAILING_BYTES'); }, dispose() { socket.off('data', onData); } };
}

function deadlineSignal(deadlineEpochMs: number, now: () => number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const remaining = deadlineEpochMs - now();
  if (!Number.isSafeInteger(deadlineEpochMs) || remaining <= 0
    || remaining > P0B_GOOGLE_WIRE_LIMITS.max_deadline_lead_ms) {
    controller.abort();
    return { signal: controller.signal, dispose() {} };
  }
  const timer = setTimeout(() => controller.abort(), remaining);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export function createPinnedGoogleHttpsAdapter(fetchImpl: typeof fetch = fetch): P0BGoogleHttpsAdapter {
  return Object.freeze({
    async request(request: P0BGoogleHttpsRequest) {
      if (request.origin !== P0B_GOOGLE_ORIGIN || request.path !== P0B_GOOGLE_PATH
        || request.method !== 'POST') throw new Error('P0B_HTTPS_DESTINATION_REJECTED');
      const response = await fetchImpl(`${P0B_GOOGLE_ORIGIN}${P0B_GOOGLE_PATH}`, {
        method: 'POST', headers: { ...request.headers }, body: Buffer.from(request.body), signal: request.signal,
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      const rawLength = response.headers.get('content-length');
      if (rawLength !== null && (!/^(?:0|[1-9][0-9]*)$/.test(rawLength)
        || Number(rawLength) > P0B_GOOGLE_WIRE_LIMITS.max_response_bytes)) {
        throw new Error('P0B_HTTPS_RESPONSE_TOO_LARGE');
      }
      const declaredLength = rawLength === null ? undefined : Number(rawLength);
      if (response.body === null) {
        if (declaredLength !== undefined && declaredLength !== 0) throw new Error('P0B_HTTPS_CONTENT_LENGTH_MISMATCH');
        return Object.freeze({ status: response.status, body: new Uint8Array() });
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > P0B_GOOGLE_WIRE_LIMITS.max_response_bytes) {
            await reader.cancel(); throw new Error('P0B_HTTPS_RESPONSE_TOO_LARGE');
          }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      if (declaredLength !== undefined && total !== declaredLength) throw new Error('P0B_HTTPS_CONTENT_LENGTH_MISMATCH');
      const body = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return Object.freeze({ status: response.status, body });
    },
  });
}

function googleBody(request: WireRequest): Uint8Array {
  return Buffer.from(JSON.stringify({ requests: request.inputs.map(text => ({
    model: 'models/gemini-embedding-001', content: { parts: [{ text }] }, outputDimensionality: 768,
  })) }), 'utf8');
}

function parseGoogleResponse(response: P0BGoogleHttpsResponse, count: number): readonly (readonly number[])[] {
  if (response.status !== 200 || response.body.byteLength > P0B_GOOGLE_WIRE_LIMITS.max_response_bytes) {
    throw new Error('P0B_GOOGLE_RESPONSE_REJECTED');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(response.body).toString('utf8')); }
  catch { throw new Error('P0B_GOOGLE_RESPONSE_REJECTED'); }
  const root = exact(parsed, ['embeddings']);
  const embeddings = dense(root.embeddings);
  if (embeddings.length !== count) throw new Error('P0B_GOOGLE_RESPONSE_REJECTED');
  return Object.freeze(embeddings.map(item => {
    const embedding = exact(item, ['values']);
    const values = dense(embedding.values);
    if (values.length !== P0B_GOOGLE_DIMENSIONS
      || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('P0B_GOOGLE_RESPONSE_REJECTED');
    }
    return Object.freeze(values.map(value => Object.is(value, -0) ? 0 : value as number));
  }));
}

export interface P0BGoogleProviderServerOptions {
  readonly socket_path: string;
  readonly peer_credentials?: P0BGoogleLinuxPeerCredentialAdapter;
  readonly peer_policy: P0BGooglePeerPolicy;
  readonly https: P0BGoogleHttpsAdapter;
  readonly with_api_key: <T>(use: (apiKey: string) => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

export async function startP0BGoogleProviderServer(options: P0BGoogleProviderServerOptions): Promise<Server> {
  const now = options.now ?? Date.now;
  const peerAdapter = options.peer_credentials ?? denyByDefaultPeerCredentialAdapter;
  const server = createServer(socket => {
    void (async () => {
      let deadline: ReturnType<typeof deadlineSignal> | undefined;
      let trailingGuard: ReturnType<typeof guardNoTrailingData> | undefined;
      try {
        const peer = await peerAdapter.getPeerCredentials(socket);
        if (!Number.isSafeInteger(peer.pid) || peer.pid <= 0 || peer.uid !== options.peer_policy.authorized_uid
          || (options.peer_policy.authorized_gid !== undefined && peer.gid !== options.peer_policy.authorized_gid)) {
          throw new Error('P0B_PEER_REJECTED');
        }
        const initial = deadlineSignal(now() + P0B_GOOGLE_WIRE_LIMITS.max_deadline_lead_ms, now);
        const raw = await readOneFrame(socket, P0B_GOOGLE_WIRE_LIMITS.max_request_bytes, initial.signal);
        initial.dispose();
        trailingGuard = guardNoTrailingData(socket);
        const request = parseP0BGoogleWireRequest(raw, now());
        deadline = deadlineSignal(request.deadline_epoch_ms, now);
        const vectors = await options.with_api_key(async apiKey => {
          const response = await options.https.request(Object.freeze({
            origin: P0B_GOOGLE_ORIGIN, path: P0B_GOOGLE_PATH, method: 'POST',
            headers: Object.freeze({ 'content-type': 'application/json', 'x-goog-api-key': apiKey }),
            body: googleBody(request), signal: deadline!.signal,
          }));
          if (deadline!.signal.aborted) throw new Error('P0B_PROVIDER_DEADLINE');
          return parseGoogleResponse(response, request.inputs.length);
        });
        trailingGuard.assert();
        socket.end(encodeFrame(Object.freeze({ schema_version: 1, request_nonce: request.request_nonce, ok: true, vectors }), P0B_GOOGLE_WIRE_LIMITS.max_response_bytes));
      } catch (error) {
        const code = error instanceof Error ? error.message : 'P0B_PROVIDER_REJECTED';
        const safeCode = /^P0B_[A-Z0-9_]{1,128}$/.test(code) ? code : 'P0B_PROVIDER_REJECTED';
        if (!socket.destroyed) {
          try { socket.end(encodeFrame({ schema_version: 1, ok: false, error: safeCode.slice(0, P0B_GOOGLE_WIRE_LIMITS.max_error_utf8_bytes) }, P0B_GOOGLE_WIRE_LIMITS.max_response_bytes)); }
          catch { socket.destroy(); }
        }
      } finally { deadline?.dispose(); trailingGuard?.dispose(); }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socket_path, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

export interface P0BGoogleProviderClientOptions {
  readonly socket_path?: string;
  readonly now?: () => number;
  readonly random_bytes?: (size: number) => Uint8Array;
}

export function createP0BGoogleUnixClient(options: P0BGoogleProviderClientOptions = {}) {
  const socketPath = options.socket_path ?? P0B_GOOGLE_SOCKET_PATH;
  const now = options.now ?? Date.now;
  const random = options.random_bytes ?? randomBytes;
  return Object.freeze({
    async embed(inputs: readonly string[], deadlineEpochMs: number): Promise<{ schema_version: 1; vectors: number[][] }> {
      const nonceBytes = random(32);
      if (!(nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== 32) throw new Error('P0B_NONCE_SOURCE_REJECTED');
      const requestNonce = Buffer.from(nonceBytes).toString('hex');
      const request = parseP0BGoogleWireRequest({ schema_version: 1, action: 'GOOGLE_EMBED_FIXED',
        request_nonce: requestNonce, model: P0B_GOOGLE_MODEL, dimensions: P0B_GOOGLE_DIMENSIONS,
        inputs: [...inputs], deadline_epoch_ms: deadlineEpochMs }, now());
      const deadline = deadlineSignal(deadlineEpochMs, now);
      if (deadline.signal.aborted) { deadline.dispose(); throw new Error('P0B_PROVIDER_DEADLINE'); }
      const socket = createConnection({ path: socketPath });
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { socket.destroy(); reject(new Error('P0B_PROVIDER_DEADLINE')); };
          if (deadline.signal.aborted) { abort(); return; }
          deadline.signal.addEventListener('abort', abort, { once: true });
          socket.once('connect', () => { deadline.signal.removeEventListener('abort', abort); resolve(); });
          socket.once('error', () => { deadline.signal.removeEventListener('abort', abort); reject(new Error('P0B_PROVIDER_IO')); });
          if (deadline.signal.aborted) abort();
        });
        socket.write(encodeFrame(request, P0B_GOOGLE_WIRE_LIMITS.max_request_bytes));
        const raw = await readOneFrame(socket, P0B_GOOGLE_WIRE_LIMITS.max_response_bytes, deadline.signal, true);
        const candidate = plain(raw) && raw.ok === false ? exact(raw, ['schema_version', 'ok', 'error']) : raw;
        if (plain(candidate) && candidate.ok === false) throw new Error(typeof candidate.error === 'string' ? candidate.error : 'P0B_PROVIDER_REJECTED');
        const response = parseWireSuccess(raw, requestNonce, inputs.length);
        return Object.freeze({ schema_version: 1, vectors: response.vectors.map(vector => [...vector]) });
      } finally { deadline.dispose(); socket.destroy(); }
    },
  });
}
