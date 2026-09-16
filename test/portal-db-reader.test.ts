import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as security from '../src/core/portal-security';
import * as usability from '../src/portal-usability';
import { serializePageToMarkdown } from '../src/core/markdown';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'portal-db-reader-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function harness(pages: any[], localPath: string | null = root) {
  const routes = new Map<string, Function>();
  const source = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
  const region = source.slice(source.indexOf('  // Canonical article locator'), source.indexOf('app.get("/admin/access-requests"'));
  const engine = {
    listPages: async (o: any) => pages.filter(p => p.source_id === o.sourceId && (o.includeDeleted || !p.deleted_at)).slice(o.offset || 0, (o.offset || 0) + o.limit),
    getPage: async (slug: string, o: any) => {
      const row = pages.find(p => p.slug === slug && p.source_id === o.sourceId && (o.includeDeleted || !p.deleted_at));
      if (!row) return null;
      const { source_path: _storedPath, ...result } = row;
      return result; // Match rowToPage: the storage path is not exposed.
    },
    executeRaw: async (sql: string, params: any[]) => {
      expect(sql).toMatch(/source_id\s*=\s*\$1/);
      expect(sql).toMatch(/source_path\s*=\s*\$2/);
      expect(sql).toMatch(/LIMIT 2/i);
      expect(sql).not.toMatch(/deleted_at\s+IS\s+NULL/i);
      expect(params[0]).toBe('allowed');
      return pages.filter(p => p.source_id === params[0] && p.source_path === params[1]).slice(0, 2).map(p => ({ slug: p.slug }));
    },
    getTags: async () => ['fixture'],
    resolveSlugs: async (q: string) => pages.filter(p => p.slug.toLowerCase().includes(q.toLowerCase())).map(p => p.slug),
    resolveSlugWithAlias: async (s: string) => s,
    resolveAliases: async () => new Map(),
    // Match the query, but deliberately retain deleted/cross-source hits so the
    // actual route still has to enforce its read-side identity and ACL checks.
    searchKeyword: async (q: string) => pages.filter(p => `${p.slug} ${p.title} ${p.compiled_truth}`.toLowerCase().includes(q.toLowerCase())).map(p => ({ ...p, chunk_text: p.compiled_truth, score: 1 })),
    getLinks: async () => [], getBacklinks: async () => [],
  };
  const bindings = { ...security, ...usability, serializePageToMarkdown,
    resolvePortalPath: security.resolvePortalPathSecure, path, require,
    normalizeAlias: (s: string) => s.toLowerCase(), engine,
    requirePortalUser: (req: any, res: any) => req.auth ? 'fixture@example.test' : (res.status(401).json({ error: 'unauthorized' }), null),
    resolvePortalUser: (req: any) => req.auth ? 'fixture@example.test' : null,
    getSourceRowsForUser: async () => [{ id: 'allowed', name: 'Allowed', local_path: localPath }],
    app: { get: (url: string, fn: Function) => routes.set(url, fn) },
  };
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(region);
  new Function(...Object.keys(bindings), js)(...Object.values(bindings));
  return async (url: string, query: any = {}, auth = true) => {
    const res: any = { code: 200, body: undefined, headers: {}, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; }, send(b: any) { this.body = b; return this; }, set(k: string, v: string) { this.headers[k] = v; return this; }, type(v: string) { return this.set('Content-Type', v); }, attachment(v: string) { return this.set('Content-Disposition', v); }, download(p: string) { this.body = readFileSync(p, 'utf8'); } };
    await routes.get(url)!({ query: { source: 'allowed', ...query }, auth }, res);
    return res;
  };
}
test('article preview/download/context use fresh scoped DB markdown, not stale mirrors or extension aliases', async () => {
  writeFileSync(path.join(root, 'article.md'), 'STALE');
  const call = harness([page('article'), page('literal.md', { compiled_truth: '# Literal extension' })]);
  const read = await call('/portal/api/file', { path: 'article.md' });
  expect(read.body.content).toContain('# Fresh DB text');
  expect(read.body).toMatchObject({ kind: 'article', storage: 'database', slug: 'article' });
  expect((await call('/portal/download', { path: 'article.md' })).body).toBe(read.body.content);
  expect((await call('/portal/api/context', { path: 'literal.md.md' })).body.slug).toBe('literal.md');
  expect((await call('/portal/api/file', { path: 'literal.md' })).code).toBe(404);
});

