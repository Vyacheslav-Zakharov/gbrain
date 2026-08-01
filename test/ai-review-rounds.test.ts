import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { contentHash } from '../src/core/cycle/propose-takes.ts';
import { ReviewConflictError } from '../src/core/ai-review.ts';
import {
  adminFinalizeRound,
  aggregateRoundById,
  castReviewerVote,
  ensurePendingReviewRounds,
  escalateOverdueRounds,
  getReviewRoundDetail,
  getReviewerItem,
  listReviewRounds,
  listReviewerDeck,
  openReviewRound,
  recoverInterruptedFinalizations,
  reviewerSummary,
  type ReviewerScope,
} from '../src/core/ai-review-rounds.ts';
import type { ReviewerPermissionMap } from '../src/core/ai-review-aggregation.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let dir = '';

const TEAM = 'internal-review';
const ANNA = 'anna@example.test';
const BORIS = 'boris@example.test';
const SOLO = 'solo@example.test';

const PERMS: ReviewerPermissionMap = {
  [ANNA]: { source_id: 'anna', federated_read: ['shared', TEAM], federated_write: [TEAM] },
  [BORIS]: { source_id: 'boris', federated_read: ['shared', TEAM], federated_write: [TEAM] },
  'viewer@example.test': { source_id: 'viewer', federated_read: [TEAM], federated_write: [] },
  [SOLO]: { source_id: 'solo-area', federated_read: ['shared'], federated_write: ['solo-area'] },
};

function scope(email: string, sources: string[] = [TEAM]): ReviewerScope {
  return { email, allowedWriteSources: sources };
}

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
  dir = mkdtempSync(join(tmpdir(), 'gbrain-review-rounds-'));
  mkdirSync(join(dir, 'team'), { recursive: true });
  mkdirSync(join(dir, 'solo'), { recursive: true });
  await engine.executeRaw(
    `INSERT INTO sources (id,name,local_path,config) VALUES ($1,'Team review',$2,'{}'::jsonb), ($3,'Solo area',$4,'{}'::jsonb)`,
    [TEAM, join(dir, 'team'), 'solo-area', join(dir, 'solo')],
  );
});

async function seedTakeProposal(sourceId = TEAM, slug = 'notes/review-source'): Promise<number> {
  const markdown = `---\ntype: note\ntitle: Review source\n---\n\nSource prose that supports a bounded claim.\n`;
  await importFromContent(engine, slug, markdown, { sourceId, noEmbed: true });
  const page = await engine.getPage(slug, { sourceId });
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_hash,claim_text,kind,holder,weight,domain,model_id)
     VALUES ($1,$2,$3,'test-v1','run-test',$4,'Supported bounded claim','take','world',0.7,'testing','stub') RETURNING id`,
    [sourceId, slug, contentHash(page!.compiled_truth), `claim-${slug}`],
  );
  return Number(rows[0]!.id);
}

async function seedConceptProposal(sourceId = TEAM): Promise<number> {
  const markdown = `---\ntype: note\ntitle: Concept\nsynthesized_by: gbrain-test\n---\n\nA synthesized concept body.\n`;
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO concept_proposals
       (source_id,page_slug,source_content_hash,prompt_version,proposal_run_id,proposed_markdown,source_atoms,model_id)
     VALUES ($1,'concepts/new-concept',$2,'test-v1','run-test',$3,'[{"source_id":"x","slug":"y"}]'::jsonb,'stub') RETURNING id`,
    [sourceId, contentHash(markdown), markdown],
  );
  return Number(rows[0]!.id);
}

async function openTeamRound(targetId: number, targetType: 'take_proposal' | 'concept_proposal' = 'take_proposal', nowMs?: number) {
  return openReviewRound(engine, { targetType, targetId, permissions: PERMS, actor: 'admin-test', nowMs });
}

function assignmentFor(assignments: Array<{ id: number; reviewer_email: string }>, email: string): number {
  const found = assignments.find(a => a.reviewer_email === email);
  if (!found) throw new Error(`no assignment for ${email}`);
  return Number(found.id);
}

