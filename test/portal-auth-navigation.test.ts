import { beforeAll, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

let apiCode: string;
let navigationCode: string;
beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [new URL('../portal/src/api.ts', import.meta.url).pathname], target: 'browser', format: 'cjs' });
  if (!built.success) throw new Error(String(built.logs));
  apiCode = await built.outputs[0].text();
  const navigation = await Bun.build({ entrypoints: [new URL('../portal/src/auth-navigation.ts', import.meta.url).pathname], target: 'browser', format: 'cjs' });
  navigationCode = await navigation.outputs[0].text();
});

function browser(status = 401) {
  const assigned: string[] = [];
  const storage = new Map<string, string>();
  const article = { scrollTop: 640, scrollLeft: 12 };
  const window = {
    location: { pathname: '/portal', search: '?source=team-example&path=docs%2Fnote.md', hash: '#section', assign: (href: string) => assigned.push(href) },
    document: { querySelector: () => article },
    sessionStorage: { setItem: (key: string, value: string) => storage.set(key, value), getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) },
  };
  const module = { exports: {} as any };
  runInNewContext(apiCode, { module, exports: module.exports, window, URLSearchParams, URL, Date, fetch: async () => new Response(status === 200 ? '{"pending":3}' : '{}', { status }) });
  const navigation = { exports: {} as any };
  runInNewContext(navigationCode, { module: navigation, exports: navigation.exports, window, URLSearchParams, URL, Date });
  return { api: module.exports.portalApi, navigation: navigation.exports, assigned, window, storage, article };
}

test('concurrent foreground 401s redirect once to the full current reader URL', async () => {
  const b = browser();
  await Promise.allSettled([b.api.file('team-example', 'docs/note.md'), b.api.context('team-example', 'docs/note.md'), b.api.tree('team-example', 'docs')]);
  expect(b.assigned).toEqual(['/login?return_to=' + encodeURIComponent('/portal?source=team-example&path=docs%2Fnote.md#section')]);
});

test('background summary 401 never navigates and remains an explicit auth error', async () => {
  const b = browser();
  const error = await b.api.reviewSummary().catch((error: unknown) => error);
  expect(b.assigned).toEqual([]);
  expect(error.status).toBe(401);
});

test('deliberate auth stores reader position and restores it once at the exact URL', () => {
  const b = browser();
  b.navigation.savePortalReadingPosition();
  b.article.scrollTop = 0;
  b.article.scrollLeft = 0;
  expect(b.navigation.restorePortalReadingPosition(b.article)).toBe(true);
  expect(b.article.scrollTop).toBe(640);
  expect(b.article.scrollLeft).toBe(12);
  expect(b.navigation.restorePortalReadingPosition(b.article)).toBe(false);
});

test('reader position never restores onto another URL', () => {
  const b = browser();
  b.navigation.savePortalReadingPosition();
  b.window.location.hash = '#other';
  b.article.scrollTop = 0;
  expect(b.navigation.restorePortalReadingPosition(b.article)).toBe(false);
  expect(b.article.scrollTop).toBe(0);
});

test('blocked session storage cannot prevent authentication', async () => {
  const b = browser();
  b.window.sessionStorage.setItem = () => { throw new Error('blocked'); };
  await b.api.file('team-example', 'docs/note.md').catch(() => {});
  expect(b.assigned.length).toBe(1);
});

test('non-auth failure never navigates', async () => {
  const b = browser(403);
  await b.api.file('team-example', 'docs/note.md').catch(() => {});
  expect(b.assigned).toEqual([]);
});

test('vote 401 keeps the immutable pending attempt in the tab', async () => {
  const b = browser();
  const error = await b.api.reviewVote(1, { decision: 'approve', proposal_snapshot_hash: 'fixture' }, 'attempt-fixture').catch((error: unknown) => error);
  expect(b.assigned).toEqual([]);
  expect(error.code).toBe('unauthenticated');
});
