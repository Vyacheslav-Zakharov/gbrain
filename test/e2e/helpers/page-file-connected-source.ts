import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import type { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import type { PageFileBootstrapAnchor } from '../../../src/core/page-file-bootstrap.ts';
import { operationsByName, type OperationContext } from '../../../src/core/operations.ts';
import { parseMarkdown } from '../../../src/core/markdown.ts';
import { snapshotCrashJournal } from './page-file-connected-crash.ts';

const operatorAnchor = '/etc/gbrain/page-file-operator-anchor.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Item = { source: string; slug: string; status: string; reason?: string };
type Batch = { status: string; source: string; items: Item[]; nextCursor: string | null };

/** Real hosted v2 vertical. All enrollment is through the executable and its
 * separate login; owner access below is readback only, never a writer bypass. */
export async function exerciseConnectedSource(f: {
  admin: PostgresEngine; engine: PostgresEngine; source: string; root: string; directory: string;
  journal: string; bootstrap: PageFileBootstrapAnchor; ordinaryUrl: string;
  enrollmentUrl: string; enrollmentRole: string;
}) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1'
    || process.env.REQUIRE_PAGE_FILE_CONNECTED_POSTGRES !== '1'
    || process.env.REQUIRE_PAGE_FILE_PILOT_POSTGRES !== '1') throw new Error('source v2 requires disposable hosted acceptance');
  expect(existsSync(operatorAnchor)).toBe(false);
  const ctx: OperationContext = { engine: f.engine, config: { engine: 'postgres' }, remote: true,
    sourceId: f.source, dryRun: false,
    auth: { allowedSources: [f.source], writeSources: [f.source] } as OperationContext['auth'],
    logger: { info() {}, warn() {}, error() {} } };
  const call = (name: string, slug: string, request: Record<string, unknown> = {}) =>
    operationsByName[name].handler(ctx, { source_id: f.source, slug, ...request }) as Promise<any>;
  const original = '---\ntitle: Original\ntype: concept\ntags: [authored-before]\nowner: original\n---\n\nOriginal source-wide article.\n';
  const revised = '---\ntitle: Revised\ntype: concept\ntags: [authored-after]\nowner: revised\ndate: "2026-01-02"\n---\n\nRevised source-wide ordinary article.\n';
  const put = async (slug: string, content: string) => {
    const result = await call('put_page', slug, { content });
    expect(result.status).toBe('created_or_updated');
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.write_through.written).toBe(true);
    expect(result.auto_links).toEqual({ skipped: 'remote' });
    expect(result.auto_timeline).toEqual({ skipped: 'remote' });
    return result;
  };
  const state = async () => {
    const rows: unknown[] = [];
    for (const table of ['pages', 'page_file_bindings']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE source_id=$1 ORDER BY to_jsonb(t)::text`, [f.source]));
    for (const table of ['tags', 'page_versions', 'content_chunks', 'page_file_write_authorizations']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1) ORDER BY to_jsonb(t)::text`, [f.source]));
    rows.push(await f.admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM page_file_operations t
      WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1) ORDER BY operation_id`, [f.source]));
    return { rows, root: snapshotCrashJournal(f.root), journal: snapshotCrashJournal(f.journal) };
  };
  const secret = join(f.directory, 'source-enrollment.credential');
  writeFileSync(secret, f.enrollmentUrl, { flag: 'wx', mode: 0o400 });
  const home = join(f.directory, 'source-operator-home'); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'postgres', database_url: f.ordinaryUrl, poolSize: 1 }), { flag: 'wx', mode: 0o600 });
  const contract = JSON.stringify({ version: 2, mode: 'production-pilot', bootstrap: f.bootstrap,
    sourceIds: [f.source], enrollmentCredentialPath: secret, enrollmentCredentialSha256: hash(f.enrollmentUrl) });
  const contractPath = join(f.directory, 'source-operator.json');
  writeFileSync(contractPath, contract, { flag: 'wx', mode: 0o400 });
  let ownsAnchor = false;
  const run = async (entrypoint: string, args: string[], denied = false) => {
    // Same ordinary-only process configuration for operator, capture and links.
    // No owner/adapter/enrollment URL, inherited HOME or API key.
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, entrypoint), ...args], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_DATABASE_URL: f.ordinaryUrl,
        GBRAIN_SKIP_STARTUP_HOOKS: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [code, out, err] = await Promise.race([
        Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('source operator deadline 15s')), 15_000); }),
      ]);
      expect(out + err).not.toContain(f.enrollmentUrl);
      expect(out + err).not.toContain(f.ordinaryUrl);
      expect(code).toBe(denied ? 1 : 0);
      return { out, err };
    } finally { clearTimeout(timer); if (proc.exitCode === null) proc.kill('SIGKILL'); await proc.exited; }
  };
  const invoke = async (action: 'inventory' | 'reconcile', cursor?: string, source = f.source, denied = false): Promise<Batch> => {
    const { out, err } = await run('../../../src/commands/page-file-operator.ts',
      [action, source, '1', ...(cursor ? [cursor] : [])], denied);
    if (denied) {
      expect(out).toBe(''); expect(err.trim()).toBe('page_file_operator_failed');
      return { status: 'denied', source, items: [], nextCursor: null };
    }
    const batch = JSON.parse(out) as Batch;
    expect(batch.status).toBe('complete'); expect(batch.source).toBe(source);
    expect(batch.items.length).toBe(1);
    return batch;
  };
  const sweep = async (action: 'inventory' | 'reconcile', slugs: string[], statuses: string[]) => {
    let cursor: string | undefined;
    const items: Item[] = [], cursors = new Set<string>();
    for (let i = 0; i < slugs.length; i++) {
      const batch = await invoke(action, cursor);
      items.push(...batch.items);
      if (i === slugs.length - 1) expect(batch.nextCursor).toBeNull();
      else {
        expect(batch.nextCursor).toBeString();
        expect(cursors.has(batch.nextCursor!)).toBe(false);
        cursors.add(batch.nextCursor!); cursor = batch.nextCursor!;
      }
    }
    expect(items).toEqual(slugs.map((slug, i) => ({ source: f.source, slug, status: statuses[i],
      ...(statuses[i] === 'pending_enrollment' ? { reason: 'checked_enrollment_required' } : {}) })));
    expect(new Set(items.map(item => item.slug)).size).toBe(slugs.length);
  };
  try {
    // Verify the actual separate login; no enrollment or owner SET ROLE here.
    const enrollment = postgres(f.enrollmentUrl, { max: 1, connect_timeout: 5 });
    try {
      const [identity] = await enrollment.unsafe('SELECT session_user,current_user');
      expect(identity.session_user).toBe(f.enrollmentRole); expect(identity.current_user).toBe(f.enrollmentRole);
    } finally { await enrollment.end({ timeout: 5 }); }
    // Two existing ordinary pages at sweep time; ordinary writes never auto-enroll.
    await f.engine.addTag('connected', 'enriched', { sourceId: f.source });
    await put('connected', original); // include the enrichment in indexed file bytes
    await put('sibling', original);
    expect(await f.admin.executeRaw('SELECT slug FROM page_file_bindings WHERE source_id=$1', [f.source])).toEqual([]);
    writeFileSync(operatorAnchor, JSON.stringify({ operatorPath: contractPath, operatorSha256: hash(contract) }), { flag: 'wx', mode: 0o400 }); ownsAnchor = true;
    const before = await state();
    renameSync(secret, secret + '.withheld');
    try {
      await sweep('inventory', ['connected', 'sibling'], ['pending_enrollment', 'pending_enrollment']);
      await invoke('reconcile', undefined, f.source, true);
      expect(await state()).toEqual(before);
    } finally { renameSync(secret + '.withheld', secret); }
    await sweep('reconcile', ['connected', 'sibling'], ['enrolled', 'enrolled']);
    const enrolled = await state();
    expect(enrolled.rows.filter((_, i) => i !== 1)).toEqual(before.rows.filter((_, i) => i !== 1));
    expect(enrolled.root).toEqual(before.root); expect(enrolled.journal).toEqual(before.journal);
    expect(await f.admin.executeRaw('SELECT slug FROM page_file_bindings WHERE source_id=$1 ORDER BY slug', [f.source]))
      .toEqual([{ slug: 'connected' }, { slug: 'sibling' }]);
    for (const slug of ['connected', 'sibling']) expect((await call('get_page_checked', slug)).persistence).toBe('file_and_database');
    await sweep('reconcile', ['connected', 'sibling'], ['verified', 'verified']);
    expect(await state()).toEqual(enrolled);
    console.log('PG_CONNECTED_SOURCE_V2: executable paginated inventory and enrollment; two existing pages; separate login; idempotent readback');

    const stale = await call('get_page_checked', 'connected');
    await put('connected', revised);
    const current = await call('get_page_checked', 'connected');
    expect(current.persistence).toBe('file_and_database');
    expect(current.revision).not.toBe(stale.revision);
    expect(current.file.baseline.generation).not.toBe(stale.file.baseline.generation);
    const page = (await f.engine.getPage('connected', { sourceId: f.source }))!;
    expect(page.title).toBe('Revised'); expect(page.frontmatter.owner).toBe('revised');
    expect(page.compiled_truth).toContain('Revised source-wide ordinary article.');
    expect(page.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.engine.getTags('connected', { sourceId: f.source })).sort()).toEqual(['authored-after', 'authored-before', 'enriched']);
    const raw = readFileSync(join(f.root, 'connected.md'), 'utf8');
    expect(current.file.raw_markdown).toBe(raw);
    const parsed = parseMarkdown(raw, 'connected.md');
    expect(parsed.title).toBe(page.title); expect(parsed.compiled_truth).toBe(page.compiled_truth);
    expect(parsed.tags.sort()).toEqual(['authored-after', 'authored-before', 'enriched']);
    const [metadata] = await f.admin.executeRaw('SELECT source_kind,ingested_via,effective_date_source FROM pages WHERE source_id=$1 AND slug=$2', [f.source, 'connected']);
    expect(metadata.source_kind).toBe('mcp:put_page'); expect(metadata.ingested_via).toBe('mcp:put_page');
    expect(metadata.effective_date_source).not.toBeNull(); expect(raw).toContain('mcp:put_page');
    const stable = await state();
    await expect(call('put_page_checked', 'connected', { operation_id: randomUUID(), expected_revision: stale.revision,
      file_baseline: stale.file.baseline, page: current.page, raw_markdown: raw })).rejects.toThrow('precondition_failed');
    expect(await call('get_page_checked', 'connected')).toEqual(current);
    expect(await state()).toEqual(stable);
    expect(await f.admin.executeRaw('SELECT * FROM page_file_write_authorizations WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [f.source])).toEqual([]);
    console.log('PG_CONNECTED_SOURCE_V2: registered ordinary enrolled put preserves tags metadata file and DB; stale checked baseline refuses without mutation');

    // sibling was created through registered ordinary put and enrolled above.
    // Exercise the real ingest executable, not runCapture with an injected engine.
    const captureBefore = await call('get_page_checked', 'sibling');
    const capturePolicy = readFileSync(contractPath, 'utf8');
    const captureAnchor = readFileSync(operatorAnchor, 'utf8');
    const captureInput = join(f.directory, 'capture-publication.md');
    writeFileSync(captureInput, '---\ntitle: Captured\ntype: concept\ntags: [captured]\nowner: capture-fixture\ndate: "2026-01-03"\n---\n\nCaptured publication with [[connected]].\n', { flag: 'wx', mode: 0o600 });
    const capture = await run('../../../src/cli.ts', ['capture', '--file', captureInput,
      '--slug', 'sibling', '--source', f.source, '--json']);
    const receipt = JSON.parse(capture.out);
    expect(receipt).toMatchObject({ slug: 'sibling', status: 'created_or_updated', written: true, source_kind: 'capture-cli' });
    expect(receipt.chunks).toBeGreaterThan(0);
    const captured = await call('get_page_checked', 'sibling');
    expect(captured.persistence).toBe('file_and_database');
    expect(captured.revision).not.toBe(captureBefore.revision);
    expect(captured.file.baseline.generation).not.toBe(captureBefore.file.baseline.generation);
    const capturedPage = (await f.engine.getPage('sibling', { sourceId: f.source }))!;
    const capturedRaw = readFileSync(join(f.root, 'sibling.md'), 'utf8');
    const capturedParsed = parseMarkdown(capturedRaw, 'sibling.md');
    expect(captured.file.raw_markdown).toBe(capturedRaw);
    expect(capturedPage.title).toBe('Captured');
    expect(capturedPage.compiled_truth).toContain('Captured publication with [[connected]].');
    expect(capturedParsed.title).toBe(capturedPage.title);
    expect(capturedParsed.type).toBe(capturedPage.type);
    expect(capturedParsed.compiled_truth).toBe(capturedPage.compiled_truth);
    expect(capturedParsed.timeline).toBe(capturedPage.timeline);
    expect(JSON.parse(JSON.stringify(capturedParsed.frontmatter))).toEqual(capturedPage.frontmatter);
    const captureTags = ['authored-before', 'captured'];
    expect((await f.engine.getTags('sibling', { sourceId: f.source })).sort()).toEqual(captureTags);
    expect(capturedParsed.tags.sort()).toEqual(captureTags);
    // File/JSON metadata records the trusted local writer; dedicated columns
    // retain capture's channel and URI (not the remote mcp:put_page provenance).
    for (const fm of [capturedPage.frontmatter, capturedParsed.frontmatter]) {
      expect(fm.owner).toBe('capture-fixture');
      expect(fm.source_kind).toBe('put_page'); expect(fm.ingested_via).toBe('put_page');
    }
    const [captureMetadata] = await f.admin.executeRaw(
      'SELECT source_kind,source_uri,ingested_via,effective_date_source FROM pages WHERE source_id=$1 AND slug=$2', [f.source, 'sibling']);
    expect(captureMetadata).toMatchObject({ source_kind: 'capture-cli', source_uri: `file://${captureInput}`, ingested_via: 'capture-cli' });
    expect(captureMetadata.effective_date_source).not.toBeNull();
    expect(await f.engine.getPage('sibling', { sourceId: 'default' })).toBeNull();
    expect(readFileSync(contractPath, 'utf8')).toBe(capturePolicy);
    expect(readFileSync(operatorAnchor, 'utf8')).toBe(captureAnchor);
    const captureStable = await state();
    const captureLinks = await f.engine.getLinks('sibling', { sourceId: f.source });
    expect(captureLinks.some(link => link.to_slug === 'connected' && link.link_source === 'markdown')).toBe(true);
    await expect(call('put_page_checked', 'sibling', { operation_id: randomUUID(), expected_revision: captureBefore.revision,
      file_baseline: captureBefore.file.baseline, page: captured.page, raw_markdown: capturedRaw })).rejects.toThrow('precondition_failed');
    expect(await call('get_page_checked', 'sibling')).toEqual(captured);
    expect(await state()).toEqual(captureStable);
    expect(await f.engine.getLinks('sibling', { sourceId: f.source })).toEqual(captureLinks);
    expect(await f.admin.executeRaw('SELECT * FROM page_file_write_authorizations WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [f.source])).toEqual([]);

    // Ingest publishes explicit links AFTER capture. This remains ordinary graph
    // DML through the real CLI; no new linkCAS or page revision is introduced.
    const linked = await run('../../../src/cli.ts', ['link', 'sibling', 'connected', '--source', f.source,
      '--from-source-id', f.source, '--to-source-id', f.source, '--link-type', 'related',
      '--link-source', 'gbrain-ingest', '--context', 'capture fixture publication', '--json']);
    expect(JSON.parse(linked.out)).toMatchObject({ status: 'ok' });
    expect((await f.engine.getLinks('sibling', { sourceId: f.source })).some(link =>
      link.to_slug === 'connected' && link.link_type === 'related' && link.link_source === 'gbrain-ingest'
      && link.context === 'capture fixture publication')).toBe(true);
    expect(await call('get_page_checked', 'sibling')).toEqual(captured);
    expect(await state()).toEqual(captureStable); // state excludes graph edges by design
    console.log('PG_CONNECTED_SOURCE_V2: executable capture --file --slug --source updates enrolled page with file DB tags and capture provenance; stale token unchanged refusal; subsequent executable ingest link remains ordinary');

    // Earlier-sorting future page: same startup engine and exact protected policy.
    const policyBefore = readFileSync(operatorAnchor, 'utf8');
    await put('aaa-future', original);
    expect(await f.admin.executeRaw("SELECT slug FROM page_file_bindings WHERE source_id=$1 AND slug='aaa-future'", [f.source])).toEqual([]);
    const futureBefore = await state();
    await sweep('inventory', ['aaa-future', 'connected', 'sibling'], ['pending_enrollment', 'verified', 'verified']);
    expect(await state()).toEqual(futureBefore);
    await sweep('reconcile', ['aaa-future', 'connected', 'sibling'], ['enrolled', 'verified', 'verified']);
    const futureAfter = await state();
    expect(futureAfter.rows.filter((_, i) => i !== 1)).toEqual(futureBefore.rows.filter((_, i) => i !== 1));
    expect(futureAfter.root).toEqual(futureBefore.root); expect(futureAfter.journal).toEqual(futureBefore.journal);
    expect((await call('get_page_checked', 'aaa-future')).persistence).toBe('file_and_database');
    expect(readFileSync(operatorAnchor, 'utf8')).toBe(policyBefore);
    expect(await f.admin.executeRaw('SELECT slug FROM page_file_bindings WHERE source_id=$1 ORDER BY slug', [f.source]))
      .toEqual([{ slug: 'aaa-future' }, { slug: 'connected' }, { slug: 'sibling' }]);
    const final = await state();
    const foreignState = () => f.admin.executeRaw(`SELECT to_jsonb(p)::text AS row FROM pages p
      WHERE source_id <> $1 ORDER BY source_id,slug`, [f.source]);
    const foreignBefore = await foreignState();
    for (const action of ['inventory', 'reconcile'] as const) await invoke(action, undefined, 'default', true);
    await expect(call('put_page', 'connected', { source_id: 'default', content: revised }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await state()).toEqual(final);
    expect(await foreignState()).toEqual(foreignBefore);
    console.log('PG_CONNECTED_SOURCE_V2: ordinary-created future page enrolled by fresh paginated sweep without repinning; cross-source inventory and reconcile denied');
  } finally { if (ownsAnchor) rmSync(operatorAnchor); }
}
