import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';

// Real PostgreSQL only. Do not import the shared destructive setupDB helper.
// CI must run this file in isolation against a disposable localhost gbrain_test.
const databaseUrl = process.env.DATABASE_URL;
if (process.env.REQUIRE_PAGE_CAS_POSTGRES === '1' && !databaseUrl) {
  throw new Error('REQUIRE_PAGE_CAS_POSTGRES=1 requires DATABASE_URL; refusing a skipped acceptance gate');
}
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/gbrain_test' || url.search || url.hash) {
    throw new Error('Page CAS acceptance requires a disposable localhost /gbrain_test URL without query overrides');
  }
}
const suite = databaseUrl ? describe : describe.skip;
const TEST_MS = 30_000;
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const sourceA = `cas-a-${runId}`;
const sourceB = `cas-b-${runId}`;
const sources = [sourceA, sourceB];
const engines: PostgresEngine[] = [];
let a: PostgresEngine;
let b: PostgresEngine;
let observer: PostgresEngine;
let identityVerified = false;

const page = (body: string) => ({
  type: 'note', title: 'CAS example', compiled_truth: body, timeline: '',
  frontmatter: { status: 'approved' } as Record<string, unknown>,
});
type Snapshot = {
  source_id: string; slug: string; revision: string;
  page: ReturnType<typeof page>; persistence: string;
};
function context(engine: BrainEngine, sourceId: string): OperationContext {
  return {
    engine, remote: true, sourceId, dryRun: false, config: { engine: 'postgres' },
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'synthetic-test-token', clientId: 'cas-example-client',
      scopes: ['read', 'write'], sourceId, allowedSources: [sourceId], writeSources: [sourceId] },
  };
}
async function call(name: string, engine: BrainEngine, source: string, params: Record<string, unknown>): Promise<Snapshot> {
  expect(operationsByName[name]).toBeDefined();
  return await operationsByName[name].handler(context(engine, source), params) as Snapshot;
}
const read = (engine: BrainEngine, slug: string, source = sourceA) =>
  call('get_page_checked', engine, source, { source_id: source, slug });
const put = (engine: BrainEngine, slug: string, revision: string, value = page('Replacement'), source = sourceA) =>
  call('put_page_checked', engine, source, { source_id: source, slug, expected_revision: revision, page: value });
async function seed(slug: string, source = sourceA) {
  await a.putPage(slug, { ...page('Original'), page_kind: 'markdown' }, { sourceId: source });
  return read(a, slug, source);
}
async function pid(engine: BrainEngine) {
  return (await engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0].pid;
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded 8s`)), 8_000);
    })]);
  } finally { clearTimeout(timer); }
}
// Test-only commit barrier: delegate every statement to the actual transaction
// engine. No nested transaction, fake connection, stubbed result, or SQL rewrite.
function beforeCommit(engine: PostgresEngine, hook: (tx: BrainEngine) => Promise<void>): BrainEngine {
  const scoped = Object.create(engine) as BrainEngine;
  scoped.transaction = <T>(fn: (tx: BrainEngine) => Promise<T>) => engine.transaction(async tx => {
    const result = await fn(tx);
    await hook(tx);
    return result;
  });
  return scoped;
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
// Observe actual server lock waits, not a sleep-based assumption of contention.
async function waitBlocked(blocked: number, blocker: number, monitor: BrainEngine = observer) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await monitor.executeRaw<{ blocked: boolean }>(
      'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [blocked, blocker]);
    if (row.blocked) return;
    await Bun.sleep(20);
  }
  throw new Error('Expected PostgreSQL row-lock contention was not observed within 5s');
}
// Attach a rejection handler immediately; blocked writes may fail before release.
const settle = <T>(promise: Promise<T>) => promise.then(
  value => ({ status: 'fulfilled' as const, value }),
  reason => ({ status: 'rejected' as const, reason }),
);
async function derivatives(engine: BrainEngine, slug: string, source = sourceA) {
  const [row] = await engine.executeRaw<{ id: number }>(
    'SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [source, slug]);
  const result: Record<string, unknown> = {};
  for (const table of ['tags', 'timeline_entries', 'page_versions', 'content_chunks']) {
    result[table] = await engine.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id = $1 ORDER BY to_jsonb(t)::text`, [row.id]);
  }
  result.links = await engine.executeRaw(
    'SELECT to_jsonb(t)::text AS row FROM links t WHERE from_page_id = $1 OR to_page_id = $1 OR origin_page_id = $1 ORDER BY to_jsonb(t)::text', [row.id]);
  return result;
}

