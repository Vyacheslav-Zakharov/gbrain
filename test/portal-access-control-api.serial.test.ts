import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PortalAccessControlRepository } from '../src/core/portal-access-control.ts';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

async function waitForReady(port: number, proc: Subprocess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const stderr = typeof proc.stderr === 'number'
        ? ''
        : await new Response(proc.stderr).text().catch(() => '');
      throw new Error(`server_exited:${proc.exitCode}:${stderr.slice(0, 2000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* still starting */ }
    await Bun.sleep(200);
  }
  throw new Error('server_not_ready');
}

async function stop(proc: Subprocess, home: string): Promise<void> {
  try { proc.kill('SIGTERM'); } catch { /* exited */ }
  await Promise.race([proc.exited, Bun.sleep(2000)]);
  try { proc.kill('SIGKILL'); } catch { /* exited */ }
  rmSync(home, { recursive: true, force: true });
}

describe('portal access-control DB Admin API', () => {
  test('uses numeric versions, audit read-back, and 409 conflicts over real HTTP', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-acl-api-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const databasePath = join(home, '.gbrain', 'brain.pglite');
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite', database_path: databasePath, embedding_dimensions: 1536,
    }) + '\n');

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    await engine.initSchema();
    await engine.executeRaw(`
      INSERT INTO sources (id, name, local_path, config) VALUES
        ('alice', 'Alice', '/tmp/alice', '{}'::jsonb),
        ('shared', 'Shared', '/tmp/shared', '{}'::jsonb),
        ('internal-it', 'IT', '/tmp/it', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
    const repository = new PortalAccessControlRepository(engine);
    await repository.provisionUser({
      email: 'alice@avers.kz', keycloakSub: 'kc-alice', personalSourceId: 'alice',
    });
    await repository.createRequest({
      id: 'req-http', email: 'alice@avers.kz', reason: 'Need IT',
      grants: [{ sourceId: 'internal-it', requestedRead: true, requestedWrite: true }],
    });
    await repository.createRequest({
      id: 'req-reject', email: 'alice@avers.kz', reason: 'No longer needed',
      grants: [{ sourceId: 'shared', requestedRead: true, requestedWrite: false }],
    });
    await engine.disconnect();

    const port = 35000 + Math.floor(Math.random() * 2000);
    const token = 'test-bootstrap-token-aaaaaaaaaaaaaaaaaa';
    const proc = Bun.spawn([
      'bun', 'run', `${REPO}/src/cli.ts`, 'serve', '--http', '--port', String(port), '--bind', '127.0.0.1',
    ], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        GBRAIN_HOME: home,
        GBRAIN_PORTAL_ACL_MODE: 'db',
        GBRAIN_ADMIN_BOOTSTRAP_TOKEN: token,
        GBRAIN_ADMIN_FALLBACK_UNTIL: '2099-01-01T00:00:00.000Z',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
      stdout: 'pipe', stderr: 'pipe',
    });

    try {
      await waitForReady(port, proc);
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/admin/api/permissions`)).status).toBe(401);

      const login = await fetch(`${base}/admin/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
      });
      expect(login.status).toBe(200);
      const cookie = String(login.headers.get('set-cookie')).split(';')[0];
      const headers = {
        cookie,
        origin: base,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      };

      const permissionsResponse = await fetch(`${base}/admin/api/permissions`, { headers: { cookie } });
      expect(permissionsResponse.status).toBe(200);
      const permissions = await permissionsResponse.json() as any;
      expect(permissions.authority).toBe('db');
      expect(permissions.users[0].version).toBe(1);

      const crossOrigin = await fetch(`${base}/admin/api/permissions/alice%40avers.kz`, {
        method: 'POST', headers: { ...headers, origin: 'https://evil.example' },
        body: JSON.stringify({ expected_version: 1, grants: [] }),
      });
      expect(crossOrigin.status).toBe(403);

      const saved = await fetch(`${base}/admin/api/permissions/alice%40avers.kz`, {
        method: 'POST', headers,
        body: JSON.stringify({
          expected_version: 1,
          grants: [
            { source_id: 'shared', read: true, write: false },
            { source_id: 'internal-it', read: false, write: false },
          ],
        }),
      });
      expect(saved.status).toBe(200);
      const savedBody = await saved.json() as any;
      expect(savedBody.version).toBe(2);
      expect(savedBody.audit?.actor).toMatch(/^[a-z-]+:[a-f0-9]{12}$/);
      expect(savedBody.audit?.changed_at).toBeTruthy();

      const stale = await fetch(`${base}/admin/api/permissions/alice%40avers.kz`, {
        method: 'POST', headers,
        body: JSON.stringify({ expected_version: 1, grants: [] }),
      });
      expect(stale.status).toBe(409);
      expect((await stale.json() as any).error).toBe('permissions_changed');

      const requestsResponse = await fetch(`${base}/admin/api/access-requests`, { headers: { cookie } });
      const requests = await requestsResponse.json() as any;
      expect(requests.authority).toBe('db');
      expect(requests.requests.find((request: any) => request.id === 'req-http').version).toBe(1);

      const approved = await fetch(`${base}/admin/api/access-requests/req-http/approve`, {
        method: 'POST', headers,
        body: JSON.stringify({ expected_version: 1, grants: [{ index: 0, read: true, write: true }] }),
      });
      expect(approved.status).toBe(200);
      const approvedBody = await approved.json() as any;
      expect(approvedBody.request.version).toBe(2);
      expect(approvedBody.audit?.actor).toMatch(/^[a-z-]+:[a-f0-9]{12}$/);

      const rejected = await fetch(`${base}/admin/api/access-requests/req-reject/reject`, {
        method: 'POST', headers,
        body: JSON.stringify({ expected_version: 1, reason: 'Not approved' }),
      });
      expect(rejected.status).toBe(200);
      const rejectedBody = await rejected.json() as any;
      expect(rejectedBody.request.version).toBe(2);
      expect(rejectedBody.request.status).toBe('rejected');
      expect(rejectedBody.audit?.actor).toMatch(/^[a-z-]+:[a-f0-9]{12}$/);

      const freshPermissions = await (await fetch(`${base}/admin/api/permissions`, { headers: { cookie } })).json() as any;
      expect(freshPermissions.users[0].version).toBe(3);
      expect(freshPermissions.users[0].federated_write).toContain('internal-it');
    } finally {
      await stop(proc, home);
    }
  }, 90_000);
});
