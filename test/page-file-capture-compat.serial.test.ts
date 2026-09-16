import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCapture } from '../src/commands/capture.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { slugifyCodePath } from '../src/core/sync.ts';
import { extractCodeRefs } from '../src/core/link-extraction.ts';
import { enrollPageFileRuntime } from '../src/core/page-file-runtime.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

// Actual capture caller/parser/registry + real offline PGLite runtime/journal.
// Capture uses real operations/authority; the stale-CAS test alters only the
// submitted baseline, then delegates to the real database CAS.
// This is not src/cli.ts startup or real PostgreSQL principal acceptance.
let engine: PGLiteEngine, home: string, root: string;
let config: OperationContext['config'];
const source = 'capture-fixture';
const slug = 'concepts/captured';
const original = '---\ntype: concept\ntitle: Original\ntags: [original]\n---\n\nOriginal body.\n';
const revised = '---\ntype: concept\ntitle: Revised\ntags: [revised]\nowner: fixture\n---\n\nRevised publication with [[concepts/target]]. See src/core/sync.ts:42 and src/core/not-imported.ts:7.\n';
const ctx = (): OperationContext => ({ engine, config, remote: false, sourceId: source, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });
const call = (name: string, params: Record<string, unknown> = {}) =>
  operationsByName[name].handler(ctx(), { slug, source_id: source, ...params }) as Promise<any>;
const offline = <T>(fn: () => Promise<T>) => withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined,
  GBRAIN_SOURCE: undefined, GBRAIN_SCHEMA_PACK: undefined, OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined,
  VOYAGE_API_KEY: undefined, ZEROENTROPY_API_KEY: undefined }, fn);
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'capture-compat-')); root = join(home, 'source');
  await mkdir(join(root, 'concepts'), { recursive: true });
  await mkdir(join(home, 'journal')); await mkdir(join(home, '.gbrain'));
  config = { engine: 'pglite', page_file_runtime: { mode: 'isolated-integration', topology: 'single-host-local',
    brainId: 'capture-offline', lockDirectory: join(home, 'locks'), journalDirectory: join(home, 'journal') } };
  await writeFile(join(home, '.gbrain/config.json'), JSON.stringify(config));
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); resetGateway();
  await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1,$1,$2)', [source, root]);
  await offline(async () => {
    await importFromContent(engine, slug, original, { noEmbed: true, remote: false, sourceId: source });
    await engine.addTag(slug, 'enriched', { sourceId: source });
    await engine.putPage('concepts/target', { type: 'concept', title: 'Target', compiled_truth: 'Target body', timeline: '', frontmatter: {} }, { sourceId: source });
    // Existing same-source code plus a default-source collision: follow-up must
    // use ordinary source-qualified links, not private page-write authority.
    for (const sourceId of [source, 'default']) {
      await engine.putPage(slugifyCodePath('src/core/sync.ts'), { type: 'concept', title: 'Code target',
        page_kind: 'code', compiled_truth: 'export const fixture = true;', timeline: '', frontmatter: {} }, { sourceId });
    }
    await writeFile(join(root, slug + '.md'), original);
    await enrollPageFileRuntime(ctx(), source, slug);
  });
}, 60000);
afterAll(async () => { await engine?.disconnect(); resetGateway(); if (home) await rm(home, { recursive: true, force: true }); });

