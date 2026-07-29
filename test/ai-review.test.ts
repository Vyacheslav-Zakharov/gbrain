import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acceptTakeProposal, rejectTakeProposal } from '../src/core/ai-review.ts';
import { acceptConceptProposal, createManualConceptRevision } from '../src/core/concept-review.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { contentHash } from '../src/core/cycle/propose-takes.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let dir = '';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'gbrain-ai-review-'));
  await engine.executeRaw(`INSERT INTO sources (id,name,local_path,config) VALUES ('review-test','Review test',$1,'{}'::jsonb)`, [dir]);
});

async function seedProposal(): Promise<number> {
  const markdown = `---\ntype: note\ntitle: Review source\n---\n\nSource prose that supports a bounded claim.\n`;
  await importFromContent(engine, 'notes/review-source', markdown, { sourceId: 'review-test', noEmbed: true });
  const page = await engine.getPage('notes/review-source', { sourceId: 'review-test' });
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
     VALUES ('review-test','notes/review-source',$1,'test-v1','run-test','claim-1','Supported bounded claim','take','world',0.7,'testing','stub') RETURNING id`,
    [contentHash(page!.compiled_truth)],
  );
  return rows[0].id;
}

describe('AI review canonical acceptance', () => {
  test('accept writes the takes fence, verifies file write, and records audit', async () => {
    const id = await seedProposal();
    const result = await acceptTakeProposal(engine, id, {
      claim_text: 'Supported bounded claim', kind: 'take', holder: 'world', weight: 0.7,
      domain: 'testing', source: 'evidence:test',
    }, 'admin-test');
    expect(result.proposal.status).toBe('accepted');
    expect(result.publication?.db_indexed).toBe(true);
    expect(result.publication?.file_written).toBe(true);
    const file = readFileSync(join(dir, 'notes/review-source.md'), 'utf8');
    expect(file).toContain('<!--- gbrain:takes:begin -->');
    expect(file).toContain('Supported bounded claim');
    const events = await engine.executeRaw<{ action: string }>(`SELECT action FROM ai_review_events WHERE target_type='take_proposal' AND target_id=$1`, [id]);
    expect(events.map(e => e.action)).toContain('accept');
  });

  test('reject changes only proposal state and records audit', async () => {
    const id = await seedProposal();
    const result = await rejectTakeProposal(engine, id, 'admin-test', 'unsupported');
    expect(result.proposal.status).toBe('rejected');
    const page = await engine.getPage('notes/review-source', { sourceId: 'review-test' });
    expect(page!.compiled_truth).not.toContain('gbrain:takes:begin');
    const events = await engine.executeRaw<{ details: { reason: string } }>(`SELECT details FROM ai_review_events WHERE target_id=$1`, [id]);
    expect(events[0].details.reason).toBe('unsupported');
  });
});

describe('Concept review canonical acceptance', () => {
  async function seedConcept(markdown = `---\ntype: concept\ntitle: Theme\nsynthesized_by: synthesize_concepts\n---\n\nProposed concept narrative.\n`): Promise<number> {
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO concept_proposals
         (source_id,page_slug,source_content_hash,destination_content_hash,prompt_version,proposal_run_id,proposed_markdown,source_atoms,model_id)
       VALUES ('review-test','concepts/theme','atoms-hash',NULL,'test-v1','run-test',$1,$2::text::jsonb,'stub') RETURNING id`,
      [markdown, JSON.stringify([{ source_id: 'review-test', slug: 'atoms/a' }])],
    );
    return rows[0].id;
  }

  test('manual edit is durable before explicit concept publication', async () => {
    const id = await seedConcept();
    const edited = `---\ntype: concept\ntitle: Theme\nsynthesized_by: synthesize_concepts\n---\n\nHuman-reviewed concept narrative.\n`;
    const revision = await createManualConceptRevision(engine, id, edited, 'admin-test');
    const result = await acceptConceptProposal(engine, id, edited, 'admin-test', { revisionId: revision.revision_id });
    expect(result.proposal.status).toBe('accepted');
    expect(readFileSync(join(dir, 'concepts/theme.md'), 'utf8')).toContain('Human-reviewed concept narrative');
    const saved = await engine.executeRaw<{ status: string }>(`SELECT status FROM ai_review_revisions WHERE id=$1`, [revision.revision_id]);
    expect(saved[0].status).toBe('applied');
  });

  test('refuses to overwrite an existing destination without explicit stale approval', async () => {
    await importFromContent(engine, 'concepts/theme', `---\ntype: concept\ntitle: Manual theme\n---\n\nHuman canonical content.\n`, { sourceId: 'review-test', noEmbed: true });
    const id = await seedConcept();
    await expect(acceptConceptProposal(engine, id, undefined, 'admin-test')).rejects.toMatchObject({ code: 'stale_destination' });
    const page = await engine.getPage('concepts/theme', { sourceId: 'review-test' });
    expect(page?.compiled_truth).toContain('Human canonical content');
  });
});

describe('AI Review migration compatibility', () => {
  test('uses migration 130 above the deployed Source Ingest watermark', () => {
    const migration = MIGRATIONS.find((entry) => entry.name === 'ai_review_foundation');
    expect(migration?.version).toBe(130);
    expect(migration?.sql).toContain('ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS claim_hash TEXT');
  });

  test('schema bootstrap upgrades existing take_proposals before replacing its index', () => {
    const schema = readFileSync(join(import.meta.dir, '../src/schema.sql'), 'utf8');
    const addClaimHash = schema.indexOf('ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS claim_hash TEXT');
    const dropOldIndex = schema.indexOf('DROP INDEX IF EXISTS take_proposals_idempotency_idx');
    const createNewIndex = schema.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS take_proposals_idempotency_idx');
    expect(addClaimHash).toBeGreaterThan(-1);
    expect(dropOldIndex).toBeGreaterThan(addClaimHash);
    expect(createNewIndex).toBeGreaterThan(dropOldIndex);
  });
});
