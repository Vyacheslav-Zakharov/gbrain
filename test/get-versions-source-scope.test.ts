import { expect, test } from 'bun:test';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

const op = operations.find(op => op.name === 'get_versions')!;
const slug = 'wiki/history-example';
// A storage double makes every read scope observable; the real operation and
// authorization resolver run unchanged. No DB/config/network is opened.
function fixture(sources = ['shared'], overrides: Partial<OperationContext> = {}) {
  const reads: Array<[string, string | undefined]> = [];
  const snapshots = [{ version: 1, compiled_truth: `Public\n${TAKES_FENCE_BEGIN}\nprivate hunch\n${TAKES_FENCE_END}\nFooter` }];
  const engine = {
    async getPage(_slug: string, opts?: { sourceId?: string }) {
      reads.push(['page', opts?.sourceId]);
      if (!opts?.sourceId) throw new Error('unscoped page read');
      return sources.includes(opts.sourceId) ? { slug, source_id: opts.sourceId } : null;
    },
    async getVersions(_slug: string, opts?: { sourceId?: string }) {
      reads.push(['versions', opts?.sourceId]);
      return sources.includes(opts?.sourceId ?? 'default') ? snapshots : [];
    },
  } as unknown as BrainEngine;
  const ctx = { engine, config: {}, remote: true, sourceId: 'personal',
    auth: { allowedSources: ['personal', 'shared'] }, ...overrides } as OperationContext;
  return { reads, snapshots, ctx, run: (source_id?: string) => op.handler(ctx, { slug, ...(source_id === undefined ? {} : { source_id }) }) };
}

test('implicit unique federated page pins versions to the shared source', async () => {
  const f = fixture();
  expect(await f.run()).toEqual(f.snapshots);
  expect(f.reads).toEqual([['page', 'personal'], ['page', 'shared'], ['versions', 'shared']]);
});

test('denied explicit source performs no reads', async () => {
  const f = fixture();
  await expect(f.run('secret')).rejects.toMatchObject({ code: 'permission_denied' });
  expect(f.reads).toEqual([]);
});

test('duplicate exact slug fails before reading any versions', async () => {
  const f = fixture(['personal', 'shared']);
  await expect(f.run()).rejects.toMatchObject({ code: 'ambiguous_slug' });
  expect(f.reads.every(([kind]) => kind === 'page')).toBe(true);
  expect(await f.run('shared')).toEqual(f.snapshots);
});

test('missing page fails closed rather than reporting empty history', async () => {
  const f = fixture(['secret']);
  await expect(f.run()).rejects.toMatchObject({ code: 'page_not_found' });
  expect(f.reads).toEqual([['page', 'personal'], ['page', 'shared']]);
});

test('existing page with no versions returns an empty array', async () => {
  const f = fixture();
  f.snapshots.splice(0);
  expect(await f.run()).toEqual([]);
  expect(f.reads.at(-1)).toEqual(['versions', 'shared']);
});

test('takes fence is masked on every shared snapshot without mutating storage', async () => {
  const f = fixture(['shared'], { takesHoldersAllowList: ['world'] });
  const result = await f.run() as Array<{ compiled_truth: string }>;
  expect(result).toHaveLength(1);
  expect(result[0].compiled_truth).not.toContain('private hunch');
  expect(result[0].compiled_truth).toContain('Public');
  expect(result[0].compiled_truth).toContain('Footer');
  expect(f.snapshots[0].compiled_truth).toContain('private hunch');
});

test('remote caller without any source fails closed without storage access', async () => {
  for (const remote of [true, undefined]) {
    const f = fixture(['default'], { remote, sourceId: undefined, auth: undefined });
    await expect(f.run()).rejects.toMatchObject({ code: 'permission_denied' });
    expect(f.reads).toEqual([]);
  }
});

test('scalar-only remote source cannot request a different source', async () => {
  const f = fixture(['personal'], { auth: undefined });
  await expect(f.run('shared')).rejects.toMatchObject({ code: 'permission_denied' });
  expect(f.reads).toEqual([]);
  expect(await f.run()).toEqual(f.snapshots);
});

test('empty federated grant falls back to scalar, not all sources', async () => {
  const f = fixture(['personal'], { auth: { token: 'fixture-token', clientId: 'fixture-client', scopes: ['read'], allowedSources: [] } });
  expect(await f.run()).toEqual(f.snapshots);
  expect(f.reads).toEqual([['page', 'personal'], ['versions', 'personal']]);
});

test('trusted local default and explicit source preserve history and takes', async () => {
  const f = fixture(['default', 'shared'], { remote: false, sourceId: undefined, auth: undefined });
  expect(await f.run()).toEqual(f.snapshots);
  expect(f.reads).toEqual([['page', 'default'], ['versions', 'default']]);
  expect(await f.run('shared')).toEqual(f.snapshots);
});

test('__all__ remains bounded by the remote grant and never widens locally', async () => {
  const f = fixture();
  expect(await f.run('__all__')).toEqual(f.snapshots);
  const local = fixture(['default'], { remote: false, sourceId: undefined, auth: undefined });
  await expect(local.run('__all__')).rejects.toMatchObject({ code: 'permission_denied' });
  expect(local.reads).toEqual([]);
});

test('operation advertises optional source_id to generated MCP schema', () => {
  expect(op.params.source_id.type).toBe('string');
  expect(op.params.source_id.required).not.toBe(true);
});

test('explicit granted shared source returns history, not personal empty history', async () => {
  const f = fixture();
  expect(await f.run('shared')).toEqual(f.snapshots);
  expect(f.reads).toEqual([['page', 'shared'], ['versions', 'shared']]);
});