test('search and explicit links open canonical DB identities without source or extension collisions', async () => {
  const call = harness([page('virtual/article'), page('literal.md'), page('virtual/article', { source_id: 'denied' })], null);
  const search = await call('/portal/api/search', { q: 'article' });
  expect(search.body.results.some((r: any) => r.path === 'virtual/article.md' && r.source === 'allowed')).toBe(true);
  expect(search.body.results.every((r: any) => r.source === 'allowed')).toBe(true);
  expect((await call('/portal/api/resolve-link', { link: 'allowed:virtual/article' })).body).toMatchObject({ found: true, path: 'virtual/article.md' });
  expect((await call('/portal/api/resolve-link', { link: 'literal.md' })).body).toMatchObject({ found: true, path: 'literal.md.md' });
  expect((await call('/portal/api/resolve-link', { link: 'denied:virtual/article' })).body.found).toBe(false);
  expect((await call('/portal/api/resolve-link', { link: 'missing.md' })).body.found).toBe(false);
});

test('11 DB articles, 3 mirrors and README remain distinct; tombstones cannot fall back through any route', async () => {
  mkdirSync(path.join(root, 'processes'));
  const pages = Array.from({ length: 11 }, (_, i) => page(`processes/article-${i}`));
  pages.push(page('processes/README', { compiled_truth: '# Fresh DB support' }));
  for (let i = 0; i < 3; i++) writeFileSync(path.join(root, `processes/article-${i}.md`), 'STALE');
  writeFileSync(path.join(root, 'processes/README.md'), '# Support');
  writeFileSync(path.join(root, 'processes/attachment.pdf'), 'PDF');
  writeFileSync(path.join(root, 'processes/deleted.md'), 'DELETED');
  pages.push(page('processes/deleted', { deleted_at: new Date() }));
  const call = harness(pages);
  const tree = (await call('/portal/api/tree', { path: 'processes' })).body;
  expect(tree.summary.documents).toBe(11);
  expect(tree.entries.filter((e: any) => e.kind === 'article')).toHaveLength(11);
  expect(tree.entries.some((e: any) => e.path === 'processes/deleted.md')).toBe(false);
  expect(tree.entries.find((e: any) => e.name === 'README.md')).toMatchObject({ kind: 'support', storage: 'database' });
  expect(tree.entries.find((e: any) => e.name === 'attachment.pdf')).toMatchObject({ kind: 'attachment', storage: 'filesystem' });
  for (const route of ['/portal/api/file', '/portal/download', '/portal/api/context']) expect((await call(route, { path: 'processes/deleted.md' })).code).toBe(404);
  expect((await call('/portal/api/search', { q: 'deleted' })).body.results.some((r: any) => r.path === 'processes/deleted.md')).toBe(false);
  expect((await call('/portal/api/resolve-link', { link: 'processes/deleted' })).body.found).toBe(false);
  expect((await call('/portal/api/file', { path: 'processes/README.md' })).body).toMatchObject({ kind: 'support', storage: 'database' });
  expect((await call('/portal/api/file', { path: 'processes/README.md' })).body.content).toContain('# Fresh DB support');
  expect((await call('/portal/download', { path: 'processes/attachment.pdf' })).body).toBe('PDF');
});

