import { describe, expect, test } from 'bun:test';
import {
  aggregateRound,
  resolveMandatoryReviewers,
  resolveRoundDeadlineHours,
  DEFAULT_ROUND_DEADLINE_HOURS,
  type AggregationVote,
  type ReviewerPermissionMap,
} from '../src/core/ai-review-aggregation.ts';
import { rejectReasonsFor, validateRejectReason } from '../src/core/ai-review-reasons.ts';

const PERMS: ReviewerPermissionMap = {
  'owner@example.test': { source_id: 'owner-area', federated_read: ['shared'], federated_write: ['internal-it'] },
  'head@example.test': { source_id: 'head', federated_read: ['shared', 'internal-it'], federated_write: ['internal-it'] },
  'reader@example.test': { source_id: 'reader', federated_read: ['internal-it'], federated_write: [] },
  'personal@example.test': { source_id: 'personal', federated_read: ['shared'], federated_write: ['personal'] },
  'former@example.test': { source_id: 'former', federated_write: ['internal-it'], active: false },
  'suspended@example.test': { source_id: 'suspended', federated_write: ['internal-it'], disabled: true },
};

function assignments(...emails: string[]) {
  return emails.map((email, index) => ({ assignment_id: index + 1, reviewer_email: email }));
}

function vote(assignmentId: number, email: string, decision: 'approve' | 'reject' | 'abstain', extra: Partial<AggregationVote> = {}): AggregationVote {
  return { assignment_id: assignmentId, actor_email: email, decision, voter_kind: 'portal_user', active: true, ...extra };
}

type RoundInput = Parameters<typeof aggregateRound>[0];
function aggregateShared(input: Omit<RoundInput, 'policyKind'>) {
  return aggregateRound({ ...input, policyKind: 'shared' });
}
function aggregatePersonal(input: Omit<RoundInput, 'policyKind'>) {
  return aggregateRound({ ...input, policyKind: 'personal' });
}

describe('reviewer ACL resolution', () => {
  test('every configured active user with write access to a shared source is mandatory', () => {
    const { reviewers, policyKind } = resolveMandatoryReviewers(PERMS, 'internal-it');
    expect(reviewers.map(r => r.email)).toEqual(['head@example.test', 'owner@example.test']);
    expect(policyKind).toBe('shared');
    expect(reviewers.every(r => r.weight === 1)).toBe(true);
  });

  test('read-only grants and deactivated users are never assigned', () => {
    const emails = resolveMandatoryReviewers(PERMS, 'internal-it').reviewers.map(r => r.email);
    expect(emails).not.toContain('reader@example.test');
    expect(emails).not.toContain('former@example.test');
    expect(emails).not.toContain('suspended@example.test');
  });

  test('a personal source assigns only its owner and reports the personal policy', () => {
    const { reviewers, policyKind } = resolveMandatoryReviewers(PERMS, 'personal');
    expect(reviewers.map(r => r.email)).toEqual(['personal@example.test']);
    expect(reviewers[0]!.ownsSource).toBe(true);
    expect(policyKind).toBe('personal');
  });

  test('a personal source shared with a second writer still assigns only its owner', () => {
    const shared = resolveMandatoryReviewers(
      { ...PERMS, 'deputy@example.test': { source_id: 'deputy', federated_write: ['personal'] } },
      'personal',
    );
    expect(shared.reviewers.map(r => r.email)).toEqual(['personal@example.test']);
    expect(shared.policyKind).toBe('personal');
  });

  test('an explicitly shared source includes delegated writers even with one direct owner', () => {
    const shared = resolveMandatoryReviewers(
      { ...PERMS, 'deputy@example.test': { source_id: 'deputy', federated_write: ['personal'] } },
      'personal',
      { policyKind: 'shared' },
    );
    expect(shared.reviewers.map(r => r.email)).toEqual(['deputy@example.test', 'personal@example.test']);
    expect(shared.policyKind).toBe('shared');
  });

  test('an unknown source resolves to zero reviewers rather than a default', () => {
    expect(resolveMandatoryReviewers(PERMS, 'internal-nobody').reviewers).toEqual([]);
    expect(resolveMandatoryReviewers(PERMS, '').reviewers).toEqual([]);
  });

  test('emails normalize and deduplicate case-insensitively', () => {
    const { reviewers } = resolveMandatoryReviewers({ 'Owner@Example.Test': { source_id: 'x', federated_write: ['x'] } }, 'x');
    expect(reviewers.map(r => r.email)).toEqual(['owner@example.test']);
  });
});

