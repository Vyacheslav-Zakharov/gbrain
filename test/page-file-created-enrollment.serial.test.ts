import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { enrollPageFileRuntime } from '../src/core/page-file-runtime.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine, dir: string, root: string;
let ctx: OperationContext;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'created-enrollment-'));
  root = join(dir, 'source'); await mkdir(root); await mkdir(join(dir, 'journal'));
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  ctx = { engine, remote: true, dryRun: false, sourceId: 'default',
    config: { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local',
      brainId: 'created-enrollment', lockDirectory: join(dir, 'locks'), journalDirectory: join(dir, 'journal') } },
    auth: { allowedSources: ['default'], writeSources: ['default'] } as OperationContext['auth'],
    logger: { info() {}, warn() {}, error() {} } };
  resetGateway();
}, 30000);
afterAll(async () => { await engine?.disconnect(); resetGateway(); if (dir) await rm(dir, { recursive: true, force: true }); });
const call = (name: string, slug: string, params: Record<string, unknown> = {}) =>
  operationsByName[name].handler(ctx, { source_id: 'default', slug, ...params }) as Promise<any>;
const offline = <T>(fn: () => Promise<T>) => withEnv({
  GBRAIN_HOME: dir, DATABASE_URL: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
  GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, VOYAGE_API_KEY: undefined, ZEROENTROPY_API_KEY: undefined,
}, fn);

test('ordinary-created physical markdown enrolls without changing the indexed projection', () => offline(async () => {
  const content = '---\ntitle: Original\ntype: concept\ntags: [authored-before]\nowner: original\n---\n\nOriginal source-wide article.\n';
  const result = await call('put_page', 'connected', { content });
  expect(result.write_through.written).toBe(true);
  const row = (await engine.getPage('connected', { sourceId: 'default' }))!;
  const raw = await readFile(join(root, 'connected.md'), 'utf8');
  const parsed = parseMarkdown(raw, 'connected.md');
  expect(parsed.frontmatter).toEqual(row.frontmatter);
  expect(row.frontmatter).toMatchObject({ owner: 'original', ingested_via: 'mcp:put_page', source_kind: 'mcp:put_page' });
  expect(typeof row.frontmatter.ingested_at).toBe('string');
  expect(await engine.executeRaw('SELECT * FROM page_file_bindings')).toEqual([]);
  const enrollment = await enrollPageFileRuntime({ ...ctx, remote: false }, 'default', 'connected');
  expect(enrollment.status).toBe('enrolled');
  expect(await engine.getPage('connected', { sourceId: 'default' })).toEqual(row);
  expect(await readFile(join(root, 'connected.md'), 'utf8')).toBe(raw);
  expect((await call('get_page_checked', 'connected')).persistence).toBe('file_and_database');
}), 30000);

test('ordinary updates and hash-equal skips preserve typed metadata and enrollment eligibility', () => offline(async () => {
  const slug = 'sibling';
  const initial = '---\ntitle: Sibling\ntype: concept\nowner: original\n---\n\nInitial body.\n';
  await call('put_page', slug, { content: initial });
  await engine.addTag(slug, 'enriched', { sourceId: 'default' });
  const content = '---\ntitle: Revised\ntype: concept\ntags: [authored]\nowner: revised\ndate: "2026-01-02"\nbare_date: 2026-01-03\nnested: { count: 7, enabled: true, empty: null }\ningested_at: forged\ningested_via: forged\nsource_kind: forged\n---\n\nRevised body.\n';
  expect((await call('put_page', slug, { content })).write_through.written).toBe(true);
  const row = (await engine.getPage(slug, { sourceId: 'default' }))!;
  const raw = await readFile(join(root, slug + '.md'), 'utf8');
  expect(parseMarkdown(raw, slug + '.md').frontmatter).toEqual(row.frontmatter);
  expect(row.frontmatter).toMatchObject({ date: '2026-01-02', bare_date: '2026-01-03T00:00:00.000Z',
    nested: { count: 7, enabled: true, empty: null }, ingested_via: 'mcp:put_page', source_kind: 'mcp:put_page' });
  expect(row.frontmatter.ingested_at).not.toBe('forged');
  expect((await engine.getTags(slug, { sourceId: 'default' })).sort()).toEqual(['authored', 'enriched']);
  const repeated = await call('put_page', slug, { content });
  expect(repeated.chunks).toBe(0);
  expect(repeated.write_through.written).toBe(true);
  expect(await engine.getPage(slug, { sourceId: 'default' })).toEqual(row);
  expect(await readFile(join(root, slug + '.md'), 'utf8')).toBe(raw);
  expect((await enrollPageFileRuntime({ ...ctx, remote: false }, 'default', slug)).status).toBe('enrolled');
  expect((await call('get_page_checked', slug)).persistence).toBe('file_and_database');
}), 30000);

test('a real frontmatter mismatch still refuses enrollment without mutating either side', () => offline(async () => {
  const slug = 'divergent';
  await call('put_page', slug, { content: '---\ntitle: Divergent\ntype: concept\nowner: original\n---\n\nBody.\n' });
  const row = (await engine.getPage(slug, { sourceId: 'default' }))!;
  const path = join(root, slug + '.md');
  const divergent = (await readFile(path, 'utf8')).replace('owner: original', 'owner: different');
  await writeFile(path, divergent);
  await expect(enrollPageFileRuntime({ ...ctx, remote: false }, 'default', slug)).rejects.toThrow('sync_required');
  expect(await engine.executeRaw('SELECT * FROM page_file_bindings WHERE slug=$1', [slug])).toEqual([]);
  expect(await engine.getPage(slug, { sourceId: 'default' })).toEqual(row);
  expect(await readFile(path, 'utf8')).toBe(divergent);
}), 30000);
