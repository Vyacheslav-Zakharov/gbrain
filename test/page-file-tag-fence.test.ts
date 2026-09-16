import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { exerciseTagRevisionFence } from './helpers/page-file-tag-fence.ts';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
test('unchanged tag trigger requires refreshed exact revision even for conflict no-op (offline, not role attestation)', async () => {
  await engine.putPage('tag-fence', { type: 'note', title: 'Tag fence', compiled_truth: 'Before', timeline: '', frontmatter: {} });
  await engine.addTag('tag-fence', 'overlay');
  const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug='tag-fence'");
  await engine.executeRaw(`INSERT INTO page_file_bindings(source_id,slug,page_id,binding_key,canonical_root,relative_path,indexed_raw_sha256)
    VALUES('default','tag-fence',$1,'offline-tag-fence','/fixture','tag-fence.md',$2)`, [page.id, 'a'.repeat(64)]);
  const before = await engine.executeRaw('SELECT to_jsonb(p)::text AS row FROM pages p WHERE id=$1', [page.id]);
  const rollback = new Error('fixture rollback');
  await expect(engine.transaction(async tx => {
    await exerciseTagRevisionFence((sql, params = []) => tx.executeRaw(sql, params), page.id);
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await engine.executeRaw('SELECT to_jsonb(p)::text AS row FROM pages p WHERE id=$1', [page.id])).toEqual(before);
  expect(await engine.getTags('tag-fence')).toEqual(['overlay']);
  expect(await engine.executeRaw('SELECT * FROM page_file_write_authorizations')).toEqual([]);
});