async function expectConflict(fn: () => Promise<unknown>, code: string): Promise<ReviewConflictError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewConflictError);
    expect((error as ReviewConflictError).code).toBe(code);
    return error as ReviewConflictError;
  }
  throw new Error(`expected a ${code} conflict but the call succeeded`);
}

describe('round creation', () => {
  test('freezes every mandatory reviewer and records the audit event', async () => {
    const id = await seedTakeProposal();
    const { round, assignments } = await openTeamRound(id);
    expect(round.status).toBe('open');
    expect(round.policy_kind).toBe('shared');
    expect(assignments.map(a => a.reviewer_email).sort()).toEqual([ANNA, BORIS]);
    expect(Date.parse(round.due_at) - Date.parse(round.opened_at)).toBe(72 * 3_600_000);
    const events = await engine.executeRaw<{ action: string; details: { reviewers: string[] } }>(
      `SELECT action, details FROM ai_review_events WHERE target_type='take_proposal' AND target_id=$1`, [id]);
    expect(events.map(e => e.action)).toContain('round_opened');
    expect(events[0]!.details.reviewers.sort()).toEqual([ANNA, BORIS]);
  });

  test('a personal source assigns only its owner', async () => {
    const id = await seedTakeProposal('solo-area', 'notes/solo-note');
    const { round, assignments } = await openReviewRound(engine, {
      targetType: 'take_proposal', targetId: id, permissions: PERMS, actor: 'admin-test',
    });
    expect(round.policy_kind).toBe('personal');
    expect(assignments.map(a => a.reviewer_email)).toEqual([SOLO]);
  });

  test('delegated write access never adds a reviewer to a personal source', async () => {
    const id = await seedTakeProposal('solo-area', 'notes/solo-delegated');
    const permissions: ReviewerPermissionMap = {
      ...PERMS,
      'delegate@example.test': { source_id: 'delegate-area', federated_write: ['solo-area'] },
    };
    const { round, assignments } = await openReviewRound(engine, {
      targetType: 'take_proposal', targetId: id, permissions, actor: 'admin-test',
    });
    expect(round.policy_kind).toBe('personal');
    expect(assignments.map(a => a.reviewer_email)).toEqual([SOLO]);
  });

  test('a managed shared source keeps every writer when one user has it as source_id', async () => {
    const id = await seedTakeProposal();
    const permissions: ReviewerPermissionMap = {
      [ANNA]: { source_id: TEAM, federated_write: [TEAM] },
      [BORIS]: { source_id: 'boris', federated_write: [TEAM] },
    };
    const { round, assignments } = await openReviewRound(engine, {
      targetType: 'take_proposal', targetId: id, permissions, actor: 'admin-test',
    });
    expect(round.policy_kind).toBe('shared');
    expect(assignments.map(a => a.reviewer_email).sort()).toEqual([ANNA, BORIS]);
  });

  test('a source nobody can write to fails closed into the Admin queue', async () => {
    const id = await seedTakeProposal();
    const { round, assignments } = await openReviewRound(engine, {
      targetType: 'take_proposal', targetId: id, permissions: {}, actor: 'admin-test',
    });
    expect(round.status).toBe('escalated');
    expect(round.escalation_reason).toBe('no_reviewers');
    expect(assignments).toHaveLength(0);
    const rounds = await engine.executeRaw(`SELECT id FROM ai_review_rounds`);
    expect(rounds).toHaveLength(1);
  });

  test('only one active round exists per proposal', async () => {
    const id = await seedTakeProposal();
    await openTeamRound(id);
    await expectConflict(() => openTeamRound(id), 'round_already_open');
  });

  test('a non-pending proposal cannot open a round', async () => {
    const id = await seedTakeProposal();
    await engine.executeRaw(`UPDATE take_proposals SET status='accepted' WHERE id=$1`, [id]);
    await expectConflict(() => openTeamRound(id), 'stale_status');
  });

  test('the deadline is configurable', async () => {
    await engine.setConfig('ai_review.round_deadline_hours', '6');
    const id = await seedTakeProposal();
    const { round } = await openTeamRound(id);
    expect(Date.parse(round.due_at) - Date.parse(round.opened_at)).toBe(6 * 3_600_000);
  });
});

