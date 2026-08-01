/**
 * Pure aggregation + reviewer resolution for multi-reviewer AI Review.
 *
 * No DB, no clock, no filesystem — every input is passed in so the governance
 * math is deterministic and testable in isolation. The persistence + state
 * machine that consumes these functions lives in `ai-review-rounds.ts`.
 *
 * Governance policy (owner-approved, supersedes the weighted-quorum draft):
 *   1. Every CONFIGURED, ACTIVE Portal user whose `source_id` or
 *      `federated_write` grants write access to the proposal's source is a
 *      MANDATORY reviewer. Assignments freeze at round creation.
 *   2. A personal source degenerates to exactly one reviewer (its owner), so
 *      that one human vote finalizes the round. No Admin step.
 *   3. All reviewers carry equal weight 1. Only a UNANIMOUS vote by ALL
 *      assigned reviewers auto-finalizes.
 *   4. Disagreement after all votes, or missing votes past the deadline,
 *      escalates to Admin. Non-response is NEVER counted as reject.
 *   5. Only verified Portal human identities drive auto-finalize; model and
 *      audit output can never carry a round to accepted.
 *   6. Zero eligible reviewers fails CLOSED (escalate, never auto-accept).
 */

export type ReviewDecision = 'approve' | 'reject';
export type ReviewVoterKind = 'portal_user' | 'system';
export type ReviewPolicyKind = 'personal' | 'shared';

/** Shape of one entry in `~/.gbrain/user_permissions.json`. */
export interface ReviewerPermissionEntry {
  source_id?: string | null;
  federated_read?: string[] | null;
  federated_write?: string[] | null;
  /** Explicit deactivation. Absent means active. */
  active?: boolean;
  disabled?: boolean;
}

export type ReviewerPermissionMap = Record<string, ReviewerPermissionEntry>;

export interface ResolvedReviewer {
  email: string;
  /** The source is this user's own personal area. */
  ownsSource: boolean;
  weight: 1;
}

export interface ReviewerResolution {
  reviewers: ResolvedReviewer[];
  policyKind: ReviewPolicyKind;
}

function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

function isActiveEntry(entry: ReviewerPermissionEntry | null | undefined): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.active === false) return false;
  if (entry.disabled === true) return false;
  return true;
}

function writeGrants(entry: ReviewerPermissionEntry): Set<string> {
  const grants = new Set<string>();
  const personal = String(entry.source_id ?? '').trim();
  if (personal) grants.add(personal);
  for (const id of Array.isArray(entry.federated_write) ? entry.federated_write : []) {
    const clean = String(id ?? '').trim();
    if (clean) grants.add(clean);
  }
  return grants;
}

/**
 * Every configured active user who may WRITE to `sourceId` is a mandatory
 * reviewer. Only explicitly configured users count — the implicit
 * "derive a personal source from the email prefix" fallback used by the Portal
 * read path would otherwise make every address on earth a reviewer.
 */
export function resolveMandatoryReviewers(
  permissions: ReviewerPermissionMap,
  sourceIdRaw: string,
  opts: { policyKind?: ReviewPolicyKind } = {},
): ReviewerResolution {
  const sourceId = String(sourceIdRaw ?? '').trim();
  const reviewers: ResolvedReviewer[] = [];
  if (!sourceId || !permissions || typeof permissions !== 'object') {
    return { reviewers, policyKind: 'shared' };
  }

  // Personal ownership wins over delegated write access. A personal area may
  // intentionally be present in another user's `federated_write` (assistant,
  // migration operator, emergency access), but the owner-approved policy says
  // only the unique user whose canonical `source_id` is this source reviews
  // its proposals. Treating delegated writers as co-reviewers would silently
  // turn a personal decision into a shared-area quorum.
  const owners = Object.entries(permissions)
    .map(([emailRaw, entry]) => ({ email: normalizeEmail(emailRaw), entry }))
    .filter(({ email, entry }) =>
      Boolean(email && email.includes('@'))
      && isActiveEntry(entry)
      && String(entry.source_id ?? '').trim() === sourceId)
    .map(({ email }) => ({ email, ownsSource: true, weight: 1 as const }));
  const uniqueOwners = Array.from(new Map(owners.map(owner => [owner.email, owner])).values())
    .sort((a, b) => a.email.localeCompare(b.email));
  if (opts.policyKind !== 'shared' && uniqueOwners.length === 1) {
    return { reviewers: uniqueOwners, policyKind: 'personal' };
  }

  const seen = new Set<string>();
  for (const [emailRaw, entry] of Object.entries(permissions)) {
    const email = normalizeEmail(emailRaw);
    if (!email || !email.includes('@') || seen.has(email)) continue;
    if (!isActiveEntry(entry)) continue;
    if (!writeGrants(entry).has(sourceId)) continue;
    seen.add(email);
    reviewers.push({
      email,
      ownsSource: String(entry.source_id ?? '').trim() === sourceId,
      weight: 1,
    });
  }
  reviewers.sort((a, b) => a.email.localeCompare(b.email));
  return { reviewers, policyKind: 'shared' };
}

