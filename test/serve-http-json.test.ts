import { describe, expect, test } from 'bun:test';
import { jsonBigIntReplacer } from '../src/commands/serve-http.ts';

describe('serve-http JSON bigint serialization', () => {
  test('serializes ordinary BIGINT ids as numbers for admin API clients', () => {
    expect(JSON.stringify({ id: 419n }, jsonBigIntReplacer)).toBe('{"id":419}');
  });

  test('serializes out-of-range BIGINT values as strings without precision loss', () => {
    const id = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(JSON.stringify({ id }, jsonBigIntReplacer)).toBe('{"id":"9007199254740992"}');
  });

  test('leaves non-bigint values unchanged', () => {
    expect(JSON.stringify({ id: 7, ok: true }, jsonBigIntReplacer)).toBe('{"id":7,"ok":true}');
  });
});