describe('automatic assignment synchronization', () => {
  test('new take and concept proposals receive frozen assignments without an Admin action', async () => {
    const takeId = await seedTakeProposal();
    const conceptId = await seedConceptProposal();
    const cutoverAt = new Date(Date.now() - 60_000).toISOString();
    const first = await ensurePendingReviewRounds(engine, {
      permissions: PERMS,
      actor: 'system:assignment-sync',
      cutoverAt,
    });
    expect(first.opened).toBe(2);
    expect(first.failed).toEqual([]);
    const rounds = await engine.executeRaw<{ target_type: string; target_id: number }>(
      `SELECT target_type, target_id FROM ai_review_rounds ORDER BY target_type, target_id`,
    );
    expect(rounds.map(row => `${row.target_type}:${Number(row.target_id)}`).sort()).toEqual([
      `concept_proposal:${conceptId}`,
      `take_proposal:${takeId}`,
    ].sort());
    const replay = await ensurePendingReviewRounds(engine, { permissions: PERMS, cutoverAt });
    expect(replay.opened).toBe(0);
  });

  test('the cutover leaves the pre-existing frozen manual backlog untouched', async () => {
    await seedTakeProposal();
    const result = await ensurePendingReviewRounds(engine, {
      permissions: PERMS,
      cutoverAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(result.opened).toBe(0);
    expect(await engine.executeRaw(`SELECT id FROM ai_review_rounds`)).toHaveLength(0);
  });
});

describe('reviewer deck and ACL', () => {
  test('a reviewer sees only their own pending assignments and no other votes', async () => {
    const id = await seedTakeProposal();
    await openTeamRound(id);
    const deck = await listReviewerDeck(engine, scope(ANNA));
    expect(deck.cards).toHaveLength(1);
    expect(deck.cards[0]!.headline).toBe('Supported bounded claim');
    expect(JSON.stringify(deck.cards[0])).not.toContain(BORIS);
    expect(await reviewerSummary(engine, scope(ANNA))).toEqual({ pending: 1, escalated_visible: 0 });
  });

  test('a revoked source grant hides the deck and blocks the detail view', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    expect((await listReviewerDeck(engine, scope(ANNA, []))).cards).toHaveLength(0);
    await expectConflict(
      () => getReviewerItem(engine, scope(ANNA, ['other-source']), assignmentFor(assignments, ANNA)),
      'source_access_revoked',
    );
  });

  test('stale cards at the front do not starve valid assignments behind the limit', async () => {
    const staleId = await seedTakeProposal(TEAM, 'notes/stale-first');
    const staleRound = await openTeamRound(staleId);
    await engine.executeRaw(`UPDATE take_proposals SET status='accepted' WHERE id=$1`, [staleId]);
    const validId = await seedTakeProposal(TEAM, 'notes/valid-second');
    const validRound = await openTeamRound(validId);
    const deck = await listReviewerDeck(engine, scope(ANNA), { limit: 1 });
    expect(deck.cards.map(card => card.round_id)).toEqual([Number(validRound.round.id)]);
    const stale = await engine.executeRaw<{ status: string; escalation_reason: string }>(
      `SELECT status, escalation_reason FROM ai_review_rounds WHERE id=$1`, [staleRound.round.id],
    );
    expect(stale[0]).toMatchObject({ status: 'escalated', escalation_reason: 'stale_proposal' });
  });

  test('another reviewer cannot read or vote on a foreign assignment', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    const borisAssignment = assignmentFor(assignments, BORIS);
    await expectConflict(() => getReviewerItem(engine, scope(ANNA), borisAssignment), 'foreign_assignment');
    await expectConflict(
      () => castReviewerVote(engine, scope(ANNA), { assignmentId: borisAssignment, decision: 'approve' }),
      'foreign_assignment',
    );
  });

  test('opening the details marks the assignment without creating a vote', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    const item = await getReviewerItem(engine, scope(ANNA), assignmentFor(assignments, ANNA), { markDetailsOpened: true });
    expect(item.details_opened).toBe(true);
    expect(item.detail).toContain('Source prose');
    expect(await engine.executeRaw(`SELECT id FROM ai_review_votes`)).toHaveLength(0);
  });
});