test('local capture --file --slug --source publishes code references on an enrolled page and preserves separate ingest links', () => offline(async () => {
  expect(extractCodeRefs(revised).map(ref => ref.path)).toEqual(['src/core/sync.ts', 'src/core/not-imported.ts']);
  const input = join(home, 'publication.md'); await writeFile(input, revised);
  const snapshot = await call('get_page_checked');
  const before = { page: await engine.getPage(slug, { sourceId: source }), chunks: await engine.getChunks(slug, { sourceId: source }),
    versions: await engine.getVersions(slug, { sourceId: source }), tags: await engine.getTags(slug, { sourceId: source }) };
  const lines: string[] = [], errors: string[] = [];
  const out = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
  const err = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`capture exit ${code}: ${errors.join('\n')}`); });
  const network = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('offline network forbidden'); }) as unknown as typeof fetch);
  try {
    try { await runCapture(engine, ['--file', input, '--slug', slug, '--source', source, '--json']); }
    catch (error) {
      expect(await call('get_page_checked')).toEqual(snapshot);
      expect(await engine.getPage(slug, { sourceId: source })).toEqual(before.page);
      expect(await engine.getChunks(slug, { sourceId: source })).toEqual(before.chunks);
      expect(await engine.getVersions(slug, { sourceId: source })).toEqual(before.versions);
      expect(await engine.getTags(slug, { sourceId: source })).toEqual(before.tags);
      expect(await readFile(join(root, slug + '.md'), 'utf8')).toBe(original);
      expect(await readdir(join(home, 'journal'))).toEqual([]);
      throw error;
    }
    const receipt = JSON.parse(lines.join('\n'));
    expect(receipt).toMatchObject({ slug, status: 'created_or_updated', written: true, source_kind: 'capture-cli' });
    expect(receipt.chunks).toBeGreaterThan(0);
    const current = await call('get_page_checked');
    expect(current.revision).not.toBe(snapshot.revision);
    expect(current.file.baseline.generation).not.toBe(snapshot.file.baseline.generation);
    expect(current.page.title).toBe('Revised');
    expect(current.file.raw_markdown).toContain('Revised publication');
    // Local put_page file provenance differs from the capture channel columns.
    expect(current.page.frontmatter.ingested_via).toBe('put_page');
    expect(current.page.frontmatter.source_kind).toBe('put_page');
    const [provenance] = await engine.executeRaw('SELECT source_kind, source_uri, ingested_via FROM pages WHERE source_id=$1 AND slug=$2', [source, slug]);
    expect(provenance).toEqual({ source_kind: 'capture-cli', source_uri: `file://${input}`, ingested_via: 'capture-cli' });
    expect((await engine.getTags(slug, { sourceId: source })).sort()).toEqual(['enriched', 'original', 'revised']);
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    expect(await engine.executeRaw('SELECT * FROM page_file_write_authorizations')).toEqual([]);
    expect(await engine.executeRaw("SELECT state FROM page_file_operations")).toEqual([{ state: 'committed' }]);
    expect((await engine.getLinks(slug, { sourceId: source })).some(link => link.link_source === 'markdown')).toBe(true);
    // Legacy auto-link can reconcile away the outgoing `documents` edge;
    // the reverse importer-authored edge must still survive, same as capture
    // before enrollment. Do not turn this into a new graph-atomicity contract.
    expect(await engine.getLinks(slugifyCodePath('src/core/sync.ts'), { sourceId: source })).toContainEqual(
      expect.objectContaining({ to_slug: slug, link_type: 'documented_by', link_source: 'markdown',
        origin_slug: slug, origin_field: 'compiled_truth', context: 'src/core/sync.ts' }),
    );
    expect(await engine.getLinks(slugifyCodePath('src/core/sync.ts'), { sourceId: 'default' })).toEqual([]);
    // The separate ingestion link command remains ordinary graph DML, not page CAS.
    await call('add_link', { from: slug, to: 'concepts/target', link_type: 'related',
      link_source: 'gbrain-ingest', context: 'fixture publication', from_source_id: source, to_source_id: source });
    expect((await engine.getLinks(slug, { sourceId: source })).some(link => link.link_source === 'gbrain-ingest')).toBe(true);
    expect(await call('get_page_checked')).toEqual(current);
    await expect(call('put_page_checked', { expected_revision: snapshot.revision, page: current.page,
      operation_id: randomUUID(), file_baseline: snapshot.file.baseline, raw_markdown: current.file.raw_markdown })).rejects.toThrow('precondition_failed');
    expect(await call('get_page_checked')).toEqual(current);
    const links = await engine.getLinks(slug, { sourceId: source });
    lines.length = 0;
    const addLink = spyOn(engine, 'addLink');
    const aliases = spyOn(engine, 'setPageAliases');
    try {
      await runCapture(engine, ['--file', input, '--slug', slug, '--source', source, '--json']);
      // Existing auto-link still reconciles skipped imports; the importer
      // code-reference and alias hooks must not replay on a hash-equal skip.
      expect(addLink.mock.calls.filter(args => args[3] === 'documents' || args[3] === 'documented_by')).toEqual([]);
      expect(aliases).not.toHaveBeenCalled();
    } finally { aliases.mockRestore(); addLink.mockRestore(); }
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ slug, status: 'skipped', written: true });
    expect(await call('get_page_checked')).toEqual(current);
    expect(await engine.getLinks(slug, { sourceId: source })).toEqual(links);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); exit.mockRestore(); err.mockRestore(); out.mockRestore(); }
}), 30000);

