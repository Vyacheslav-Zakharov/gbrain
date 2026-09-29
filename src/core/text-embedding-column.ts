import type { ChunkInput, ResolvedColumn } from './types.ts';
import type { BrainEngine } from './engine.ts';
import { loadConfig, type GBrainConfig } from './config.ts';
import { buildVectorCastFragment, resolveEmbeddingColumn, validateColumnConfig } from './search/embedding-column.ts';

/** Write authority must distinguish absent configuration from failed reads.
 * Keep file/env precedence, but never swallow DB I/O or malformed registry.
 */
export async function loadTextEmbeddingConfig(engine: BrainEngine): Promise<GBrainConfig> {
  const cfg = { ...(loadConfig() ?? { engine: 'postgres' as const }) };
  const selector = await engine.getConfig('search_embedding_column');
  const registry = await engine.getConfig('embedding_columns');
  if (cfg.search_embedding_column === undefined && selector) cfg.search_embedding_column = selector;
  if (cfg.embedding_columns === undefined && registry) {
    const parsed = JSON.parse(registry);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid embedding_columns registry');
    cfg.embedding_columns = parsed;
  }
  return cfg;
}

/** Invalidate the selected space even for legacy/no-embed chunk writers.
 * SQL runs in the same ON CONFLICT statement, scoped by the owning page ID.
 */
export async function selectedTextInvalidation(engine: BrainEngine, writtenColumn?: ResolvedColumn): Promise<string> {
  const cfg = await loadTextEmbeddingConfig(engine);
  if (!cfg?.search_embedding_column || cfg.search_embedding_column === 'embedding') return '';
  const selected = resolveEmbeddingColumn(undefined, cfg);
  const target = textEmbeddingColumn(selected);
  if (selected.name === writtenColumn?.name) return '';
  return `${target.col} = CASE WHEN EXCLUDED.chunk_text IS DISTINCT FROM content_chunks.chunk_text THEN NULL ELSE content_chunks.${target.col} END,`;
}

/** Config-free engine seam: callers resolve the registry at their boundary. */
export function textEmbeddingColumn(column?: ResolvedColumn): { col: string; cast: string; custom: boolean } {
  if (!column) return { col: 'embedding', cast: 'vector', custom: false };
  resolveEmbeddingColumn({ embeddingColumn: column }, { engine: 'pglite' });
  validateColumnConfig(column.name, { provider: column.embeddingModel, dimensions: column.dimensions, type: column.type });
  if (column.name === 'embedding_image' || column.name === 'embedding_multimodal') {
    throw new Error(`Not a text embedding column: ${column.name}`);
  }
  const { col, castSql } = buildVectorCastFragment(column);
  return { col, cast: castSql.slice(4), custom: column.name !== 'embedding' };
}

export function validateChunkEmbeddingDimensions(chunks: ChunkInput[], column?: ResolvedColumn): void {
  if (!column) return;
  textEmbeddingColumn(column);
  for (const chunk of chunks) {
    if (chunk.embedding && (chunk.embedding.length !== column.dimensions || !chunk.embedding.every(Number.isFinite))) {
      throw new Error(`Invalid embedding for ${column.name}: expected ${column.dimensions} finite dimensions`);
    }
  }
}