describe('voting', () => {
  test('a reject without a valid reason code is refused', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    const assignmentId = assignmentFor(assignments, ANNA);
    await expectConflict(
      () => castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'reject' }),
      'reason_code_required',
    );
    await expectConflict(
      () => castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'reject', reasonCode: 'other' }),
      'reason_comment_required',
    );
    await expectConflict(
      () => castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'nope' }),
      'invalid_decision',
    );
  });

  test('replaying the same idempotency key returns the first vote', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    const assignmentId = assignmentFor(assignments, ANNA);
    const first = await castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'approve', idempotencyKey: 'same-key' });
    const replay = await castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'approve', idempotencyKey: 'same-key' });
    expect(replay.replayed).toBe(true);
    expect(replay.vote.id).toBe(first.vote.id);
    expect(await engine.executeRaw(`SELECT id FROM ai_review_votes`)).toHaveLength(1);
  });

  test('reusing an idempotency key for a different payload is rejected', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    const assignmentId = assignmentFor(assignments, ANNA);
    await castReviewerVote(engine, scope(ANNA), {
      assignmentId, decision: 'approve', idempotencyKey: 'payload-bound-key',
    });
    await expectConflict(
      () => castReviewerVote(engine, scope(ANNA), {
        assignmentId, decision: 'reject', reasonCode: 'outdated', idempotencyKey: 'payload-bound-key',
      }),
      'idempotency_conflict',
    );
  });

  test('an idempotent retry settles a durable vote left behind before settlement', async () => {
    const id = await seedTakeProposal('solo-area', 'notes/solo-recovery');
    const { round, assignments } = await openReviewRound(engine, {
      targetType: 'take_proposal', targetId: id, permissions: PERMS, actor: 'admin-test',
    });
    const assignmentId = assignmentFor(assignments, SOLO);
    await engine.executeRaw(
      `INSERT INTO ai_review_votes
         (round_id, assignment_id, decision, voter_kind, actor_email, proposal_snapshot_hash, idempotency_key, active)
       VALUES ($1,$2,'approve','portal_user',$3,$4,$5,true)`,
      [round.id, assignmentId, SOLO, round.proposal_snapshot_hash, 'crash-recovery-key'],
    );
    await engine.executeRaw(`UPDATE ai_review_assignments SET status='voted' WHERE id=$1`, [assignmentId]);
    const recovered = await castReviewerVote(engine, scope(SOLO, ['solo-area']), {
      assignmentId, decision: 'approve', idempotencyKey: 'crash-recovery-key',
    });
    expect(recovered.replayed).toBe(true);
    expect(recovered.round.status).toBe('finalized');
  });

  test('an identical payload without a key is still idempotent', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    const assignmentId = assignmentFor(assignments, ANNA);
    await castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'approve' });
    const replay = await castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'approve' });
    expect(replay.replayed).toBe(true);
    expect(await engine.executeRaw(`SELECT id FROM ai_review_votes`)).toHaveLength(1);
  });

  test('an explicit idempotency replay succeeds after the first vote finalized the round', async () => {
    const id = await seedTakeProposal('solo-area', 'notes/solo-replay');
    const { assignments } = await openReviewRound(engine, {
      targetType: 'take_proposal', targetId: id, permissions: PERMS, actor: 'admin-test',
    });
    const assignmentId = assignmentFor(assignments, SOLO);
    const first = await castReviewerVote(engine, scope(SOLO, ['solo-area']), {
      assignmentId, decision: 'approve', idempotencyKey: 'solo-finalize-key',
    });
    expect(first.round.status).toBe('finalized');
    const replay = await castReviewerVote(engine, scope(SOLO, ['solo-area']), {
      assignmentId, decision: 'approve', idempotencyKey: 'solo-finalize-key',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.vote.id).toBe(first.vote.id);
    expect(replay.round.status).toBe('finalized');
  });

  test('changing a vote supersedes instead of deleting, keeping one active row', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    const assignmentId = assignmentFor(assignments, ANNA);
    const first = await castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'approve' });
    const second = await castReviewerVote(engine, scope(ANNA), { assignmentId, decision: 'reject', reasonCode: 'outdated' });
    expect(second.round.round_version).toBeGreaterThan(first.round.round_version);
    const staleClaim = await engine.executeRaw(
      `UPDATE ai_review_rounds SET status='finalizing'
        WHERE id=$1 AND status='open' AND round_version=$2 RETURNING id`,
      [first.round.id, first.round.round_version],
    );
    expect(staleClaim).toHaveLength(0);
    const votes = await engine.executeRaw<{ decision: string; active: boolean }>(
      `SELECT decision, active FROM ai_review_votes WHERE assignment_id=$1 ORDER BY id`, [assignmentId]);
    expect(votes).toHaveLength(2);
    expect(votes.filter(v => v.active)).toHaveLength(1);
    const actions = await engine.executeRaw<{ action: string }>(`SELECT action FROM ai_review_events WHERE target_id=$1`, [id]);
    expect(actions.map(a => a.action)).toContain('vote_replaced');
  });

  test('a vote echoing a stale snapshot hash is refused', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    await expectConflict(
      () => castReviewerVote(engine, scope(ANNA), {
        assignmentId: assignmentFor(assignments, ANNA), decision: 'approve', proposalSnapshotHash: 'deadbeef',
      }),
      'stale_proposal',
    );
  });

  test('a proposal decided elsewhere blocks further voting', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    await engine.executeRaw(`UPDATE take_proposals SET status='rejected' WHERE id=$1`, [id]);
    await expectConflict(
      () => castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' }),
      'stale_proposal',
    );
  });

  test('the audit event never stores the reviewer comment body', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), {
      assignmentId: assignmentFor(assignments, ANNA), decision: 'reject',
      reasonCode: 'other', comment: 'КОНФИДЕНЦИАЛЬНАЯ ЦИТАТА',
    });
    const events = await engine.executeRaw<{ details: Record<string, unknown> }>(
      `SELECT details FROM ai_review_events WHERE action='vote_cast'`);
    expect(JSON.stringify(events)).not.toContain('КОНФИДЕНЦИАЛЬНАЯ');
    expect(events[0]!.details.has_comment).toBe(true);
  });
});

