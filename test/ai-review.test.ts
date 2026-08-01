import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  acceptTakeProposal,
  deferTakeProposal,
  rejectTakeProposal,
  restoreTakeProposalToPending,
} from '../src/core/ai-review.ts';
import { acceptConceptProposal, createManualConceptRevision } from '../src/core/concept-review.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { contentHash, proposalClaimHash, runPhaseProposeTakes, PROPOSE_TAKES_PROMPT_VERSION, type ProposedTake } from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
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

async function seedProposal(suffix = '1'): Promise<number> {
  const markdown = `---\ntype: note\ntitle: Review source\n---\n\nSource prose that supports a bounded claim.\n`;
  await importFromContent(engine, 'notes/review-source', markdown, { sourceId: 'review-test', noEmbed: true });
  const page = await engine.getPage('notes/review-source', { sourceId: 'review-test' });
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
     VALUES ('review-test','notes/review-source',$1,'test-v1','run-test',$2,$3,'take','world',0.7,'testing','stub') RETURNING id`,
    [contentHash(page!.compiled_truth), `claim-${suffix}`, `Supported bounded claim ${suffix}`],
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

  test('reject rolls back the status when the audit event cannot be written', async () => {
    const id = await seedProposal();
    await engine.executeRaw(
      `ALTER TABLE ai_review_events ADD CONSTRAINT reject_event_test CHECK (action <> 'reject')`,
    );
    try {
      await expect(rejectTakeProposal(engine, id, 'admin-test', 'must roll back')).rejects.toThrow();
    } finally {
      await engine.executeRaw(`ALTER TABLE ai_review_events DROP CONSTRAINT reject_event_test`);
    }
    const rows = await engine.executeRaw<{ status: string; acted_at: string | null; acted_by: string | null }>(
      `SELECT status, acted_at, acted_by FROM take_proposals WHERE id=$1`, [id],
    );
    expect(rows[0]).toMatchObject({ status: 'pending', acted_at: null, acted_by: null });
  });

  test('defer and restore are audited reversible state transitions without canonical writes', async () => {
    const id = await seedProposal();
    const deferred = await deferTakeProposal(engine, id, 'admin-test', 'capacity');
    expect(deferred.proposal.status).toBe('deferred');
    expect(deferred.proposal.acted_by).toBe('admin-test');

    const restored = await restoreTakeProposalToPending(engine, id, 'admin-test', 'rollback rehearsal');
    expect(restored.proposal.status).toBe('pending');
    expect(restored.proposal.acted_at).toBeNull();
    expect(restored.proposal.acted_by).toBeNull();

    const page = await engine.getPage('notes/review-source', { sourceId: 'review-test' });
    expect(page!.compiled_truth).not.toContain('gbrain:takes:begin');
    const events = await engine.executeRaw<{ action: string; details: { reason: string } }>(
      `SELECT action, details FROM ai_review_events WHERE target_id=$1 ORDER BY id`, [id],
    );
    expect(events.map(event => event.action)).toEqual(['defer', 'restore']);
    expect(events.map(event => event.details.reason)).toEqual(['capacity', 'rollback rehearsal']);
  });

  test('restore can roll back a governed rejection but never an accepted proposal', async () => {
    const rejectedId = await seedProposal();
    await rejectTakeProposal(engine, rejectedId, 'admin-test', 'unsupported');
    const restored = await restoreTakeProposalToPending(engine, rejectedId, 'admin-test', 'operator rollback');
    expect(restored.proposal.status).toBe('pending');

    const acceptedId = await seedProposal('2');
    await acceptTakeProposal(engine, acceptedId, undefined, 'admin-test');
    await expect(restoreTakeProposalToPending(engine, acceptedId, 'admin-test'))
      .rejects.toMatchObject({ code: 'stale_status' });
  });

  test('restore refuses to create a second pending revision of the same claim', async () => {
    const deferredId = await seedProposal();
    await deferTakeProposal(engine, deferredId, 'admin-test', 'capacity');
    const newer = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       SELECT source_id,page_slug,'newer-content','test-v2','run-newer','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',claim_text,kind,holder,weight,domain,model_id
         FROM take_proposals WHERE id=$1
       RETURNING id`,
      [deferredId],
    );

    await expect(restoreTakeProposalToPending(engine, deferredId, 'admin-test', 'late rollback'))
      .rejects.toMatchObject({ code: 'newer_pending_exists' });
    const states = await engine.executeRaw<{ id: number; status: string }>(
      `SELECT id, status FROM take_proposals WHERE id IN ($1,$2) ORDER BY id`,
      [deferredId, newer[0].id],
    );
    expect(states.map(row => row.status)).toEqual(['deferred', 'pending']);
  });

  test('restore treats whitespace, empty, and null domains as one identity across mixed hashes', async () => {
    const deferredId = await seedProposal();
    await deferTakeProposal(engine, deferredId, 'admin-test', 'capacity');
    await engine.executeRaw(
      `UPDATE take_proposals
          SET claim_hash='0123456789abcdef0123456789abcdef', domain='   '
        WHERE id=$1`,
      [deferredId],
    );
    const pending = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       SELECT source_id,page_slug,'blank-domain-content','test-v3','run-blank-domain',
              'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              claim_text,kind,holder,weight,NULL,model_id
         FROM take_proposals WHERE id=$1
       RETURNING id`,
      [deferredId],
    );

    await expect(restoreTakeProposalToPending(engine, deferredId, 'admin-test', 'mixed-domain rollback'))
      .rejects.toMatchObject({ code: 'newer_pending_exists' });
    const states = await engine.executeRaw<{ id: number; status: string }>(
      `SELECT id, status FROM take_proposals WHERE id IN ($1,$2) ORDER BY id`,
      [deferredId, pending[0].id],
    );
    expect(states.map(row => row.status)).toEqual(['deferred', 'pending']);
  });

  test('producer suppresses terminal history even when the stored row uses the legacy MD5 hash contract', async () => {
    const id = await seedProposal();
    await engine.executeRaw(`UPDATE take_proposals SET claim_hash='0123456789abcdef0123456789abcdef' WHERE id=$1`, [id]);
    await rejectTakeProposal(engine, id, 'admin-test', 'confirmed generic low-value claim');
    const proposal: ProposedTake = {
      claim_text: 'Supported bounded claim 1', kind: 'take', holder: 'world', weight: 0.7, domain: 'testing',
    };
    const ctx: OperationContext = {
      engine,
      config: {} as never,
      logger: { info() {}, warn() {}, error() {} } as never,
      dryRun: false,
      remote: false,
      sourceId: 'review-test',
    };
    const result = await runPhaseProposeTakes(ctx, {
      promptVersion: 'future-governed-v2',
      extractor: async () => [proposal],
    });
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(0);
    expect((result.details as Record<string, unknown>).proposals_suppressed).toBe(1);
    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE source_id='review-test' AND page_slug='notes/review-source'`,
    );
    expect(rows.map(row => row.status)).toEqual(['rejected']);
  });

  test('producer replaces a restored old revision and leaves other claims independent', async () => {
    const oldId = await seedProposal();
    const proposal: ProposedTake = {
      claim_text: 'Supported bounded claim 1', kind: 'take', holder: 'world', weight: 0.7, domain: 'testing',
    };
    const claimHash = proposalClaimHash(proposal);
    await engine.executeRaw(`UPDATE take_proposals SET claim_hash=$2 WHERE id=$1`, [oldId, claimHash]);
    await deferTakeProposal(engine, oldId, 'admin-test', 'capacity');
    await restoreTakeProposalToPending(engine, oldId, 'admin-test', 'operator restore');

    const page = await engine.getPage('notes/review-source', { sourceId: 'review-test' });
    const other = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       VALUES ('review-test','notes/review-source',$1,$2,'run-other','other-claim','Independent claim','take','world',0.6,'testing','stub')
       RETURNING id`,
      [contentHash(page!.compiled_truth), PROPOSE_TAKES_PROMPT_VERSION],
    );
    const ctx: OperationContext = {
      engine,
      config: {} as never,
      logger: { info() {}, warn() {}, error() {} } as never,
      dryRun: false,
      remote: false,
      sourceId: 'review-test',
    };
    const result = await runPhaseProposeTakes(ctx, { extractor: async () => [proposal] });
    expect(result.status).toBe('ok');

    const sameClaim = await engine.executeRaw<{ id: number; status: string }>(
      `SELECT id,status FROM take_proposals
        WHERE source_id='review-test' AND page_slug='notes/review-source' AND claim_hash=$1
        ORDER BY id`,
      [claimHash],
    );
    expect(sameClaim.map(row => row.status)).toEqual(['superseded', 'pending']);
    const independent = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [other[0].id]);
    expect(independent[0].status).toBe('pending');
  });

  test('database rejects a second pending row for the same claim but allows a different claim', async () => {
    const id = await seedProposal();
    await expect(engine.executeRaw(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       SELECT source_id,page_slug,'second-content','test-v2','run-second',claim_hash,claim_text,kind,holder,weight,domain,model_id
         FROM take_proposals WHERE id=$1`,
      [id],
    )).rejects.toThrow();
    const different = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       SELECT source_id,page_slug,'second-content','test-v2','run-second','different-claim','Different claim',kind,holder,weight,domain,model_id
         FROM take_proposals WHERE id=$1 RETURNING id`,
      [id],
    );
    expect(different).toHaveLength(1);
  });

  test('canonical take content is restored when the accept audit cannot commit', async () => {
    const id = await seedProposal();
    await engine.executeRaw(`ALTER TABLE ai_review_events ADD CONSTRAINT test_block_take_accept CHECK (action <> 'accept')`);
    try {
      await expect(acceptTakeProposal(engine, id, undefined, 'admin-test')).rejects.toThrow();
    } finally {
      await engine.executeRaw(`ALTER TABLE ai_review_events DROP CONSTRAINT test_block_take_accept`);
    }
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('pending');
    expect(readFileSync(join(dir, 'notes/review-source.md'), 'utf8')).not.toContain('gbrain:takes:begin');
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

  test('new concept content is removed when the accept audit cannot commit', async () => {
    const id = await seedConcept();
    await engine.executeRaw(`ALTER TABLE ai_review_events ADD CONSTRAINT test_block_concept_accept CHECK (action <> 'accept')`);
    try {
      await expect(acceptConceptProposal(engine, id, undefined, 'admin-test')).rejects.toThrow();
    } finally {
      await engine.executeRaw(`ALTER TABLE ai_review_events DROP CONSTRAINT test_block_concept_accept`);
    }
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM concept_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('pending');
    expect(await engine.getPage('concepts/theme', { sourceId: 'review-test' })).toBeNull();
  });
});
