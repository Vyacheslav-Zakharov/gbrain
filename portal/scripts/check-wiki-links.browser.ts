// Synthetic loopback server + exact dist browser regression; no live APIs/DB/credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let server: ReturnType<typeof Bun.serve> | undefined;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true, args: ['--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  const errors: string[] = [];
  context.on('page', (page: any) => page.on('pageerror', (e: Error) => errors.push(e.message)));
  const target = 'second:Псевдоним & + % ? "пример"';
  const fixture = `[[${target}|Cross source]] [[local alias|Local]] [[missing|Missing]] [[denied|Denied]] [[slow|Slow]]\n\n[Heading](#section)\n\n${'Paragraph.\n\n'.repeat(60)}## Section\n\nEnd`;
  const resolves: { link: string; currentSource: string }[] = [];
  let files = 0;
  let release: (() => void) | undefined;
  let slowStatus = 200;
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const route = { fulfill: ({ json, body, status = 200, contentType }: any) => json !== undefined
      ? Response.json(json, { status }) : new Response(body, { status, headers: { 'Content-Type': contentType } }) };
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    const source = url.searchParams.get('source') || '';
    const path = url.searchParams.get('path') || '';
    const summary = { sections: 0, documents: 1, complete: true };
    if (url.pathname === '/portal/api/resolve-link') {
      const link = url.searchParams.get('link') || '';
      resolves.push({ link, currentSource: url.searchParams.get('currentSource') || '' });
      if (link === 'slow') {
        await new Promise<void>(resolve => { release = resolve; });
        if (slowStatus !== 200) return route.fulfill({ status: slowStatus, json: { error: 'Obsolete resolver failure' } });
      }
      if (link === 'denied') return route.fulfill({ status: 403, json: { error: 'Access denied' } });
      return route.fulfill({ json: link === 'missing' ? { found: false } : { found: true, source: link === target ? 'second' : 'example', path: 'canonical.md' } });
    }
    const responses: Record<string, unknown> = {
      '/portal/api/session': { email: 'reader@example.test', canReview: false },
      '/portal/api/sources': { sources: [{ id: 'example', name: 'Example' }, { id: 'second', name: 'Second' }] },
      '/portal/api/tree': { entries: [], summary, sourceSummary: summary },
      '/portal/api/context': { backlinks: [], meetings: [] },
      '/portal/api/file': { source, sourceName: source, path, title: path, content: path === 'guide.md' ? fixture : `Resolved ${source}/${path}\n\n[[local alias|Local]]`, tags: [], size: 1 },
    };
    if (url.pathname === '/portal/api/file') files++;
    if (url.pathname in responses) return route.fulfill({ json: responses[url.pathname] });
    if (url.pathname.startsWith('/portal/assets/')) return route.fulfill({ body: await readFile(`dist/assets/${url.pathname.split('/').pop()}`), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
    assert.equal(url.pathname, '/portal');
    return route.fulfill({ body: await readFile('dist/index.html'), contentType: 'text/html' });
  } });
  const origin = server.url.origin;
  const page = await context.newPage();
  const home = `${origin}/portal?source=example&path=guide.md`;
  const mount = async () => { await page.goto(home); await page.waitForSelector('.wiki-link'); };
  const resolved = async (p: any, source = 'second') => {
    await p.waitForFunction((s: string) => document.querySelector('.markdown-body')?.textContent?.includes(`Resolved ${s}/canonical.md`), source);
    const url = new URL(p.url());
    assert.equal(url.searchParams.get('source'), source);
    assert.equal(url.searchParams.get('path'), 'canonical.md');
    assert.equal(url.searchParams.has('wiki'), false);
  };
  await mount();
  const link = page.getByRole('link', { name: 'Cross source', exact: true });
  const href = await link.getAttribute('href');
  const url = new URL(href, home);
  assert.equal(url.pathname, '/portal');
  assert.equal(url.searchParams.get('wiki'), target, 'copy/new-tab href must carry the exact wiki target');
  assert.equal(url.searchParams.get('source'), 'example');
  assert.equal(resolves.length, 0, 'rendering must not prefetch every link');
  const tab = await context.newPage();
  await tab.goto(url.href);
  await resolved(tab);
  assert.deepEqual(resolves.at(-1), { link: target, currentSource: 'example' });
  await tab.reload(); await resolved(tab);
  await tab.close();
  await link.click(); await resolved(page);
  await page.goBack(); await page.waitForSelector('.wiki-link');
  await page.goForward(); await resolved(page);
  assert.equal(new URL(await page.getByRole('link', { name: 'Local', exact: true }).getAttribute('href'), home).searchParams.get('source'), 'second');
  console.log('PASS exact encoded href, direct new page, reload, plain click, cross-source alias and Back/Forward');
  for (const gesture of ['Control', 'Shift', 'middle']) {
    await mount();
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Cross source', exact: true }).click(gesture === 'middle' ? { button: 'middle' } : { modifiers: [gesture] });
    const popup = await popupPromise;
    await popup.waitForLoadState();
    console.log(`Native gesture: ${gesture}`);
    await resolved(popup); assert.equal(page.url(), home); await popup.close();
  }
  // Meta has no native new-tab meaning on Linux, but must not be intercepted.
  await mount();
  const meta = await page.getByRole('link', { name: 'Cross source', exact: true }).evaluate((a: HTMLAnchorElement) => {
    let prevented = true;
    const observe = (event: Event) => { prevented = event.defaultPrevented; event.preventDefault(); };
    window.addEventListener('click', observe, { once: true });
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    return prevented;
  });
  assert.equal(meta, false);
  console.log('PASS Ctrl/Shift/middle native tabs/windows and Cmd event preservation');
  for (const targetName of ['missing', 'denied']) {
    await page.goto(`${origin}/portal?source=example&wiki=${targetName}`);
    await page.waitForSelector('.error-banner');
    assert.equal(await page.locator('.markdown-body').count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('wiki'), targetName);
  }
  await mount();
  await page.getByRole('link', { name: 'Missing', exact: true }).click();
  await page.waitForSelector('.error-banner');
  assert.equal(page.url(), home);
  assert.equal(await page.locator('.markdown-body').count(), 1);
  console.log('PASS missing/denied direct URLs and failed click retain safe state');
  for (const status of [200, 500]) {
    await mount(); release = undefined; slowStatus = status;
    await page.evaluate(() => { history.pushState({}, '', '/portal?source=example&wiki=slow'); dispatchEvent(new PopStateEvent('popstate')); });
    for (let i = 0; i < 100 && !release; i++) await page.waitForTimeout(20);
    assert.ok(release);
    await page.goBack(); await page.waitForSelector('.markdown-body');
    const before = files;
    release!(); await page.waitForTimeout(150);
    assert.equal(page.url(), home); assert.equal(files, before);
    assert.equal(await page.locator('.error-banner').count(), 0);
  }
  await mount(); release = undefined; slowStatus = 200;
  await page.getByRole('link', { name: 'Slow', exact: true }).click();
  for (let i = 0; i < 100 && !release; i++) await page.waitForTimeout(20);
  assert.ok(release);
  await page.getByRole('link', { name: 'Heading', exact: true }).click();
  const anchored = page.url(); const before = files;
  release!(); await page.waitForTimeout(150);
  assert.equal(page.url(), anchored); assert.equal(files, before);
  assert.ok(await page.locator('.document-scroll').evaluate((el: HTMLElement) => el.scrollTop > 100));
  await mount(); release = undefined;
  await page.getByRole('link', { name: 'Slow', exact: true }).click();
  for (let i = 0; i < 100 && !release; i++) await page.waitForTimeout(20);
  assert.ok(release);
  await page.getByRole('link', { name: 'Cross source', exact: true }).click();
  await resolved(page);
  const currentUrl = page.url(); const currentFiles = files;
  release!(); await page.waitForTimeout(150);
  assert.equal(page.url(), currentUrl); assert.equal(files, currentFiles);
  await mount();
  await page.getByRole('link', { name: 'Local', exact: true }).click();
  await resolved(page, 'example');
  assert.deepEqual(resolves.at(-1), { link: 'local alias', currentSource: 'example' });
  console.log('PASS stale resolver success/error fenced after Back, heading selection and a newer wiki click; local aliases resolve via API');
  assert.deepEqual(errors, []);
} finally { await browser.close(); server?.stop(true); }