describe('auto-finalization', () => {
  test('one owner vote finalizes a personal-source round through the guarded publisher', async () => {
    const id = await seedTakeProposal('solo-area', 'notes/solo-note');
    const { assignments } = await openReviewRound(engine, {
      targetType: 'take_proposal', targetId: id, permissions: PERMS, actor: 'admin-test',
    });
    const result = await castReviewerVote(engine, { email: SOLO, allowedWriteSources: ['solo-area'] }, {
      assignmentId: assignmentFor(assignments, SOLO), decision: 'approve',
    });
    expect(result.round.status).toBe('finalized');
    expect(result.round.outcome).toBe('accepted');
    expect(result.round.finalized_mode).toBe('auto_unanimous');
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('accepted');
    const file = readFileSync(join(dir, 'solo', 'notes/solo-note.md'), 'utf8');
    expect(file).toContain('Supported bounded claim');
  });

  test('unanimous approval by every assigned reviewer accepts the proposal', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    const first = await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    expect(first.round.status).toBe('open');
    const second = await castReviewerVote(engine, scope(BORIS), { assignmentId: assignmentFor(assignments, BORIS), decision: 'approve' });
    expect(second.round.status).toBe('finalized');
    expect(second.round.outcome).toBe('accepted');
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('accepted');
  });

  test('unanimous rejection rejects through the guarded publisher and leaves the page untouched', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), {
      assignmentId: assignmentFor(assignments, ANNA), decision: 'reject', reasonCode: 'outdated',
    });
    const final = await castReviewerVote(engine, scope(BORIS), {
      assignmentId: assignmentFor(assignments, BORIS), decision: 'reject', reasonCode: 'duplicate',
    });
    expect(final.round.outcome).toBe('rejected');
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('rejected');
    const page = await engine.getPage('notes/review-source', { sourceId: TEAM });
    expect(page!.compiled_truth).not.toContain('gbrain:takes:begin');
  });

  test('a unanimous concept round publishes through the concept publisher', async () => {
    const id = await seedConceptProposal();
    const { assignments } = await openTeamRound(id, 'concept_proposal');
    await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    const final = await castReviewerVote(engine, scope(BORIS), { assignmentId: assignmentFor(assignments, BORIS), decision: 'approve' });
    expect(final.round.outcome).toBe('accepted');
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM concept_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('accepted');
  });

  test('disagreement escalates and never publishes', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    const final = await castReviewerVote(engine, scope(BORIS), {
      assignmentId: assignmentFor(assignments, BORIS), decision: 'reject', reasonCode: 'contradicts_evidence', comment: 'Противоречит акту',
    });
    expect(final.round.status).toBe('escalated');
    expect(final.round.escalation_reason).toBe('disagreement');
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('pending');
  });

  test('a system-authored vote cannot complete a round', async () => {
    const id = await seedTakeProposal();
    const { round, assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    await engine.executeRaw(
      `INSERT INTO ai_review_votes (round_id, assignment_id, decision, voter_kind, actor_email, proposal_snapshot_hash, idempotency_key)
       VALUES ($1, $2, 'approve', 'system', $3, $4, 'model-forged')`,
      [round.id, assignmentFor(assignments, BORIS), BORIS, round.proposal_snapshot_hash],
    );
    const { aggregate } = await aggregateRoundById(engine, Number(round.id));
    expect(aggregate.verdict).toBe('open');
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('pending');
  });

  test('only one of two concurrent finalizations publishes', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    const borisAssignment = assignmentFor(assignments, BORIS);
    const results = await Promise.allSettled([
      castReviewerVote(engine, scope(BORIS), { assignmentId: borisAssignment, decision: 'approve', idempotencyKey: 'a' }),
      castReviewerVote(engine, scope(BORIS), { assignmentId: borisAssignment, decision: 'approve', idempotencyKey: 'b' }),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const rounds = await engine.executeRaw<{ status: string; outcome: string | null }>(`SELECT status, outcome FROM ai_review_rounds`);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.status).toBe('finalized');
    expect(rounds[0]!.outcome).toBe('accepted');
    const activeVotes = await engine.executeRaw(`SELECT id FROM ai_review_votes WHERE assignment_id=$1 AND active=true`, [borisAssignment]);
    expect(activeVotes).toHaveLength(1);
    const accepts = await engine.executeRaw(`SELECT id FROM ai_review_events WHERE target_id=$1 AND action='accept'`, [id]);
    expect(accepts).toHaveLength(1);
  });

  test('a publication failure does not become a finalized success', async () => {
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    // Mutate the canonical page so the publisher's stale-source guard fires.
    await importFromContent(engine, 'notes/review-source',
      `---\ntype: note\ntitle: Review source\n---\n\nCompletely different prose.\n`,
      { sourceId: TEAM, noEmbed: true });
    const final = await castReviewerVote(engine, scope(BORIS), { assignmentId: assignmentFor(assignments, BORIS), decision: 'approve' });
    expect(final.round.status).toBe('escalated');
    expect(final.round.escalation_reason).toBe('publication_failed');
    expect(final.finalizationError).toBeTruthy();
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('pending');
    const failures = await engine.executeRaw(`SELECT id FROM ai_review_events WHERE action='publication_failed'`);
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });
});

