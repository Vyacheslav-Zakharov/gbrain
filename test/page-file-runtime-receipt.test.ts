import { beforeAll, afterAll, test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { PageFileJournal, rawDigest } from '../src/core/page-file-journal.ts';
import { pageFileSyncHost } from '../src/core/page-file-sync.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let dir: string;
let root: string;
let config: any;
const call = (name: string, p: any) => operationsByName[name].handler({
  engine, config, remote: false, sourceId: 'default', dryRun: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as OperationContext, p) as Promise<any>;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-receipt-'));
  root = join(dir, 'source');
  await mkdir(root); await mkdir(join(dir, 'journal'));
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  config = { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local',
    brainId: 'receipt-test', lockDirectory: join(dir, 'locks'), journalDirectory: join(dir, 'journal') } };
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
}, 30000);
afterAll(async () => { await engine?.disconnect(); if (dir) await rm(dir, { recursive: true, force: true }); });

async function request(slug: string, prepared = false, installed = false) {
  await engine.putPage(slug, { type: 'concept', title: slug[0].toUpperCase() + slug.slice(1),
    compiled_truth: 'Before', timeline: '', frontmatter: {} });
  await writeFile(join(root, slug + '.md'), 'Before');
  await new PageFileDatabase(engine, { brainId: 'receipt-test', journalDirectory: join(dir, 'journal'),
    ...pageFileSyncHost({ root, paths: [slug + '.md'], lockDirectory: join(dir, 'locks'), topology: 'single-host-local' }),
  }).enroll('default', slug);
  const snap = await call('get_page_checked', { source_id: 'default', slug });
  const p = { source_id: 'default', slug, expected_revision: snap.revision, file_baseline: snap.file.baseline,
    page: { ...snap.page, compiled_truth: 'After' }, raw_markdown: 'After', operation_id: randomUUID() };
  if (prepared) {
    const record = { operationId: p.operation_id,
      requestDigest: rawDigest(Buffer.from(JSON.stringify(['default', slug, p.expected_revision, p.file_baseline, p.page, p.raw_markdown]))),
      target: join(root, slug + '.md'), bindingId: p.file_baseline.binding_id, expectedRevision: p.expected_revision,
      beforeDigest: p.file_baseline.raw_sha256, afterDigest: rawDigest(Buffer.from('After')) };
    await new PageFileJournal(join(dir, 'journal')).prepare(record, Buffer.from('Before'), Buffer.from('After'));
    await engine.transaction(async tx => {
      await tx.executeRaw("INSERT INTO page_file_operations(operation_id,binding_id,request_digest,record,state) VALUES($1,$2,$3,$4::text::jsonb,'prepared')",
        [p.operation_id, record.bindingId, record.requestDigest, JSON.stringify(record)]);
      await tx.executeRaw('UPDATE page_file_bindings SET pending_op_id=$2 WHERE binding_id=$1', [record.bindingId, p.operation_id]);
    });
    if (installed) await writeFile(record.target, 'After');
  }
  return p;
}
async function committed(p: any, result: any) {
  const [row] = await engine.executeRaw<any>('SELECT write_revision, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', ['default', p.slug]);
  expect(result).toEqual({ status: 'committed', revision: row.write_revision,
    operation_id: p.operation_id, persistence: 'file_and_database', derived_state: 'chunks_current_embeddings_pending' });
  expect(result.revision).not.toBe(p.expected_revision);
  expect(row!.compiled_truth).toBe('After');
  expect(await readFile(join(root, p.slug + '.md'), 'utf8')).toBe('After');
  const chunks = await engine.executeRaw<any>(`SELECT c.chunk_text, c.embedding IS NULL AS pending
    FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY c.chunk_index`, ['default', p.slug]);
  expect(chunks).toEqual([{ chunk_text: 'After', pending: true }]);
}

test('registered file commit and exact replay disclose current chunks and pending embeddings', async () => {
  const p = await request('receipt');
  const result = await call('put_page_checked', p);
  await committed(p, result);
  const chunks = await engine.executeRaw<any>('SELECT id FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', ['default', p.slug]);
  expect(await call('put_page_checked', p)).toEqual(result);
  expect(await engine.executeRaw<any>('SELECT id FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', ['default', p.slug])).toEqual(chunks);
});

test('pending retry, abort, aborted replay and rejected retry never claim committed chunks', async () => {
  const p = await request('pending', true);
  expect(await call('put_page_checked', p)).toEqual({ status: 'pending_recovery', operation_id: p.operation_id, persistence: 'file_and_database' });
  const result = { status: 'aborted', operation_id: p.operation_id, persistence: 'file_and_database' };
  expect(await call('recover_page_file_checked', { ...p, action: 'abort' })).toEqual(result);
  expect(await call('recover_page_file_checked', { ...p, action: 'abort' })).toEqual(result);
  expect(await call('put_page_checked', p)).toEqual({ status: 'conflict', operation_id: p.operation_id, persistence: 'file_and_database' });
  expect((await engine.getPage(p.slug))!.compiled_truth).toBe('Before');
});

for (const installed of [false, true]) test(`exact recovery and replay disclose committed chunks (installed=${installed})`, async () => {
  const p = await request(installed ? 'installed' : 'resume', true, installed);
  const intent = { ...p, action: 'resume-exact' };
  const result = await call('recover_page_file_checked', intent);
  await committed(p, result);
  expect(await call('recover_page_file_checked', intent)).toEqual(result);
});

test('recovery transaction failure stays pending without a committed-chunks claim', async () => {
  const p = await request('failed', true);
  // Real database failure after file installation, not a mocked receipt.
  await engine.executeRaw(`CREATE FUNCTION receipt_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.slug = 'failed' THEN RAISE EXCEPTION 'receipt injected failure'; END IF; RETURN NEW; END $$`);
  await engine.executeRaw('CREATE TRIGGER receipt_fail_update BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION receipt_fail_update()');
  try {
    expect(await call('recover_page_file_checked', { ...p, action: 'resume-exact' })).toEqual({
      status: 'pending_recovery', operation_id: p.operation_id, persistence: 'file_and_database',
    });
    expect((await engine.getPage(p.slug))!.compiled_truth).toBe('Before');
    expect(await readFile(join(root, p.slug + '.md'), 'utf8')).toBe('After');
  } finally {
    await engine.executeRaw('DROP TRIGGER receipt_fail_update ON pages');
    await engine.executeRaw('DROP FUNCTION receipt_fail_update()');
  }
  await committed(p, await call('recover_page_file_checked', { ...p, action: 'resume-exact' }));
});

test('unexpected bytes recovery refusal does not disclose committed chunk readiness', async () => {
  const p = await request('conflict', true);
  await writeFile(join(root, p.slug + '.md'), 'Unexpected');
  for (const action of ['resume-exact', 'abort']) {
    expect(await call('recover_page_file_checked', { ...p, action })).toEqual({ status: 'conflict', operation_id: p.operation_id, persistence: 'file_and_database' });
  }
  expect((await engine.getPage(p.slug))!.compiled_truth).toBe('Before');
  expect(await readFile(join(root, p.slug + '.md'), 'utf8')).toBe('Unexpected');
});
