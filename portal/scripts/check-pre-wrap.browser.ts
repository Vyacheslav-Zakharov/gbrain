// Real Chromium + production Portal bundle, mocked read-only API; no live DB/auth.
// Run from portal/: PLAYWRIGHT_MODULE=... CHROMIUM_EXECUTABLE=... bun run scripts/check-pre-wrap.browser.ts
// Optional PRIVATE_ARTICLE=/private/article.md is never copied into the repository.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.EVIDENCE_DIR;
const dist = resolve(process.env.PORTAL_DIST || 'dist');
const text = '  Сохрани отступы и переносы. '.repeat(30) + '\n\tindented line\n\n' + 'x'.repeat(500) + '\n';
const fixture = '# Wrapping regression\n\n```text\n' + text + '```\n\n```js\n  const value = "' + 'a'.repeat(300) + '";\n```';
const documents = [{ name: 'synthetic', content: fixture }];
if (process.env.PRIVATE_ARTICLE) documents.push({ name: 'private', content: await readFile(process.env.PRIVATE_ARTICLE, 'utf8') });
if (output) await mkdir(output, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true, args: ['--disable-dev-shm-usage'] });
const results: unknown[] = [];
let failures = 0;
try {
  for (const doc of documents) for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, 'http://portal.test');
      assert.equal(route.request().method(), 'GET');
      const summary = { sections: 0, documents: 1, complete: true };
      const responses: Record<string, unknown> = {
        '/portal/api/session': { email: 'reader@example.test', canReview: false },
        '/portal/api/sources': { sources: [{ id: 'example', name: 'Example' }] },
        '/portal/api/tree': { entries: [], summary, sourceSummary: summary },
        '/portal/api/context': { backlinks: [], meetings: [] },
        '/portal/api/file': { source: 'example', sourceName: 'Example', path: 'guide.md', title: 'Guide', content: doc.content, size: doc.content.length, tags: [] },
      };
      if (url.pathname in responses) return route.fulfill({ json: responses[url.pathname] });
      if (url.pathname.startsWith('/portal/assets/')) {
        const file = join(dist, 'assets', url.pathname.split('/').at(-1)!);
        return route.fulfill({ body: await readFile(file), contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript' });
      }
      return route.fulfill({ contentType: 'text/html', body: await readFile(join(dist, 'index.html')) });
    });
    await page.goto('http://portal.test/portal?source=example&path=guide.md');
    await page.waitForSelector('.markdown-body pre code');
    const result = await page.evaluate(() => {
      const pres = [...document.querySelectorAll<HTMLElement>('.markdown-body pre')];
      const before = pres.map(pre => pre.textContent);
      const metrics = pres.map(pre => {
        const code = pre.querySelector('code')!;
        const range = document.createRange(); range.selectNodeContents(code);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        const selectedBefore = selection.toString();
        const baselineStyle = document.createElement('style');
        baselineStyle.textContent = '.markdown-body pre,.markdown-body pre code{white-space:pre!important;overflow-wrap:normal!important}';
        document.head.append(baselineStyle);
        const selectionUnchanged = selection.toString() === selectedBefore;
        baselineStyle.remove();
        selection.removeAllRanges();
        return { client: pre.clientWidth, scroll: pre.scrollWidth, whiteSpace: getComputedStyle(pre).whiteSpace, overflowWrap: getComputedStyle(pre).overflowWrap, codeWhiteSpace: getComputedStyle(code).whiteSpace, selectionUnchanged };
      });
      // CSS cannot modify the copy source: compare wrapped vs baseline computed layout.
      const style = document.createElement('style'); style.textContent = '.markdown-body pre,.markdown-body pre code{white-space:pre!important;overflow-wrap:normal!important}';
      document.head.append(style);
      const baselineText = pres.map(pre => pre.textContent);
      style.remove();
      const scroller = document.querySelector<HTMLElement>('.document-scroll')!;
      return { metrics, textContentUnchanged: JSON.stringify(before) === JSON.stringify(baselineText), documentWidth: document.documentElement.clientWidth, documentScroll: document.documentElement.scrollWidth, articleWidth: scroller.clientWidth, articleScroll: scroller.scrollWidth };
    });
    const passed = result.metrics.every(m => m.scroll <= m.client + 1 && m.whiteSpace === 'pre-wrap' && m.codeWhiteSpace === 'pre-wrap' && m.overflowWrap === 'anywhere' && m.selectionUnchanged) && result.textContentUnchanged && result.documentScroll <= result.documentWidth + 1 && result.articleScroll <= result.articleWidth + 1 && !errors.length;
    if (doc.name === 'synthetic') assert.equal(await page.locator('.markdown-body pre code').first().textContent(), text);
    if (output) await page.screenshot({ path: join(output, `${doc.name}-${width}.png`) });
    results.push({ name: doc.name, width, passed, ...result, errors });
    if (!passed) failures++;
    await page.close();
  }
} finally { await browser.close(); }
const report = { scope: 'Production bundle in isolated browser with read-only mocked APIs; not authenticated live Portal', results, failures };
if (output) await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.equal(failures, 0, 'preformatted text must wrap without overflow or changing copy text');