describe('interrupted finalization recovery', () => {
  test('a stale finalizing round with a pending proposal escalates for inspection', async () => {
    const id = await seedTakeProposal();
    const { round } = await openTeamRound(id);
    const nowMs = Date.now();
    await engine.executeRaw(
      `UPDATE ai_review_rounds
          SET status='finalizing', finalizing_at=$2, finalized_by='system:unanimous',
              finalized_mode='auto_unanimous'
        WHERE id=$1`,
      [round.id, new Date(nowMs - 120_000).toISOString()],
    );
    const result = await recoverInterruptedFinalizations(engine, { nowMs, staleAfterMs: 60_000 });
    expect(result.escalated).toBe(1);
    const rows = await engine.executeRaw<{ status: string; escalation_reason: string }>(
      `SELECT status, escalation_reason FROM ai_review_rounds WHERE id=$1`, [round.id],
    );
    expect(rows[0]).toMatchObject({ status: 'escalated', escalation_reason: 'publication_interrupted' });
  });

  test('a terminal proposal proves an interrupted finalization completed', async () => {
    const id = await seedTakeProposal();
    const { round } = await openTeamRound(id);
    const nowMs = Date.now();
    await engine.executeRaw(`UPDATE take_proposals SET status='accepted' WHERE id=$1`, [id]);
    await engine.executeRaw(
      `UPDATE ai_review_rounds
          SET status='finalizing', finalizing_at=$2, finalized_by='system:unanimous',
              finalized_mode='auto_unanimous'
        WHERE id=$1`,
      [round.id, new Date(nowMs - 120_000).toISOString()],
    );
    const result = await recoverInterruptedFinalizations(engine, { nowMs, staleAfterMs: 60_000 });
    expect(result.finalized).toBe(1);
    const rows = await engine.executeRaw<{ status: string; outcome: string }>(
      `SELECT status, outcome FROM ai_review_rounds WHERE id=$1`, [round.id],
    );
    expect(rows[0]).toMatchObject({ status: 'finalized', outcome: 'accepted' });
  });
});

