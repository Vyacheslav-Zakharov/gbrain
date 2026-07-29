import { describe, expect, test } from 'bun:test';
import { filterSourcesForCaller, operations, resolveFederatedWriteSourceId } from '../src/core/operations.ts';

describe('federated put_page write routing', () => {
  const remoteCtx = {
    remote: true,
    sourceId: 'alice-example',
    auth: {
      sourceId: 'alice-example',
      writeSources: ['alice-example', 'internal-example'],
    },
  } as any;

  test.each(['put_page', 'delete_page', 'add_timeline_entry'])(
    '%s exposes an explicit source_id parameter',
    (name) => {
      const op = operations.find((candidate) => candidate.name === name);
      expect(op).toBeDefined();
      expect(op!.params.source_id).toMatchObject({ type: 'string', required: false });
    },
  );

  test('allows an explicitly granted federated write source', () => {
    expect(resolveFederatedWriteSourceId(remoteCtx, 'internal-example')).toBe('internal-example');
  });

  test('defaults to the scalar personal source when omitted', () => {
    expect(resolveFederatedWriteSourceId(remoteCtx, undefined)).toBe('alice-example');
  });

  test('rejects an ungranted source before writing', () => {
    expect(() => resolveFederatedWriteSourceId(remoteCtx, 'restricted-example')).toThrow(
      "Permission denied for writing to source_id 'restricted-example'",
    );
  });

  test('trusted local callers retain explicit source routing', () => {
    expect(resolveFederatedWriteSourceId({ remote: false, sourceId: 'default' } as any, 'internal-example'))
      .toBe('internal-example');
  });

  test.each(['delete_page', 'add_timeline_entry'])(
    '%s rejects an ungranted source_id before mutation',
    async (name) => {
      const op = operations.find((candidate) => candidate.name === name)!;
      await expect(op.handler({ ...remoteCtx, dryRun: true } as any, {
        slug: 'topics/example',
        source_id: 'restricted-example',
        date: '2026-07-29',
        summary: 'not written',
      })).rejects.toThrow("Permission denied for writing to source_id 'restricted-example'");
    },
  );
});

describe('remote source metadata visibility', () => {
  test('returns only granted sources and strips host-local paths', () => {
    const ctx = {
      remote: true,
      sourceId: 'alice-example',
      auth: { allowedSources: ['alice-example', 'internal-example'] },
    } as any;
    const rows = [
      { id: 'alice-example', local_path: '/private/alice', name: 'Alice' },
      { id: 'internal-example', local_path: '/private/internal', clone_dir: '/private/clone', name: 'Internal' },
      { id: 'restricted-example', local_path: '/private/restricted', name: 'Restricted' },
    ];
    expect(filterSourcesForCaller(ctx, rows)).toEqual([
      { id: 'alice-example', name: 'Alice' },
      { id: 'internal-example', name: 'Internal' },
    ]);
  });

  test('trusted local callers retain the full source catalog', () => {
    const rows = [{ id: 'restricted-example', local_path: '/local/path' }];
    expect(filterSourcesForCaller({ remote: false } as any, rows)).toBe(rows);
  });
});
