import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullRepo, divergenceSafePull } from '../src/core/git-remote.ts';
import type { BrainEngine } from '../src/core/engine.ts';
let db: PGlite;
let root: string;
const engine = { executeRaw: async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows } as Pick<BrainEngine, 'executeRaw'>;
beforeAll(async () => { db = new PGlite(); await db.waitReady; });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-root-gate-'));
  await db.exec('DROP TABLE IF EXISTS page_file_bindings; CREATE TABLE page_file_bindings(source_id text, canonical_root text, relative_path text)');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
test('enrolled nested roots and symlink aliases refuse while unrelated roots continue', async () => {
  const gate = await import('../src/core/page-file-root-gate.ts');
  mkdirSync(join(root, 'enrolled')); mkdirSync(join(root, 'other'));
  symlinkSync(join(root, 'enrolled'), join(root, 'alias'));
  await db.query('INSERT INTO page_file_bindings VALUES ($1,$2,$3)', ['other-source', join(root, 'enrolled'), 'note.md']);
  for (const target of [root, join(root, 'alias'), join(root, 'enrolled')]) {
    await expect(gate.withLegacyPageFileRootMutation(engine, target, () => { throw new Error('mutation ran'); })).rejects.toThrow('page_file_unsupported_root_writer');
  }
  let saved: any;
  await gate.withLegacyPageFileRootMutation(engine, join(root, 'other'), permit => {
    saved = permit; gate.assertPageFileRootPermit(join(root, 'other'), permit);
    expect(() => gate.assertPageFileRootPermit(root, permit)).toThrow('page_file_root_gate_unavailable');
  });
  expect(() => gate.assertPageFileRootPermit(join(root, 'other'), saved)).toThrow('page_file_root_gate_unavailable');
});
test('reclone refuses enrolled checkout before clone or replacement', async () => {
  const { recloneIfMissing } = await import('../src/core/sources-ops.ts');
  await db.exec('DROP TABLE IF EXISTS sources; CREATE TABLE sources(id text, name text, local_path text, last_commit text, last_sync_at timestamptz, config jsonb, created_at timestamptz)');
  await db.query("INSERT INTO sources VALUES ('example','Example',$1,NULL,NULL,$2::text::jsonb,now())", [root, JSON.stringify({ managed_clone: true, remote_url: join(root, 'nonexistent-offline-remote') })]);
  await db.query('INSERT INTO page_file_bindings VALUES ($1,$2,$3)', ['example', root, 'note.md']);
  await expect(recloneIfMissing(engine as BrainEngine, 'example')).rejects.toThrow('page_file_unsupported_root_writer');
});
test('pull entrypoints refuse missing root safety proof before invoking git', () => {
  expect(() => pullRepo(root)).toThrow('page_file_root_gate_unavailable');
  expect(() => divergenceSafePull(root, 'main')).toThrow('page_file_root_gate_unavailable');
});
