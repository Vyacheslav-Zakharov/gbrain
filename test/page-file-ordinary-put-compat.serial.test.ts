import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { enrollPageFileRuntime } from '../src/core/page-file-runtime.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { pageFileSqlAuthorityQueries } from '../src/core/page-file-sql-authority.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { withEnv } from './helpers/with-env.ts';

// Deliberate compatibility RED, not test.failing: enrolling a valid ordinary
// article must not disable put_page. Real registry/parser/PGLite/files/flock;
// this does NOT establish production PostgreSQL role/RLS acceptance.
let engine: PGLiteEngine, dir: string, root: string;
let config: OperationContext['config'];
const before = '---\ntype: concept\ntitle: Original\ntags: [authored-before]\nowner: original\n---\n\nOriginal article body.\n';
const after = '---\ntype: concept\ntitle: Revised\ntags: [authored-after]\nowner: revised\ndate: "2026-01-02"\n---\n\nRevised article body for ordinary put compatibility.\n';
const context = (): OperationContext => ({ engine, config, remote: true, sourceId: 'default', dryRun: false,
  auth: { allowedSources: ['default'], writeSources: ['default'] } as OperationContext['auth'],
  logger: { info() {}, warn() {}, error() {} } });
const offline = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined, VOYAGE_API_KEY: undefined, ZEROENTROPY_API_KEY: undefined }, fn);
const call = (name: string, slug: string, params: Record<string, unknown> = {}) =>
  operationsByName[name].handler(context(), { source_id: 'default', slug, ...params }) as Promise<any>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ordinary-put-compat-'));
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

test('adapter admission requires add-only tags and exact backing-sequence USAGE', () => {
  const probes = pageFileSqlAuthorityQueries({ database: 'offline', role: 'adapter',
    roles: { ordinary: 'ordinary', adapter: 'adapter', enrollment: 'enrollment' }, catalogPins: {} });
  const tags = probes.find(p => p.id === 'table:tags')!.sql;
  for (const privilege of ['SELECT', 'INSERT'])
    expect(tags).toContain(`has_table_privilege($1,c.oid,'${privilege}')=true`);
  for (const privilege of ['UPDATE', 'DELETE'])
    expect(tags).toContain(`has_table_privilege($1,c.oid,'${privilege}')=false`);
  const sequence = probes.find(p => p.id === 'sequence:tags')!.sql;
  expect(sequence).toContain("pg_get_serial_sequence('public.tags','id')");
  expect(sequence).toContain("has_sequence_privilege($1,c.oid,'USAGE')=true");
  for (const privilege of ['SELECT', 'UPDATE'])
    expect(sequence).toContain(`has_sequence_privilege($1,c.oid,'${privilege}')=false`);
  for (const privilege of ['USAGE', 'SELECT', 'UPDATE'])
    expect(sequence).toContain(`NOT has_sequence_privilege($1,c.oid,'${privilege} WITH GRANT OPTION')`);
});

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
