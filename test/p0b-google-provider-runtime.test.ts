import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import {
  createP0BGoogleUnixClient,
  createPinnedGoogleHttpsAdapter,
  P0B_GOOGLE_DIMENSIONS,
  P0B_GOOGLE_ORIGIN,
  P0B_GOOGLE_PATH,
  P0B_GOOGLE_WIRE_LIMITS,
  parseP0BGoogleWireRequest,
  startP0BGoogleProviderServer,
  type P0BGoogleHttpsRequest,
} from '../src/core/p0b-google-provider-protocol.ts';
import { withP0BGoogleCredentialSecret } from '../src/core/p0b-google-credential.ts';
import {
  computeP0BPackageRoot,
  verifyP0BImmutablePackage,
} from '../src/core/p0b-google-package-verifier.ts';
import { runP0BGoogleProviderExecutable } from '../src/core/p0b-google-provider-process.ts';

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

async function tempPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'p0b-provider-'));
  cleanup.push(path);
  return path;
}

function vectors(count: number): number[][] {
  return Array.from({ length: count }, (_, row) => Array.from({ length: P0B_GOOGLE_DIMENSIONS }, (_, col) => row + col / 1000));
}

describe('P0-B concrete AF_UNIX provider successor', () => {
  test('rejects a deadline that expires between validation and connect registration', async () => {
    let calls = 0;
    const client = createP0BGoogleUnixClient({ socket_path: '/tmp/does-not-matter.sock', now: () => ++calls === 1 ? 1_000 : 2_000 });
    await expect(client.embed(['alpha'], 1_500)).rejects.toThrow('P0B_PROVIDER_DEADLINE');
  });

  test('rejects a delayed second response frame', async () => {
    const dir = await tempPath(); const socketPath = join(dir, 'trailing.sock');
    const nonce = '01'.repeat(32); const payload = { schema_version: 1, request_nonce: nonce, ok: true, vectors: vectors(1) };
    const frame = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(4 + body.length); out.writeUInt32BE(body.length); body.copy(out, 4); return out; };
    const server = createServer(socket => socket.once('data', () => { socket.write(frame(payload)); setTimeout(() => socket.end(frame(payload)), 5); }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    try {
      const client = createP0BGoogleUnixClient({ socket_path: socketPath, random_bytes: size => new Uint8Array(size).fill(1) });
      await expect(client.embed(['alpha'], Date.now() + 5_000)).rejects.toThrow('P0B_PROVIDER_TRAILING_BYTES');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test('caps chunked HTTPS response during streaming receipt', async () => {
    const oversized = new Uint8Array(P0B_GOOGLE_WIRE_LIMITS.max_response_bytes + 1);
    const adapter = createPinnedGoogleHttpsAdapter((async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(oversized); controller.close(); } }), { status: 200 })) as unknown as typeof fetch);
    await expect(adapter.request({ origin: P0B_GOOGLE_ORIGIN, path: P0B_GOOGLE_PATH, method: 'POST', headers: {}, body: new Uint8Array([1]), signal: new AbortController().signal })).rejects.toThrow('P0B_HTTPS_RESPONSE_TOO_LARGE');
    const short = createPinnedGoogleHttpsAdapter((async () => new Response('abc', { status: 200, headers: { 'content-length': '4' } })) as unknown as typeof fetch);
    await expect(short.request({ origin: P0B_GOOGLE_ORIGIN, path: P0B_GOOGLE_PATH, method: 'POST', headers: {}, body: new Uint8Array([1]), signal: new AbortController().signal })).rejects.toThrow('P0B_HTTPS_CONTENT_LENGTH_MISMATCH');
    const nullBody = createPinnedGoogleHttpsAdapter((async () => new Response(null, { status: 200, headers: { 'content-length': '1' } })) as unknown as typeof fetch);
    await expect(nullBody.request({ origin: P0B_GOOGLE_ORIGIN, path: P0B_GOOGLE_PATH, method: 'POST', headers: {}, body: new Uint8Array([1]), signal: new AbortController().signal })).rejects.toThrow('P0B_HTTPS_CONTENT_LENGTH_MISMATCH');
  });
  test('runs a real local socket round trip through an exact-destination fake HTTPS adapter', async () => {
    const dir = await tempPath();
    const socketPath = join(dir, 'provider.sock');
    const seen: P0BGoogleHttpsRequest[] = [];
    const expected = vectors(2);
    const server = await startP0BGoogleProviderServer({
      socket_path: socketPath,
      peer_credentials: { async getPeerCredentials() { return { pid: 123, uid: 1001, gid: 1002 }; } },
      peer_policy: { authorized_uid: 1001, authorized_gid: 1002 },
      async with_api_key(use) { return await use('offline-test-api-key-123456'); },
      https: { async request(request) {
        seen.push(request);
        expect(request.origin).toBe(P0B_GOOGLE_ORIGIN);
        expect(request.path).toBe(P0B_GOOGLE_PATH);
        expect(request.headers['x-goog-api-key']).toBe('offline-test-api-key-123456');
        expect(request.signal.aborted).toBe(false);
        const body = JSON.parse(Buffer.from(request.body).toString('utf8'));
        expect(body.requests.map((item: any) => item.content.parts[0].text)).toEqual(['alpha', 'beta']);
        return { status: 200, body: Buffer.from(JSON.stringify({ embeddings: expected.map(values => ({ values })) })) };
      } },
    });
    try {
      let nonceCalls = 0;
      const client = createP0BGoogleUnixClient({
        socket_path: socketPath,
        random_bytes(size) { nonceCalls += 1; return new Uint8Array(size).fill(nonceCalls); },
      });
      const result = await client.embed(['alpha', 'beta'], Date.now() + 5000);
      expect(result.vectors).toEqual(expected);
      expect(nonceCalls).toBe(1);
      expect(seen).toHaveLength(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test('rejects unauthorized peers before credential or HTTPS access', async () => {
    const dir = await tempPath();
    const socketPath = join(dir, 'provider.sock');
    let secrets = 0;
    let requests = 0;
    const server = await startP0BGoogleProviderServer({
      socket_path: socketPath,
      peer_credentials: { async getPeerCredentials() { return { pid: 123, uid: 999, gid: 1002 }; } },
      peer_policy: { authorized_uid: 1001, authorized_gid: 1002 },
      async with_api_key(use) { secrets += 1; return await use('must-not-be-read-1234'); },
      https: { async request() { requests += 1; throw new Error('must not call'); } },
    });
    try {
      const client = createP0BGoogleUnixClient({ socket_path: socketPath });
      await expect(client.embed(['alpha'], Date.now() + 5000)).rejects.toThrow('P0B_PEER_REJECTED');
      expect(secrets).toBe(0);
      expect(requests).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test('enforces count, per-string, aggregate, and absolute deadline bounds before IO', () => {
    const now = 1_000_000;
    const base = { schema_version: 1, action: 'GOOGLE_EMBED_FIXED', request_nonce: 'a'.repeat(64),
      model: 'google:gemini-embedding-001', dimensions: 768, deadline_epoch_ms: now + 1000 };
    expect(() => parseP0BGoogleWireRequest({ ...base, inputs: Array(17).fill('x') }, now)).toThrow('P0B_PROVIDER_PROTOCOL');
    expect(() => parseP0BGoogleWireRequest({ ...base, inputs: ['x'.repeat(P0B_GOOGLE_WIRE_LIMITS.max_input_utf8_bytes + 1)] }, now)).toThrow('P0B_PROVIDER_PROTOCOL');
    expect(() => parseP0BGoogleWireRequest({ ...base, inputs: Array(5).fill('x'.repeat(14_000)) }, now)).toThrow('P0B_PROVIDER_PROTOCOL');
    expect(() => parseP0BGoogleWireRequest({ ...base, inputs: ['x'], deadline_epoch_ms: now }, now)).toThrow('P0B_PROVIDER_PROTOCOL');
  });

  test('concrete credential adapter uses numeric nofollow flags, same-fd stat/read, and makes close failure fatal', async () => {
    const dir = await tempPath();
    const path = join(dir, 'credential');
    await writeFile(path, 'offline-test-api-key-123456\n', { mode: 0o600 });
    const stat = await (await open(path, 'r')).stat();
    const policy = { owner_uid: stat.uid, owner_gid: stat.gid, mode: 0o600, max_bytes: 128 };
    let flags = 0;
    const value = await withP0BGoogleCredentialSecret(async key => key.length, {
      path, policy,
      adapter: { async open(file, numericFlags) { flags = numericFlags; return await open(file, numericFlags); } },
    });
    expect(value).toBe('offline-test-api-key-123456'.length);
    expect(flags).toBeNumber();
    expect(flags).not.toBe(0);

    await expect(withP0BGoogleCredentialSecret(async () => 'used', {
      path, policy,
      adapter: { async open(file, numericFlags) {
        const handle = await open(file, numericFlags);
        return {
          fd: handle.fd,
          stat: handle.stat.bind(handle),
          read: handle.read.bind(handle),
          async close() { await handle.close(); throw new Error('injected close failure'); },
        } as any;
      } },
    })).rejects.toThrow('P0B_CREDENTIAL_CLOSE_FAILED');
  });

  test('verifies the exact package root and rejects symlinks and unlisted bytes', async () => {
    const dir = await tempPath();
    await chmod(dir, 0o700);
    await writeFile(join(dir, 'runner'), 'runner-bytes', { mode: 0o600 });
    await writeFile(join(dir, 'provider'), 'provider-bytes', { mode: 0o600 });
    const stat = await (await open(join(dir, 'runner'), 'r')).stat();
    const hashes = {
      provider: createHash('sha256').update('provider-bytes').digest('hex'),
      runner: createHash('sha256').update('runner-bytes').digest('hex'),
    };
    const manifest = { schema_version: 1 as const, files: hashes, root_sha256: computeP0BPackageRoot(hashes) };
    await expect(verifyP0BImmutablePackage(dir, manifest, {
      owner_uid: stat.uid, owner_gid: stat.gid, max_file_bytes: 1024, max_files: 4,
    })).resolves.toEqual(hashes);
    await symlink('runner', join(dir, 'alias'));
    await expect(verifyP0BImmutablePackage(dir, manifest, {
      owner_uid: stat.uid, owner_gid: stat.gid, max_file_bytes: 1024, max_files: 4,
    })).rejects.toThrow('P0B_PACKAGE_SYMLINK_REJECTED');

    const rootAlias = join(await tempPath(), 'root-alias');
    await symlink(dir, rootAlias);
    await expect(verifyP0BImmutablePackage(rootAlias, manifest, {
      owner_uid: stat.uid, owner_gid: stat.gid, max_file_bytes: 1024, max_files: 4,
    })).rejects.toThrow('P0B_PACKAGE_ROOT_REJECTED');
    await expect(verifyP0BImmutablePackage(`${dir}/.`, manifest, {
      owner_uid: stat.uid, owner_gid: stat.gid, max_file_bytes: 1024, max_files: 4,
    })).rejects.toThrow('P0B_PACKAGE_ROOT_REJECTED');

    await rm(join(dir, 'alias'));
    await rm(join(dir, 'provider')); await rm(join(dir, 'runner'));
    const nested = join(dir, 'nested'); await import('node:fs/promises').then(fs => fs.mkdir(nested, { mode: 0o777 }));
    await chmod(nested, 0o777); await writeFile(join(nested, 'runner'), 'runner-bytes', { mode: 0o600 });
    const nestedHashes = { 'nested/runner': hashes.runner };
    await expect(verifyP0BImmutablePackage(dir, { schema_version: 1, files: nestedHashes, root_sha256: computeP0BPackageRoot(nestedHashes) }, {
      owner_uid: stat.uid, owner_gid: stat.gid, max_file_bytes: 1024, max_files: 4,
    })).rejects.toThrow('P0B_PACKAGE_DIRECTORY_REJECTED');
  });

  test('production executable remains fenced before peer, credential, socket, or network setup', async () => {
    await expect(runP0BGoogleProviderExecutable()).rejects.toThrow('P0B_GOOGLE_RUNTIME_UNFINALIZED_NOEXEC');
  });
});
