import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine';
import {
  AI_REVIEW_CONCEPT_MAX_TOKENS,
  AI_REVIEW_TAKE_MAX_TOKENS,
  resolveAiReviewRevisionModel,
} from '../src/core/ai-review-model';

function configEngine(values: Record<string, string>): BrainEngine {
  return {
    getConfig: async (key: string) => values[key] ?? null,
  } as unknown as BrainEngine;
}

describe('AI Review revision model routing', () => {
  test('uses the current models.chat runtime configuration by default', async () => {
    const engine = configEngine({
      'models.chat': 'google:gemini-3.1-pro-preview',
      'models.tier.reasoning': 'anthropic:claude-sonnet-4-6',
    });
    expect(await resolveAiReviewRevisionModel(engine)).toBe('google:gemini-3.1-pro-preview');
  });

  test('keeps an explicit request override above models.chat', async () => {
    const engine = configEngine({ 'models.chat': 'google:gemini-3.1-pro-preview' });
    expect(await resolveAiReviewRevisionModel(engine, 'sonnet')).toBe('anthropic:claude-sonnet-4-6');
  });

  test('uses bounded ceilings that leave room for reasoning-model output', () => {
    expect(AI_REVIEW_TAKE_MAX_TOKENS).toBe(2048);
    expect(AI_REVIEW_CONCEPT_MAX_TOKENS).toBe(4096);
  });
});
