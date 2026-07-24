import { describe, expect, test } from 'bun:test';
import { PORTAL_ASSET_COUNT, PORTAL_ASSETS, PORTAL_INDEX_HTML } from '../src/portal-embedded';

const serveSource = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
const oauthSource = await Bun.file(new URL('../src/core/oauth-provider.ts', import.meta.url)).text();

describe('portal SPA contract', () => {
  test('ships an embedded index, JavaScript, and CSS bundle', () => {
    expect(PORTAL_ASSET_COUNT).toBeGreaterThanOrEqual(3);
    expect(PORTAL_INDEX_HTML?.mime).toContain('text/html');
    const paths = Object.keys(PORTAL_ASSETS);
    expect(paths.some((path) => path.endsWith('.js'))).toBe(true);
    expect(paths.some((path) => path.endsWith('.css'))).toBe(true);
  });

  test('keeps page, asset, and API routing distinct', () => {
    expect(serveSource).toContain("app.get(['/portal', '/portal/'], requirePortalPage, sendPortalIndex)");
    expect(serveSource).toContain("app.get('/portal/assets/{*path}', requirePortalPage");
    expect(serveSource).toContain("app.get('/portal/api/session'");
    expect(serveSource).toContain('app.get("/portal/api/sources"');
    expect(serveSource.indexOf("app.get('/portal/assets/{*path}'")).toBeLessThan(serveSource.indexOf('app.get("/portal/api/sources"'));
  });

  test('applies the source grant to every content surface', () => {
    expect(serveSource).toContain('engine.searchKeyword(q, {');
    expect(serveSource).toContain('sourceIds: sources.map((source) => source.id)');
    expect(serveSource).toContain('engine.getBacklinks(slug, { sourceIds: sources.map');
    expect(serveSource).toContain('return res.status(404).json({ error: "Not found" })');
    expect(serveSource).toContain('resolvePortalPath(source.local_path, req.query.path)');
  });

  test('uses opaque server-side Portal sessions and never trusts the legacy identity cookie', () => {
    expect(serveSource).toContain('new PortalSessionStore(');
    expect(serveSource).toContain('portalSessions.issue(email)');
    expect(serveSource).toContain('const portalEmail = resolvePortalUser(req, res)');
    expect(serveSource).toContain('res.locals.gbrainPortalUser = portalEmail');
    expect(serveSource).toContain("return res.redirect(`/login?${req.originalUrl.split('?')[1] || ''}`)");
    expect(oauthSource).toContain('this.resolveUserSourceGrant(String(portalEmail');
    expect(oauthSource).toContain('OAuth authorization denied: valid Portal user source grant required');
    expect(oauthSource).not.toContain('cookies?.session_user');
    expect(serveSource).not.toContain('res.cookie("session_user"');
    expect(serveSource).not.toContain("const portalEmail = typeof cookies.session_user");
  });

  test('ships browser containment and private caching headers', () => {
    expect(serveSource).toContain("frame-ancestors 'none'");
    expect(serveSource).toContain("object-src 'none'");
    expect(serveSource).toContain("Cache-Control', 'private, no-store'");
    expect(serveSource).toContain("X-Content-Type-Options', 'nosniff'");
  });

  test('resolves source-qualified legacy aliases inside an allowed source without scanning file bodies', () => {
    const resolveStart = serveSource.indexOf('app.get("/portal/api/resolve-link"');
    const resolveEnd = serveSource.indexOf('app.get("/portal/download"', resolveStart);
    const resolveRoute = serveSource.slice(resolveStart, resolveEnd);
    expect(resolveRoute).toContain('engine.resolveSlugWithAlias(normalizedTarget, source.id)');
    expect(resolveRoute).toContain('engine.resolveAliases([aliasNorm], { sourceId: source.id })');
    expect(resolveRoute).not.toContain('readFileSync(fullPath');
    expect(resolveRoute).toContain('requestedSourceId');
    expect(resolveRoute).toContain('sources.some((source) => source.id === requestedSourceId)');
  });

  test('unions title candidates with indexed body and filename candidates', () => {
    const searchStart = serveSource.indexOf('app.get("/portal/api/search"');
    const searchEnd = serveSource.indexOf('app.get("/portal/api/resolve-link"', searchStart);
    const searchRoute = serveSource.slice(searchStart, searchEnd);
    expect(searchRoute).not.toContain('readFileSync(full');
    expect(searchRoute).toContain('engine.resolveSlugs(q, { sourceId: source.id })');
    expect(searchRoute).toContain('getPortalPages(source.id)');
    expect(searchRoute).toContain('isPortalTitlePrefixMatch(q, page.title)');
    expect(searchRoute).toContain('.slice(0, 100)');
    expect(searchRoute).toContain('engine.getPage(slug, { sourceId: source.id })');
    expect(searchRoute).toContain('classifyPortalSearchMatch({');
    expect(searchRoute).toContain('cleanPortalSearchSnippet(');
    expect(searchRoute).toContain('.sort(comparePortalSearchResults)');
    expect(searchRoute).toContain('match: "name"');
  });

  test('enforces the Portal file policy at preview, context, resolve, and download boundaries', () => {
    const fileRoute = serveSource.slice(serveSource.indexOf('app.get("/portal/api/file"'), serveSource.indexOf("app.get('/portal/api/context'"));
    const contextRoute = serveSource.slice(serveSource.indexOf("app.get('/portal/api/context'"), serveSource.indexOf('app.get("/portal/api/search"'));
    const resolveRoute = serveSource.slice(serveSource.indexOf('app.get("/portal/api/resolve-link"'), serveSource.indexOf('app.get("/portal/download"'));
    const downloadRoute = serveSource.slice(serveSource.indexOf('app.get("/portal/download"'), serveSource.indexOf('app.get("/admin/access-requests"'));
    expect(fileRoute).toContain('isPortalFileAllowed(req.query.path)');
    expect(contextRoute).toContain('isPortalFileAllowed(req.query.path)');
    expect(resolveRoute).toContain('isPortalFileAllowed(testPath)');
    expect(resolveRoute).toContain('isPortalFileAllowed(relPath)');
    expect(downloadRoute).toContain('isPortalFileAllowed(requestedPath)');
  });

  test('uses indexed page counts and separates source summary from folder summary', () => {
    const treeRoute = serveSource.slice(serveSource.indexOf('app.get("/portal/api/tree"'), serveSource.indexOf('app.get("/portal/api/file"'));
    expect(serveSource).toContain("engine.listPages({ sourceId, limit: pageSize, offset, sort: 'slug' })");
    expect(treeRoute).toContain('sourceSummary');
    expect(treeRoute).not.toContain('countDocuments');
  });
});
