import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';

// Dedicated disposable hosted service only: never fall back to user config,
// .env.testing, or the operator's DATABASE_URL.
const url = process.env.GBRAIN_VERSIONS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('get_versions source isolation through MCP dispatch and real Postgres', () => {
  let engine: PostgresEngine;
  const slug = 'wiki/version-history-example';
  const opts = { remote: true, sourceId: 'personal', takesHoldersAllowList: ['world'],
    auth: { token: 'test-token', clientId: 'test-client', sourceId: 'personal', allowedSources: ['personal', 'shared'], scopes: ['read'] } };
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/gbrain_versions_test') {
      throw new Error('Version tests require the dedicated localhost gbrain_versions_test database');
    }
    engine = new PostgresEngine();
    await engine.connect({ database_url: url! });
    await engine.initSchema();
    for (const source of ['personal', 'shared', 'secret']) {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    }
    for (const source of ['shared', 'secret']) {
      await engine.putPage(slug, { title: 'Example', type: 'note', compiled_truth: `${source} public\n${TAKES_FENCE_BEGIN}\nprivate hunch\n${TAKES_FENCE_END}\nfooter` }, { sourceId: source });
      await engine.createVersion(slug, { sourceId: source });
    }
    await engine.putPage('wiki/no-history', { title: 'New', type: 'note', compiled_truth: 'new' }, { sourceId: 'shared' });
  }, 120_000);
  afterAll(async () => { if (engine) await engine.disconnect(); }, 30_000);
  async function call(params: Record<string, unknown>) {
    return dispatchToolCall(engine, 'get_versions', params, opts);
  }
  test('explicit and implicit shared history is returned and masked', async () => {
    for (const params of [{ slug }, { slug, source_id: 'shared' }]) {
      const result = await call(params);
      expect(result.isError).toBeFalsy();
      const versions = JSON.parse(result.content[0].text);
      expect(versions).toHaveLength(1);
      expect(versions[0].compiled_truth).toContain('shared public');
      expect(versions[0].compiled_truth).not.toContain('private hunch');
      expect(versions[0].compiled_truth).not.toContain('secret');
    }
  });
  test('denied source and missing page fail, while existing no-history page is empty', async () => {
    const denied = await call({ slug, source_id: 'secret' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('permission_denied');
    const missing = await call({ slug: 'wiki/missing' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('page_not_found');
    const empty = await call({ slug: 'wiki/no-history' });
    expect(empty.isError).toBeFalsy();
    expect(JSON.parse(empty.content[0].text)).toEqual([]);
  });
  test('duplicate granted slug refuses implicit selection; explicit history remains usable', async () => {
    const duplicate = 'wiki/duplicate-history';
    for (const source of ['personal', 'shared']) {
      await engine.putPage(duplicate, { title: 'Duplicate', type: 'note', compiled_truth: source }, { sourceId: source });
      await engine.createVersion(duplicate, { sourceId: source });
    }
    const result = await call({ slug: duplicate });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ambiguous_slug');
    const explicit = await call({ slug: duplicate, source_id: 'shared' });
    expect(explicit.isError).toBeFalsy();
    expect(JSON.parse(explicit.content[0].text)[0].compiled_truth).toBe('shared');
  });
});
