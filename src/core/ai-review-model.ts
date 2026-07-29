import type { BrainEngine } from './engine.ts';
import { resolveModel } from './model-config.ts';

export const AI_REVIEW_TAKE_MAX_TOKENS = 2048;
export const AI_REVIEW_CONCEPT_MAX_TOKENS = 4096;

/**
 * Runtime model selection for human-requested AI Review revisions.
 *
 * A proposal's model_id is immutable generation provenance, not a routing
 * instruction for later reviewer requests. New revisions follow the current
 * chat configuration unless the request explicitly supplies an override.
 */
export async function resolveAiReviewRevisionModel(
  engine: BrainEngine,
  explicitModel?: string,
): Promise<string> {
  return resolveModel(engine, {
    cliFlag: explicitModel,
    configKey: 'models.chat',
    tier: 'reasoning',
    envVar: 'GBRAIN_MODEL',
    fallback: 'anthropic:claude-sonnet-4-6',
  });
}
