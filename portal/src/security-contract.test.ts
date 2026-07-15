import { describe, expect, test } from 'bun:test';

const appSource = await Bun.file(new URL('./PortalApp.tsx', import.meta.url)).text();
const markdownSource = await Bun.file(new URL('./markdown.ts', import.meta.url)).text();

describe('Portal client security contract', () => {
  test('partitions personalization by authenticated account', () => {
    expect(appSource).toContain('scopedStorageKey(LAST_SOURCE_KEY, session.email)');
    expect(appSource).toContain('scopedStorageKey(RECENTS_KEY, session.email)');
    expect(appSource).toContain('scopedStorageKey(FAVORITES_KEY, session.email)');
    expect(appSource).not.toContain('stored(RECENTS_KEY, []');
    expect(appSource).not.toContain('persist(FAVORITES_KEY, next)');
  });

  test('uses an HTML allowlist and rejects protocol-relative navigation', () => {
    expect(markdownSource).toContain('const allowedTags = new Set');
    expect(markdownSource).toContain("href.startsWith('//')");
    expect(markdownSource).toContain("node.removeAttribute('href')");
    expect(markdownSource).toContain("!src.startsWith('/') || src.startsWith('//')");
  });
});
