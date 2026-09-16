import { beforeAll, afterAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import { createPageCheckedOperations } from '../src/core/page-checked.ts';
import * as db from '../src/core/page-file-db.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
let engine: PGLiteEngine; let root: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); root = await mkdtemp(join(tmpdir(), 'file-db-')); });
afterAll(async () => { await engine.disconnect(); await rm(root, { recursive: true, force: true }); });
const fields = (body: string) => ({ type: 'concept', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
const ctx = () => ({ engine, remote: false, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } } as OperationContext);
test('explicit offline enrollment to operation handler persists exact file, projection and idempotent receipt; production gate stays closed', async () => {
  expect(db.PageFileDatabase).toBeDefined();
  await engine.putPage('example', fields('Before'));
  await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
  await writeFile(join(root, 'example.md'), 'Before'); await mkdir(join(root, 'journal'), { mode: 0o700 });
  const service = new db.PageFileDatabase(engine, { brainId: 'offline-fixture', journalDirectory: join(root, 'journal'),
    // Single sequential caller fixture, NOT a production lock implementation.
    withLockedBinding: async fn => fn() });
  const ops = createPageCheckedOperations({ OperationError, validatePageSlug() {}, resolveFederatedWriteSourceId: () => 'default', resolveRequestedScope() {}, filePages: service });
  const call = (name: string, p: any) => ops.find(o => o.name === name)!.handler(ctx(), p) as Promise<any>;
  await expect(call('get_page_checked', { source_id: 'default', slug: 'example' })).rejects.toThrow('not_enrolled');
  expect(await engine.executeRaw('SELECT * FROM page_file_bindings')).toHaveLength(0);
  await service.enroll('default', 'example');
  const before = await call('get_page_checked', { source_id: 'default', slug: 'example' });
  expect(before.file.raw_markdown).toBe('Before');
  const request = { source_id: 'default', slug: 'example', expected_revision: before.revision, page: fields('After'),
    file_baseline: before.file.baseline, operation_id: randomUUID(), raw_markdown: 'After' };
  const result = await call('put_page_checked', request);
  expect(result.status).toBe('committed'); expect(result.persistence).toBe('file_and_database');
  expect(await readFile(join(root, 'example.md'), 'utf8')).toBe('After');
  expect((await engine.getPage('example'))!.compiled_truth).toBe('After');
  expect((await engine.getChunks('example')).map(c => c.chunk_text)).toEqual(['After']);
  expect(await call('put_page_checked', request)).toEqual(result);
  expect(await engine.executeRaw('SELECT * FROM page_file_operations')).toHaveLength(1);
  await expect(call('put_page_checked', { ...request, raw_markdown: 'Different' })).rejects.toThrow();
  await expect(operationsByName.get_page_checked.handler(ctx(), { source_id: 'default', slug: 'example' })).rejects.toMatchObject({ code: 'ineligible_page' });
  await expect(engine.executeRaw("UPDATE pages SET compiled_truth='Bypass' WHERE slug='example'")).rejects.toThrow('file_page_fenced');
  await expect(engine.putPage('example', fields('Legacy bypass'))).rejects.toThrow('file_page_fenced');
  expect((await call('get_page_checked', { source_id: 'default', slug: 'example' })).page.compiled_truth).toBe('After');
});

test('Markdown handler proves parser projection and installs exact approved bytes preserving metadata and tag overlay', async () => {
  const slug = 'markdown-example';
  const raw = '\uFEFF---\r\n# keep this comment\r\ntype: note\r\ntitle: Business example\r\nslug: markdown-example\r\ntags: [authored]\r\nowner: team-example\r\n---\r\n\r\n# Business example\r\nBefore\r\n\r\n<!-- timeline -->\r\n## History\r\n- Original event\r\n';
  const projection = (text: string) => {
    const p = parseMarkdown(text, slug + '.md');
    return { type: p.type, title: p.title, compiled_truth: p.compiled_truth, timeline: p.timeline, frontmatter: p.frontmatter };
  };
  await engine.putPage(slug, projection(raw));
  await engine.addTag(slug, 'authored'); await engine.addTag(slug, 'enriched-overlay');
  await writeFile(join(root, slug + '.md'), raw);
  await mkdir(join(root, 'journal-markdown'), { mode: 0o700 });
  const service = new db.PageFileDatabase(engine, { brainId: 'offline-fixture', journalDirectory: join(root, 'journal-markdown'), withLockedBinding: async fn => fn() });
  const ops = createPageCheckedOperations({ OperationError, validatePageSlug() {}, resolveFederatedWriteSourceId: () => 'default', resolveRequestedScope() {}, filePages: service });
  const call = (name: string, p: any) => ops.find(o => o.name === name)!.handler(ctx(), p) as Promise<any>;
  await service.enroll('default', slug);
  const baseline = await call('get_page_checked', { source_id: 'default', slug });
  expect(baseline.file.raw_markdown).toBe(raw);
  const after = raw.replace('Before', 'Approved replacement');
  const request = { source_id: 'default', slug, expected_revision: baseline.revision, file_baseline: baseline.file.baseline, operation_id: randomUUID(), page: projection(after), raw_markdown: after };
  for (const bad of [after.replace('Approved replacement', 'Unapproved'), after.replace('Original event', 'Changed event'), after.replace('team-example', 'other-team'), after.replace('[authored]', '[injected]')]) {
    await expect(call('put_page_checked', { ...request, operation_id: randomUUID(), raw_markdown: bad })).rejects.toThrow('unsupported_file_edit');
    expect(await readFile(join(root, slug + '.md'), 'utf8')).toBe(raw);
  }
  const result = await call('put_page_checked', request);
  expect(result.status).toBe('committed');
  expect(await readFile(join(root, slug + '.md'))).toEqual(Buffer.from(after));
  expect((await engine.getPage(slug))!.compiled_truth).toBe(projection(after).compiled_truth);
  expect((await engine.getPage(slug))!.timeline).toBe(projection(raw).timeline);
  expect((await engine.getTags(slug)).sort()).toEqual(['authored', 'enriched-overlay']);
  expect((await call('get_page_checked', { source_id: 'default', slug })).file.raw_markdown).toBe(after);
  expect(await call('put_page_checked', request)).toEqual(result);
});

test('caller mutation after invocation cannot change the approved request', async () => {
  const slug = 'mutable-example';
  const page = { ...fields('Before'), title: 'Mutable Example' };
  await engine.putPage(slug, page); await writeFile(join(root, slug + '.md'), 'Before');
  await mkdir(join(root, 'journal-mutable'), { mode: 0o700 });
  const service = new db.PageFileDatabase(engine, { brainId: 'offline-fixture', journalDirectory: join(root, 'journal-mutable'), withLockedBinding: async fn => fn() });
  await service.enroll('default', slug);
  const baseline = await service.get('default', slug, () => {});
  const request = { expected_revision: baseline.revision, file_baseline: baseline.file.baseline, operation_id: randomUUID(), page: { ...page, compiled_truth: 'Approved' }, raw_markdown: 'Approved' };
  const pending = service.put('default', slug, request, () => {});
  request.page.compiled_truth = 'Not approved'; request.raw_markdown = 'Not approved';
  expect((await pending).status).toBe('committed');
  expect(await readFile(join(root, slug + '.md'), 'utf8')).toBe('Approved');
  expect((await engine.getPage(slug))!.compiled_truth).toBe('Approved');
});

 test('source retarget and pending derived writes fail closed; lifecycle and tags are fenced per page', async () => {
  await expect(engine.executeRaw("UPDATE sources SET local_path='/other-root' WHERE id='default'")).rejects.toThrow('file_page_fenced');
  const [b] = await engine.executeRaw<any>("SELECT * FROM page_file_bindings WHERE slug='example'");
  await engine.executeRaw('UPDATE page_file_bindings SET pending_op_id=$2 WHERE binding_id=$1', [b.binding_id, randomUUID()]);
  for (const sql of ["UPDATE pages SET compiled_truth='stale' WHERE slug='example'", "UPDATE pages SET deleted_at=now() WHERE slug='example'", "UPDATE pages SET slug='moved' WHERE slug='example'", "DELETE FROM pages WHERE slug='example'", "UPDATE content_chunks SET chunk_text='stale' WHERE page_id="+b.page_id]) {
    await expect(engine.executeRaw(sql)).rejects.toThrow('file_page_fenced');
  }
  await expect(engine.addTag('example', 'bypass')).rejects.toThrow('file_page_fenced');
  await engine.putPage('unenrolled', fields('Allowed'));
  expect((await engine.getPage('unenrolled'))!.compiled_truth).toBe('Allowed');
  expect(await engine.executeRaw('SELECT * FROM page_file_write_authorizations')).toHaveLength(0);
 });

test('global root retarget cannot invalidate enrolled bindings', async () => {
  await expect(engine.setConfig('sync.repo_path', '/retarget')).rejects.toThrow('file_page_fenced');
});
test('transaction capability cannot authorize another page, survive rollback, or leak from checked commit', async () => {
  const [b] = await engine.executeRaw<any>("SELECT b.*,p.write_revision FROM page_file_bindings b JOIN pages p ON p.id=b.page_id WHERE b.slug='markdown-example'");
  const op = randomUUID();
  await engine.executeRaw("INSERT INTO page_file_operations(operation_id,binding_id,request_digest,record,state) VALUES($1,$2,'fixture','{}','prepared')", [op,b.binding_id]);
  await engine.executeRaw('UPDATE page_file_bindings SET pending_op_id=$2 WHERE binding_id=$1', [b.binding_id,op]);
  await expect(engine.transaction(async tx => {
    await tx.executeRaw('INSERT INTO page_file_write_authorizations VALUES(txid_current(),$1,$2,$3)', [b.page_id,op,b.write_revision]);
    await tx.executeRaw("UPDATE pages SET compiled_truth='cross-page bypass' WHERE slug='mutable-example'");
  })).rejects.toThrow('file_page_fenced');
  expect(await engine.executeRaw('SELECT * FROM page_file_write_authorizations')).toHaveLength(0);
  await expect(engine.executeRaw("UPDATE pages SET compiled_truth='rollback leaked' WHERE slug='markdown-example'")).rejects.toThrow('file_page_fenced');
  // A caller-supplied session setting is not a capability.
  await engine.executeRaw("SELECT set_config('gbrain.file_operation_id',$1,false)", [op]);
  await expect(engine.executeRaw("UPDATE pages SET compiled_truth='guc bypass' WHERE slug='markdown-example'")).rejects.toThrow('file_page_fenced');
});