test('actual capture stale page CAS never runs ordinary link or alias follow-up', () => offline(async () => {
  const before = await call('get_page_checked');
  const rows = await engine.executeRaw('SELECT * FROM page_file_operations');
  const journal = await readdir(join(home, 'journal'));
  const links = await engine.executeRaw('SELECT * FROM links ORDER BY id');
  const input = join(home, 'stale-publication.md');
  await writeFile(input, revised + '\nStale candidate must not publish.\n');
  const putOrdinary = PageFileDatabase.prototype.putOrdinary;
  const stale = spyOn(PageFileDatabase.prototype, 'putOrdinary').mockImplementation(function (this: PageFileDatabase, sourceId, target, prepared, baseline, validate) {
    return putOrdinary.call(this, sourceId, target, prepared, { ...baseline, revision: randomUUID() }, validate);
  });
  const addLink = spyOn(engine, 'addLink');
  const aliases = spyOn(engine, 'setPageAliases');
  const out = spyOn(console, 'log').mockImplementation(() => {});
  const errors: string[] = [];
  const err = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error(errors.join('\n')); });
  const network = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('offline network forbidden'); }) as unknown as typeof fetch);
  try {
    await expect(runCapture(engine, ['--file', input, '--slug', slug, '--source', source, '--json'])).rejects.toThrow('precondition_failed');
    expect(stale).toHaveBeenCalledTimes(1);
    expect(addLink).not.toHaveBeenCalled();
    expect(aliases).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(await call('get_page_checked')).toEqual(before);
    expect(await engine.executeRaw('SELECT * FROM page_file_operations')).toEqual(rows);
    expect(await readdir(join(home, 'journal'))).toEqual(journal);
    expect(await engine.executeRaw('SELECT * FROM links ORDER BY id')).toEqual(links);
  } finally {
    network.mockRestore(); exit.mockRestore(); err.mockRestore(); out.mockRestore();
    aliases.mockRestore(); addLink.mockRestore(); stale.mockRestore();
  }
}), 30000);

for (const remote of [true, undefined]) {
  test(`capture-shaped params with remote=${remote} retain remote provenance and skip local hooks`, () => offline(async () => {
    const result = await operationsByName.put_page.handler({ ...ctx(), remote } as OperationContext, {
      slug, source_id: source, content: `---\ntype: concept\ntitle: Remote\nsource_kind: capture-cli\ningested_via: capture-cli\nquarantine: true\n---\n\nRemote body ${remote}.`,
      source_kind: 'capture-cli', ingested_via: 'capture-cli', source_uri: 'file:///spoofed',
    }) as any;
    expect(result.auto_links).toEqual({ skipped: 'remote' });
    expect(result.auto_timeline).toEqual({ skipped: 'remote' });
    const current = await call('get_page_checked');
    expect(current.page.frontmatter.source_kind).toBe('mcp:put_page');
    expect(current.page.frontmatter.ingested_via).toBe('mcp:put_page');
    expect(current.page.frontmatter.quarantine).toBeUndefined();
    const [row] = await engine.executeRaw('SELECT source_kind, ingested_via FROM pages WHERE source_id=$1 AND slug=$2', [source, slug]);
    expect(row).toEqual({ source_kind: 'mcp:put_page', ingested_via: 'mcp:put_page' });
  }));
}

test('other local writers and direct enrolled import retain their nonmutating refusals', () => offline(async () => {
  const before = await call('get_page_checked');
  const operations = await engine.executeRaw('SELECT * FROM page_file_operations');
  await expect(call('put_page', { content: 'Unsupported ordinary local writer' })).rejects.toThrow('unsupported_ordinary_file_writer');
  await expect(importFromContent(engine, slug, 'No direct importer bypass', { sourceId: source, remote: false, noEmbed: true })).rejects.toThrow();
  expect(await call('get_page_checked')).toEqual(before);
  expect(await engine.executeRaw('SELECT * FROM page_file_operations')).toEqual(operations);
}));

test('legacy unenrolled capture accepts the same code references and retains source-qualified reverse links', () => offline(async () => {
  const legacySlug = 'concepts/legacy-captured';
  const input = join(home, 'legacy-publication.md'); await writeFile(input, revised);
  const lines: string[] = [], errors: string[] = [];
  const out = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
  const err = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`capture exit ${code}: ${errors.join('\n')}`); });
  const network = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('offline network forbidden'); }) as unknown as typeof fetch);
  try {
    await runCapture(engine, ['--file', input, '--slug', legacySlug, '--source', source, '--json']);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ slug: legacySlug, status: 'created_or_updated', written: true });
    expect(await engine.getLinks(slugifyCodePath('src/core/sync.ts'), { sourceId: source })).toContainEqual(
      expect.objectContaining({ to_slug: legacySlug, link_type: 'documented_by', link_source: 'markdown',
        origin_slug: legacySlug, origin_field: 'compiled_truth', context: 'src/core/sync.ts' }),
    );
    expect(await engine.getLinks(slugifyCodePath('src/core/sync.ts'), { sourceId: 'default' })).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); exit.mockRestore(); err.mockRestore(); out.mockRestore(); }
}), 30000);
