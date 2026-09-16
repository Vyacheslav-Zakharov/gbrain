import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
const context = () => ({ engine, remote: false, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} } } as OperationContext);
const call = (name: string, params: Record<string, unknown>) => operationsByName[name].handler(context(), params) as Promise<any>;
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: { status: 'approved' } });

test('checked replacement atomically rebuilds chunks without old vectors and saves prior body', async () => {
  const slug = 'cas-store/replace';
  await engine.putPage(slug, page('Old searchable text'));
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'Old searchable text', chunk_source: 'compiled_truth', embedding: new Float32Array(1536).fill(0.01) }]);
  const old = await engine.getChunks(slug);
  const snapshot = await call('get_page_checked', { slug, source_id: 'default' });
  await call('put_page_checked', { slug, source_id: 'default', expected_revision: snapshot.revision, page: page('New searchable text') });
  const chunks = await engine.getChunks(slug);
  expect(chunks.map(c => c.chunk_text)).toEqual(['New searchable text']);
  expect(chunks[0].id).not.toBe(old[0].id);
  expect(chunks[0].embedding).toBeNull();
  expect(chunks[0].embedded_at).toBeNull();
  expect((await engine.getVersions(slug, { sourceId: 'default' })).some(v => v.compiled_truth === 'Old searchable text')).toBe(true);
});


test('store rolls page, chunks and before-image back when chunk insertion fails', async () => {
  const { updateCheckedPage } = await import('../src/core/page-checked-store.ts');
  const slug = 'cas-store/rollback';
  await engine.putPage(slug, page('Original'));
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'Original', chunk_source: 'compiled_truth' }]);
  const before = (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM pages WHERE slug = $1', [slug]))[0];
  const oldChunks = await engine.getChunks(slug);
  const versions = await engine.getVersions(slug, { sourceId: 'default' });
  await engine.executeRaw(`CREATE FUNCTION cas_store_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.chunk_text = 'FAIL INSERT' THEN RAISE EXCEPTION 'fixture_chunk_insert'; END IF; RETURN NEW; END; $$`);
  await engine.executeRaw(`CREATE TRIGGER cas_store_test_fail BEFORE INSERT ON content_chunks
    FOR EACH ROW EXECUTE FUNCTION cas_store_test_fail()`);
  try {
    await expect(updateCheckedPage(engine, { source: 'default', slug, expectedRevision: before.write_revision as string,
      page: page('FAIL INSERT') }, async () => {})).rejects.toThrow('fixture_chunk_insert');
    expect((await engine.executeRaw('SELECT * FROM pages WHERE slug = $1', [slug]))[0]).toEqual(before);
    expect(await engine.getChunks(slug)).toEqual(oldChunks);
    expect(await engine.getVersions(slug, { sourceId: 'default' })).toEqual(versions);
  } finally {
    await engine.executeRaw('DROP TRIGGER cas_store_test_fail ON content_chunks');
    await engine.executeRaw('DROP FUNCTION cas_store_test_fail()');
  }
});

test('title-only changes replace chunk identities and empty body removes old chunks', async () => {
  const { updateCheckedPage } = await import('../src/core/page-checked-store.ts');
  const slug = 'cas-store/title';
  await engine.putPage(slug, page('Unchanged body'));
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'Unchanged body', chunk_source: 'compiled_truth' }]);
  const read = async () => (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM pages WHERE slug = $1', [slug]))[0];
  const oldChunks = await engine.getChunks(slug);
  const changed = { ...page('Unchanged body'), title: 'New title' };
  const after = await updateCheckedPage(engine, { source: 'default', slug, expectedRevision: (await read()).write_revision as string,
    page: changed }, async () => {});
  const newChunks = await engine.getChunks(slug);
  expect(newChunks[0].id).not.toBe(oldChunks[0].id);
  expect(newChunks[0].embedding).toBeNull();
  await updateCheckedPage(engine, { source: 'default', slug, expectedRevision: after!.write_revision as string,
    page: { ...changed, compiled_truth: '' } }, async () => {});
  expect(await engine.getChunks(slug)).toEqual([]);
});
