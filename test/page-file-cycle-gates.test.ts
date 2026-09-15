import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __testing as synth } from '../src/core/cycle/synthesize.ts';
import { reverseWriteRefs as patterns } from '../src/core/cycle/patterns.ts';
import { tryRedirectPhantom } from '../src/core/cycle/phantom-redirect.ts';
import type { Page } from '../src/core/types.ts';
let db: PGlite;
let root: string;
let puts = 0;
const engine = {
  executeRaw: async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows,
  getPage: async (slug: string) => ({ slug, type: 'note', title: 'Note', compiled_truth: 'replacement', timeline: '', frontmatter: {} }),
  getTags: async () => [],
  putPage: async () => { puts++; },
} as unknown as BrainEngine;
beforeAll(async () => { db = new PGlite(); await db.waitReady; });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-cycle-gate-')); puts = 0;
  await db.exec(`DROP TABLE IF EXISTS page_file_bindings; CREATE TABLE page_file_bindings(source_id text, slug text, canonical_root text, relative_path text, pending_op_id text)`);
  writeFileSync(join(root, 'note.md'), '\ufefforiginal\r\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function enroll(slug = 'note', relative = 'note.md', source = 'default') {
  await db.query('INSERT INTO page_file_bindings VALUES ($1,$2,$3,$4,$5)', [source, slug, root, relative, 'pending']);
}
function snapshot() {
  return readdirSync(root, { recursive: true }).sort().map(n => {
    const p = join(root, String(n)); const s = statSync(p);
    return [n, s.ino, s.mode, s.size, s.mtimeMs, s.isFile() ? readFileSync(p).toString('hex') : null];
  });
}
for (const target of ['note', 'people/note']) {
  test(`phantom preflights ${target} before materialization, fence rename or deletion`, async () => {
    await enroll(target, `${target}.md`); const before = snapshot();
    const phantomEngine = {
      ...engine,
      executeRaw: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM pages')) return [{ slug: 'people/note', score: 1, connection_count: 1 }];
        return engine.executeRaw(sql, params);
      },
      refreshPageBody: async () => { throw new Error('reached DB mutation'); },
    } as unknown as BrainEngine;
    await expect(tryRedirectPhantom(phantomEngine, { slug: 'note', compiled_truth: '# note' } as Page, 'default', root, false)).rejects.toMatchObject({ code: 'page_file_unsupported_writer' });
    expect(snapshot()).toEqual(before);
  });
}
test('summary refuses before DB put or canonical file mutation', async () => {
  await enroll(); const before = snapshot();
  await expect(synth.writeSummaryPage(engine, root, 'note', '2026-01-01', [], [])).rejects.toThrow('page_file_unsupported_writer');
  expect(puts).toBe(0); expect(snapshot()).toEqual(before);
});
for (const [name, write] of [['synthesize', synth.reverseWriteRefs], ['patterns', patterns]] as const) {
  test(`${name} permits unrelated page while another binding is pending`, async () => {
    await enroll('other', 'other.md');
    expect(await write(engine, root, [{ slug: 'note', source_id: 'default' }])).toBe(1);
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toContain('replacement');
  });
  test(`${name} rejects physical-path alias and preserves missing directories`, async () => {
    await enroll('different-slug', 'missing/note.md'); const before = snapshot();
    await expect(write(engine, root, [{ slug: 'missing/note', source_id: 'default' }])).rejects.toThrow('page_file_unsupported_writer');
    expect(snapshot()).toEqual(before);
  });
  test(`${name} catalog failure is not swallowed as reverse-write success`, async () => {
    await db.exec('ALTER TABLE page_file_bindings DROP COLUMN relative_path'); const before = snapshot();
    await expect(write(engine, root, [{ slug: 'note', source_id: 'default' }])).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });
  test(`${name} refuses enrolled reverse-write rather than reporting success`, async () => {
    await enroll(); const before = snapshot();
    await expect(write(engine, root, [{ slug: 'note', source_id: 'default' }])).rejects.toThrow('page_file_unsupported_writer');
    expect(snapshot()).toEqual(before);
  });
}