test('all entry points retain ACL, traversal and symlink confinement', async () => {
  writeFileSync(path.join(root, 'README.md'), '# Support');
  symlinkSync(path.join(root, 'README.md'), path.join(root, 'symlink.md'));
  const call = harness([page('article'), page('article', { source_id: 'denied', compiled_truth: 'PRIVATE' })]);
  for (const route of ['/portal/api/tree', '/portal/api/file', '/portal/download', '/portal/api/context']) {
    expect((await call(route, { source: 'denied', path: 'article.md' })).code).toBe(404);
    expect((await call(route, { path: '../README.md' })).code).toBe(404);
    expect((await call(route, { path: 'symlink.md' })).code).toBe(404);
    expect((await call(route, {}, false)).code).toBe(401);
  }
  for (const bad of ['../README', '/README', '%2e%2e/README', 'folder/../../README', 'folder\\\\README']) {
    expect((await call('/portal/api/resolve-link', { link: bad })).body.found).toBe(false);
  }
});

test('pagination is complete past the former cap and directory/file name collisions remain browsable', async () => {
  const call = harness(Array.from({ length: 50_001 }, (_, i) => page(`p${i}`)), null);
  const tree = (await call('/portal/api/tree')).body;
  expect(tree.summary.documents).toBe(50_001);
  expect(tree.summary.complete).toBe(true);
  const collision = harness([page('topic'), page('topic.md'), page('topic.md/child')], null);
  const entries = (await collision('/portal/api/tree')).body.entries;
  expect(entries.filter((e: any) => e.path === 'topic.md')).toHaveLength(2);
  expect((await collision('/portal/api/resolve-link', { link: 'topic.md' })).body.path).toBe('topic.md');
  expect((await collision('/portal/api/tree', { path: 'topic.md' })).body.entries[0].path).toBe('topic.md/child.md');
});

test('reader labels support and attachment rows separately from counted DB articles', () => {
  const ui = readFileSync(new URL('../portal/src/PortalApp.tsx', import.meta.url), 'utf8');
  expect(ui).toContain("entry.kind === 'article'");
  expect(ui).toContain('Служебный документ');
  expect(ui).toContain('Вложение');
  expect(ui).toContain('key={`${entry.type}:${entry.path}`}');
});

test('legacy text mirrors of live/deleted articles cannot masquerade as filesystem support', async () => {
  for (const name of ['gone.markdown', 'gone.txt', 'live.txt']) writeFileSync(path.join(root, name), 'STALE');
  const call = harness([page('gone', { deleted_at: new Date() }), page('live')]);
  for (const name of ['gone.markdown', 'gone.txt', 'live.txt']) {
    for (const route of ['/portal/api/file', '/portal/api/context', '/portal/download']) expect((await call(route, { path: name })).code).toBe(404);
  }
  expect((await call('/portal/api/tree')).body.entries.map((e: any) => e.path)).toEqual(['live.md']);
  expect((await call('/portal/api/search', { q: 'gone' })).body.results).toHaveLength(0);
  expect((await call('/portal/api/resolve-link', { link: 'gone' })).body.found).toBe(false);
});

test('exact stored legacy path opens fresh DB content and resolves the canonical identity', async () => {
  mkdirSync(path.join(root, 'legacy'));
  writeFileSync(path.join(root, 'legacy/Original.markdown'), 'STALE');
  const call = harness([page('canonical', { source_path: 'legacy/Original.markdown' })]);
  const read = await call('/portal/api/file', { path: 'legacy/Original.markdown' });
  expect(read.body.content).toContain('# Fresh DB text');
  expect(read.body.storage).toBe('database');
  expect((await call('/portal/download', { path: 'legacy/Original.markdown' })).body).toBe(read.body.content);
  expect((await call('/portal/api/context', { path: 'legacy/Original.markdown' })).body.slug).toBe('canonical');
  expect((await call('/portal/api/resolve-link', { link: 'allowed:legacy/Original.markdown' })).body).toMatchObject({ found: true, path: 'canonical.md', storage: 'database' });
  expect((await call('/portal/api/tree', { path: 'legacy' })).body.entries).toHaveLength(0);
  expect((await call('/portal/api/resolve-link', { link: 'legacy/original.markdown' })).body.found).toBe(false);
});

