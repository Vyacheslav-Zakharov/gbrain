import { describe, expect, test } from 'bun:test';
import {
  buildLlmTakeDraft,
  TAKE_REVISION_PROMPT_VERSION,
  type TakeDraft,
} from '../src/core/ai-review';
import { formatChangedDraftFields } from '../admin/src/review-diff';

const current: TakeDraft = {
  claim_text: 'Original claim',
  kind: 'take',
  holder: 'brain',
  weight: 0.9,
  domain: 'security',
  since_date: null,
  source: null,
};

describe('AI Review draft preservation', () => {
  test('an LLM claim revision cannot silently rewrite metadata', () => {
    const draft = buildLlmTakeDraft(current, {
      claim_text: 'Переведённое утверждение',
      kind: 'fact',
      holder: 'author',
      weight: 0.2,
      domain: 'other',
      since_date: '2026-01-01',
      source: 'invented-source',
    });
    expect(draft).toEqual({ ...current, claim_text: 'Переведённое утверждение' });
  });

  test('prompt version invalidates cached drafts created under the old contract', () => {
    expect(TAKE_REVISION_PROMPT_VERSION).toBe('ai-review-take-revision-v2');
  });

  test('diff text includes only changed fields', () => {
    const next = { ...current, claim_text: 'Переведённое утверждение' };
    const text = formatChangedDraftFields(current, next, ['claim_text']);
    expect(text).toContain('- claim_text: "Original claim"');
    expect(text).toContain('+ claim_text: "Переведённое утверждение"');
    expect(text).not.toContain('holder');
    expect(text).not.toContain('source');
    expect(text).not.toContain('weight');
  });
});
