import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../portal/src/PortalApp.tsx', import.meta.url), 'utf8');
// Exercise both layout and passive document effects: testing just the layout
// callback misses an anchor effect that immediately overwrites auth restoration.
const effects = [...source.matchAll(/use(?:Layout)?Effect\(\(\) => \{([\s\S]*?)\n  }, \[document, loadingDocument\]\);/g)]
  .map(match => match[0].slice(match[0].lastIndexOf('useLayoutEffect(') >= 0 ? match[0].lastIndexOf('useLayoutEffect(') : match[0].lastIndexOf('useEffect(')));
function run({ saved = false, same = false, loading = false, hash = '#section' } = {}) {
  const article = { scrollTop: 640, scrollTo({ top }: { top: number }) { this.scrollTop = top; } };
  const document = { path: 'guide.md' };
  let restores = 0;
  let anchors = 0;
  const context = {
    useLayoutEffect: (fn: () => void) => fn(), useEffect: (fn: () => void) => fn(),
    articleRef: { current: article }, document, loadingDocument: loading,
    lastRenderedDocument: { current: same ? document : null },
    pendingHistoryScroll: { current: false },
    readingBeforeLoad: { current: null },
    window: { location: { hash } },
    restorePortalReadingPosition: () => { restores++; if (saved) article.scrollTop = 777; return saved; },
    rememberPortalReadingPosition: () => {},
    scrollArticleAnchor: () => { anchors++; article.scrollTop = 1200; return true; },
  };
  for (const effect of effects) runInNewContext(effect, context);
  return { top: article.scrollTop, restores, anchors };
}

test('auth return position wins over a matching hash after delayed document commit', () => {
  expect(run({ saved: true })).toEqual({ top: 777, restores: 1, anchors: 0 });
});
test('failed fetch or cancelled navigation cannot reset the same committed document', () => {
  expect(run({ same: true, hash: '' })).toEqual({ top: 640, restores: 0, anchors: 0 });
  expect(run({ same: true })).toEqual({ top: 640, restores: 0, anchors: 0 });
});
test('fresh deep link without an auth position uses its anchor', () => {
  expect(run()).toEqual({ top: 1200, restores: 1, anchors: 1 });
});
test('loading skeleton must neither consume saved auth position nor scroll to a hash', () => {
  expect(run({ loading: true, saved: true })).toEqual({ top: 640, restores: 0, anchors: 0 });
});
