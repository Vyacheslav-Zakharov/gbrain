import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PortalSessionStore,
  hashPortalSessionToken,
  isPortalFileAllowed,
  isSafePortalRelativePath,
  portalSessionCookieName,
  resolvePortalPathSecure,
} from '../src/core/portal-security';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-portal-security-'));
  cleanup.push(root);
  mkdirSync(join(root, 'папка'));
  writeFileSync(join(root, 'папка', 'документ.md'), '# safe');
  return root;
}

describe('PortalSessionStore', () => {
  test('stores only a token hash and resolves an opaque session', async () => {
    const root = fixture();
    const file = join(root, 'sessions.json');
    const store = new PortalSessionStore(file, 1_000);
    const token = store.issue('User@avers.kz', 100);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(file).text()).not.toContain(token);
    expect(store.resolve(token, 200)).toBe('user@avers.kz');
    expect(store.resolve('user@avers.kz', 200)).toBeNull();
    expect(hashPortalSessionToken(token)).not.toBe(token);
  });

  test('exposes valid, revalidation_required, expired and revoked without sliding expiry', () => {
    const root = fixture();
    const store = new PortalSessionStore(join(root, 'sessions.json'), 8 * 60 * 60 * 1_000, 5 * 60 * 1_000);
    const token = store.issue({ email: 'user@avers.kz', sub: 'keycloak-subject', authMethod: 'keycloak', isAdmin: false }, 100);
    expect(store.inspect(token, 200)).toMatchObject({ state: 'valid', email: 'user@avers.kz', lastValidatedAt: 100, isAdmin: false, authorizationVersion: 1 });
    expect(store.inspect(token, 5 * 60 * 1_000 + 101)).toMatchObject({ state: 'revalidation_required' });
    expect(store.revalidate(token, { email: 'user@avers.kz', sub: 'keycloak-subject', isAdmin: true }, 5 * 60 * 1_000 + 102)).toBeTrue();
    expect(store.inspect(token, 5 * 60 * 1_000 + 103)).toMatchObject({ state: 'valid', isAdmin: true, authorizationVersion: 1 });
    expect(store.revalidate(token, { email: 'user@avers.kz', sub: 'keycloak-subject', isAdmin: false }, 5 * 60 * 1_000 + 104)).toBeTrue();
    expect(store.inspect(token, 5 * 60 * 1_000 + 105)).toMatchObject({ state: 'valid', isAdmin: false, authorizationVersion: 1 });
    expect(store.inspect(token, 8 * 60 * 60 * 1_000 + 101)).toMatchObject({ state: 'expired' });

    const revoked = store.issue({ email: 'user@avers.kz', sub: 'keycloak-subject', authMethod: 'keycloak', isAdmin: false }, 200);
    expect(store.revoke(revoked)).toBeTrue();
    expect(store.inspect(revoked, 201)).toMatchObject({ state: 'revoked' });
    expect(store.inspect('0'.repeat(64), 201)).toMatchObject({ state: 'revoked' });
  });

  test('does not persist Keycloak access or refresh tokens', async () => {
    const root = fixture();
    const file = join(root, 'sessions.json');
    const store = new PortalSessionStore(file);
    store.issue({ email: 'user@avers.kz', sub: 'keycloak-subject', authMethod: 'keycloak', isAdmin: false }, 100);
    const persisted = await Bun.file(file).text();
    expect(persisted).not.toContain('access_token');
    expect(persisted).not.toContain('refresh_token');
    expect(persisted).toContain('keycloak-subject');
  });

  test('old session records stay Portal-readable but cannot inherit Admin before revalidation', () => {
    const root = fixture();
    const file = join(root, 'sessions.json');
    const token = 'a'.repeat(64);
    const now = Date.now();
    writeFileSync(file, JSON.stringify({
      [hashPortalSessionToken(token)]: {
        email: 'user@avers.kz', sub: 'keycloak-subject', authMethod: 'keycloak',
        createdAt: now - 100, expiresAt: now + 10_000, lastValidatedAt: now - 100,
      },
    }));
    const store = new PortalSessionStore(file, 20_000, 5_000);
    expect(store.inspect(token, now)).toMatchObject({
      state: 'valid', isAdmin: false, authorizationVersion: 0,
    });
    expect(store.revalidate(token, { email: 'user@avers.kz', sub: 'keycloak-subject', isAdmin: true }, now + 1)).toBeTrue();
    expect(store.inspect(token, now + 2)).toMatchObject({
      state: 'valid', isAdmin: true, authorizationVersion: 1,
    });
  });

  test('prunes expired and revoked records from persistent storage', async () => {
    const root = fixture();
    const file = join(root, 'sessions.json');
    const store = new PortalSessionStore(file, 50, 10);
    store.issue({ email: 'alice-example@avers.kz', sub: 'person-1', authMethod: 'keycloak', isAdmin: false }, 100);
    const revoked = store.issue({ email: 'bob-example@avers.kz', sub: 'person-2', authMethod: 'keycloak', isAdmin: false }, 100);
    expect(store.revoke(revoked, 110)).toBeTrue();
    expect(store.prune(151)).toBe(2);
    const persisted = await Bun.file(file).text();
    expect(persisted).not.toContain('alice-example@avers.kz');
    expect(persisted).not.toContain('bob-example@avers.kz');
  });

  test('uses a __Host cookie only for secure origins', () => {
    expect(portalSessionCookieName(true)).toBe('__Host-gbrain_portal');
    expect(portalSessionCookieName(false)).toBe('gbrain_portal');
  });
});

describe('portal path confinement', () => {
  test('accepts Cyrillic nested files and root only when explicitly allowed', () => {
    const root = fixture();
    expect(resolvePortalPathSecure(root, 'папка/документ.md')).toBe(join(root, 'папка', 'документ.md'));
    expect(resolvePortalPathSecure(root, '', true)).toBe(root);
    expect(resolvePortalPathSecure(root, '', false)).toBeNull();
  });

  test('rejects traversal, hidden paths, encoded bytes, controls and backslashes', () => {
    for (const value of ['../secret', 'folder/../secret', '.env', '.git/config', 'folder/.hidden', 'folder\\secret', '%2e%2e/secret', 'a\u0000b']) {
      expect(isSafePortalRelativePath(value)).toBeFalse();
    }
  });

  test('allows document formats but rejects configs, keys and extensionless files', () => {
    expect(isPortalFileAllowed('docs/report.pdf')).toBeTrue();
    expect(isPortalFileAllowed('notes/отчёт.md')).toBeTrue();
    expect(isPortalFileAllowed('config.json')).toBeFalse();
    expect(isPortalFileAllowed('server-private-key.pem')).toBeFalse();
    expect(isPortalFileAllowed('credentials/private-key.md')).toBeFalse();
    expect(isPortalFileAllowed('docs/secret.md')).toBeFalse();
    expect(isPortalFileAllowed('credentials')).toBeFalse();
  });

  test('rejects final and parent-directory symlinks', () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-portal-outside-'));
    cleanup.push(outside);
    writeFileSync(join(outside, 'secret.md'), '# secret');
    symlinkSync(join(outside, 'secret.md'), join(root, 'leak.md'));
    symlinkSync(outside, join(root, 'leak-dir'));
    expect(resolvePortalPathSecure(root, 'leak.md')).toBeNull();
    expect(resolvePortalPathSecure(root, 'leak-dir/secret.md')).toBeNull();
  });
});
