/**
 * Real-Postgres concurrency proof for multi-review voting.
 *
 * Run: DATABASE_URL=postgresql://... bun test test/e2e/ai-review-rounds-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { contentHash } from '../../src/core/cycle/propose-takes.ts';
import {
  castReviewerVote,
  getReviewRoundDetail,
  listReviewRounds,
  openReviewRound,
  type ReviewerScope,
} from '../../src/core/ai-review-rounds.ts';
import type { ReviewerPermissionMap } from '../../src/core/ai-review-aggregation.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const TEAM = 'internal-review-pg';
const ANNA = 'anna-pg@example.test';
const BORIS = 'boris-pg@example.test';
const CAROL = 'carol-pg@example.test';
const PERMISSIONS: ReviewerPermissionMap = {
  [ANNA]: { source_id: 'anna-pg', federated_read: [TEAM], federated_write: [TEAM] },
  [BORIS]: { source_id: 'boris-pg', federated_read: [TEAM], federated_write: [TEAM] },
  [CAROL]: { source_id: 'carol-pg', federated_read: [TEAM], federated_write: [TEAM] },
};
const describePg = hasDatabase() ? describe : describe.skip;

function scope(email: string): ReviewerScope {
  return { email, allowedWriteSources: [TEAM] };
}

describePg('multi-review voting on separate Postgres pools', () => {
  let engineA: PostgresEngine;
  let engineB: PostgresEngine;
  let dir = '';

  beforeAll(async () => {
    engineA = await setupDB();
    engineB = new PostgresEngine();
    await engineB.connect({ engine: 'postgres', database_url: DATABASE_URL!, poolSize: 4 });
    dir = mkdtempSync(join(tmpdir(), 'gbrain-review-pg-'));
    mkdirSync(join(dir, 'team'), { recursive: true });

    await engineA.executeRaw(
      `TRUNCATE ai_review_votes, ai_review_assignments, ai_review_rounds,
                ai_review_events, ai_review_revisions, take_proposals,
                concept_proposals
       RESTART IDENTITY CASCADE`,
    );
    await engineA.executeRaw(
      `INSERT INTO sources (id,name,local_path,config)
       VALUES ($1,'Postgres review test',$2,'{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET local_path=EXCLUDED.local_path`,
      [TEAM, join(dir, 'team')],
    );
  }, 60_000);

  afterAll(async () => {
    if (engineB) await engineB.disconnect();
    await teardownDB();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('competing final votes serialize and publish the outcome exactly once', async () => {
    const slug = 'notes/postgres-concurrency';
    const markdown = `---\ntype: note\ntitle: PostgreSQL concurrency\n---\n\nEvidence for a bounded claim.\n`;
    await importFromContent(engineA, slug, markdown, { sourceId: TEAM, noEmbed: true });
    const page = await engineA.getPage(slug, { sourceId: TEAM });
    const proposalRows = await engineA.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       VALUES ($1,$2,$3,'pg-test-v1','pg-test-run','pg-claim','Concurrent bounded claim','take','world',0.7,'testing','stub')
       RETURNING id`,
      [TEAM, slug, contentHash(page!.compiled_truth)],
    );
    const proposalId = Number(proposalRows[0]!.id);
    const opened = await openReviewRound(engineA, {
      targetType: 'take_proposal', targetId: proposalId, permissions: PERMISSIONS, actor: 'pg-test',
    });
    expect(() => JSON.stringify(opened)).not.toThrow();
    const annaAssignment = Number(opened.assignments.find(a => a.reviewer_email === ANNA)!.id);
    const borisAssignment = Number(opened.assignments.find(a => a.reviewer_email === BORIS)!.id);

    await castReviewerVote(engineA, scope(ANNA), {
      assignmentId: annaAssignment,
      decision: 'reject',
      reasonCode: 'unsupported_by_sources',
      comment: '',
      idempotencyKey: 'pg-anna-reject',
    });

    const [first, second] = await Promise.all([
      castReviewerVote(engineA, scope(BORIS), {
        assignmentId: borisAssignment,
        decision: 'reject', reasonCode: 'unsupported_by_sources', comment: '',
        idempotencyKey: 'pg-boris-race-a',
      }),
      castReviewerVote(engineB, scope(BORIS), {
        assignmentId: borisAssignment,
        decision: 'reject', reasonCode: 'unsupported_by_sources', comment: '',
        idempotencyKey: 'pg-boris-race-b',
      }),
    ]);

    expect([first.round.status, second.round.status]).toContain('finalized');
    const rounds = await getEngine().executeRaw<{ status: string; outcome: string }>(
      `SELECT status, outcome FROM ai_review_rounds WHERE id=$1`, [opened.round.id],
    );
    expect(rounds[0]).toMatchObject({ status: 'finalized', outcome: 'rejected' });

    const activeVotes = await getEngine().executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_review_votes WHERE round_id=$1 AND superseded_at IS NULL`,
      [opened.round.id],
    );
    expect(Number(activeVotes[0]!.n)).toBe(2);

    const proposals = await getEngine().executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE id=$1`, [proposalId],
    );
    expect(proposals[0]!.status).toBe('rejected');

    const rejectionEvents = await getEngine().executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_review_events
        WHERE target_type='take_proposal' AND target_id=$1 AND action='reject'`,
      [proposalId],
    );
    expect(Number(rejectionEvents[0]!.n)).toBe(1);

    const adminList = await listReviewRounds(engineA, { status: 'finalized' });
    const adminDetail = await getReviewRoundDetail(engineA, opened.round.id);
    expect(() => JSON.stringify({ adminList, adminDetail, first, second })).not.toThrow();
  }, 30_000);

  test('vote replacement cannot invalidate an already-computed finalization verdict', async () => {
    const slug = 'notes/postgres-replacement-race';
    const markdown = `---\ntype: note\ntitle: PostgreSQL replacement race\n---\n\nEvidence for another bounded claim.\n`;
    await importFromContent(engineA, slug, markdown, { sourceId: TEAM, noEmbed: true });
    const page = await engineA.getPage(slug, { sourceId: TEAM });
    const rows = await engineA.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       VALUES ($1,$2,$3,'pg-test-v1','pg-test-run-2','pg-claim-2','Replacement race claim','take','world',0.7,'testing','stub')
       RETURNING id`,
      [TEAM, slug, contentHash(page!.compiled_truth)],
    );
    const proposalId = Number(rows[0]!.id);
    const opened = await openReviewRound(engineA, {
      targetType: 'take_proposal', targetId: proposalId, permissions: PERMISSIONS, actor: 'pg-test',
    });
    const annaAssignment = Number(opened.assignments.find(a => a.reviewer_email === ANNA)!.id);
    const borisAssignment = Number(opened.assignments.find(a => a.reviewer_email === BORIS)!.id);
    await castReviewerVote(engineA, scope(ANNA), {
      assignmentId: annaAssignment, decision: 'approve', idempotencyKey: 'pg-anna-initial-approve',
    });

    await Promise.allSettled([
      castReviewerVote(engineA, scope(ANNA), {
        assignmentId: annaAssignment, decision: 'reject', reasonCode: 'outdated',
        idempotencyKey: 'pg-anna-replacement-reject',
      }),
      castReviewerVote(engineB, scope(BORIS), {
        assignmentId: borisAssignment, decision: 'approve', idempotencyKey: 'pg-boris-final-approve',
      }),
    ]);

    const detail = await getReviewRoundDetail(engineA, opened.round.id);
    const active = new Map(detail.matrix.map(item => [item.reviewer_email, item.decision]));
    if (detail.round.status === 'finalized') {
      expect(detail.round.outcome).toBe('accepted');
      expect(active.get(ANNA)).toBe('approve');
      expect(active.get(BORIS)).toBe('approve');
    } else {
      expect(detail.round.status).toBe('open');
      expect(active.get(ANNA)).toBe('reject');
      expect(active.get(BORIS)).toBe('approve');
      expect(active.get(CAROL)).toBeNull();
    }
    const proposal = await engineA.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [proposalId]);
    expect(proposal[0]!.status).toBe(detail.round.status === 'finalized' ? 'accepted' : 'pending');
  }, 30_000);

  test('abstain persists on PostgreSQL and exhausted no-quorum escalates', async () => {
    const slug = 'notes/postgres-abstain';
    const markdown = `---\ntype: note\ntitle: PostgreSQL abstain\n---\n\nEvidence requiring human review.\n`;
    await importFromContent(engineA, slug, markdown, { sourceId: TEAM, noEmbed: true });
    const page = await engineA.getPage(slug, { sourceId: TEAM });
    const rows = await engineA.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       VALUES ($1,$2,$3,'pg-test-v1','pg-test-run-3','pg-claim-3','Abstain claim','take','world',0.7,'testing','stub')
       RETURNING id`,
      [TEAM, slug, contentHash(page!.compiled_truth)],
    );
    const proposalId = Number(rows[0]!.id);
    const opened = await openReviewRound(engineA, {
      targetType: 'take_proposal', targetId: proposalId, permissions: PERMISSIONS, actor: 'pg-test',
    });
    const assignment = (email: string) => Number(opened.assignments.find(item => item.reviewer_email === email)!.id);
    await castReviewerVote(engineA, scope(ANNA), {
      assignmentId: assignment(ANNA), decision: 'approve', idempotencyKey: 'pg-abstain-anna',
    });
    await castReviewerVote(engineB, scope(BORIS), {
      assignmentId: assignment(BORIS), decision: 'reject', reasonCode: 'outdated', idempotencyKey: 'pg-abstain-boris',
    });
    const result = await castReviewerVote(engineA, scope(CAROL), {
      assignmentId: assignment(CAROL), decision: 'abstain', idempotencyKey: 'pg-abstain-carol',
    });
    expect(result.round).toMatchObject({ status: 'escalated', escalation_reason: 'no_quorum' });
    const detail = await getReviewRoundDetail(engineB, Number(opened.round.id));
    expect(detail).toMatchObject({ approvals: 1, rejections: 1, abstentions: 1, missing: [] });
    expect(detail.matrix.find(item => item.reviewer_email === CAROL)).toMatchObject({
      decision: 'abstain', reason_code: null,
    });
    const constraint = await engineA.executeRaw<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname='ai_review_votes_decision_check'`,
    );
    expect(constraint[0]!.definition).toContain("'abstain'");
  }, 30_000);

  test('concurrent abstain and decisive vote never publish an escalation', async () => {
    const slug = 'notes/postgres-abstain-race';
    const markdown = `---\ntype: note\ntitle: PostgreSQL abstain race\n---\n\nEvidence for a race test.\n`;
    await importFromContent(engineA, slug, markdown, { sourceId: TEAM, noEmbed: true });
    const page = await engineA.getPage(slug, { sourceId: TEAM });
    const rows = await engineA.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
       VALUES ($1,$2,$3,'pg-test-v1','pg-test-run-4','pg-claim-4','Abstain race claim','take','world',0.7,'testing','stub')
       RETURNING id`,
      [TEAM, slug, contentHash(page!.compiled_truth)],
    );
    const proposalId = Number(rows[0]!.id);
    const opened = await openReviewRound(engineA, {
      targetType: 'take_proposal', targetId: proposalId, permissions: PERMISSIONS, actor: 'pg-test',
    });
    const assignment = (email: string) => Number(opened.assignments.find(item => item.reviewer_email === email)!.id);
    await castReviewerVote(engineA, scope(ANNA), {
      assignmentId: assignment(ANNA), decision: 'approve', idempotencyKey: 'pg-race-anna',
    });

    const raced = await Promise.allSettled([
      castReviewerVote(engineA, scope(CAROL), {
        assignmentId: assignment(CAROL), decision: 'abstain', idempotencyKey: 'pg-race-carol',
      }),
      castReviewerVote(engineB, scope(BORIS), {
        assignmentId: assignment(BORIS), decision: 'approve', idempotencyKey: 'pg-race-boris',
      }),
    ]);
    expect(raced.some(result => result.status === 'fulfilled')).toBe(true);

    const detail = await getReviewRoundDetail(engineA, Number(opened.round.id));
    expect(detail.round).toMatchObject({ status: 'finalized', outcome: 'accepted', finalized_mode: 'auto_quorum' });
    expect(detail.approvals).toBe(2);
    expect(detail.abstentions === 0 || detail.abstentions === 1).toBe(true);
    const events = await engineA.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM ai_review_events
        WHERE details->>'round_id'=$1::text AND action='round_finalized'`,
      [opened.round.id],
    );
    expect(Number(events[0]!.count)).toBe(1);
    const escalations = await engineA.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM ai_review_events
        WHERE details->>'round_id'=$1::text AND action='round_escalated'`,
      [opened.round.id],
    );
    expect(Number(escalations[0]!.count)).toBe(0);
  }, 30_000);
});