test('tombstoned and ambiguous stored paths fail closed across every fallback', async () => {
  mkdirSync(path.join(root, 'legacy'));
  for (const name of ['Original.markdown', 'Collision.markdown']) writeFileSync(path.join(root, 'legacy', name), 'STALE');
  const call = harness([
    page('gone', { source_path: 'legacy/Original.markdown', deleted_at: new Date() }),
    page('first', { source_path: 'legacy/Collision.markdown' }),
    page('second', { source_path: 'legacy/Collision.markdown', deleted_at: new Date() }),
  ]);
  for (const name of ['Original.markdown', 'Collision.markdown']) {
    const requestedPath = `legacy/${name}`;
    for (const route of ['/portal/api/file', '/portal/download', '/portal/api/context'])
      expect((await call(route, { path: requestedPath })).code).toBe(404);
    expect((await call('/portal/api/search', { q: name })).body.results).toHaveLength(0);
    expect((await call('/portal/api/resolve-link', { link: `allowed:${requestedPath}` })).body.found).toBe(false);
  }
  expect((await call('/portal/api/tree', { path: 'legacy' })).body.entries).toHaveLength(0);
});

test('stored paths are source scoped after ACL and canonical slug.md wins collisions', async () => {
  mkdirSync(path.join(root, 'legacy'));
  writeFileSync(path.join(root, 'legacy/Original.markdown'), 'SUPPORT');
  const call = harness([
    page('allowed-page', { source_path: 'legacy/Original.markdown' }),
    page('private', { source_id: 'denied', source_path: 'legacy/Original.markdown', compiled_truth: 'PRIVATE' }),
    page('canonical'),
    page('alias-one', { source_path: 'canonical.md' }),
    page('alias-two', { source_path: 'canonical.md' }),
  ]);
  for (const route of ['/portal/api/file', '/portal/download', '/portal/api/context'])
    expect((await call(route, { source: 'denied', path: 'legacy/Original.markdown' })).code).toBe(404);
  expect((await call('/portal/api/resolve-link', { link: 'denied:legacy/Original.markdown' })).body.found).toBe(false);
  expect((await call('/portal/api/file', { path: 'legacy/Original.markdown' })).body.slug).toBe('allowed-page');
  expect((await call('/portal/api/file', { path: 'canonical.md' })).body.slug).toBe('canonical');
  expect((await call('/portal/api/resolve-link', { link: 'canonical.md' })).body.path).toBe('canonical.md');
  const support = harness([page('private', { source_id: 'denied', source_path: 'legacy/Original.markdown' })]);
  expect((await support('/portal/api/file', { path: 'legacy/Original.markdown' })).body.content).toBe('SUPPORT');
  expect((await support('/portal/api/tree', { path: 'legacy' })).body.entries[0].storage).toBe('filesystem');
});

test('stored PDF source paths retain original attachments beside canonical articles', async () => {
  writeFileSync(path.join(root, 'attachment.pdf'), '%PDF-original');
  const call = harness([page('imported', { source_path: 'attachment.pdf' })]);
  expect((await call('/portal/download', { path: 'attachment.pdf' })).body).toBe('%PDF-original');
  const entries = (await call('/portal/api/tree')).body.entries;
  expect(entries.find((e: any) => e.path === 'attachment.pdf')).toMatchObject({ kind: 'attachment', storage: 'filesystem' });
  expect(entries.find((e: any) => e.path === 'imported.md')).toMatchObject({ kind: 'article', storage: 'database' });
});

test('review: explicit stored path must precede a same-named literal slug', async () => {
  for (const ext of ['md', 'markdown', 'txt']) {
    const locator = `legacy/Original.${ext}`;
    const call = harness([page(locator), page('canonical', { source_path: locator })], null);
    expect((await call('/portal/api/file', { path: locator })).body.slug).toBe('canonical');
    expect((await call('/portal/api/context', { path: locator })).body.slug).toBe('canonical');
    expect((await call('/portal/download', { path: locator })).body).toContain('# Fresh DB text');
    expect((await call('/portal/api/resolve-link', { link: `allowed:${locator}` })).body.path).toBe('canonical.md');
  }
});