suite('page CAS MVP — real PostgreSQL acceptance', () => {
  beforeAll(async () => {
    // poolSize: 1 is essential: no module singleton and stable backend per engine.
    for (let i = 0; i < 3; i++) {
      const engine = new PostgresEngine();
      engines.push(engine); // retain even partially connected engines for teardown
      await engine.connect({ database_url: databaseUrl!, poolSize: 1 });
      const [identity] = await engine.executeRaw<{ database: string; server: string; version: string }>(
        'SELECT current_database() AS database, inet_server_addr()::text AS server, version() AS version');
      expect(identity.database).toBe('gbrain_test');
      // Hosted service port forwarding may expose a bridge address server-side.
      // The pre-connect URL guard pins the client endpoint to loopback.
      expect(typeof identity.server).toBe('string');
      expect(identity.server.length).toBeGreaterThan(0);
      expect(identity.version).toContain('PostgreSQL');
      await engine.executeRaw("SET statement_timeout = '15s'");
      await engine.executeRaw("SET lock_timeout = '10s'");
      await engine.executeRaw("SET idle_in_transaction_session_timeout = '20s'");
    }
    [a, b, observer] = engines;
    expect(new Set(await Promise.all(engines.map(pid))).size).toBe(3);
    identityVerified = true;
    // Canonical bootstrap + migrations; no schema reset or production resolver.
    await a.initSchema();
    for (const source of sources) {
      await a.executeRaw(
        "INSERT INTO sources (id, name, local_path, config, archived) VALUES ($1, $1, NULL, '{}'::jsonb, false)", [source]);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (identityVerified && a) {
        // Delete only this run's randomly named fixtures, never shared defaults.
        await a.executeRaw('DELETE FROM sources WHERE id IN ($1, $2)', sources);
      }
    } finally {
      const results = await Promise.allSettled(engines.map(engine => engine.disconnect()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  }, 30_000);

  test('two independent engines race one token: exactly one winner and one clean conflict', async () => {
    const slug = 'cas/race';
    const before = await seed(slug);
    const aPid = await pid(a);
    const bPid = await pid(b);
    expect(aPid).not.toBe(bPid);
    const locked = latch();
    const release = latch();
    let lockEngine!: BrainEngine;
    const holderPid = await pid(observer);
    const holder = settle(observer.transaction(async tx => {
      lockEngine = tx;
      await tx.executeRaw('SELECT id FROM pages WHERE source_id = $1 AND slug = $2 FOR UPDATE', [sourceA, slug]);
      locked.release();
      await release.promise;
    }));
    let outcomes: Awaited<ReturnType<typeof settle<Snapshot>>>[] = [];
    let pending: ReturnType<typeof settle<Snapshot>>[] = [];
    try {
      await bounded(locked.promise, 'race lock acquisition');
      pending = [settle(put(a, slug, before.revision, page('Writer A'))), settle(put(b, slug, before.revision, page('Writer B')))];
      // Monitor through the actual lock-holder transaction: both writers must
      // reach a PostgreSQL lock wait before either is allowed to win.
      expect(holderPid).not.toBe(aPid);
      expect(holderPid).not.toBe(bPid);
      // Either writer can hold the tuple lock while waiting for holder's xid;
      // the other can queue behind that writer, so do not assume waiter order.
      const deadline = Date.now() + 3_000;
      let queued = false;
      while (Date.now() < deadline) {
        const [state] = await lockEngine.executeRaw<{ waiting: boolean }>(
          'SELECT cardinality(pg_blocking_pids($1::int)) > 0 AND cardinality(pg_blocking_pids($2::int)) > 0 AS waiting', [aPid, bPid]);
        if (state.waiting) { queued = true; break; }
        await Bun.sleep(20);
      }
      expect(queued).toBe(true);
    } finally {
      release.release();
      outcomes = await Promise.all(pending);
      const lockResult = await holder;
      if (lockResult.status === 'rejected') throw lockResult.reason;
    }
    const wins = outcomes.filter(result => result.status === 'fulfilled');
    const losses = outcomes.filter(result => result.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].status === 'rejected' && losses[0].reason.code).toBe('precondition_failed');
    const winner = wins[0];
    if (winner.status !== 'fulfilled') throw new Error('Missing winner');
    expect(winner.value.persistence).toBe('database_only');
    expect(await read(observer, slug)).toMatchObject({ revision: winner.value.revision, page: winner.value.page });
    expect(winner.value.revision).not.toBe(before.revision);
    const committed = await derivatives(observer, slug);
    expect(committed.page_versions).toHaveLength(1); // loser must not version
    for (const key of ['tags', 'links', 'timeline_entries']) expect(committed[key]).toEqual([]);
    await expect(put(b, slug, before.revision, page('Loser retry'))).rejects.toMatchObject({ code: 'precondition_failed' });
    expect(await derivatives(observer, slug)).toEqual(committed);
  }, TEST_MS);

  test('legacy page ABA and tag add/remove invalidate all stale revisions', async () => {
    const slug = 'cas/aba';
    const before = await seed(slug);
    await b.putPage(slug, page('Temporary'), { sourceId: sourceA });
    const middle = await read(a, slug);
    await b.putPage(slug, page('Original'), { sourceId: sourceA });
    const restored = await read(a, slug);
    expect(restored.page).toEqual(before.page);
    expect(new Set([before.revision, middle.revision, restored.revision]).size).toBe(3);
    await expect(put(a, slug, before.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
    await b.addTag(slug, 'example-tag', { sourceId: sourceA });
    const tagged = await read(a, slug);
    await expect(put(a, slug, restored.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
    await b.removeTag(slug, 'example-tag', { sourceId: sourceA });
    const untagged = await read(a, slug);
    expect(new Set([restored.revision, tagged.revision, untagged.revision]).size).toBe(3);
    await expect(put(a, slug, tagged.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
    await expect(put(a, slug, restored.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
    expect(await b.getTags(slug, { sourceId: sourceA })).toEqual([]);
  }, TEST_MS);

  for (const first of ['tag', 'cas'] as const) {
    test(`${first}-first ordering serializes tag mutation and CAS on the parent row`, async () => {
      const slug = `cas/order-${first}`;
      const before = await seed(slug);
      const blocker = await pid(a);
      const blocked = await pid(b);
      const ready = latch();
      const release = latch();
      let firstReceipt: Snapshot | undefined;
      const hold = async () => { ready.release(); await release.promise; };
      const holder = first === 'tag'
        ? settle(a.transaction(async tx => {
          await tx.addTag(slug, 'ordered', { sourceId: sourceA });
          await hold();
        }))
        : settle(put(beforeCommit(a, hold), slug, before.revision, page('CAS first'))
          .then(receipt => { firstReceipt = receipt; }));
      let pending: Promise<unknown> | undefined;
      let outcome: Awaited<ReturnType<typeof settle>> | undefined;
      try {
        await bounded(ready.promise, 'ordering barrier');
        // Until commit, independent snapshot must still see the old page/revision.
        expect(await read(observer, slug)).toEqual(before);
        pending = first === 'tag'
          ? settle(put(b, slug, before.revision))
          : settle(b.addTag(slug, 'ordered', { sourceId: sourceA }));
        await waitBlocked(blocked, blocker);
      } finally {
        release.release();
        outcome = await pending as typeof outcome;
        const held = await holder;
        if (held.status === 'rejected') throw held.reason;
      }
      if (first === 'tag') {
        expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'precondition_failed' } });
        expect((await read(observer, slug)).page).toEqual(before.page);
      } else {
        expect(outcome?.status).toBe('fulfilled');
        expect((await read(observer, slug)).page.compiled_truth).toBe('CAS first');
        await expect(put(b, slug, firstReceipt!.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
      }
      expect(await observer.getTags(slug, { sourceId: sourceA })).toEqual(['ordered']);
      expect((await read(observer, slug)).revision).not.toBe(before.revision);
    }, TEST_MS);
  }

  test('same slug in distinct granted sources cannot reuse tokens or mutate its neighbor', async () => {
    const slug = 'cas/shared';
    const left = await seed(slug, sourceA);
    const right = await seed(slug, sourceB);
    expect(left.revision).not.toBe(right.revision);
    await expect(put(b, slug, left.revision, page('Wrong source'), sourceB)).rejects.toMatchObject({ code: 'precondition_failed' });
    await put(a, slug, left.revision, page('Left only'), sourceA);
    expect(await read(b, slug, sourceB)).toEqual(right);
    await expect(call('get_page_checked', a, sourceA, { source_id: sourceB, slug })).rejects.toBeDefined();
    await expect(call('put_page_checked', a, sourceA, {
      source_id: sourceB, slug, expected_revision: right.revision, page: page('Forbidden'),
    })).rejects.toBeDefined();
    expect(await read(b, slug, sourceB)).toEqual(right);
  }, TEST_MS);

  test('JSONB frontmatter stays an object with nested values over the PostgreSQL wire', async () => {
    const slug = 'cas/jsonb';
    const before = await seed(slug);
    const value = { ...page('Unicode λ, quotes " and \\ paths'),
      frontmatter: { nested: { array: [1, true, null, { text: '"quoted" \\ λ' }] }, empty: {}, status: 'approved' } };
    const receipt = await put(a, slug, before.revision, value);
    expect(receipt.page).toEqual(value);
    expect((await read(b, slug)).page).toEqual(value);
    const [stored] = await b.executeRaw<{ kind: string; nested: unknown }>(
      "SELECT jsonb_typeof(frontmatter) AS kind, frontmatter->'nested' AS nested FROM pages WHERE source_id = $1 AND slug = $2", [sourceA, slug]);
    expect(stored).toEqual({ kind: 'object', nested: value.frontmatter.nested });
  }, TEST_MS);

  test('missing, deleted, restored, and hard-recreated targets reject old incarnations', async () => {
    const slug = 'cas/lifecycle';
    const before = await seed(slug);
    await expect(put(a, 'cas/missing', before.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
    await expect(read(a, 'cas/missing')).rejects.toMatchObject({ code: 'page_not_found' });
    await b.softDeletePage(slug, { sourceId: sourceA });
    await expect(read(a, slug)).rejects.toMatchObject({ code: 'page_not_found' });
    await expect(put(a, slug, before.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
    await b.executeRaw('UPDATE pages SET deleted_at = NULL WHERE source_id = $1 AND slug = $2', [sourceA, slug]);
    const restored = await read(a, slug);
    expect(restored.revision).not.toBe(before.revision);
    await expect(put(a, slug, before.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
    await b.deletePage(slug, { sourceId: sourceA });
    const recreated = await seed(slug);
    expect(new Set([before.revision, restored.revision, recreated.revision]).size).toBe(3);
    for (const stale of [before.revision, restored.revision]) {
      await expect(put(a, slug, stale)).rejects.toMatchObject({ code: 'precondition_failed' });
    }
    expect(await read(b, slug)).toEqual(recreated);
  }, TEST_MS);

  test('page-only updates preserve existing tags, links and extracted timeline rows', async () => {
    const slug = 'conversations/cas-side-effects';
    await seed(slug);
    await seed('cas/linked-example');
    await a.addTag(slug, 'preserved', { sourceId: sourceA });
    await a.addLink(slug, 'cas/linked-example', 'Existing', 'related', 'manual', undefined, undefined,
      { fromSourceId: sourceA, toSourceId: sourceA });
    await a.addTimelineEntry(slug, { date: '2026-01-01', summary: 'Existing event' }, { sourceId: sourceA });
    const before = await read(a, slug);
    const baseline = await derivatives(a, slug);
    const value = { ...page('[[cas/linked-example]] [[cas/new-edge]] `src/example.ts`\n2026-02-02: Example event'),
      timeline: '- 2026-02-02: New event which must remain page text only' };
    await put(a, slug, before.revision, value);
    expect((await read(b, slug)).page).toEqual(value);
    const after = await derivatives(b, slug);
    for (const key of ['tags', 'links', 'timeline_entries']) expect(after[key]).toEqual(baseline[key]);
    await expect(put(a, slug, before.revision)).rejects.toMatchObject({ code: 'precondition_failed' });
    expect(await derivatives(b, slug)).toEqual(after);
  }, TEST_MS);

  test('failure after checked update rolls page, revision, tags and derivatives back atomically', async () => {
    const slug = 'cas/rollback';
    await seed(slug);
    await a.addTag(slug, 'original-tag', { sourceId: sourceA });
    await a.createVersion(slug, { sourceId: sourceA });
    const before = await read(a, slug);
    const baseline = await derivatives(a, slug);
    const failure = new Error('synthetic failure after checked page update');
    const failing = beforeCommit(a, async tx => {
      expect((await read(tx, slug)).revision).not.toBe(before.revision);
      expect((await read(tx, slug)).page.compiled_truth).toBe('Uncommitted replacement');
      await tx.addTag(slug, 'uncommitted-tag', { sourceId: sourceA });
      expect(await read(b, slug)).toEqual(before);
      throw failure;
    });
    await expect(put(failing, slug, before.revision, page('Uncommitted replacement'))).rejects.toBe(failure);
    expect(await read(b, slug)).toEqual(before);
    expect(await derivatives(b, slug)).toEqual(baseline);
    // Rolled-back token changes cannot poison a subsequent legitimate CAS.
    await put(b, slug, before.revision, page('Committed after rollback'));
    expect((await read(a, slug)).page.compiled_truth).toBe('Committed after rollback');
  }, TEST_MS);
});
