import type { BrainEngine } from './engine.ts';
import type { ResolvedColumn } from './types.ts';
import { resolveEmbeddingColumn } from './search/embedding-column.ts';
import { loadTextEmbeddingConfig, textEmbeddingColumn } from './text-embedding-column.ts';
import { embedBatch, embedQuery, type EmbedBatchOptions } from './embedding.ts';
import type { SearchOpts } from './types.ts';
import { isAvailable } from './ai/gateway.ts';

const columns = new WeakMap<BrainEngine, ResolvedColumn>();
export function selectedTextColumn(engine: BrainEngine): ResolvedColumn | undefined { return columns.get(engine); }

/** Opt-in page-only facade. Never changes gateway defaults or legacy provenance. */
export async function selectedTextEngine(engine: BrainEngine): Promise<BrainEngine> {
  if (columns.has(engine)) return engine;
  const cfg = await loadTextEmbeddingConfig(engine);
  if (!cfg?.search_embedding_column || cfg.search_embedding_column === 'embedding') return engine;
  const column = resolveEmbeddingColumn(undefined, cfg);
  textEmbeddingColumn(column);
  return bindSelectedTextEngine(engine, column);
}

function bindSelectedTextEngine(engine: BrainEngine, column: ResolvedColumn): BrainEngine {
  const facade = new Proxy(engine, {
    get(target, key) {
      // Transactions hand callbacks a new engine; keep the resolved column
      // without re-reading configuration inside the transaction.
      if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<any>) =>
        target.transaction((tx) => fn(bindSelectedTextEngine(tx, column)));
      if (key === 'upsertChunks' || key === 'getChunks') return (slug: string, ...args: any[]) => {
        if (key === 'upsertChunks') return target.upsertChunks(slug, args[0], { ...args[1], embeddingColumn: column });
        return target.getChunks(slug, { ...args[0], embeddingColumn: column });
      };
      if (key === 'countStaleChunks' || key === 'listStaleChunks' || key === 'sumStaleChunkChars') return (opts: any) => target[key]({ ...opts, embeddingColumn: column });
      // pages.embedding_signature belongs to the primary vector space. Never
      // invalidate or relabel it when writing a separately selected column.
      if (key === 'invalidateStaleSignatureEmbeddings') return async () => 0;
      if (key === 'setPageEmbeddingSignature') return async () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  columns.set(facade, column);
  return facade;
}

/** Embedding-only CAS: never replaces text, metadata, or the chunk set.
 * PostgreSQL rechecks this predicate after waiting on a concurrent row writer.
 * A changed/deleted chunk remains stale for the next pass.
 */
export async function applySelectedTextEmbeddings(
  engine: BrainEngine,
  chunks: Array<{ page_id: number; source_id: string; chunk_index: number; chunk_text: string }>,
  embeddings: Float32Array[],
): Promise<number> {
  const column = selectedTextColumn(engine);
  if (!column) throw new Error('Selected text column required');
  const target = textEmbeddingColumn(column);
  if (chunks.length !== embeddings.length) throw new Error('Embedding count mismatch');
  let applied = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i], vector = embeddings[i];
    if (vector.length !== column.dimensions || !vector.every(Number.isFinite)) throw new Error('Invalid selected embedding dimensions');
    const rows = await engine.executeRaw(`UPDATE content_chunks cc SET ${target.col} = $1::${target.cast}
      FROM pages p WHERE p.id = cc.page_id AND p.id = $2 AND p.source_id = $3
      AND p.deleted_at IS NULL AND cc.chunk_index = $4 AND cc.chunk_text = $5
      AND cc.${target.col} IS NULL RETURNING cc.id`,
      ['[' + Array.from(vector).join(',') + ']', c.page_id, c.source_id, c.chunk_index, c.chunk_text]);
    applied += rows.length;
  }
  return applied;
}

export async function preflightSelectedText(engine: BrainEngine): Promise<void> {
  const column = columns.get(engine);
  if (!column) return;
  const rows = await engine.executeRaw<{ shape: string }>(`SELECT format_type(a.atttypid, a.atttypmod) AS shape
    FROM pg_attribute a WHERE a.attrelid = 'content_chunks'::regclass
    AND a.attname = $1 AND a.attnum > 0 AND NOT a.attisdropped`, [column.name]);
  if (rows[0]?.shape !== `${column.type}(${column.dimensions})`) {
    throw new Error(`Selected text column ${column.name} expects ${column.type}(${column.dimensions}); found ${rows[0]?.shape ?? 'missing'}`);
  }
  if (!isAvailable('embedding', column.embeddingModel)) throw new Error(`Selected text embedding provider unavailable: ${column.embeddingModel}`);
}

export async function searchSelectedText(engine: BrainEngine, query: string, opts: SearchOpts = {}) {
  const selected = await selectedTextEngine(engine);
  const column = selectedTextColumn(selected);
  const embedding = await embedQuery(query, column ? { embeddingModel: column.embeddingModel, dimensions: column.dimensions } : {});
  return engine.searchVector(embedding, { ...opts, ...(column && { embeddingColumn: column }) });
}

export function embedTextBatch(engine: BrainEngine, texts: string[], opts: EmbedBatchOptions = {}): Promise<Float32Array[]> {
  const column = columns.get(engine);
  return embedBatch(texts, { ...opts, ...(column && { embeddingModel: column.embeddingModel, dimensions: column.dimensions }) });
}
