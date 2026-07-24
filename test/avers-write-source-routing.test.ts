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

  test('put_page exposes an explicit source_id parameter', () => {
    const op = operations.find((candidate) => candidate.name === 'put_page');
    expect(op).toBeDefined();
    expect(op!.params.source_id).toMatchObject({ type: 'string', required: false });
  });

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