test('review: explicit tombstoned stored path cannot resolve to an unrelated literal slug', async () => {
  const call = harness([page('legacy/Original.markdown'), page('gone', { source_path: 'legacy/Original.markdown', deleted_at: new Date() })], null);
  expect((await call('/portal/api/file', { path: 'legacy/Original.markdown' })).code).toBe(404);
  expect((await call('/portal/api/resolve-link', { link: 'allowed:legacy/Original.markdown' })).body.found).toBe(false);
});

test('review: ambiguous explicit paths block literal slugs while unclaimed extension slugs still resolve', async () => {
  for (const ext of ['md', 'markdown', 'txt']) {
    const locator = `legacy/Original.${ext}`;
    const call = harness([page(locator), page('first', { source_path: locator }), page('second', { source_path: locator })], null);
    expect((await call('/portal/api/resolve-link', { link: `allowed:${locator}` })).body.found).toBe(false);
    const literal = harness([page(locator)], null);
    expect((await literal('/portal/api/resolve-link', { link: locator })).body.path).toBe(`${locator}.md`);
    expect((await literal('/portal/api/file', { path: `${locator}.md` })).body.slug).toBe(locator);
  }
});

test('review: attachments in the conventional attachment directory remain resolvable', async () => {
  mkdirSync(path.join(root, '_attachments'));
  writeFileSync(path.join(root, '_attachments/original.pdf'), '%PDF-original');
  const call = harness([]);
  expect((await call('/portal/download', { path: '_attachments/original.pdf' })).body).toBe('%PDF-original');
  expect((await call('/portal/api/resolve-link', { link: '_attachments/original.pdf', currentSource: 'allowed' })).body).toMatchObject({ found: true, path: '_attachments/original.pdf' });
});

test('review: attachment search is independent of tree visibility and remains confined', async () => {
  mkdirSync(path.join(root, '_attachments'));
  writeFileSync(path.join(root, '_attachments/original.pdf'), '%PDF-original');
  writeFileSync(path.join(root, '_attachments/original.exe'), 'BLOCKED');
  symlinkSync(path.join(root, '_attachments/original.pdf'), path.join(root, '_attachments/original-link.pdf'));
  symlinkSync(path.join(root, '_attachments'), path.join(root, 'linked-attachments'));
  const call = harness([]);
  expect((await call('/portal/api/tree')).body.entries).toHaveLength(0);
  expect((await call('/portal/api/search', { q: 'original' })).body.results.map((r: any) => r.path)).toEqual(['_attachments/original.pdf']);
  expect((await call('/portal/api/resolve-link', { link: 'original.pdf' })).body.path).toBe('_attachments/original.pdf');
  for (const link of ['denied:_attachments/original.pdf', '_attachments/../original.pdf', '_attachments/original-link.pdf', '_attachments/original.exe'])
    expect((await call('/portal/api/resolve-link', { link })).body.found).toBe(false);
  expect((await call('/portal/download', { path: 'linked-attachments/original.pdf' })).code).toBe(404);
  expect((await call('/portal/api/search', { q: 'original' }, false)).code).toBe(401);
});

const page = (slug: string, extra = {}) => ({ slug, source_id: 'allowed', title: slug, type: 'note', compiled_truth: '# Fresh DB text', timeline: '', frontmatter: {}, updated_at: new Date('2026-01-01'), ...extra });

test('tree exposes DB-only virtual folders and exact counted article set without local_path', async () => {
  const call = harness([page('virtual/nested/article'), page('other'), page('hidden', { source_id: 'denied' }), page('deleted', { deleted_at: new Date() })], null);
  const tree = await call('/portal/api/tree');
  expect(tree.code).toBe(200);
  expect(tree.body.sourceSummary.documents).toBe(2);
  expect(tree.body.entries.map((e: any) => e.path)).toEqual(['virtual', 'other.md']);
  const folder = await call('/portal/api/tree', { path: 'virtual/nested' });
  expect(folder.body.entries[0]).toMatchObject({ path: 'virtual/nested/article.md', kind: 'article', storage: 'database' });
  expect(folder.body.summary.documents).toBe(1);
});
