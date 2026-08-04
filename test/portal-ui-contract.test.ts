import { describe, expect, test } from 'bun:test';
import { PORTAL_ASSET_COUNT, PORTAL_ASSETS, PORTAL_INDEX_HTML } from '../src/portal-embedded';

const serveSource = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
const oauthSource = await Bun.file(new URL('../src/core/oauth-provider.ts', import.meta.url)).text();
const portalAppSource = await Bun.file(new URL('../portal/src/PortalApp.tsx', import.meta.url)).text();
const adminAppSource = await Bun.file(new URL('../admin/src/App.tsx', import.meta.url)).text();
const adminApiSource = await Bun.file(new URL('../admin/src/api.ts', import.meta.url)).text();
const accessControlSource = await Bun.file(new URL('../admin/src/pages/AccessControl.tsx', import.meta.url)).text();

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
    expect(serveSource).toContain('engine.getBacklinks(slug, { sourceId: source.id })');
    expect(serveSource).toContain('return res.status(404).json({ error: "Not found" })');
    expect(serveSource).toContain('resolvePortalPath(source.local_path, req.query.path)');
  });

  test('uses opaque server-side Portal sessions and never trusts the legacy identity cookie', () => {
    expect(serveSource).toContain('new PortalSessionStore(');
    expect(serveSource).toContain("portalSessions.issue({ ...identity, authMethod: 'keycloak' })");
    expect(serveSource).toContain('const portalEmail = resolvePortalUser(req, res)');
    expect(serveSource).toContain('res.locals.gbrainPortalUser = portalEmail');
    expect(serveSource).toContain("return res.redirect(`/login?${req.originalUrl.split('?')[1] || ''}`)");
    expect(serveSource).toContain("app.get(DEFAULT_KEYCLOAK_CALLBACK_PATH");
    expect(serveSource).toContain("transaction.prompt === 'none'");
    expect(serveSource).toContain('portalSessions.revalidate(transaction.existingSessionToken, identity)');
    expect(oauthSource).toContain('this.resolveUserSourceGrant(String(portalEmail');
    expect(oauthSource).toContain('OAuth authorization denied: valid Portal user source grant required');
    expect(oauthSource).not.toContain('cookies?.session_user');
    expect(serveSource).not.toContain('res.cookie("session_user"');
    expect(serveSource).not.toContain("const portalEmail = typeof cookies.session_user");
  });

  test('admin sign-out-everywhere completes the backing Portal and Keycloak logout', () => {
    expect(adminAppSource).toContain("fetch('/logout'");
    expect(adminAppSource).toContain("method: 'POST'");
    expect(adminAppSource).toContain('logout_url');
    expect(adminAppSource).toContain("window.location.assign(logoutUrl || '/login')");
    expect(adminAppSource).toContain('finally');
    expect(adminAppSource).not.toContain("navigate('login');");
  });

  test('makes user permissions and access requests discoverable in the Admin SPA', () => {
    expect(adminAppSource).toContain("'access-control'");
    expect(adminAppSource).toContain("label: 'Доступы'");
    expect(adminAppSource).toContain('<AccessControlPage />');
    expect(adminApiSource).toContain("accessControlPermissions: () => apiFetch('/admin/api/permissions')");
    expect(adminApiSource).toContain("accessControlRequests: () => apiFetch('/admin/api/access-requests')");
    expect(accessControlSource).toContain('Права пользователей');
    expect(accessControlSource).toContain('Заявки');
    expect(accessControlSource).toContain('Администраторы');
    expect(accessControlSource).toContain('expected_version');
  });

  test('renders access decisions faithfully and keeps Admin navigation keyboard-operable', () => {
    expect(adminAppSource).toContain("type=\"button\"\n            className={`nav-item");
    expect(adminAppSource).toContain("aria-current={page === item.page ? 'page' : undefined}");
    expect(accessControlSource).toContain("grant.write && grant.read ? 'R/W'");
    expect(accessControlSource).toContain('role="tabpanel"');
    expect(accessControlSource).toContain('handleTabKey');
    expect(accessControlSource).toContain('Права сохранены, но обновить список не удалось');
    expect(accessControlSource).toContain('aria-label={`${user.email}, ${area.label}, чтение`}');
  });

  test('hardens access-control mutations with same-origin and optimistic concurrency', () => {
    expect(serveSource).toContain("app.post('/admin/api/permissions/:email', requireAdmin, requireAdminSameOrigin, express.json()");
    expect(serveSource).toContain('app.post("/admin/api/access-requests/:id/approve", requireAdmin, requireAdminSameOrigin, express.json()');
    expect(serveSource).toContain('app.post("/admin/api/access-requests/:id/reject", requireAdmin, requireAdminSameOrigin, express.json()');
    expect(serveSource).toContain('const beforeVersion = portalPermissionsVersion(user);');
    expect(serveSource).toContain('beforeVersion !== expectedVersion');
    expect(serveSource).toContain("res.status(409).json({ error: 'permissions_changed' });");
    expect(serveSource).toContain('portalAccessRequestVersion(item) !== expectedVersion');
    expect(serveSource).toContain("res.status(409).json({ error: 'request_changed' });");
    expect(serveSource).toContain('normalizeRequestGrantDecisions(requestedRows, req.body?.grants)');
    expect(serveSource).toContain('loadJsonFileStrictLocal');
    expect(serveSource).toContain('commitAccessControlJsonTransaction(accessControlTransactionPaths(), perms, requests)');
    expect(serveSource).toContain('recoverAccessControlTransactionLocal();');
    expect(serveSource).toContain('const data = readAccessRequestsStrict();');
    expect(serveSource).toContain("actor: portalEmail");
    expect(serveSource).toContain("fallbackAdminActor('magic-link', sessionId)");
    expect(serveSource).toContain("action: 'permissions_changed'");
    expect(serveSource).toContain("res.status(400).json({ error: 'rejection_reason_required' });");
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

  test('projects ACL-filtered meeting attendance and mentions into a dedicated context section', () => {
    const contextRoute = serveSource.slice(serveSource.indexOf("app.get('/portal/api/context'"), serveSource.indexOf('app.get("/portal/api/search"'));
    expect(contextRoute).toContain('engine.getBacklinks(slug, { sourceId: source.id })');
    expect(contextRoute).toContain('engine.getLinks(slug, { sourceId: source.id })');
    expect(contextRoute).not.toContain('sourceIds: allowedSourceIds');
    expect(contextRoute).toContain("link.link_type !== 'attended'");
    expect(contextRoute).toContain('allowedSources.has(linkSource)');
    expect(contextRoute).toContain('res.json({ source: source.id, slug, backlinks, meetings })');
    expect(portalAppSource).toContain('<h2>Встречи');
    expect(portalAppSource).toContain("link.type === 'attended' ? 'участие'");
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
