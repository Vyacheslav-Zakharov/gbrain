import type { BrainEngine } from './engine.ts';
import { chunkText, MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';

export interface CheckedPageFields {
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
}

/** DB-only unit: caller owns authorization, validation and owner approval. */
export async function updateCheckedPage(
  engine: BrainEngine,
  input: { source: string; slug: string; expectedRevision: string; page: CheckedPageFields },
  validateCurrent: (row: Record<string, unknown>, tx: BrainEngine) => Promise<void>,
  callerOwnsTransaction = false,
): Promise<Record<string, unknown> | null> {
  // Deterministic CPU work only, before acquiring database locks. No provider.
  const chunks = [
    ...chunkText(input.page.compiled_truth).map(c => ({ chunk_text: c.text, chunk_source: 'compiled_truth' as const })),
    ...chunkText(input.page.timeline).map(c => ({ chunk_text: c.text, chunk_source: 'timeline' as const })),
  ].map((c, chunk_index) => ({ ...c, chunk_index }));
  const apply = async (tx: BrainEngine) => {
    await tx.executeRaw("SET LOCAL lock_timeout = '5s'");
    await tx.executeRaw("SET LOCAL statement_timeout = '15s'");
    // Source configuration cannot acquire a file-backed home during this write.
    await tx.executeRaw('SELECT id FROM sources WHERE id = $1 FOR SHARE', [input.source]);
    const rows = await tx.executeRaw<Record<string, unknown>>(
      `SELECT * FROM pages WHERE source_id = $1 AND slug = $2
       AND write_revision = $3::uuid AND deleted_at IS NULL FOR UPDATE`,
      [input.source, input.slug, input.expectedRevision]);
    if (!rows.length) return null;
    await validateCurrent(rows[0], tx);
    // Lock chunk identities before checking FK edges; no cascade graph changes.
    await tx.executeRaw('SELECT id FROM content_chunks WHERE page_id = $1 ORDER BY id FOR UPDATE', [rows[0].id]);
    const edges = await tx.executeRaw<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM code_edges_chunk e JOIN content_chunks c
           ON c.id = e.from_chunk_id OR c.id = e.to_chunk_id WHERE c.page_id = $1
         UNION ALL
         SELECT 1 FROM code_edges_symbol e JOIN content_chunks c
           ON c.id = e.from_chunk_id WHERE c.page_id = $1
       ) AS present`, [rows[0].id]);
    if (edges[0]?.present) throw new Error('Checked page update excludes chunk-linked code graphs');
    await tx.createVersion(input.slug, { sourceId: input.source });
    const updated = await tx.executeRaw<Record<string, unknown>>(
      `UPDATE pages SET type = $4, title = $5, compiled_truth = $6, timeline = $7,
         frontmatter = $8::text::jsonb, content_hash = NULL, updated_at = clock_timestamp(),
         chunker_version = $9, embedding_signature = NULL
       WHERE source_id = $1 AND slug = $2 AND write_revision = $3::uuid AND deleted_at IS NULL
       RETURNING *`,
      [input.source, input.slug, input.expectedRevision, input.page.type, input.page.title,
        input.page.compiled_truth, input.page.timeline, JSON.stringify(input.page.frontmatter), MARKDOWN_CHUNKER_VERSION]);
    if (!updated.length) throw new Error('Checked page precondition changed inside locked transaction');
    // New IDs fence late embedding writes against the old snapshot, even title-only edits.
    await tx.deleteChunks(input.slug, { sourceId: input.source });
    if (chunks.length) await tx.upsertChunks(input.slug, chunks, { sourceId: input.source });
    return updated[0];
  };
  return callerOwnsTransaction ? apply(engine) : engine.transaction(apply);
}
