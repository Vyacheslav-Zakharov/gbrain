import { describe, expect, test } from 'bun:test';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../src/core/ai/defaults.ts';
import { MODE_BUNDLES, SEARCH_MODES } from '../src/core/search/mode.ts';

describe('R1 zero hosted-ZE default egress contract', () => {
  test('fresh/configless embedding defaults resolve to owner-approved Google 768d', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('google:gemini-embedding-001');
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(768);
  });

  test('every shipped search mode keeps reranking disabled and off ZeroEntropy', () => {
    for (const mode of SEARCH_MODES) {
      expect(MODE_BUNDLES[mode].reranker_enabled).toBe(false);
      expect(MODE_BUNDLES[mode].reranker_model.startsWith('zeroentropyai:')).toBe(false);
    }
  });
});
