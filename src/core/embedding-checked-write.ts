import type { BrainEngine } from './engine.ts';
import type { Chunk, Page } from './types.ts';

export interface EmbeddingBaseline {
  slug: string;
  sourceId: string;
  page: Page;
  chunks: Chunk[];
  pageToken: string;
  chunkToken: string;
}

// Capture actual provider inputs under the same parent-first lock ordering
// used by checked page writes. No lock is held while a provider is running.
export async function readEmbeddingBaseline(engine: BrainEngine, slug: string, sourceId: string): Promise<EmbeddingBaseline | null> {
  return engine.transaction(async tx => {
    const [row] = await tx.executeRaw<{ id: number; token: string }>(
      'SELECT p.id, to_jsonb(p)::text AS token FROM pages p WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL FOR UPDATE', [slug, sourceId]);
    if (!row) return null;
    await tx.executeRaw('SELECT id FROM content_chunks WHERE page_id = $1 FOR UPDATE', [row.id]);
    const page = await tx.getPage(slug, { sourceId });
    if (!page) return null;
    const chunks = await tx.getChunks(slug, { sourceId });
    return { slug, sourceId, page, chunks, pageToken: row.token, chunkToken: JSON.stringify(chunks) };
  });
}

/** Fail closed on any page revision/context or chunk identity/metadata change. */
export async function withEmbeddingBaseline(engine: BrainEngine, baseline: EmbeddingBaseline, write: (tx: BrainEngine) => Promise<void>): Promise<boolean> {
  return engine.transaction(async tx => {
    const [row] = await tx.executeRaw<{ id: number; token: string }>(
      'SELECT p.id, to_jsonb(p)::text AS token FROM pages p WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL FOR UPDATE', [baseline.slug, baseline.sourceId]);
    if (!row || row.token !== baseline.pageToken) return false;
    await tx.executeRaw('SELECT id FROM content_chunks WHERE page_id = $1 FOR UPDATE', [row.id]);
    const chunks = await tx.getChunks(baseline.slug, { sourceId: baseline.sourceId });
    if (JSON.stringify(chunks) !== baseline.chunkToken) return false;
    await write(tx);
    return true;
  });
}
export interface EmbeddingCommit {
  slug: string;
  sourceId: string;
  /** Exact rows read before the provider call, in provider input order. */
  chunks: Pick<Chunk, 'id' | 'page_id' | 'chunk_index' | 'chunk_text'>[];
  embeddings: Float32Array[];
  signature?: string;
}
export async function commitCheckedEmbeddings(engine: BrainEngine, input: EmbeddingCommit): Promise<boolean> {
  if (!input.chunks.length || input.embeddings.length !== input.chunks.length) return false;
  const ids = new Set(input.chunks.map(c => c.id));
  if (ids.size !== input.chunks.length) return false;
  const model = input.signature?.slice(0, input.signature.lastIndexOf(':')) ?? null;
  return engine.transaction(async tx => {
    const [page] = await tx.executeRaw<{ id: number }>(
      'SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [input.slug, input.sourceId]);
    if (!page) return false;
    const current = await tx.executeRaw<{ id: number; chunk_index: number; chunk_text: string }>(
      'SELECT id, chunk_index, chunk_text FROM content_chunks WHERE page_id = $1 FOR UPDATE', [page.id]);
    if (input.chunks.some(c => c.page_id !== page.id || !current.some(r => r.id === c.id && r.chunk_index === c.chunk_index && r.chunk_text === c.chunk_text))) return false;
    for (let i = 0; i < input.chunks.length; i++) {
      await tx.executeRaw(
        'UPDATE content_chunks SET embedding = $1::vector, embedded_at = now(), model = $2 WHERE id = $3 AND page_id = $4',
        ['[' + Array.from(input.embeddings[i]).join(',') + ']', model, input.chunks[i].id, page.id]);
    }
    // A partial batch cannot claim page-wide provenance.
    if (input.signature && current.length === input.chunks.length) {
      await tx.executeRaw('UPDATE pages SET embedding_signature = $1 WHERE id = $2', [input.signature, page.id]);
    }
    return true;
  });
}
