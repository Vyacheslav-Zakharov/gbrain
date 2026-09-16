import { beforeAll, afterAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
const ctx = (extra = {}) => ({ engine, remote: true, sourceId: 'default', dryRun: false, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {}, debug() {} }, ...extra } as OperationContext);
const page = { type: 'note', title: 'Example', compiled_truth: 'Original', timeline: '', frontmatter: { status: 'approved' } };
const call = (name: string, p: Record<string, unknown>, c = ctx()) => operationsByName[name].handler(c, p) as Promise<any>;
const seed = async (slug: string) => { await engine.putPage(slug, page); return call('get_page_checked', { slug, source_id: 'default' }); };
test('explicit empty source grants fail closed on read and write, including unset remote', async () => {
 const slug = 'security/grants'; const snap = await seed(slug);
 for (const remote of [true, undefined]) {
  await expect(call('get_page_checked', { slug, source_id: 'default' }, ctx({ remote, auth: { allowedSources: [] } }))).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: snap.revision, page }, ctx({ remote, auth: { writeSources: [] } }))).rejects.toMatchObject({ code: 'permission_denied' });
 }
 expect(await call('get_page_checked', { slug, source_id: 'default' })).toEqual(snap);
});

test('checked writes keep subagents in their namespace, not owner-package allowlists', async () => {
 const slug = 'security/namespace'; const snap = await seed(slug);
 for (const extra of [{ viaSubagent: true }, { viaSubagent: true, subagentId: 12, allowedSlugPrefixes: ['security/*'] }]) {
  await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: snap.revision, page }, ctx(extra))).rejects.toMatchObject({ code: 'permission_denied' });
 }
 const own = 'wiki/agents/12/own'; const ownSnap = await seed(own);
 await call('put_page_checked', { slug: own, source_id: 'default', expected_revision: ownSnap.revision, page }, ctx({ viaSubagent: true, subagentId: 12 }));
});

test('remote checked operations reject snapshots requiring privacy redaction without replacing content', async () => {
 const slug = 'security/private'; await engine.putPage(slug, { ...page, compiled_truth: '<!--- gbrain:takes:begin -->\nsecret\n<!--- gbrain:takes:end -->' });
 const local = await call('get_page_checked', { slug, source_id: 'default' }, ctx({ remote: false }));
 for (const remote of [true, undefined]) {
  await expect(call('get_page_checked', { slug, source_id: 'default' }, ctx({ remote }))).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: local.revision, page }, ctx({ remote }))).rejects.toMatchObject({ code: 'permission_denied' });
 }
 expect(await call('get_page_checked', { slug, source_id: 'default' }, ctx({ remote: false }))).toEqual(local);
});

test('editable payload must be complete and cannot alter governance or timeline', async () => {
 const slug = 'security/payload'; const snap = await seed(slug);
 for (const invalid of [null, [], {}, { ...page, title: 1 }, { ...page, extra: true }, { ...page, frontmatter: [] }, { ...page, frontmatter: { status: 'rejected' } }, { ...page, timeline: 'rewrite' }]) {
  await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: snap.revision, page: invalid })).rejects.toMatchObject({ code: 'invalid_params' });
 }
 expect(await call('get_page_checked', { slug, source_id: 'default' })).toEqual(snap);
});

test('eligibility uses persisted page, source and server sync config, never client assertions', async () => {
 for (const [column, value] of [['page_kind', 'code'], ['source_path', 'example.md']] ) {
  const slug = `security/${column.replaceAll('_', '-')}`; const snap = await seed(slug);
  await engine.executeRaw(`UPDATE pages SET ${column} = $1 WHERE slug = $2`, [value, slug]);
  await expect(call('get_page_checked', { slug, source_id: 'default' })).rejects.toMatchObject({ code: 'ineligible_page' });
  const revision = (await engine.executeRaw<any>('SELECT write_revision FROM pages WHERE slug = $1', [slug]))[0].write_revision;
  await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: revision, page })).rejects.toMatchObject({ code: 'ineligible_page' });
 }
 const slug = 'security/config'; const snap = await seed(slug);
 await engine.executeRaw("UPDATE sources SET local_path = '/not-required-to-exist' WHERE id = 'default'");
 try { await expect(call('get_page_checked', { slug, source_id: 'default' })).rejects.toMatchObject({ code: 'ineligible_page' }); }
 finally { await engine.executeRaw("UPDATE sources SET local_path = NULL WHERE id = 'default'"); }
 await engine.setConfig('sync.repo_path', '/not-required-to-exist');
 try { await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: snap.revision, page })).rejects.toMatchObject({ code: 'ineligible_page' }); }
 finally { await engine.executeRaw("DELETE FROM config WHERE key = 'sync.repo_path'"); }
});


test('dry-run cannot mutate a checked page or its derivatives', async () => {
 const slug = 'security/dry-run'; const snap = await seed(slug);
 const beforeChunks = await engine.getChunks(slug);
 const beforeVersions = await engine.getVersions(slug, { sourceId: 'default' });
 await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: snap.revision,
   page: { ...page, compiled_truth: 'Must not be written' } }, ctx({ dryRun: true })))
   .rejects.toMatchObject({ code: 'invalid_params' });
 expect(await call('get_page_checked', { slug, source_id: 'default' })).toEqual(snap);
 expect(await engine.getChunks(slug)).toEqual(beforeChunks);
 expect(await engine.getVersions(slug, { sourceId: 'default' })).toEqual(beforeVersions);
});

test('server-loaded filesystem configuration blocks checked reads and writes', async () => {
 const slug = 'security/server-config'; const snap = await seed(slug);
 const configured = ctx({ config: { engine: 'pglite', sync: { repo_path: '/synthetic/not-created' } } });
 await expect(call('get_page_checked', { slug, source_id: 'default' }, configured)).rejects.toMatchObject({ code: 'ineligible_page' });
 await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: snap.revision, page }, configured)).rejects.toMatchObject({ code: 'ineligible_page' });
 expect(await call('get_page_checked', { slug, source_id: 'default' })).toEqual(snap);
});
