import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../portal/src/PortalApp.tsx', import.meta.url), 'utf8');
const callback = source.match(/const refreshReviewPending = useCallback\([\s\S]*?\n  }, \[\]\);/)![0];
const js = new Bun.Transpiler({ loader: 'tsx' }).transformSync(callback) + '\nrefreshReviewPending;';

test('background auth expiry becomes a recoverable notice without clearing the document', async () => {
  let authRequired = false;
  let pending: number | null = 9;
  let status = 401;
  class ReviewApiError extends Error { constructor(public status: number) { super('auth'); } }
  const refresh = runInNewContext(js, {
    useCallback: (fn: unknown) => fn,
    reviewPendingInFlight: { current: false },
    ReviewApiError,
    portalApi: { reviewSummary: async () => { if (status) throw new ReviewApiError(status); return { pending: 4 }; } },
    setReviewPending: (value: number | null) => { pending = value; },
    setAuthRequired: (value: boolean) => { authRequired = value; },
  });
  await refresh();
  expect(authRequired).toBe(true);
  expect(pending).toBeNull();
  status = 0;
  await refresh();
  expect(authRequired).toBe(false);
  expect(pending).toBe(4);
  status = 503;
  await refresh();
  expect(authRequired).toBe(false);
});

test('a failed document fetch does not reset the already rendered document', () => {
  const effect = source.match(/useLayoutEffect\(\(\) => \{([\s\S]*?)\n  }, \[document, loadingDocument\]\);/)![1];
  const article = { scrollTop: 640 };
  const document = { path: 'docs/note.md' };
  const callback = runInNewContext('(function () {' + effect + '\n})', {
    articleRef: { current: article }, loadingDocument: false, document,
    lastRenderedDocument: { current: document },
    pendingHistoryScroll: { current: false },
    readingBeforeLoad: { current: null },
    restorePortalReadingPosition: () => false, rememberPortalReadingPosition: () => {},
  });
  callback();
  expect(article.scrollTop).toBe(640);
});

test('background polling remains paused while authentication is required', () => {
  const effect = source.match(/useEffect\(\(\) => \{\n    if \(!session\?\.canReview\)[\s\S]*?\n  }, \[[^\]]*\]\);/)![0];
  let requests = 0;
  runInNewContext(new Bun.Transpiler({ loader: 'tsx' }).transformSync(effect), {
    useEffect: (fn: () => void) => fn(), session: { canReview: true }, authRequired: true,
    setReviewPending: () => {}, refreshReviewPending: () => { requests++; },
    window: { setInterval: () => { requests++; }, addEventListener: () => { requests++; } },
  });
  expect(requests).toBe(0);
});

test('reader offers deliberate reauth and restores scroll only after document rendering', () => {
  expect(source).toMatch(/authRequired\s*&&[\s\S]*?role="status"/);
  expect(source).toContain('href={portalLoginHref()}');
  expect(source).toContain('redirectToPortalLogin()');
  expect(source).toMatch(/useLayoutEffect\([\s\S]*?restorePortalReadingPosition/);
});