describe('deadline escalation', () => {
  test('missing votes past the deadline escalate without counting as reject', async () => {
    const openedAt = Date.now() - 100 * 3_600_000;
    const id = await seedTakeProposal();
    const { round, assignments } = await openTeamRound(id, 'take_proposal', openedAt);
    await castReviewerVote(engine, scope(ANNA), {
      assignmentId: assignmentFor(assignments, ANNA), decision: 'approve', nowMs: openedAt + 1_000,
    });
    const swept = await escalateOverdueRounds(engine);
    expect(swept.escalated).toBe(1);
    const detail = await getReviewRoundDetail(engine, Number(round.id));
    expect(detail.round.status).toBe('escalated');
    expect(detail.round.escalation_reason).toBe('deadline_missed');
    expect(detail.rejections).toBe(0);
    expect(detail.missing).toEqual([BORIS]);
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('pending');
  });

  test('a late vote escalates the round instead of landing silently', async () => {
    const openedAt = Date.now() - 100 * 3_600_000;
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id, 'take_proposal', openedAt);
    await expectConflict(
      () => castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' }),
      'round_escalated',
    );
    expect(await engine.executeRaw(`SELECT id FROM ai_review_votes`)).toHaveLength(0);
  });

  test('a sweep never turns a complete unanimous round into an escalation', async () => {
    const openedAt = Date.now() - 100 * 3_600_000;
    const id = await seedTakeProposal();
    const { assignments } = await openTeamRound(id, 'take_proposal', openedAt);
    for (const email of [ANNA, BORIS]) {
      await castReviewerVote(engine, scope(email), {
        assignmentId: assignmentFor(assignments, email), decision: 'approve', nowMs: openedAt + 1_000,
      });
    }
    const swept = await escalateOverdueRounds(engine);
    expect(swept.escalated).toBe(0);
  });
});

