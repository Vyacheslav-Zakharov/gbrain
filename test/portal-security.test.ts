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

  test('fails closed for expired, unknown and revoked sessions', () => {
    const root = fixture();
    const store = new PortalSessionStore(join(root, 'sessions.json'), 50);
    const expired = store.issue('user@avers.kz', 100);
    expect(store.resolve(expired, 151)).toBeNull();
    const revoked = store.issue('user@avers.kz', 200);
    expect(store.revoke(revoked)).toBeTrue();
    expect(store.resolve(revoked, 201)).toBeNull();
    expect(store.resolve('0'.repeat(64), 201)).toBeNull();
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
