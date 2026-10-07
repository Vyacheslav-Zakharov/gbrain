/**
 * `migrate embeddings` compares the lock set (sorted in JavaScript) with the
 * post-lock census (`SELECT … ORDER BY id`, sorted by the database collation).
 * Under a non-C collation such as `en_US.utf8` the two orders disagree for ids
 * where one is a hyphen-prefix of the other (`alexandr-kalentyev` vs
 * `alexandra-mityushina`), and the positional comparison reported
 * "Source census changed while acquiring locks" on an idle brain, on every
 * retry. The comparison is a set comparison now.
 */
import { describe, expect, test } from 'bun:test';
import { sameSourceIdSet } from '../src/commands/migrate-embeddings.ts';

describe('migrate embeddings: source census comparison is collation-independent', () => {
  const jsOrder = ['alexandr-kalentyev', 'alexandra-mityushina', 'shared', 'vyacheslav-zakharov'];
  // What `ORDER BY id` returns under en_US.utf8: punctuation is ignored at the
  // first comparison level, so the longer alphabetic prefix wins.
  const enUsOrder = ['alexandra-mityushina', 'alexandr-kalentyev', 'shared', 'vyacheslav-zakharov'];

  test('the same ids in database-collation order match the JavaScript-sorted lock set', () => {
    expect(JSON.stringify(enUsOrder)).not.toBe(JSON.stringify([...jsOrder].sort()));
    expect(sameSourceIdSet(enUsOrder, [...jsOrder].sort())).toBe(true);
  });

  test('a genuinely changed census still fails', () => {
    expect(sameSourceIdSet(['a', 'b'], ['a'])).toBe(false);
    expect(sameSourceIdSet(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(sameSourceIdSet(['a', 'b', 'b'], ['a', 'a', 'b'])).toBe(false);
  });

  test('empty censuses match', () => {
    expect(sameSourceIdSet([], [])).toBe(true);
  });
});
