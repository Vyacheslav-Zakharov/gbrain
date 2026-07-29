import { describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';

import { computeSnapshotSchemaHash } from '../src/core/pglite-engine.ts';
import { getPGLiteSchema } from '../src/core/pglite-schema.ts';

describe('PGLite snapshot compatibility hash', () => {
  const migrations = [
    { version: 1, name: 'fixture', sql: 'SELECT 1' },
  ];

  test('changes when the rendered embedding dimension changes', () => {
    const hash1280 = computeSnapshotSchemaHash(
      migrations,
      getPGLiteSchema(1280, 'zeroentropyai:zembed-1'),
      crypto,
    );
    const hash1536 = computeSnapshotSchemaHash(
      migrations,
      getPGLiteSchema(1536, 'openai:text-embedding-3-large'),
      crypto,
    );

    expect(hash1280).not.toBe(hash1536);
  });

  test('is deterministic for the same rendered schema', () => {
    const schema = getPGLiteSchema(1280, 'zeroentropyai:zembed-1');
    expect(computeSnapshotSchemaHash(migrations, schema, crypto)).toBe(
      computeSnapshotSchemaHash(migrations, schema, crypto),
    );
  });
});
