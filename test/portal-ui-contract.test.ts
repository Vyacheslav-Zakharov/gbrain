import { describe, expect, test } from 'bun:test';
import { PORTAL_ASSET_COUNT, PORTAL_ASSETS, PORTAL_INDEX_HTML } from '../src/portal-embedded';

const serveSource = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();

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
    expect(serveSource).not.toContain('res.cookie("session_user"');
    expect(serveSource).not.toContain("const portalEmail = typeof cookies.session_user");
  });

  test('ships browser containment and private caching headers', () => {
    expect(serveSource).toContain("frame-ancestors 'none'");
    expect(serveSource).toContain("object-src 'none'");
    expect(serveSource).toContain("Cache-Control', 'private, no-store'");
    expect(serveSource).toContain("X-Content-Type-Options', 'nosniff'");
  });

  test('resolves source-qualified legacy aliases inside an allowed source', () => {
    const resolveStart = serveSource.indexOf('app.get("/portal/api/resolve-link"');
    const resolveEnd = serveSource.indexOf('app.get("/portal/download"', resolveStart);
    const resolveRoute = serveSource.slice(resolveStart, resolveEnd);
    expect(resolveRoute).toContain('extractPortalAliases(content)');
    expect(resolveRoute).toContain('requestedSourceId');
    expect(resolveRoute).toContain('sources.some((source) => source.id === requestedSourceId)');
  });

  test('does not read every markdown body during filename fallback', () => {
    const searchStart = serveSource.indexOf('app.get("/portal/api/search"');
    const searchEnd = serveSource.indexOf('app.get("/portal/api/resolve-link"', searchStart);
    const searchRoute = serveSource.slice(searchStart, searchEnd);
    expect(searchRoute).not.toContain('readFileSync(full');
    expect(searchRoute).toContain('classifyPortalSearchMatch({');
    expect(searchRoute).toContain('cleanPortalSearchSnippet(');
    expect(searchRoute).toContain('.sort(comparePortalSearchResults)');
    expect(searchRoute).toContain('match: "name"');
  });
});