describe('round aggregation', () => {
  const dueAtMs = 2_000;

  test('two shared reviewers require the facilitator even when unanimous', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test'),
      votes: [vote(1, 'a@x.test', 'approve'), vote(2, 'b@x.test', 'approve')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('escalate');
    expect(result.reason).toBe('facilitator_required');
    expect(result.approvals).toBe(2);
  });

  test('one reviewer on an explicitly shared source still requires the facilitator', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test'),
      votes: [vote(1, 'a@x.test', 'approve')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('escalate');
    expect(result.reason).toBe('facilitator_required');
  });

  test('strict majority of all shared reviewers auto-accepts without waiting for every vote', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test', 'c@x.test'),
      votes: [vote(1, 'a@x.test', 'approve'), vote(2, 'b@x.test', 'approve')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('auto_accept');
    expect(result.reason).toBe('quorum_approve');
    expect(result.quorum).toBe(2);
  });

  test('strict majority of all shared reviewers auto-rejects symmetrically', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'),
      votes: [vote(1, 'a@x.test', 'reject'), vote(2, 'b@x.test', 'reject'), vote(3, 'c@x.test', 'reject')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('auto_reject');
    expect(result.reason).toBe('quorum_reject');
    expect(result.quorum).toBe(3);
  });

  test('half of an even shared reviewer set is not a quorum', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'),
      votes: [vote(1, 'a@x.test', 'approve'), vote(2, 'b@x.test', 'approve')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('open');
    expect(result.quorum).toBe(3);
  });

  test('a single vote finalizes a one-reviewer (personal) round', () => {
    expect(aggregatePersonal({
      assignments: assignments('solo@x.test'),
      votes: [vote(1, 'solo@x.test', 'approve')],
      dueAtMs, nowMs: 1_000,
    }).verdict).toBe('auto_accept');
  });

  test('a completed even shared tie escalates to the facilitator', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'),
      votes: [
        vote(1, 'a@x.test', 'approve'), vote(2, 'b@x.test', 'approve'),
        vote(3, 'c@x.test', 'reject'), vote(4, 'd@x.test', 'reject'),
      ],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('escalate');
    expect(result.reason).toBe('disagreement');
    expect(result.approvals).toBe(2);
    expect(result.rejections).toBe(2);
  });

  test('abstain completes an assignment but supports neither side', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test', 'c@x.test'),
      votes: [
        vote(1, 'a@x.test', 'approve'),
        vote(2, 'b@x.test', 'reject'),
        vote(3, 'c@x.test', 'abstain'),
      ],
      dueAtMs, nowMs: 1_000,
    });
    expect(result).toMatchObject({
      verdict: 'escalate', reason: 'no_quorum', voted: 3,
      approvals: 1, rejections: 1, abstentions: 1, missing: [], quorum: 2,
    });
  });

  test('abstain does not prevent the other reviewers from reaching quorum', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'),
      votes: [
        vote(1, 'a@x.test', 'abstain'),
        vote(2, 'b@x.test', 'approve'),
        vote(3, 'c@x.test', 'approve'),
        vote(4, 'd@x.test', 'approve'),
      ],
      dueAtMs, nowMs: 1_000,
    });
    expect(result).toMatchObject({
      verdict: 'auto_accept', reason: 'quorum_approve', voted: 4,
      approvals: 3, rejections: 0, abstentions: 1, quorum: 3,
    });
  });

  test('a personal owner who cannot assess escalates to the facilitator', () => {
    const result = aggregatePersonal({
      assignments: assignments('solo@x.test'),
      votes: [vote(1, 'solo@x.test', 'abstain')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result).toMatchObject({
      verdict: 'escalate', reason: 'facilitator_required', voted: 1,
      approvals: 0, rejections: 0, abstentions: 1, missing: [], quorum: 1,
    });
  });

  test('an incomplete round stays open before the deadline', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test'),
      votes: [vote(1, 'a@x.test', 'approve')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('open');
    expect(result.missing).toEqual(['b@x.test']);
  });

  test('non-response past the deadline escalates and is never counted as reject', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test'),
      votes: [vote(1, 'a@x.test', 'approve')],
      dueAtMs, nowMs: 2_001,
    });
    expect(result.verdict).toBe('escalate');
    expect(result.reason).toBe('deadline_missed');
    expect(result.rejections).toBe(0);
    expect(result.missing).toEqual(['b@x.test']);
  });

  test('zero reviewers fails closed to escalation, never to accept', () => {
    const result = aggregateShared({ assignments: [], votes: [], dueAtMs, nowMs: 1_000 });
    expect(result.verdict).toBe('escalate');
    expect(result.reason).toBe('no_reviewers');
  });

  test('system-authored votes cannot drive auto-finalize', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test', 'b@x.test'),
      votes: [vote(1, 'a@x.test', 'approve'), vote(2, 'b@x.test', 'approve', { voter_kind: 'system' })],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('open');
    expect(result.approvals).toBe(1);
    expect(result.missing).toEqual(['b@x.test']);
  });

  test('a vote whose actor does not match its frozen assignment is ignored', () => {
    const result = aggregateShared({
      assignments: assignments('a@x.test'),
      votes: [vote(1, 'impostor@x.test', 'approve')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('open');
    expect(result.voted).toBe(0);
  });

  test('superseded votes do not count twice', () => {
    const result = aggregatePersonal({
      assignments: assignments('a@x.test'),
      votes: [vote(1, 'a@x.test', 'reject', { active: false }), vote(1, 'a@x.test', 'approve')],
      dueAtMs, nowMs: 1_000,
    });
    expect(result.verdict).toBe('auto_accept');
    expect(result.rejections).toBe(0);
  });
});

describe('deadline resolution', () => {
  test('defaults to 72 hours and clamps garbage', () => {
    expect(resolveRoundDeadlineHours(undefined)).toBe(DEFAULT_ROUND_DEADLINE_HOURS);
    expect(resolveRoundDeadlineHours('not-a-number')).toBe(DEFAULT_ROUND_DEADLINE_HOURS);
    expect(resolveRoundDeadlineHours(-5)).toBe(DEFAULT_ROUND_DEADLINE_HOURS);
    expect(resolveRoundDeadlineHours('24')).toBe(24);
    expect(resolveRoundDeadlineHours(100_000)).toBe(24 * 30);
  });
});

describe('reject reason taxonomy', () => {
  test('take deck excludes concept-only codes', () => {
    const codes = rejectReasonsFor('take_proposal').map(r => r.code);
    expect(codes).toContain('unsupported_by_sources');
    expect(codes).not.toContain('weak_synthesis');
    expect(rejectReasonsFor('concept_proposal').map(r => r.code)).toContain('weak_synthesis');
  });

  test('a reject without a code is refused', () => {
    expect(validateRejectReason('take_proposal', '', null).error).toBe('reason_code_required');
    expect(validateRejectReason('take_proposal', 'made_up', null).error).toBe('reason_code_unknown');
    expect(validateRejectReason('take_proposal', 'weak_synthesis', 'x').error).toBe('reason_code_unknown');
  });

  test('codes that demand a comment refuse an empty one', () => {
    expect(validateRejectReason('take_proposal', 'other', '   ').error).toBe('reason_comment_required');
    expect(validateRejectReason('take_proposal', 'contradicts_evidence', '').error).toBe('reason_comment_required');
    expect(validateRejectReason('take_proposal', 'other', 'Дубль записи из 2024 года').ok).toBe(true);
  });

  test('optional-comment codes pass without a comment and cap the length', () => {
    const ok = validateRejectReason('take_proposal', 'outdated', undefined);
    expect(ok.ok).toBe(true);
    expect(ok.comment).toBeNull();
    expect(validateRejectReason('take_proposal', 'outdated', 'x'.repeat(2_001)).error).toBe('reason_comment_too_long');
  });
});
