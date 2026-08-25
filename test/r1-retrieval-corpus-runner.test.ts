import { describe, expect, test } from 'bun:test';
import {
  evaluateCorpusResult,
  parseCorpusLine,
  summarizeCorpus,
} from '../scripts/run-r1-retrieval-corpus.ts';

const row = parseCorpusLine(JSON.stringify({
  id: 'q01',
  query: 'корпоративная база знаний',
  source_id: 'shared',
  k: 5,
  critical: true,
  must_have: [{ source_id: 'shared', slug: 'digital/systems/gbrain', min_rank: 3 }],
  must_not_have: [{ source_id: 'internal-hr', slug: 'private/person' }],
}));

describe('R1 retrieval corpus runner', () => {
  test('validates and normalizes a corpus row', () => {
    expect(row.id).toBe('q01');
    expect(row.k).toBe(5);
    expect(row.must_have[0].min_rank).toBe(3);
    expect(() => parseCorpusLine('{"id":"bad","query":"valid","k":0,"critical":true,"must_have":[],"must_not_have":[]}')).toThrow(/k/i);
  });

  test('evaluates ranked source-qualified expectations without exposing query text', () => {
    const result = evaluateCorpusResult(row, [
      { source_id: 'shared', slug: 'digital/systems/index' },
      { source_id: 'shared', slug: 'digital/systems/gbrain' },
    ], { vector_enabled: true });
    expect(result.passed).toBe(true);
    expect('query' in result).toBe(false);
    expect(result.query_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.must_have[0]).toMatchObject({ found_rank: 2, passed: true });
  });

  test('fails critical must-have rank and forbidden hits, then summarizes', () => {
    const failed = evaluateCorpusResult(row, [
      { source_id: 'internal-hr', slug: 'private/person' },
      { source_id: 'shared', slug: 'digital/systems/gbrain' },
      { source_id: 'shared', slug: 'other' },
      { source_id: 'shared', slug: 'another' },
    ], { vector_enabled: false });
    expect(failed.passed).toBe(false);
    expect(failed.must_not_have[0].passed).toBe(false);
    const summary = summarizeCorpus([failed]);
    expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1, critical_failed: 1 });
  });
});
