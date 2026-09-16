import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Missing module is deliberately an assertion failure in the initial RED receipt.
async function caller() {
  const module = await import('../src/core/markdown-projection.ts').catch(() => ({}));
  expect('materializeMarkdownProjection' in module).toBe(true);
  return (module as typeof import('../src/core/markdown-projection.ts')).materializeMarkdownProjection;
}

test('disabled/unconfigured caller does not inspect snapshot or mutate a real fixture', async () => {
  const run = await caller();
  const root = mkdtempSync(join(tmpdir(), 'projection-test-'));
  try {
    writeFileSync(join(root, 'sentinel'), 'unchanged');
    const snapshot = new Proxy({}, { get() { throw new Error('snapshot accessed'); } });
    for (const policy of [undefined, { mode: 'disabled' }, { mode: 'db_only' }]) {
      expect(run({ policy, snapshot })).toEqual({ status: 'not_required', reason: 'disabled_or_unconfigured', materialized: false });
    }
    expect(readdirSync(root)).toEqual(['sentinel']);
    expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enabled caller plans source-scoped Markdown but remains pending with no writes', async () => {
  const run = await caller();
  const root = mkdtempSync(join(tmpdir(), 'projection-test-'));
  try {
    const policy = { mode: 'projection_required', sourceId: 'source-a', root: join(root, 'managed'), managed: true, inputRoots: [join(root, 'input')] };
    const snapshot = { sourceId: 'source-a', pageId: 'page-1', generation: 1, pageKind: 'markdown', slug: 'notes/example', title: 'Example', body: 'Body', tags: ['z', 'a'], sourcePath: 'original.pdf' };
    const result = run({ policy, snapshot });
    expect(result.status).toBe('pending');
    expect(result.materialized).toBe(false);
    expect(result.reason).toBe('durable_adapter_not_connected');
    expect(result.plan?.path).toBe(join(root, 'managed', 'source-a', 'notes', 'example.md'));
    expect(result.plan?.markdown).toContain('tags: ["a","z"]');
    expect(result.plan?.markdown).toContain('Body');
    expect(run({ policy, snapshot }).plan).toEqual(result.plan);
    for (const bad of [
      { policy: { ...policy, managed: false }, snapshot },
      { policy: { ...policy, root: policy.inputRoots[0] }, snapshot },
      { policy: { ...policy, root: '/' }, snapshot },
      { policy: { ...policy, root: 'relative' }, snapshot },
      { policy: { ...policy, mode: 'unknown' }, snapshot },
      { policy: { ...policy, sourceId: 'source-b' }, snapshot },
      { policy, snapshot: { ...snapshot, sourceId: '../escape' } },
      { policy, snapshot: { ...snapshot, pageKind: 'attachment' } },
      ...['../escape', '/absolute', 'a/../escape', 'a\\escape', 'file.pdf', 'a//b'].map(slug => ({ policy, snapshot: { ...snapshot, slug } })),
    ]) {
      expect(run(bad).status).toBe('blocked');
      expect(run(bad).materialized).toBe(false);
      expect(run(bad).plan).toBeUndefined();
    }
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

