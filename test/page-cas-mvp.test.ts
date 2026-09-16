import { beforeAll, afterAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const ctx = () => ({ engine, remote: true, sourceId: 'default', dryRun: false,
  config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {}, debug() {} },
} as OperationContext);
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: { status: 'approved' } });
const call = (name: string, params: Record<string, unknown>, context = ctx()) => {
  expect(operationsByName[name]).toBeDefined();
  return operationsByName[name].handler(context, params) as Promise<any>;
};

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

test('meaningful page updates advance revisions through metadata ABA; no-ops preserve them', async () => {
  await engine.putPage('cas/revision', { type: 'note', title: 'Example', compiled_truth: 'Original' });
  const read = async () => (await engine.executeRaw<{ write_revision?: string }>(
    `SELECT * FROM pages WHERE source_id = 'default' AND slug = 'cas/revision'`,
  ))[0].write_revision;
  const a = await read();
  expect(a).toMatch(/^[0-9a-f-]{36}$/);
  await engine.executeRaw(`UPDATE pages SET source_uri = 'example:changed' WHERE slug = 'cas/revision'`);
  const b = await read();
  await engine.executeRaw(`UPDATE pages SET source_uri = NULL WHERE slug = 'cas/revision'`);
  const c = await read();
  await engine.executeRaw(`UPDATE pages SET title = title WHERE slug = 'cas/revision'`);
  expect(new Set([a, b, c]).size).toBe(3);
  expect(await read()).toBe(c);
});

test('retrieval telemetry does not invalidate a checked revision', async () => {
  const slug = 'cas/telemetry';
  await engine.putPage(slug, page('Original'));
  const before = await call('get_page_checked', { slug, source_id: 'default' });
  await engine.executeRaw(`UPDATE pages SET last_retrieved_at = clock_timestamp() WHERE slug = $1`, [slug]);
  expect((await call('get_page_checked', { slug, source_id: 'default' })).revision).toBe(before.revision);
  await engine.executeRaw(`UPDATE pages SET last_retrieved_at = last_retrieved_at WHERE slug = $1`, [slug]);
  expect((await call('get_page_checked', { slug, source_id: 'default' })).revision).toBe(before.revision);
  await call('put_page_checked', { slug, source_id: 'default', expected_revision: before.revision, page: page('After read') });
});

test('legacy tag add/remove ABA invalidates old tokens', async () => {
  const slug = 'cas/tags';
  await engine.putPage(slug, page('Original'));
  const before = await call('get_page_checked', { slug, source_id: 'default' });
  await engine.addTag(slug, 'example');
  const added = await call('get_page_checked', { slug, source_id: 'default' });
  expect(added.revision).not.toBe(before.revision);
  await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: before.revision, page: page('Rejected') }))
    .rejects.toMatchObject({ code: 'precondition_failed' });
  await engine.removeTag(slug, 'example');
  const removed = await call('get_page_checked', { slug, source_id: 'default' });
  expect(new Set([before.revision, added.revision, removed.revision]).size).toBe(3);
  await expect(call('put_page_checked', { slug, source_id: 'default', expected_revision: added.revision, page: page('Rejected') }))
    .rejects.toMatchObject({ code: 'precondition_failed' });
  expect(removed.page.compiled_truth).toBe('Original');
});

test('direct SQL tag moves invalidate both parents and rollback restores revisions', async () => {
  const slugs = ['cas/tag-left', 'cas/tag-right'];
  for (const slug of slugs) await engine.putPage(slug, page('Original'));
  const rows = await engine.executeRaw<{ id: number; slug: string }>(
    `SELECT id, slug FROM pages WHERE slug IN ($1, $2) ORDER BY slug`, slugs);
  await engine.addTag(slugs[0], 'moving');
  const read = () => engine.executeRaw<{ write_revision: string }>(
    `SELECT write_revision FROM pages WHERE slug IN ($1, $2) ORDER BY slug`, slugs);
  const before = await read();
  await engine.executeRaw(`UPDATE tags SET page_id = $1 WHERE page_id = $2`, [rows[1].id, rows[0].id]);
  const moved = await read();
  expect(moved[0].write_revision).not.toBe(before[0].write_revision);
  expect(moved[1].write_revision).not.toBe(before[1].write_revision);
  await engine.executeRaw('BEGIN');
  try {
    await engine.executeRaw(`UPDATE tags SET tag = 'temporary' WHERE page_id = $1`, [rows[1].id]);
    expect((await read())[1].write_revision).not.toBe(moved[1].write_revision);
  } finally { await engine.executeRaw('ROLLBACK'); }
  expect(await read()).toEqual(moved);
});

test('checked update cannot create missing pages or resurrect tombstones', async () => {
  const slug = 'cas/lifecycle';
  await engine.putPage(slug, page('Original'));
  const before = await call('get_page_checked', { slug, source_id: 'default' });
  await engine.softDeletePage(slug, { sourceId: 'default' });
  for (const target of [slug, 'cas/not-present']) {
    await expect(call('put_page_checked', { slug: target, source_id: 'default', expected_revision: before.revision, page: page('Rejected') }))
      .rejects.toMatchObject({ code: 'precondition_failed' });
  }
});

test('coherent checked read and concurrent stale updates preserve exactly one winner', async () => {
  const slug = 'cas/winner';
  await engine.putPage(slug, page('Original'));
  const before = await call('get_page_checked', { slug, source_id: 'default' });
  expect(before.page.compiled_truth).toBe('Original');
  expect(before.revision).toMatch(/^[0-9a-f-]{36}$/);
  const results = await Promise.allSettled(['Winner A', 'Winner B'].map(body => call('put_page_checked', {
    slug, source_id: 'default', expected_revision: before.revision, page: page(body),
  })));
  const successes = results.filter(r => r.status === 'fulfilled');
  expect(successes).toHaveLength(1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason.code).toBe('precondition_failed');
  const winner = (successes[0] as PromiseFulfilledResult<any>).value;
  expect(winner.persistence).toBe('database_only');
  const after = await call('get_page_checked', { slug, source_id: 'default' });
  expect(after).toMatchObject({ page: winner.page, revision: winner.revision });
  expect(after.revision).not.toBe(before.revision);
});


test('update-only rejects create requests without creating a page', async () => {
  const args = { slug: 'cas/create', source_id: 'default', if_absent: true, page: page('Created') };
  await expect(call('put_page_checked', args)).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(call('get_page_checked', { slug: args.slug, source_id: 'default' }))
    .rejects.toMatchObject({ code: 'page_not_found' });
  expect(operationsByName.put_page_checked.params.expected_revision.required).toBe(true);
  expect(operationsByName.put_page_checked.params.if_absent).toBeUndefined();
});

test('missing, malformed and contradictory preconditions fail before any mutation', async () => {
  const slug = 'cas/invalid';
  await engine.putPage(slug, page('Original'));
  const before = await call('get_page_checked', { slug, source_id: 'default' });
  for (const condition of [{}, { expected_revision: '' }, { expected_revision: '1' },
    { expected_revision: 1 }, { expected_revision: null }, { if_absent: false },
    { if_absent: 'true' }, { expected_revision: before.revision, if_absent: true },
    { expected_revision: ` ${before.revision}` }]) {
    await expect(call('put_page_checked', { slug, source_id: 'default', page: page('Rejected'), ...condition }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  }
  expect(await call('get_page_checked', { slug, source_id: 'default' })).toEqual(before);
});
