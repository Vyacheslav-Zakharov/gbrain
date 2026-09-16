import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, symlinkSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { writePageThrough } from '../src/core/write-through.ts';

let db: PGlite;
let root: string;
// Offline SQL adapter: no engine configuration, migrations, providers or services.
const engine = {
  executeRaw: async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows,
  getConfig: async () => null,
  getPage: async (slug: string, opts: { sourceId: string }) => (await db.query('SELECT * FROM pages WHERE source_id=$1 AND slug=$2', [opts.sourceId, slug])).rows[0],
  getTags: async () => [],
} as unknown as BrainEngine;
beforeAll(async () => { db = new PGlite(); await db.waitReady; });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-file-gate-'));
  await db.exec(`DROP TABLE IF EXISTS page_file_bindings; DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS sources;
    CREATE TABLE sources(id text, local_path text);
    CREATE TABLE pages(source_id text, slug text, source_path text, deleted_at timestamptz, title text, type text, compiled_truth text, timeline text, frontmatter jsonb);
    CREATE TABLE page_file_bindings(source_id text, slug text, canonical_root text, relative_path text, pending_op_id text);`);
  await db.query('INSERT INTO sources VALUES ($1,$2)', ['default', root]);
  await db.query(`INSERT INTO pages VALUES ('default','note','note.md',NULL,'Note','note','replacement','', '{}'::jsonb)`);
  writeFileSync(join(root, 'note.md'), '\ufefforiginal\r\n# untouched\r\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
async function enroll(slug = 'note', relativePath = 'note.md', pending: string | null = null) {
  await db.query('INSERT INTO page_file_bindings VALUES ($1,$2,$3,$4,$5)', ['default', slug, root, relativePath, pending]);
}
function snapshot() {
  return readdirSync(root, { recursive: true }).sort().map(name => {
    const p = join(root, String(name)); const s = statSync(p);
    return [name, s.ino, s.mode, s.size, s.mtimeMs, s.isFile() ? readFileSync(p).toString('hex') : null];
  });
}
test('pending binding refuses before creating missing directories', async () => {
  await db.query("UPDATE pages SET source_path='missing/note.md'");
  await enroll('note', 'missing/note.md', 'pending-operation');
  const before = snapshot();
  expect(await writePageThrough(engine, 'note')).toMatchObject({ written: false, error: 'page_file_unsupported_writer' });
  expect(snapshot()).toEqual(before);
});
test('unrelated page remains writable while another page is pending', async () => {
  await enroll('other', 'other.md', 'pending-operation');
  expect((await writePageThrough(engine, 'note')).written).toBe(true);
  expect(readFileSync(join(root, 'note.md'), 'utf8')).toContain('replacement');
});
test('same slug in another source and physical root is not globally frozen', async () => {
  await enroll();
  mkdirSync(join(root, 'other'));
  await db.query('INSERT INTO sources VALUES ($1,$2)', ['other', join(root, 'other')]);
  await db.exec("INSERT INTO pages SELECT 'other',slug,source_path,deleted_at,title,type,compiled_truth,timeline,frontmatter FROM pages");
  const original = readFileSync(join(root, 'note.md'));
  expect((await writePageThrough(engine, 'note', { sourceId: 'other' })).written).toBe(true);
  expect(readFileSync(join(root, 'note.md'))).toEqual(original);
});
test('verified absent binding table supports legacy schema', async () => {
  await db.exec('DROP TABLE page_file_bindings');
  expect((await writePageThrough(engine, 'note')).written).toBe(true);
});
test('binding query failure refuses without touching files', async () => {
  await db.exec('ALTER TABLE page_file_bindings DROP COLUMN relative_path');
  const before = snapshot();
  const result = await writePageThrough(engine, 'note');
  expect(result.written).toBe(false);
  expect(result.error).toContain('relative_path');
  expect(snapshot()).toEqual(before);
});
test('symlinked source root cannot bypass persisted physical path identity', async () => {
  mkdirSync(join(root, 'canonical'));
  writeFileSync(join(root, 'canonical', 'note.md'), 'protected');
  symlinkSync(join(root, 'canonical'), join(root, 'alias'));
  await db.query('UPDATE sources SET local_path=$1', [join(root, 'alias')]);
  await enroll('original-slug', 'canonical/note.md');
  const before = snapshot();
  expect(await writePageThrough(engine, 'note')).toMatchObject({ written: false, error: 'page_file_unsupported_writer' });
  expect(snapshot()).toEqual(before);
});

test('persisted canonical path blocks a different slug targeting the enrolled file', async () => {
  await enroll('original-slug');
  const before = snapshot();
  expect(await writePageThrough(engine, 'note')).toMatchObject({ written: false, error: 'page_file_unsupported_writer' });
  expect(snapshot()).toEqual(before);
});

test('enrolled page refuses legacy overwrite without changing bytes, inode or temp siblings', async () => {
  await enroll();
  writeFileSync(join(root, 'note.md.tmp.sentinel'), 'unrelated temp');
  const before = snapshot();
  expect(await writePageThrough(engine, 'note')).toMatchObject({ written: false, error: 'page_file_unsupported_writer' });
  expect(snapshot()).toEqual(before);
});
