// Bounded real-DOM regression. No server, credentials, DB, or external requests.
// PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_EXECUTABLE=/path/to/chrome bun run scripts/check-anchors.browser.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temp = await mkdtemp(join(tmpdir(), 'portal-anchors-'));
let browser: any;
try {
  const build = await Bun.build({ entrypoints: ['src/markdown.ts'], outdir: temp, target: 'browser', format: 'esm' });
  assert.equal(build.success, true);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const browserErrors: string[] = [];
  page.on('pageerror', (error: Error) => browserErrors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.route('**/*', (route: any) => route.fulfill({ contentType: 'text/html', body: '<main id="article"></main>' }));
  await page.goto('http://portal.test/portal?source=example&path=guide.md');
  await page.addScriptTag({ type: 'module', content: `${await build.outputs[0].text()}\nwindow.markdown = { renderMarkdown };` });
  await page.waitForFunction(() => (window as any).markdown);
  const result = await page.evaluate(() => {
    const rendered = (window as any).markdown.renderMarkdown('## 2. Пример / раздел\n\n[go](#2-пример--раздел)');
    document.getElementById('article')!.innerHTML = rendered.html;
    const heading = document.querySelector('h2')!;
    return { id: heading.id, aliases: JSON.parse(heading.getAttribute('data-heading-aliases') || '[]') };
  });
  assert.equal(result.id, '2-пример-раздел');
  assert.ok(result.aliases.includes('2-пример--раздел'), 'GitHub-style punctuation alias must reach the existing heading');
  console.log('PASS GitHub-style punctuation alias, legacy canonical ID preserved');
  const levels = await page.evaluate(() => {
    document.getElementById('article')!.innerHTML = (window as any).markdown.renderMarkdown('# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six').html;
    return [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => h.id);
  });
  assert.deepEqual(levels, ['one', 'two', 'three', 'four', 'five', 'six']);
  console.log('PASS all H1–H6 receive canonical IDs');
  const appBuild = await Bun.build({ entrypoints: ['scripts/anchors-fixture.tsx'], outdir: temp, target: 'browser', format: 'esm' });
  assert.equal(appBuild.success, true);
  let fixture = '[first](#2-пример--раздел) [second](#81-глубокий-раздел) [missing](#no-such-heading)\n\n' + 'Paragraph.\n\n'.repeat(60) + '## 2. Пример / раздел\n\n' + 'Paragraph.\n\n'.repeat(60) + '### 8.1 Глубокий раздел\n\n' + 'Paragraph.\n\n'.repeat(60);
  let fileRequests = 0;
  let navigationRequests = 0;
  await page.unroute('**/*');
  let held: { endpoint: string; source: string; path: string; release?: () => void; status?: number } | null = null;
  await page.route('**/*', async (route: any) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get('source') || 'example';
    const path = url.searchParams.get('path') || '';
    const content = source === 'example' && path === 'guide.md' ? fixture : `# Other article\n\n${source}/${path}`;
    const delay = held;
    if (delay && url.pathname === delay.endpoint && source === delay.source && path === delay.path) {
      await new Promise<void>(resolve => { delay.release = resolve; });
      if (delay.status) return route.fulfill({ status: delay.status, json: { error: 'Obsolete failure' } });
    }
    assert.equal(url.origin, 'http://portal.test');
    assert.equal(route.request().method(), 'GET');
    const summary = { sections: 0, documents: 1, complete: true };
    const responses: Record<string, unknown> = {
      '/portal/api/session': { email: 'reader@example.test', canReview: false },
      '/portal/api/sources': { sources: [{ id: 'example', name: 'Example' }, { id: 'second', name: 'Second' }] },
      '/portal/api/tree': { entries: [{ name: `${source}-${path || 'root'}-entry.md`, path: 'entry.md', type: 'file', markdown: true, size: 1 }], summary, sourceSummary: summary },
      '/portal/api/context': { backlinks: [], meetings: [] },
      '/portal/api/file': { source, sourceName: source, path, title: path === 'guide.md' ? 'Guide' : 'Other article', content, size: content.length, tags: [], updatedAt: '2026-01-01T00:00:00Z' },
    };
    if (url.pathname === '/portal/api/file') fileRequests++;
    if (route.request().isNavigationRequest()) navigationRequests++;
    if (url.pathname in responses) return route.fulfill({ json: responses[url.pathname] });
    return route.fulfill({ contentType: 'text/html', body: '<main id="article"></main>' });
  });
  await page.goto('http://portal.test/portal?source=example&path=guide.md');
  for (const output of appBuild.outputs) {
    if (output.path.endsWith('.js')) await page.addScriptTag({ type: 'module', content: await output.text() });
    if (output.path.endsWith('.css')) await page.addStyleTag({ content: await output.text() });
  }
  await page.waitForFunction(() => (window as any).mountPortal);
  await page.evaluate(() => (window as any).mountPortal());
  await page.waitForSelector('.markdown-body h2');
  // Let initial mounting and native history events finish before taking counts.
  const settle = () => page.waitForTimeout(180);
  await settle();
  const before = fileRequests;
  await page.evaluate(() => { window.location.hash = '#2-пример-раздел'; });
  await settle();
  assert.equal(fileRequests, before, 'native hash popstate must not refetch the same document');
  assert.ok(await page.locator('.document-scroll').evaluate((node: HTMLElement) => node.scrollTop > 100));
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = window.location.hash;
    document.body.append(link);
    link.click();
    link.remove();
  });
  await settle();
  assert.equal(fileRequests, before, 'repeated native hash popstate must not refetch');
  console.log('PASS native and repeated hash popstate do not refetch');
  await page.evaluate(() => { history.replaceState({}, '', location.pathname + location.search); });
  const prevented = await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('.markdown-body a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, true, 'fragment click must suppress the default browser jump');
  await page.waitForFunction(() => document.querySelector('.document-scroll')!.scrollTop > 100);
  assert.equal(fileRequests, before, 'fragment click must not reload the article');
  assert.equal(navigationRequests, 1, 'fragment click must not navigate/reload the page');
  console.log('PASS real PortalApp click prevented, scrolled, no file/page reload');
  const click = async (text: string) => {
    await page.locator('.markdown-body a').filter({ hasText: text }).evaluate((link: HTMLAnchorElement) => link.click());
    await settle();
  };
  const position = () => page.locator('.document-scroll').evaluate((node: HTMLElement) => node.scrollTop);
  const atHeading = async (tag: string) => {
    const top = await page.locator(`.markdown-body ${tag}`).evaluate((node: HTMLElement) => node.getBoundingClientRect().top - document.querySelector('.document-scroll')!.getBoundingClientRect().top);
    assert.ok(Math.abs(top - 16) < 2, `heading is aligned inside article: ${top}`);
  };
  await atHeading('h2');
  await click('second');
  await atHeading('h3');
  const second = await position();
  await click('missing');
  assert.equal(await position(), second, 'unknown anchor must not reset top');
  await page.evaluate(() => history.back());
  await settle();
  await atHeading('h2');
  await page.evaluate(() => history.forward());
  await settle();
  await atHeading('h3');
  await page.locator('.document-scroll').evaluate((node: HTMLElement) => { node.scrollTop = 0; });
  const historyLength = await page.evaluate(() => history.length);
  await click('second');
  await atHeading('h3');
  assert.equal(await page.evaluate(() => history.length), historyLength, 'repeat click must not add history');
  assert.equal(fileRequests, before);
  console.log('PASS unknown fragment, repeat click, Back/Forward preserve article and target');

  const remount = async (hash: string) => {
    await page.goto(`http://portal.test/portal?source=example&path=guide.md${hash}`);
    for (const output of appBuild.outputs) {
      if (output.path.endsWith('.js')) await page.addScriptTag({ type: 'module', content: await output.text() });
      if (output.path.endsWith('.css')) await page.addStyleTag({ content: await output.text() });
    }
    await page.waitForFunction(() => (window as any).mountPortal);
    await page.evaluate(() => (window as any).mountPortal());
    await page.waitForSelector('.markdown-body');
    await settle();
  };
  // Successful local selections supersede a pending folder without refetching.
  const localSelectionFailures: string[] = [];
  for (const selection of ['Markdown anchor', 'outline']) {
    await remount('');
    held = { endpoint: '/portal/api/tree', source: 'example', path: '' };
    await page.getByRole('button', { name: 'Корень', exact: true }).click();
    for (let i = 0; i < 100 && !held.release; i++) await page.waitForTimeout(20);
    assert.ok(held.release, 'folder response barrier must be reached');
    const requestsBefore = fileRequests;
    const historyBefore = await page.evaluate(() => history.length);
    if (selection === 'Markdown anchor') await click('first');
    else await page.locator('.outline button').first().click();
    await settle();
    await atHeading('h2');
    const selectedUrl = page.url();
    assert.equal(await page.evaluate(() => history.length), historyBefore + (selection === 'Markdown anchor' ? 1 : 0));
    held.release!();
    held = null;
    await settle();
    try {
      assert.equal(await page.locator('.markdown-body h2').count(), 1, `${selection}: late folder cannot remove article`);
      assert.equal(page.url(), selectedUrl, `${selection}: late folder cannot change URL`);
      assert.ok((await page.locator('.document-toolbar').innerText()).includes('guide.md'));
      assert.equal(await page.locator('.error-banner, .document-skeleton, .skeleton-list').count(), 0);
      assert.equal(fileRequests, requestsBefore, `${selection}: no article refetch`);
      await atHeading('h2');
      console.log(`PASS ${selection} supersedes pending folder, preserving URL/history and article`);
    } catch (error) {
      localSelectionFailures.push(String(error));
      console.error(`FAIL ${selection}: ${error}`);
    }
  }
  assert.deepEqual(localSelectionFailures, []);

  // Destination-aware delayed responses reproduce a pending history transition
  // returning to the still-committed article, then completing out of order.
  const transition = (href: string) => page.evaluate((href: string) => {
    history.pushState({}, '', href);
    dispatchEvent(new PopStateEvent('popstate'));
  }, href);
  const waitHeld = async () => {
    for (let i = 0; i < 100 && !held?.release; i++) await page.waitForTimeout(20);
    assert.ok(held?.release, 'destination request must actually be pending');
  };
  await remount('');
  held = { endpoint: '/portal/api/file', source: 'example', path: 'other.md' };
  await transition('/portal?source=example&path=other.md');
  await waitHeld();
  await page.evaluate(() => history.back());
  await page.waitForURL('**/portal?source=example&path=guide.md');
  await settle();
  held.release!();
  held = null;
  await settle();
  assert.equal(await page.locator('.markdown-body h2').count(), 1, 'Back must invalidate the pending other article');
  assert.ok((await page.locator('.document-toolbar').innerText()).includes('guide.md'));
  await page.evaluate(() => history.forward());
  await page.waitForFunction(() => document.querySelector('.markdown-body')?.textContent?.includes('example/other.md'));
  assert.ok((await page.locator('.markdown-body').innerText()).includes('example/other.md'), 'Forward must load its actual destination');
  assert.ok((await page.locator('.document-toolbar').innerText()).includes('other.md'));
  console.log('PASS delayed cross-document Back invalidates stale response; Forward loads destination');

  for (const scenario of [
    { name: 'source document', endpoint: '/portal/api/file', source: 'second', path: 'guide.md', href: '/portal?source=second&path=guide.md' },
    { name: 'folder', endpoint: '/portal/api/tree', source: 'second', path: 'archive', href: '/portal?source=second&folder=archive' },
    { name: 'document error', endpoint: '/portal/api/file', source: 'second', path: 'guide.md', href: '/portal?source=second&path=guide.md', status: 500 },
    { name: 'folder error', endpoint: '/portal/api/tree', source: 'second', path: 'archive', href: '/portal?source=second&folder=archive', status: 500 },
    { name: 'binary tree', endpoint: '/portal/api/tree', source: 'second', path: 'archive', href: '/portal?source=second&path=archive%2Fimage.png' },
    { name: 'binary tree error', endpoint: '/portal/api/tree', source: 'second', path: 'archive', href: '/portal?source=second&path=archive%2Fimage.png', status: 500 },
  ]) {
    await remount('');
    held = { ...scenario };
    await transition(scenario.href);
    await waitHeld();
    await page.evaluate(() => history.back());
    await page.waitForURL('**/portal?source=example&path=guide.md');
    await settle();
    held.release!();
    held = null;
    await settle();
    assert.equal(await page.locator('.markdown-body h2').count(), 1, `${scenario.name}: stale result cannot replace article`);
    assert.ok((await page.locator('.document-toolbar').innerText()).includes('guide.md'), scenario.name);
    assert.ok((await page.locator('.tree-list').textContent()).includes('example-root-entry.md'), `${scenario.name}: current tree preserved`);
    assert.equal(await page.locator('.error-banner').count(), 0, `${scenario.name}: stale error ignored`);
    assert.equal(await page.locator('.document-skeleton, .skeleton-list').count(), 0, `${scenario.name}: loading cleared on accepted history`);
    console.log(`PASS delayed ${scenario.name} after Back cannot change article/tree/error/loading`);
  }

  await remount('');
  await page.evaluate(() => {
    history.pushState({}, '', '/portal?source=example&path=other.md');
    history.pushState({}, '', '/portal?source=example&path=guide.md');
  });
  held = { endpoint: '/portal/api/file', source: 'example', path: 'other.md' };
  await page.evaluate(() => history.back());
  await waitHeld();
  await page.evaluate(() => history.forward());
  await page.waitForURL('**/portal?source=example&path=guide.md');
  await settle();
  held.release!();
  held = null;
  await settle();
  assert.equal(await page.locator('.markdown-body h2').count(), 1, 'Forward to committed article invalidates pending Back response');
  assert.ok((await page.locator('.document-toolbar').innerText()).includes('guide.md'));
  console.log('PASS delayed Back response cannot overwrite accepted Forward destination');

  // A stale finally must not clear the loading indicator of a newer request.
  await remount('');
  held = { endpoint: '/portal/api/file', source: 'example', path: 'other.md', status: 500 };
  await transition('/portal?source=example&path=other.md');
  await waitHeld();
  const obsolete = held;
  held = { endpoint: '/portal/api/file', source: 'second', path: 'next.md' };
  await transition('/portal?source=second&path=next.md');
  await waitHeld();
  obsolete.release!();
  await settle();
  assert.equal(await page.locator('.document-skeleton').count(), 1, 'stale finally cannot finish the newer load');
  assert.equal(await page.locator('.error-banner').count(), 0, 'stale rejection cannot set current error');
  held.release!();
  held = null;
  await page.waitForFunction(() => document.querySelector('.markdown-body')?.textContent?.includes('second/next.md'));
  console.log('PASS stale error/finally cannot affect a newer pending navigation');

  await remount('#81-глубокий-раздел');
  await atHeading('h3');
  console.log('PASS initial deep URL scrolls after mounted content');
  await page.evaluate(() => {
    const decoy = document.createElement('h2');
    decoy.id = document.querySelector('.markdown-body h2')!.id;
    decoy.textContent = 'Outside article';
    document.body.prepend(decoy);
    document.querySelector<HTMLElement>('.document-scroll')!.scrollTop = 0;
  });
  await page.locator('.outline button').first().click();
  await settle();
  await atHeading('h2');
  console.log('PASS sidebar outline is scoped to the article despite outside ID collision');

  const contracts = await page.evaluate(() => {
    const root = document.createElement('div');
    const render = (text: string) => { root.innerHTML = (window as any).markdown.renderMarkdown(text).html; };
    const resolve = (hash: string) => (window as any).resolveArticleAnchor(root, hash)?.textContent || null;
    render('#### Same\n## Same\n## Same\n## Café\n## Й ё\n## A / B\n## A  B\n## A--B\n## Under_score');
    const ids = [...root.querySelectorAll('[id]')].map(h => h.id);
    const values = ['#same', '#same-2', '#same-3', '#caf%C3%A9', '#%D0%B9-%D1%91', '#a--b', '#under_score', '#Café', '#caf%25C3%25A9', '#%ZZ', '#missing'].map(resolve);
    root.innerHTML = '<h2 id="one" data-heading-aliases=\'["alias"]\'>One</h2><h2 id="two" data-heading-aliases=\'["alias"]\'>Two</h2>';
    const ambiguous = resolve('#alias');
    root.innerHTML += '<h3 id="alias">Exact</h3>';
    const precedence = resolve('#alias');
    root.innerHTML += '<h3 id="alias">Duplicate</h3>';
    const duplicate = resolve('#alias');
    render('<h2 id="injected" data-heading-aliases=\'["spoof"]\' onclick="alert(1)">Safe</h2>');
    return { ids, values, ambiguous, precedence, duplicate, spoof: resolve('#spoof'), unsafe: root.querySelector('[onclick]') !== null };
  });
  assert.deepEqual(contracts.ids, ['same-3', 'same', 'same-2', 'cafe', 'и-е', 'a-b', 'a-b-2', 'a-b-3', 'under-score']);
  assert.deepEqual(contracts.values, ['Same', 'Same', 'Same', 'Café', 'Й ё', 'A / B', 'Under_score', null, null, null, null]);
  assert.equal(contracts.ambiguous, null);
  assert.equal(contracts.precedence, 'Exact');
  assert.equal(contracts.duplicate, null);
  assert.equal(contracts.spoof, null);
  assert.equal(contracts.unsafe, false);
  console.log('PASS collisions, ambiguity, exact precedence, encoding, Unicode, sanitizer');
  if (process.env.ANCHOR_REPORT_DIR) {
    await mkdir(process.env.ANCHOR_REPORT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.ANCHOR_REPORT_DIR, 'generic-deep-link.png') });
  }
  if (process.env.ANCHOR_ARTICLE_FILE) {
    const bytes = await readFile(process.env.ANCHOR_ARTICLE_FILE);
    fixture = bytes.toString('utf8');
    await remount('');
    const links: string[] = await page.locator('.markdown-body a[href^="#"]').evaluateAll((nodes: HTMLAnchorElement[]) => [...new Set(nodes.filter(n => !n.dataset.wikiTarget).map(n => n.getAttribute('href')!))]);
    if (process.env.ANCHOR_EXPECT_LINKS) assert.equal(links.length, Number(process.env.ANCHOR_EXPECT_LINKS));
    const articleBefore = fileRequests;
    const results = [];
    for (const hash of links) {
      const result = await page.evaluate((hash: string) => {
        const root = document.querySelector<HTMLElement>('.markdown-body')!;
        const target = (window as any).resolveArticleAnchor(root, hash);
        if (!target) return { hash, found: false };
        const link = [...root.querySelectorAll<HTMLAnchorElement>('a')].find(n => n.getAttribute('href') === hash)!;
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(event);
        const container = document.querySelector<HTMLElement>('.document-scroll')!;
        const relativeTop = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
        return { hash, found: true, id: target.id, prevented: event.defaultPrevented, visible: relativeTop >= 0 && relativeTop < container.clientHeight, scrollTop: container.scrollTop };
      }, hash);
      assert.equal(result.found, true);
      assert.equal(result.prevented, true);
      assert.equal(result.visible, true);
      results.push(result);
    }
    await settle();
    assert.equal(fileRequests, articleBefore);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(createHash('sha256').update(await readFile(process.env.ANCHOR_ARTICLE_FILE)).digest('hex'), sha256);
    if (process.env.ANCHOR_REPORT_DIR) {
      await writeFile(join(process.env.ANCHOR_REPORT_DIR, 'private-article.json'), JSON.stringify({ sha256, uniqueLinks: links.length, results, fileRefetches: fileRequests - articleBefore, scope: 'local mounted PortalApp, mocked read-only API; not authenticated live proof' }, null, 2));
      await page.screenshot({ path: join(process.env.ANCHOR_REPORT_DIR, 'private-article.png') });
    }
    console.log(`PASS private article: ${links.length} unique links, zero refetches, unchanged SHA256 ${sha256}`);
  }
  assert.deepEqual(browserErrors, [], 'no browser runtime errors');
} finally {
  await browser?.close();
  await rm(temp, { recursive: true, force: true });
}
