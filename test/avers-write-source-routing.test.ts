import { describe, expect, test } from 'bun:test';
import { operations, resolveFederatedWriteSourceId } from '../src/core/operations.ts';

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