describe('admin escalation queue', () => {
  test('escalated rounds expose a named vote matrix and count', async () => {
    const id = await seedTakeProposal();
    const { round, assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    await castReviewerVote(engine, scope(BORIS), {
      assignmentId: assignmentFor(assignments, BORIS), decision: 'reject', reasonCode: 'other', comment: 'Не согласен',
    });
    const list = await listReviewRounds(engine, { status: 'escalated' });
    expect(list.rounds).toHaveLength(1);
    expect(list.rounds[0]!.approvals).toBe(1);
    expect(list.rounds[0]!.rejections).toBe(1);
    const detail = await getReviewRoundDetail(engine, Number(round.id));
    expect(detail.matrix.map(m => m.reviewer_email)).toEqual([ANNA, BORIS]);
    expect(detail.matrix.find(m => m.reviewer_email === BORIS)!.reason_code).toBe('other');
    expect(detail.matrix.find(m => m.reviewer_email === BORIS)!.comment).toBe('Не согласен');
  });

  test('Admin can page through every escalated round beyond the first page', async () => {
    for (const slug of ['notes/page-a', 'notes/page-b', 'notes/page-c']) {
      const id = await seedTakeProposal(TEAM, slug);
      await openReviewRound(engine, { targetType: 'take_proposal', targetId: id, permissions: {}, actor: 'admin-test' });
    }
    const first = await listReviewRounds(engine, { status: 'escalated', limit: 2, offset: 0 });
    const second = await listReviewRounds(engine, { status: 'escalated', limit: 2, offset: 2 });
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect(first.rounds).toHaveLength(2);
    expect(second.rounds).toHaveLength(1);
    expect(new Set([...first.rounds, ...second.rounds].map(item => item.round.id)).size).toBe(3);
  });

  test('finalizing an escalated round requires a reason and publishes once', async () => {
    const id = await seedTakeProposal();
    const { round, assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    await castReviewerVote(engine, scope(BORIS), {
      assignmentId: assignmentFor(assignments, BORIS), decision: 'reject', reasonCode: 'outdated',
    });
    await expectConflict(
      () => adminFinalizeRound(engine, { roundId: Number(round.id), actor: 'admin-ui:abc', action: 'accepted', reason: 'ок' }),
      'override_reason_required',
    );
    await expectConflict(
      () => adminFinalizeRound(engine, { roundId: Number(round.id), actor: 'admin-ui:abc', action: 'maybe', reason: 'достаточно длинная причина' }),
      'invalid_action',
    );
    const result = await adminFinalizeRound(engine, {
      roundId: Number(round.id), actor: 'admin-ui:abc', action: 'accepted',
      reason: 'Проверил первоисточник, формулировка подтверждена',
    });
    expect(result.round.status).toBe('finalized');
    expect(result.round.finalized_mode).toBe('admin_override');
    expect(result.round.final_reason).toContain('первоисточник');
    const proposal = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id=$1`, [id]);
    expect(proposal[0]!.status).toBe('accepted');
    const overrides = await engine.executeRaw(`SELECT id FROM ai_review_events WHERE action='round_override'`);
    expect(overrides).toHaveLength(1);
  });

  test('an open round cannot be finalized by hand', async () => {
    const id = await seedTakeProposal();
    const { round } = await openTeamRound(id);
    await expectConflict(
      () => adminFinalizeRound(engine, {
        roundId: Number(round.id), actor: 'admin-ui:abc', action: 'accepted', reason: 'достаточно длинная причина',
      }),
      'round_not_escalated',
    );
  });

  test('an escalated round finalized against a stale proposal refuses to publish', async () => {
    const id = await seedTakeProposal();
    const { round, assignments } = await openTeamRound(id);
    await castReviewerVote(engine, scope(ANNA), { assignmentId: assignmentFor(assignments, ANNA), decision: 'approve' });
    await castReviewerVote(engine, scope(BORIS), {
      assignmentId: assignmentFor(assignments, BORIS), decision: 'reject', reasonCode: 'outdated',
    });
    await engine.executeRaw(`UPDATE take_proposals SET status='accepted' WHERE id=$1`, [id]);
    await expectConflict(
      () => adminFinalizeRound(engine, {
        roundId: Number(round.id), actor: 'admin-ui:abc', action: 'accepted', reason: 'достаточно длинная причина',
      }),
      'stale_proposal',
    );
    const after = await getReviewRoundDetail(engine, Number(round.id));
    expect(after.round.status).toBe('escalated');
    expect(after.round.escalation_reason).toBe('stale_proposal');
  });
});
