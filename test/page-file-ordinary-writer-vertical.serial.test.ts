import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { importFromContent, prepareContentImport } from '../src/core/import-file.ts';
import { enrollPageFileRuntime, resolvePageFileRuntime } from '../src/core/page-file-runtime.ts';
import { PageFileJournal } from '../src/core/page-file-journal.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { withEnv } from './helpers/with-env.ts';

// Deliberate compatibility RED, not test.failing: enrolling a valid ordinary
// article must not disable put_page. Real registry/parser/PGLite/files/flock;
// this does NOT establish production PostgreSQL role/RLS acceptance.
let engine: PGLiteEngine, dir: string, root: string;
let config: OperationContext['config'];
const before = '---\ntype: concept\ntitle: Original\ntags: [authored-before]\nowner: original\n---\n\nOriginal article body.\n';
const after = '---\ntype: concept\ntitle: Revised\ntags: [authored-after, authored-before]\nowner: revised\ndate: "2026-01-02"\n---\n\nRevised article body for ordinary put compatibility.\n\n```ts\nexport const answer = 42;\n```\n';
const context = (): OperationContext => ({ engine, config, remote: true, sourceId: 'default', dryRun: false,
  auth: { allowedSources: ['default'], writeSources: ['default'] } as OperationContext['auth'],
  logger: { info() {}, warn() {}, error() {} } });