export interface AggregationAssignment {
  assignment_id: number;
  reviewer_email: string;
}

export interface AggregationVote {
  assignment_id: number;
  decision: ReviewDecision;
  voter_kind: ReviewVoterKind;
  actor_email: string;
  active: boolean;
}

export interface AggregationInput {
  assignments: AggregationAssignment[];
  votes: AggregationVote[];
  /** Epoch ms. Missing votes past this instant escalate. */
  dueAtMs: number;
  nowMs: number;
}

export type RoundVerdict = 'open' | 'auto_accept' | 'auto_reject' | 'escalate';

export type RoundVerdictReason =
  | 'no_reviewers'
  | 'awaiting_votes'
  | 'unanimous_approve'
  | 'unanimous_reject'
  | 'disagreement'
  | 'deadline_missed';

export interface AggregationResult {
  verdict: RoundVerdict;
  reason: RoundVerdictReason;
  assigned: number;
  voted: number;
  approvals: number;
  rejections: number;
  /** Reviewer emails with no counted vote yet. Never treated as reject. */
  missing: string[];
}

/**
 * A vote only counts when it is the active vote of an assignment in THIS
 * round, cast by a verified Portal human whose identity matches the frozen
 * assignment. Everything else (system-authored rows, superseded rows,
 * mismatched actors) is ignored — that is what makes "model output never
 * auto-accepts" a structural property instead of a code-review promise.
 */
export function aggregateRound(input: AggregationInput): AggregationResult {
  const assignments = Array.isArray(input.assignments) ? input.assignments : [];
  const assigned = assignments.length;
  if (assigned === 0) {
    return { verdict: 'escalate', reason: 'no_reviewers', assigned: 0, voted: 0, approvals: 0, rejections: 0, missing: [] };
  }

  const byAssignment = new Map<number, AggregationAssignment>();
  for (const a of assignments) byAssignment.set(a.assignment_id, a);

  const counted = new Map<number, ReviewDecision>();
  for (const vote of Array.isArray(input.votes) ? input.votes : []) {
    if (!vote.active) continue;
    if (vote.voter_kind !== 'portal_user') continue;
    const assignment = byAssignment.get(vote.assignment_id);
    if (!assignment) continue;
    if (normalizeEmail(vote.actor_email) !== normalizeEmail(assignment.reviewer_email)) continue;
    if (vote.decision !== 'approve' && vote.decision !== 'reject') continue;
    counted.set(vote.assignment_id, vote.decision);
  }

  let approvals = 0;
  let rejections = 0;
  const missing: string[] = [];
  for (const assignment of assignments) {
    const decision = counted.get(assignment.assignment_id);
    if (decision === 'approve') approvals += 1;
    else if (decision === 'reject') rejections += 1;
    else missing.push(assignment.reviewer_email);
  }
  const voted = approvals + rejections;

  if (voted === assigned) {
    if (approvals === assigned) {
      return { verdict: 'auto_accept', reason: 'unanimous_approve', assigned, voted, approvals, rejections, missing };
    }
    if (rejections === assigned) {
      return { verdict: 'auto_reject', reason: 'unanimous_reject', assigned, voted, approvals, rejections, missing };
    }
    return { verdict: 'escalate', reason: 'disagreement', assigned, voted, approvals, rejections, missing };
  }

  if (Number.isFinite(input.dueAtMs) && input.nowMs >= input.dueAtMs) {
    return { verdict: 'escalate', reason: 'deadline_missed', assigned, voted, approvals, rejections, missing };
  }

  return { verdict: 'open', reason: 'awaiting_votes', assigned, voted, approvals, rejections, missing };
}

export const DEFAULT_ROUND_DEADLINE_HOURS = 72;
export const MIN_ROUND_DEADLINE_HOURS = 1;
export const MAX_ROUND_DEADLINE_HOURS = 24 * 30;

/** Clamp an operator-supplied deadline; garbage falls back to 72h. */
export function resolveRoundDeadlineHours(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ROUND_DEADLINE_HOURS;
  return Math.min(MAX_ROUND_DEADLINE_HOURS, Math.max(MIN_ROUND_DEADLINE_HOURS, value));
}
