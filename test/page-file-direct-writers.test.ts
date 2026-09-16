import { afterAll, afterEach, beforeAll, beforeEach, expect, test as bunTest } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { writeFactsToFence, type FenceInputFact } from '../src/core/facts/fence-write.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { buildSourceRevertReport } from '../src/core/source-ingest/revert.ts';
import { upsertFactRow } from '../src/core/facts-fence.ts';
import { withEnv } from './helpers/with-env.ts';

let db: PGlite;
let root: string;
let home: string;

let mutations: string[];
const engine = {
  executeRaw: async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows,
  insertFacts: async () => { mutations.push('insertFacts'); return { inserted: 1, ids: [1] }; },
  expireFact: async () => { mutations.push('expireFact'); return true; },
  softDeletePage: async () => { mutations.push('softDeletePage'); },
  getPage: async () => ({ updated_at: '2020-01-01', compiled_truth: 'current' }),
  getVersions: async () => [{ id: 1, frontmatter: {}, compiled_truth: 'old' }],
} as unknown as BrainEngine;
const fact: FenceInputFact = { fact: 'Synthetic fact', kind: 'fact', notability: 'medium', source: 'test', visibility: 'world', embedding: null, sessionId: null };
beforeAll(async () => { db = new PGlite(); await db.waitReady; });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-direct-gate-'));
  root = join(home, 'source'); mkdirSync(root);

  mutations = [];
  await db.exec(`DROP TABLE IF EXISTS page_file_bindings, sources, facts, source_ingest_run_items;
    CREATE TABLE page_file_bindings(source_id text, slug text, canonical_root text, relative_path text, pending_op_id text);
    CREATE TABLE sources(id text, local_path text);
    CREATE TABLE facts(id int, source_id text, entity_slug text, row_num int, source_markdown_slug text, expired_at timestamptz, valid_until text);
    CREATE TABLE source_ingest_run_items(run_id text, connector_id text, source_object text, external_id text, slug text, approved_source_id text, profile_id text, profile_version int, last_result text, last_error text, created_at timestamptz, action text, prior_version_id int);`);
  await db.query('INSERT INTO sources VALUES ($1,$2)', ['default', root]);
  await db.exec("INSERT INTO facts VALUES (1,'default','note',1,'note',NULL,NULL)");
  const body = upsertFactRow('\ufeff# Original\r\n', { claim: 'Existing fact', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', validFrom: '2020-01-01', source: 'test' }).body;
  writeFileSync(join(root, 'note.md'), body);
  writeFileSync(join(root, 'note.md.tmp'), 'preserve sibling');
});
afterEach(() => {

  rmSync(home, { recursive: true, force: true });
});
// Return the whole async scope so restoration runs only after the test settles.
function test(name: string, run: () => Promise<void>) {
  bunTest(name, () => withEnv({ GBRAIN_HOME: home }, run));
}
async function enroll(slug = 'note', pending: string | null = null) {
  await db.query('INSERT INTO page_file_bindings VALUES ($1,$2,$3,$4,$5)', ['default', slug, root, 'note.md', pending]);
}
function snapshot() {
  return readdirSync(root, { recursive: true }).sort().map(name => {
    const p = join(root, String(name)); const s = statSync(p);
    return [name, s.ino, s.mode, s.size, s.mtimeMs, s.isFile() ? readFileSync(p).toString('hex') : null];
  });
}
async function refusal(action: () => Promise<unknown>) {
  const before = snapshot();
  let error: unknown;
  try { await action(); } catch (e) { error = e; }
  expect(snapshot()).toEqual(before);
  expect(mutations).toEqual([]);
  expect(String(error)).toContain('page_file_unsupported_writer');
}
for (const writer of ['fence', 'forget'] as const) {
  const invoke = () => writer === 'fence'
    ? writeFactsToFence(engine, { sourceId: 'default', localPath: root, slug: 'note' }, [fact])
    : forgetFactInFence(engine, 1);
  test(`${writer}: physical path alias with pending binding refuses`, async () => {
    await enroll('different-slug', 'pending');
    await refusal(invoke);
  });
  test(`${writer}: unrelated pending page does not freeze this file`, async () => {
    await db.query('INSERT INTO page_file_bindings VALUES ($1,$2,$3,$4,$5)', ['default', 'other', root, 'other.md', 'pending']);
    const before = readFileSync(join(root, 'note.md'));
    await invoke();
    expect(readFileSync(join(root, 'note.md'))).not.toEqual(before);
  });
  test(`${writer}: metadata failure refuses before touching target or sibling`, async () => {
    await db.exec('ALTER TABLE page_file_bindings DROP COLUMN relative_path');
    const before = snapshot();
    await expect(invoke()).rejects.toThrow('relative_path');
    expect(snapshot()).toEqual(before);
    expect(mutations).toEqual([]);
  });
}
test('revert updated page refuses pending physical alias before restoration', async () => {
  await enroll('different-slug', 'pending');
  await db.exec("INSERT INTO source_ingest_run_items VALUES ('run','test','items','1','note','default','profile',1,'success',NULL,now(),'updated',1)");
  const before = snapshot();
  const result = await buildSourceRevertReport(engine, 'run', { apply: true, force: true });
  expect(result.pages[0]).toMatchObject({ revert_action: 'blocked', reason: 'page_file_unsupported_writer' });
  expect(snapshot()).toEqual(before);
  expect(mutations).toEqual([]);
});
test('revert cannot resolve a filesystem target and blocks only the requested apply', async () => {
  await db.exec("UPDATE sources SET local_path=NULL; INSERT INTO source_ingest_run_items VALUES ('run','test','items','1','note','default','profile',1,'success',NULL,now(),'created',NULL)");
  const before = snapshot();
  const report = await buildSourceRevertReport(engine, 'run');
  expect(report.pages[0].revert_action).toBe('would-soft-delete');
  const result = await buildSourceRevertReport(engine, 'run', { apply: true });
  expect(result.pages[0]).toMatchObject({ revert_action: 'blocked', reason: 'page_file_gate_unavailable' });
  expect(snapshot()).toEqual(before);
  expect(mutations).toEqual([]);
});
test('revert metadata failure is a page-local blocked result', async () => {
  await db.exec('ALTER TABLE page_file_bindings DROP COLUMN relative_path');
  await db.exec("INSERT INTO source_ingest_run_items VALUES ('run','test','items','1','note','default','profile',1,'success',NULL,now(),'created',NULL)");
  const before = snapshot();
  const result = await buildSourceRevertReport(engine, 'run', { apply: true });
  expect(result.pages[0].revert_action).toBe('blocked');
  expect(result.pages[0].reason).toContain('relative_path');
  expect(snapshot()).toEqual(before);
  expect(mutations).toEqual([]);
});
test('revert refuses enrolled created page before soft-delete or unlink even with force', async () => {
  await enroll();
  await db.exec("INSERT INTO source_ingest_run_items VALUES ('run','test','items','1','note','default','profile',1,'success',NULL,now(),'created',NULL)");
  const before = snapshot();
  let result: Awaited<ReturnType<typeof buildSourceRevertReport>> | undefined;
  try { result = await buildSourceRevertReport(engine, 'run', { apply: true, force: true }); } catch {}
  expect(snapshot()).toEqual(before);
  expect(mutations).toEqual([]);
  expect(result?.pages[0]).toMatchObject({ revert_action: 'blocked', reason: 'page_file_unsupported_writer' });
});
test('forget refuses enrolled canonical file without expiring the fact', async () => {
  await enroll();
  await refusal(() => forgetFactInFence(engine, 1));
  expect((await db.query('SELECT expired_at FROM facts')).rows[0]).toEqual({ expired_at: null });
});
test('fence append refuses enrolled canonical file before temp overwrite', async () => {
  await enroll();
  await refusal(() => writeFactsToFence(engine, { sourceId: 'default', localPath: root, slug: 'note' }, [fact]));
});
