import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { normalizePortalReturnTo } from '../src/core/portal-keycloak-auth';

// Execute the real page middleware without booting serve-http, a DB or an IdP.
const source = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
const guard = source.match(/const requirePortalPage = [\s\S]*?\n};/)![0];
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(guard) + '\nrequirePortalPage;';
function invoke(originalUrl: string, email: string | null = null, onboarded = true) {
  const redirects: string[] = [];
  let next = false;
  const middleware = runInNewContext(js, { normalizePortalReturnTo, encodeURIComponent, resolvePortalUser: () => email, hasSeenPortalOnboarding: () => onboarded });
  middleware({ originalUrl }, { redirect: (url: string) => redirects.push(url) }, () => { next = true; });
  return { redirects, next };
}

test('unauthenticated portal page preserves the original path and query through login', () => {
  const url = '/portal?source=team-example&path=docs%2Fnote.md';
  expect(invoke(url).redirects).toEqual(['/login?return_to=' + encodeURIComponent(url)]);
  expect(invoke('/portal/review?filter=pending').redirects).toEqual(['/login?return_to=' + encodeURIComponent('/portal/review?filter=pending')]);
});

test('silent revalidation denial clears cookies but keeps its normalized return target', () => {
  const branch = source.match(/if \(!portalSessions\.revalidate\(transaction\.existingSessionToken, identity\)\) \{([\s\S]*?)\n        }/)![1];
  let cleared = false;
  let redirect = '';
  const callback = runInNewContext('(function () {' + branch + '\n})', {
    normalizePortalReturnTo, encodeURIComponent, transaction: { returnTo: '/portal?source=team-example&path=note.md#section' },
    clearPortalSessionCookies: () => { cleared = true; }, req: {}, res: { redirect: (url: string) => { redirect = url; } },
  });
  callback();
  expect(cleared).toBe(true);
  expect(redirect).toBe('/login?return_to=' + encodeURIComponent('/portal?source=team-example&path=note.md#section'));
});

test('page redirect retains return-target validation and the existing onboarding gate', () => {
  expect(invoke('//evil.example').redirects).toEqual(['/login?return_to=%2Fportal']);
  expect(invoke('/portal', 'alice-example@example.com', false).redirects).toEqual(['/portal/welcome']);
  expect(invoke('/portal', 'alice-example@example.com').next).toBe(true);
});