const offline = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined, VOYAGE_API_KEY: undefined, ZEROENTROPY_API_KEY: undefined }, fn);
const call = (name: string, slug: string, params: Record<string, unknown> = {}) =>
  operationsByName[name].handler(context(), { source_id: 'default', slug, ...params }) as Promise<any>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ordinary-writer-vertical-'));
  root = join(dir, 'source');
  await mkdir(root); await mkdir(join(dir, 'journal'));
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  config = { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local',
    brainId: 'ordinary-put-compat', lockDirectory: join(dir, 'locks'), journalDirectory: join(dir, 'journal') } };
  resetGateway();
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  await offline(async () => {
    for (const slug of ['ordinary-control', 'enrolled-article']) {
      await importFromContent(engine, slug, before, { noEmbed: true, remote: true, sourceId: 'default' });
      await engine.addTag(slug, 'enriched', { sourceId: 'default' });
      await writeFile(join(root, `${slug}.md`), before);
    }
    await enrollPageFileRuntime({ ...context(), remote: false }, 'default', 'enrolled-article');
  });
}, 30000);
afterAll(async () => {
  await engine?.disconnect(); resetGateway();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function expectOrdinaryResult(slug: string, result: any) {
  expect(result.status).toBe('created_or_updated');
  expect(result.chunks).toBeGreaterThan(0);
  expect(result.write_through.written).toBe(true);
  expect(result.auto_links).toEqual({ skipped: 'remote' });
  expect(result.auto_timeline).toEqual({ skipped: 'remote' });
  const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
  expect(page.title).toBe('Revised');
  expect(page.frontmatter.owner).toBe('revised');
  expect(page.compiled_truth).toContain('Revised article body');
  expect(page.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect((await engine.getTags(slug, { sourceId: 'default' })).sort())
    .toEqual(['authored-after', 'authored-before', 'enriched']);
  const raw = await readFile(join(root, `${slug}.md`), 'utf8');
  const parsed = parseMarkdown(raw, `${slug}.md`);
  expect(parsed.title).toBe(page.title);
  expect(parsed.compiled_truth).toBe(page.compiled_truth);
  expect(parsed.tags.sort()).toEqual(['authored-after', 'authored-before', 'enriched']);
  expect(raw).toContain('mcp:put_page');
  const [metadata] = await engine.executeRaw<any>('SELECT effective_date_source, source_kind, ingested_via FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug]);
  expect(metadata.source_kind).toBe('mcp:put_page');
  expect(metadata.ingested_via).toBe('mcp:put_page');
  expect(metadata.effective_date_source).not.toBeNull();
}

test('unenrolled registered ordinary put defines metadata/add-only-tags/write-through compatibility', () => offline(async () => {
  await expectOrdinaryResult('ordinary-control', await call('put_page', 'ordinary-control', { content: after }));
}));

test('enrolled registered ordinary put retains the ordinary contract and invalidates a checked baseline', () => offline(async () => {
  const slug = 'enrolled-article';
  const snapshot = await call('get_page_checked', slug);
  expect(snapshot.persistence).toBe('file_and_database');
  expect(snapshot.file.raw_markdown).toBe(before);
  const oldPage = await engine.getPage(slug, { sourceId: 'default' });
  const oldTags = await engine.getTags(slug, { sourceId: 'default' });
  const oldChunks = await engine.getChunks(slug, { sourceId: 'default' });
  const oldVersions = await engine.getVersions(slug, { sourceId: 'default' });
  let result: any;
  try {
    result = await call('put_page', slug, { content: after });
  } catch (error) {
    // Today's refusal must be non-mutating; rethrow to keep the compatibility
    // requirement RED rather than quietly accepting unsupported_writer.
    expect(await engine.getPage(slug, { sourceId: 'default' })).toEqual(oldPage);
    expect(await engine.getTags(slug, { sourceId: 'default' })).toEqual(oldTags);
    expect(await engine.getChunks(slug, { sourceId: 'default' })).toEqual(oldChunks);
    expect(await engine.getVersions(slug, { sourceId: 'default' })).toEqual(oldVersions);
    expect(await readFile(join(root, `${slug}.md`), 'utf8')).toBe(before);
    expect(await readdir(join(dir, 'journal'))).toEqual([]);
    expect(await call('get_page_checked', slug)).toEqual(snapshot);
    throw error;
  }
  await expectOrdinaryResult(slug, result);
  const current = await call('get_page_checked', slug);
  expect(current.revision).not.toBe(snapshot.revision);
  expect(current.file.baseline.generation).not.toBe(snapshot.file.baseline.generation);
  await expect(call('put_page_checked', slug, { expected_revision: snapshot.revision, page: current.page,
    operation_id: randomUUID(), file_baseline: snapshot.file.baseline, raw_markdown: current.file.raw_markdown })).rejects.toThrow('precondition_failed');
  expect(await call('get_page_checked', slug)).toEqual(current);
}));

test('same-content enrolled ordinary put keeps the ordinary skipped receipt', () => offline(async () => {
  const snapshot = await call('get_page_checked', 'enrolled-article');
  const result = await call('put_page', 'enrolled-article', { content: after });
  expect(result.status).toBe('skipped');
  expect(result.chunks).toBe(0);
  expect(result.write_through.written).toBe(true);
  expect(await call('get_page_checked', 'enrolled-article')).toEqual(snapshot);
}));

test('ordinary intent carries exact prepared recovery data after a post-rename transaction failure', () => offline(async () => {
  const slug = 'recover-ordinary';
  await importFromContent(engine, slug, before, { noEmbed: true, remote: true, sourceId: 'default' });
  await engine.addTag(slug, 'enriched', { sourceId: 'default' });
  await writeFile(join(root, `${slug}.md`), before);
  await enrollPageFileRuntime({ ...context(), remote: false }, 'default', slug);
  const baseline = await call('get_page_checked', slug);
  const runtime = (await resolvePageFileRuntime(context(), 'default', slug))!;
  const prepared = await prepareContentImport(engine, slug, after, {
    noEmbed: true, remote: true, sourceId: 'default', source_kind: 'mcp:put_page', ingested_via: 'mcp:put_page',
  });
  if (!('pageInput' in prepared)) throw new Error('expected prepared ordinary import');
  // Deterministic provider output at the data-only preparation seam; the real
  // runtime, journal, transaction and pgvector storage are not mocked.
  const vector = Float32Array.from({ length: 1536 }, (_, i) => (i % 17 - 8) / 32);
  expect(prepared.chunks.length).toBeGreaterThan(0);
  prepared.noEmbed = false;
  prepared.embeddingSignature = 'offline-float32-fixture';
  for (const chunk of prepared.chunks) chunk.embedding = new Float32Array(vector);
  const createVersion = engine.createVersion;
  engine.createVersion = async () => { throw new Error('injected transaction failure'); };
  try { await expect(runtime.pages.putOrdinary('default', slug, prepared, baseline, () => {})).rejects.toThrow('pending_recovery'); }
  finally { engine.createVersion = createVersion; }
  const [op] = await engine.executeRaw<any>('SELECT o.* FROM page_file_operations o JOIN page_file_bindings b USING(binding_id) WHERE b.source_id=$1 AND b.slug=$2', ['default', slug]);
  expect(op.state).toBe('prepared');
  const evidence = await new PageFileJournal(join(dir, 'journal')).read(op.operation_id);
  expect(typeof (evidence.record as any).ordinaryPayload).toBe('string');
  const parsed = parseMarkdown(evidence.after.toString('utf8'), slug + '.md');
  const page = { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter };
  expect((await readFile(join(root, `${slug}.md`))).equals(evidence.after)).toBe(true);
  expect(evidence.after.equals(evidence.before)).toBe(false);
  const request = { action: 'resume-exact', operation_id: op.operation_id,
    expected_revision: baseline.revision, file_baseline: baseline.file.baseline, page, raw_markdown: evidence.after.toString('utf8') };
  // A disk-only payload edit must not become approved prepared data: the DB
  // operation record and request digest independently bind the exact payload.
  const recordPath = join(dir, 'journal', op.operation_id, 'record.json');
  const originalRecord = await readFile(recordPath, 'utf8');
  const alteredRecord = JSON.parse(originalRecord);
  const alteredPayload = JSON.parse(alteredRecord.ordinaryPayload);
  alteredPayload.pageInput.title = 'Unapproved title';
  alteredRecord.ordinaryPayload = JSON.stringify(alteredPayload);
  const pendingPage = await engine.getPage(slug, { sourceId: 'default' });
  const pendingChunks = await engine.getChunks(slug, { sourceId: 'default' });
  const pendingVersions = await engine.getVersions(slug, { sourceId: 'default' });
  try {
    await writeFile(recordPath, JSON.stringify(alteredRecord));
    await expect(runtime.pages.recover('default', slug, request, () => {})).rejects.toThrow('operation_id_reused');
    expect(await engine.getPage(slug, { sourceId: 'default' })).toEqual(pendingPage);
    expect(await engine.getChunks(slug, { sourceId: 'default' })).toEqual(pendingChunks);
    expect(await engine.getVersions(slug, { sourceId: 'default' })).toEqual(pendingVersions);
    expect((await readFile(join(root, `${slug}.md`))).equals(evidence.after)).toBe(true);
  } finally { await writeFile(recordPath, originalRecord); }
  const durableState = async () => ({
    page: await engine.getPage(slug, { sourceId: 'default' }),
    tags: await engine.getTags(slug, { sourceId: 'default' }),
    chunks: await engine.executeRaw('SELECT c.* FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY chunk_index', ['default', slug]),
    versions: await engine.getVersions(slug, { sourceId: 'default' }),
    operations: await engine.executeRaw('SELECT * FROM page_file_operations WHERE operation_id=$1', [op.operation_id]),
    binding: await engine.executeRaw('SELECT * FROM page_file_bindings WHERE source_id=$1 AND slug=$2', ['default', slug]),
    authorizations: await engine.executeRaw('SELECT * FROM page_file_write_authorizations'),
    file: await readFile(join(root, `${slug}.md`), 'utf8'),
    journal: await Promise.all((await readdir(join(dir, 'journal', op.operation_id))).sort().map(async name =>
      [name, (await readFile(join(dir, 'journal', op.operation_id, name))).toString('base64')])),
  });
  // Reject malformed vectors without touching even the malformed journal bytes.
  // The original DB digest/record are never rewritten to make recovery pass.
  for (const malformed of [{}, { 1: 0.25 }, { 0: '0.25' }, { 0: null },
    { 0: 0.25, length: 1 }, { 0: 0.1 }, [0.25], { 0: 1e100 }]) {
    const badRecord = JSON.parse(originalRecord);
    const badPayload = JSON.parse(badRecord.ordinaryPayload);
    badPayload.chunks[0].embedding = malformed;
    badRecord.ordinaryPayload = JSON.stringify(badPayload);
    try {
      await writeFile(recordPath, JSON.stringify(badRecord));
      const unchanged = await durableState();
      await expect(runtime.pages.recover('default', slug, request, () => {})).rejects.toThrow('invalid_ordinary_payload');
      expect(await durableState()).toEqual(unchanged);
    } finally { await writeFile(recordPath, originalRecord); }
  }
  const result = await runtime.pages.recover('default', slug, request, () => {});
  expect(result.status).toBe('committed');
  const committedChunks = await engine.getChunks(slug, { sourceId: 'default' });
  expect(committedChunks.length).toBe(prepared.chunks.length);
  for (const chunk of committedChunks) {
    const [stored] = await engine.executeRaw<{ embedding: string }>(
      'SELECT c.embedding::text AS embedding FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2 AND c.chunk_index=$3',
      ['default', slug, chunk.chunk_index]);
    expect(JSON.parse(stored.embedding)).toEqual(Array.from(vector));
    expect(chunk.chunk_text).toBe(prepared.chunks[chunk.chunk_index].chunk_text);
  }
  const [committedOp] = await engine.executeRaw<any>('SELECT * FROM page_file_operations WHERE operation_id=$1', [op.operation_id]);
  expect(committedOp.request_digest).toBe(op.request_digest);
  expect(committedOp.record).toEqual(op.record);
  expect(await readFile(recordPath, 'utf8')).toBe(originalRecord);
  const committedVersions = await engine.getVersions(slug, { sourceId: 'default' });
  const committedSnapshot = await call('get_page_checked', slug);
  const committedState = await durableState();
  expect(await runtime.pages.recover('default', slug, request, () => {})).toEqual(result);
  expect(await durableState()).toEqual(committedState);
  expect(await engine.getVersions(slug, { sourceId: 'default' })).toEqual(committedVersions);
  expect(await call('get_page_checked', slug)).toEqual(committedSnapshot);
  await expectOrdinaryResult(slug, { status: 'created_or_updated', chunks: (await engine.getChunks(slug, { sourceId: 'default' })).length,
    write_through: { written: true }, auto_links: { skipped: 'remote' }, auto_timeline: { skipped: 'remote' } });
  expect((await call('get_page_checked', slug)).revision).not.toBe(baseline.revision);
  expect(await engine.executeRaw('SELECT * FROM page_file_write_authorizations')).toEqual([]);
}));
