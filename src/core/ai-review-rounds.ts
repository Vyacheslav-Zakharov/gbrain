/**
 * Multi-reviewer AI Review: persistence + state machine.
 *
 * Rounds sit ON TOP of the immutable `take_proposals` / `concept_proposals`
 * rows. A round never writes canonical content itself — finalization delegates
 * to the existing guarded publishers (`acceptTakeProposal`,
 * `rejectTakeProposal`, `acceptConceptProposal`, `rejectConceptProposal`), so
 * page locks, stale-source checks, file read-back and rollback all stay in one
 * place.
 *
 * The governance rules live in `ai-review-aggregation.ts` as pure functions;
 * this module is the side-effecting shell around them. Audit lands in the
 * existing `ai_review_events` table — one ledger for the whole review surface.
 *
 * Trust: the actor is ALWAYS derived server-side from a Portal or Admin
 * session. No entry point on this module accepts a browser-supplied reviewer
 * list or actor identity.
 */

import type { BrainEngine } from './engine.ts';
import { ReviewConflictError, acceptTakeProposal, rejectTakeProposal } from './ai-review.ts';
import { acceptConceptProposal, rejectConceptProposal } from './concept-review.ts';
import {
  aggregateRound,
  resolveMandatoryReviewers,
  resolveRoundDeadlineHours,
  type AggregationAssignment,
  type AggregationResult,
  type AggregationVote,
  type ReviewDecision,
  type ReviewPolicyKind,
  type ReviewerPermissionMap,
} from './ai-review-aggregation.ts';
import { validateRejectReason, type ReviewTargetType } from './ai-review-reasons.ts';
import { createHash } from 'node:crypto';

export type RoundStatus = 'open' | 'escalated' | 'finalizing' | 'finalized' | 'cancelled';
export type RoundOutcome = 'accepted' | 'rejected';
export type FinalizeMode = 'auto_unanimous' | 'admin_override';

export const ROUND_DEADLINE_CONFIG_KEY = 'ai_review.round_deadline_hours';
export const ROUND_CUTOVER_CONFIG_KEY = 'ai_review.multi_reviewer_cutover_at';

export interface ReviewRoundRow {
  id: number;
  target_type: ReviewTargetType;
  target_id: number;
  source_id: string;
  proposal_snapshot_hash: string;
  policy_kind: ReviewPolicyKind;
  status: RoundStatus;
  outcome: RoundOutcome | null;
  escalation_reason: string | null;
  round_version: number;
  opened_by: string;
  opened_at: string;
  due_at: string;
  closed_at: string | null;
  finalized_by: string | null;
  finalized_at: string | null;
  finalizing_at: string | null;
  finalized_mode: FinalizeMode | null;
  final_reason: string | null;
}

export interface ReviewAssignmentRow {
  id: number;
  round_id: number;
  reviewer_email: string;
  owns_source: boolean;
  status: 'pending' | 'voted';
  assigned_at: string;
  details_opened_at: string | null;
}

export interface ReviewVoteRow {
  id: number;
  round_id: number;
  assignment_id: number;
  decision: ReviewDecision;
  reason_code: string | null;
  comment: string | null;
  voter_kind: 'portal_user' | 'system';
  actor_email: string;
  proposal_snapshot_hash: string;
  idempotency_key: string;
  active: boolean;
  created_at: string;
  superseded_at: string | null;
}

interface ProposalIdentity {
  source_id: string;
  page_slug: string;
  status: string;
  snapshot_hash: string;
  headline: string;
  preview: string;
  page_title: string | null;
  detail: string;
  evidence_count: number;
  proposed_at: string;
  provenance: ReviewProvenance;
}

export interface ReviewProvenance {
  source_id: string;
  page_slug: string;
  page_title: string | null;
  proposed_at: string;
  proposal_run_id: string | null;
  model_id: string | null;
  supporting_sources: Array<{
    source_id: string;
    page_slug: string;
    claim: string | null;
  }>;
}

const TARGET_TYPES: ReviewTargetType[] = ['take_proposal', 'concept_proposal'];

function assertTargetType(raw: unknown): ReviewTargetType {
  const value = String(raw ?? '');
  if (!TARGET_TYPES.includes(value as ReviewTargetType)) {
    throw new ReviewConflictError(`unsupported target_type: ${value}`, 'unsupported_target_type');
  }
  return value as ReviewTargetType;
}

function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

function dbNumber(raw: unknown, field: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} is outside the JavaScript safe integer range`);
  }
  return value;
}

function jsonSafe<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map(item => jsonSafe(item)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]),
    ) as T;
  }
  return value;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item);
}

function normalizeRoundRow(row: ReviewRoundRow): ReviewRoundRow {
  return jsonSafe({
    ...row,
    id: dbNumber(row.id, 'round.id'),
    target_id: dbNumber(row.target_id, 'round.target_id'),
    round_version: dbNumber(row.round_version, 'round.round_version'),
  });
}

function normalizeAssignmentRow(row: ReviewAssignmentRow): ReviewAssignmentRow {
  return jsonSafe({
    ...row,
    id: dbNumber(row.id, 'assignment.id'),
    round_id: dbNumber(row.round_id, 'assignment.round_id'),
  });
}

function normalizeVoteRow(row: ReviewVoteRow): ReviewVoteRow {
  return jsonSafe({
    ...row,
    id: dbNumber(row.id, 'vote.id'),
    round_id: dbNumber(row.round_id, 'vote.round_id'),
    assignment_id: dbNumber(row.assignment_id, 'vote.assignment_id'),
  });
}

function firstLines(markdown: string, count: number): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, count)
    .join('\n');
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"')))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Human-readable title + body excerpt for a not-yet-published concept page. */
export function conceptProposalPresentation(
  markdown: string,
  pageTitle: string | null,
  pageSlug: string,
): { headline: string; preview: string } {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatterTitle = frontmatter?.[1]?.match(/^title:\s*(.+)$/m)?.[1];
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headingIndex = lines.findIndex(line => /^#{1,6}\s+/.test(line));
  const heading = headingIndex >= 0 ? lines[headingIndex]!.replace(/^#{1,6}\s+/, '').trim() : '';
  const headline = (frontmatterTitle ? unquoteYamlScalar(frontmatterTitle) : '')
    || heading
    || pageTitle
    || pageSlug;
  const previewBody = lines.filter((_line, index) => index !== headingIndex).join('\n');
  return { headline, preview: firstLines(previewBody, 4).slice(0, 1_200) };
}

async function recordEvent(
  engine: BrainEngine,
  round: Pick<ReviewRoundRow, 'id' | 'target_type' | 'target_id'>,
  action: string,
  actor: string,
  previous: unknown,
  next: unknown,
  details: Record<string, unknown>,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO ai_review_events
       (target_type, target_id, action, actor, previous_state, new_state, details)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7::text::jsonb)`,
    [
      round.target_type,
      round.target_id,
      action,
      actor,
      stringifyJson(previous ?? null),
      stringifyJson(next ?? null),
      stringifyJson({ round_id: round.id, ...details }),
    ],
  );
}

async function loadProposalIdentity(
  engine: BrainEngine,
  targetType: ReviewTargetType,
  targetId: number,
): Promise<ProposalIdentity> {
  if (targetType === 'take_proposal') {
    const rows = await engine.executeRaw<{
      source_id: string; page_slug: string; status: string; content_hash: string;
      claim_text: string; kind: string; holder: string; weight: number; domain: string | null;
      page_title: string | null; page_body: string | null; proposed_at: string;
      proposal_run_id: string | null; model_id: string | null;
    }>(
      `SELECT tp.source_id, tp.page_slug, tp.status, tp.content_hash, tp.claim_text, tp.kind,
              tp.holder, tp.weight, tp.domain, tp.proposal_run_id, tp.model_id,
              tp.proposed_at::text AS proposed_at,
              p.title AS page_title, p.compiled_truth AS page_body
         FROM take_proposals tp
         LEFT JOIN pages p ON p.source_id = tp.source_id AND p.slug = tp.page_slug AND p.deleted_at IS NULL
        WHERE tp.id = $1`,
      [targetId],
    );
    const row = rows[0];
    if (!row) throw new ReviewConflictError('proposal not found', 'not_found');
    return {
      source_id: row.source_id,
      page_slug: row.page_slug,
      status: row.status,
      snapshot_hash: row.content_hash,
      headline: row.claim_text,
      preview: '',
      page_title: row.page_title,
      detail: (row.page_body ?? '').slice(0, 8000),
      evidence_count: row.page_body ? 1 : 0,
      proposed_at: row.proposed_at,
      provenance: {
        source_id: row.source_id,
        page_slug: row.page_slug,
        page_title: row.page_title,
        proposed_at: row.proposed_at,
        proposal_run_id: row.proposal_run_id,
        model_id: row.model_id,
        supporting_sources: [{ source_id: row.source_id, page_slug: row.page_slug, claim: row.claim_text }],
      },
    };
  }
  const rows = await engine.executeRaw<{
    source_id: string; page_slug: string; status: string; source_content_hash: string;
    proposed_markdown: string; source_atoms: unknown; source_takes: unknown; page_title: string | null; proposed_at: string;
    proposal_run_id: string | null; model_id: string | null;
  }>(
    `SELECT cp.source_id, cp.page_slug, cp.status, cp.source_content_hash,
            cp.proposed_markdown, cp.source_atoms, cp.source_takes, cp.proposal_run_id, cp.model_id,
            cp.proposed_at::text AS proposed_at, p.title AS page_title
       FROM concept_proposals cp
       LEFT JOIN pages p ON p.source_id = cp.source_id AND p.slug = cp.page_slug AND p.deleted_at IS NULL
      WHERE cp.id = $1`,
    [targetId],
  );
  const row = rows[0];
  if (!row) throw new ReviewConflictError('concept proposal not found', 'not_found');
  const atoms = Array.isArray(row.source_atoms) ? row.source_atoms : [];
  const sourceTakes = Array.isArray(row.source_takes) ? row.source_takes : [];
  const supportingSources = sourceTakes.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const candidate = value as Record<string, unknown>;
    const sourceId = typeof candidate.source_id === 'string' ? candidate.source_id : '';
    const pageSlug = typeof candidate.page_slug === 'string' ? candidate.page_slug : '';
    // Review access to the proposal target does not imply cross-source read access.
    if (sourceId !== row.source_id || !pageSlug) return [];
    return [{
      source_id: sourceId,
      page_slug: pageSlug,
      claim: typeof candidate.claim === 'string' ? candidate.claim : null,
    }];
  });
  const presentation = conceptProposalPresentation(row.proposed_markdown, row.page_title, row.page_slug);
  return {
    source_id: row.source_id,
    page_slug: row.page_slug,
    status: row.status,
    snapshot_hash: row.source_content_hash,
    headline: presentation.headline,
    preview: presentation.preview,
    page_title: row.page_title,
    detail: row.proposed_markdown.slice(0, 40_000),
    evidence_count: atoms.length,
    proposed_at: row.proposed_at,
    provenance: {
      source_id: row.source_id,
      page_slug: row.page_slug,
      page_title: row.page_title,
      proposed_at: row.proposed_at,
      proposal_run_id: row.proposal_run_id,
      model_id: row.model_id,
      supporting_sources: supportingSources,
    },
  };
}

export async function resolveRoundDeadlineHoursFromConfig(engine: BrainEngine): Promise<number> {
  const raw = await engine.getConfig(ROUND_DEADLINE_CONFIG_KEY).catch(() => null);
  return resolveRoundDeadlineHours(raw);
}

/**
 * Preserve the pre-existing manually frozen backlog. The first server process
 * running this feature records a durable cutover timestamp; only proposals
 * created after it are automatically enrolled. An operator can move the
 * cutover deliberately through the normal config plane.
 */
export async function resolveReviewCutoverAtFromConfig(
  engine: BrainEngine,
  nowMs = Date.now(),
): Promise<string> {
  const raw = await engine.getConfig(ROUND_CUTOVER_CONFIG_KEY).catch(() => null);
  const parsed = Date.parse(String(raw ?? ''));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const initialized = new Date(nowMs).toISOString();
  await engine.setConfig(ROUND_CUTOVER_CONFIG_KEY, initialized);
  return initialized;
}

export interface OpenRoundOptions {
  targetType: ReviewTargetType | string;
  targetId: number;
  /** Whole `user_permissions.json` map, loaded server-side. */
  permissions: ReviewerPermissionMap;
  /** Server-derived actor (admin session or CLI), never browser-supplied. */
  actor: string;
  deadlineHours?: number;
  nowMs?: number;
}

export interface OpenRoundResult {
  round: ReviewRoundRow;
  assignments: ReviewAssignmentRow[];
}

async function resolveSourceReviewPolicy(engine: BrainEngine, sourceId: string): Promise<ReviewPolicyKind | undefined> {
  // Corporate managed areas are shared even if an administrator happened to
  // configure one of them as a user's default source_id.
  if (sourceId === 'shared' || sourceId.startsWith('internal-')) return 'shared';
  const rows = await engine.executeRaw<{ config: unknown }>(`SELECT config FROM sources WHERE id = $1`, [sourceId]);
  const raw = rows[0]?.config;
  let config: unknown = raw;
  if (typeof raw === 'string') {
    try { config = JSON.parse(raw); } catch { config = {}; }
  }
  const explicit = config && typeof config === 'object'
    ? String((config as Record<string, unknown>).review_policy ?? '').trim()
    : '';
  return explicit === 'shared' || explicit === 'personal' ? explicit : undefined;
}

/**
 * Create the round and freeze its assignments in one transaction. Zero
 * eligible reviewers is represented as an immediately escalated round so the
 * configuration gap is visible to Admin and can never auto-accept.
 */
export async function openReviewRound(engine: BrainEngine, opts: OpenRoundOptions): Promise<OpenRoundResult> {
  const targetType = assertTargetType(opts.targetType);
  const targetId = Number(opts.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new ReviewConflictError('target_id must be a positive integer', 'invalid_target_id');
  }
  const proposal = await loadProposalIdentity(engine, targetType, targetId);
  if (proposal.status !== 'pending') {
    throw new ReviewConflictError('proposal is no longer pending', 'stale_status');
  }

  const sourcePolicy = await resolveSourceReviewPolicy(engine, proposal.source_id);
  const { reviewers, policyKind } = resolveMandatoryReviewers(
    opts.permissions,
    proposal.source_id,
    { policyKind: sourcePolicy },
  );
  const initialStatus: RoundStatus = reviewers.length === 0 ? 'escalated' : 'open';
  const initialEscalationReason = reviewers.length === 0 ? 'no_reviewers' : null;

  const existing = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM ai_review_rounds
      WHERE target_type = $1 AND target_id = $2 AND status IN ('open','escalated','finalizing')`,
    [targetType, targetId],
  );
  if (existing[0]) throw new ReviewConflictError('an active review round already exists', 'round_already_open');

  const deadlineHours = resolveRoundDeadlineHours(opts.deadlineHours ?? await resolveRoundDeadlineHoursFromConfig(engine));
  const nowMs = opts.nowMs ?? Date.now();
  const dueAt = new Date(nowMs + deadlineHours * 3_600_000).toISOString();
  const actor = String(opts.actor || '').trim() || 'system';

  return engine.transaction(async (tx) => {
    const roundRows = await tx.executeRaw<ReviewRoundRow>(
      `INSERT INTO ai_review_rounds
         (target_type, target_id, source_id, proposal_snapshot_hash, policy_kind, status,
          escalation_reason, opened_by, opened_at, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [targetType, targetId, proposal.source_id, proposal.snapshot_hash, policyKind,
        initialStatus, initialEscalationReason, actor,
        new Date(nowMs).toISOString(), dueAt],
    );
    const round = normalizeRoundRow(roundRows[0]!);
    const assignments: ReviewAssignmentRow[] = [];
    for (const reviewer of reviewers) {
      const rows = await tx.executeRaw<ReviewAssignmentRow>(
        `INSERT INTO ai_review_assignments (round_id, reviewer_email, owns_source, weight, status)
         VALUES ($1, $2, $3, 1, 'pending')
         RETURNING *`,
        [round.id, reviewer.email, reviewer.ownsSource],
      );
      assignments.push(normalizeAssignmentRow(rows[0]!));
    }
    await tx.executeRaw(
      `INSERT INTO ai_review_events
         (target_type, target_id, action, actor, previous_state, new_state, details)
       VALUES ($1, $2, 'round_opened', $3, NULL, $4::text::jsonb, $5::text::jsonb)`,
      [
        targetType, targetId, actor,
        stringifyJson({ status: initialStatus, policy_kind: policyKind, escalation_reason: initialEscalationReason }),
        stringifyJson({
          round_id: round.id,
          source_id: proposal.source_id,
          due_at: dueAt,
          deadline_hours: deadlineHours,
          reviewers: assignments.map(a => a.reviewer_email),
        }),
      ],
    );
    return { round, assignments };
  });
}

export interface EnsurePendingRoundsResult {
  opened: number;
  skipped: number;
  failed: Array<{ target_type: ReviewTargetType; target_id: number; code: string }>;
  cutover_at: string;
}

/**
 * Bounded assignment synchronizer for newly generated proposals. It is safe to
 * call from startup, Portal reads and Admin reads: the active-round unique
 * index plus `openReviewRound` make concurrent calls idempotent.
 */
export async function ensurePendingReviewRounds(
  engine: BrainEngine,
  opts: {
    permissions: ReviewerPermissionMap;
    actor?: string;
    deadlineHours?: number;
    limit?: number;
    nowMs?: number;
    cutoverAt?: string;
  },
): Promise<EnsurePendingRoundsResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoverAt = opts.cutoverAt ?? await resolveReviewCutoverAtFromConfig(engine, nowMs);
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const candidates = await engine.executeRaw<{
    target_type: ReviewTargetType;
    target_id: number;
    proposed_at: string;
  }>(
    `SELECT c.target_type, c.target_id, c.proposed_at::text AS proposed_at
       FROM (
         SELECT 'take_proposal'::text AS target_type, id AS target_id, proposed_at
           FROM take_proposals WHERE status = 'pending'
         UNION ALL
         SELECT 'concept_proposal'::text AS target_type, id AS target_id, proposed_at
           FROM concept_proposals WHERE status = 'pending'
       ) c
      WHERE c.proposed_at > $1
        AND NOT EXISTS (
          SELECT 1 FROM ai_review_rounds r
           WHERE r.target_type = c.target_type AND r.target_id = c.target_id
             AND r.status IN ('open','escalated','finalizing')
        )
      ORDER BY c.proposed_at ASC, c.target_type ASC, c.target_id ASC
      LIMIT $2`,
    [cutoverAt, limit],
  );

  let opened = 0;
  let skipped = 0;
  const failed: EnsurePendingRoundsResult['failed'] = [];
  for (const candidate of candidates) {
    try {
      await openReviewRound(engine, {
        targetType: candidate.target_type,
        targetId: Number(candidate.target_id),
        permissions: opts.permissions,
        actor: opts.actor ?? 'system:assignment-sync',
        deadlineHours: opts.deadlineHours,
        nowMs,
      });
      opened += 1;
    } catch (error) {
      const code = error instanceof ReviewConflictError ? error.code : 'assignment_sync_failed';
      if (code === 'round_already_open' || code === 'stale_status') skipped += 1;
      else failed.push({
        target_type: candidate.target_type,
        target_id: Number(candidate.target_id),
        code,
      });
    }
  }
  return { opened, skipped, failed, cutover_at: cutoverAt };
}

async function loadRound(engine: BrainEngine, roundId: number): Promise<ReviewRoundRow> {
  const rows = await engine.executeRaw<ReviewRoundRow>(`SELECT * FROM ai_review_rounds WHERE id = $1`, [roundId]);
  if (!rows[0]) throw new ReviewConflictError('review round not found', 'not_found');
  return normalizeRoundRow(rows[0]);
}

async function loadAggregationInputs(
  engine: BrainEngine,
  roundId: number,
): Promise<{ assignments: AggregationAssignment[]; votes: AggregationVote[] }> {
  const [assignments, votes] = await Promise.all([
    engine.executeRaw<{ id: number; reviewer_email: string }>(
      `SELECT id, reviewer_email FROM ai_review_assignments WHERE round_id = $1 ORDER BY reviewer_email`,
      [roundId],
    ),
    engine.executeRaw<{ assignment_id: number; decision: ReviewDecision; voter_kind: 'portal_user' | 'system'; actor_email: string; active: boolean }>(
      `SELECT assignment_id, decision, voter_kind, actor_email, active
         FROM ai_review_votes WHERE round_id = $1 AND active = true`,
      [roundId],
    ),
  ]);
  return {
    assignments: assignments.map(a => ({ assignment_id: Number(a.id), reviewer_email: a.reviewer_email })),
    votes: votes.map(v => ({
      assignment_id: Number(v.assignment_id),
      decision: v.decision,
      voter_kind: v.voter_kind,
      actor_email: v.actor_email,
      active: v.active !== false,
    })),
  };
}

export async function aggregateRoundById(
  engine: BrainEngine,
  roundId: number,
  nowMs = Date.now(),
): Promise<{ round: ReviewRoundRow; aggregate: AggregationResult }> {
  const round = await loadRound(engine, roundId);
  const { assignments, votes } = await loadAggregationInputs(engine, roundId);
  return {
    round,
    aggregate: aggregateRound({ assignments, votes, dueAtMs: Date.parse(round.due_at), nowMs }),
  };
}

async function markEscalated(
  engine: BrainEngine,
  round: ReviewRoundRow,
  reason: string,
  actor: string,
  details: Record<string, unknown> = {},
): Promise<ReviewRoundRow> {
  return engine.transaction(async (tx) => {
    const rows = await tx.executeRaw<ReviewRoundRow>(
      `UPDATE ai_review_rounds
          SET status = 'escalated', escalation_reason = $2, round_version = round_version + 1
        WHERE id = $1 AND status = 'open' AND round_version = $3
        RETURNING *`,
      [round.id, reason, round.round_version],
    );
    if (!rows[0]) return loadRound(tx, round.id);
    await recordEvent(tx, round, 'round_escalated', actor, { status: round.status }, { status: 'escalated' }, { reason, ...details });
    return normalizeRoundRow(rows[0]);
  });
}

export interface FinalizeResult {
  round: ReviewRoundRow;
  outcome: RoundOutcome;
  publication?: unknown;
}

/**
 * Two-phase finalize. Phase 1 CAS-claims the round into `finalizing` so a
 * second concurrent caller loses deterministically. Phase 2 publishes through
 * the existing guarded service. A publication failure rolls the round back to
 * its prior state and records `publication_failed` — it never becomes a
 * finalized success.
 */
async function finalizeRoundInternal(
  engine: BrainEngine,
  round: ReviewRoundRow,
  opts: { action: RoundOutcome; mode: FinalizeMode; actor: string; reason: string | null; voters: string[] },
): Promise<FinalizeResult> {
  const claimed = await engine.executeRaw<ReviewRoundRow>(
    `UPDATE ai_review_rounds
        SET status = 'finalizing', finalizing_at = now(), finalized_by = $4,
            finalized_mode = $5, final_reason = $6, round_version = round_version + 1
      WHERE id = $1 AND status = $2 AND round_version = $3
      RETURNING *`,
    [round.id, round.status, round.round_version, opts.actor, opts.mode, opts.reason],
  );
  if (!claimed[0]) {
    throw new ReviewConflictError('review round changed concurrently', 'concurrent_finalization');
  }
  const claimedRound = normalizeRoundRow(claimed[0]);


  const proposal = await loadProposalIdentity(engine, round.target_type, round.target_id).catch(() => null);
  if (!proposal || proposal.status !== 'pending' || proposal.snapshot_hash !== round.proposal_snapshot_hash) {
    await engine.transaction(async (tx) => {
      await tx.executeRaw(
        `UPDATE ai_review_rounds
            SET status = 'escalated', escalation_reason = 'stale_proposal', finalizing_at = NULL,
                finalized_by = NULL, finalized_mode = NULL, final_reason = NULL,
                round_version = round_version + 1
          WHERE id = $1 AND status = 'finalizing'`,
        [round.id],
      );
      await recordEvent(tx, round, 'round_escalated', opts.actor, { status: claimedRound.status }, { status: 'escalated' }, {
        reason: 'stale_proposal',
        proposal_status: proposal?.status ?? 'missing',
      });
    });
    throw new ReviewConflictError('proposal changed after the round was opened', 'stale_proposal');
  }

  const publisherActor = opts.mode === 'admin_override'
    ? `review-round:${round.id}:override:${opts.actor}`
    : `review-round:${round.id}:unanimous`;

  let publication: unknown;
  try {
    if (round.target_type === 'take_proposal') {
      const result = opts.action === 'accepted'
        ? await acceptTakeProposal(engine, round.target_id, undefined, publisherActor)
        : await rejectTakeProposal(engine, round.target_id, publisherActor, opts.reason ?? undefined);
      publication = result.publication ?? null;
    } else {
      const result = opts.action === 'accepted'
        ? await acceptConceptProposal(engine, round.target_id, undefined, publisherActor)
        : await rejectConceptProposal(engine, round.target_id, publisherActor, opts.reason ?? undefined);
      publication = (result as { publication?: unknown }).publication ?? null;
    }
  } catch (error) {
    // A durable unanimous vote must never fall back to an invisible open
    // round: nobody has another vote to cast, so it would otherwise remain
    // stuck forever. Surface the failed canonical mutation to Admin while
    // preserving every vote and the publisher error in the audit ledger.
    await engine.transaction(async (tx) => {
      await tx.executeRaw(
        `UPDATE ai_review_rounds
            SET status = 'escalated', escalation_reason = 'publication_failed',
                finalizing_at = NULL, finalized_by = NULL, finalized_mode = NULL, final_reason = NULL,
                round_version = round_version + 1
          WHERE id = $1 AND status = 'finalizing'`,
        [round.id],
      );
      await recordEvent(tx, round, 'publication_failed', opts.actor, { status: 'finalizing' }, { status: 'escalated' }, {
        action: opts.action,
        mode: opts.mode,
        error: error instanceof Error ? error.message : String(error),
        error_code: error instanceof ReviewConflictError ? error.code : null,
      });
    });
    throw error;
  }

  const finalRound = await engine.transaction(async (tx) => {
    const finalized = await tx.executeRaw<ReviewRoundRow>(
      `UPDATE ai_review_rounds
          SET status = 'finalized', outcome = $2, closed_at = now(), finalized_at = now(),
              finalizing_at = NULL, finalized_by = $3, finalized_mode = $4, final_reason = $5,
              round_version = round_version + 1
        WHERE id = $1 AND status = 'finalizing'
        RETURNING *`,
      [round.id, opts.action, opts.actor, opts.mode, opts.reason],
    );
    const completed = finalized[0] ? normalizeRoundRow(finalized[0]) : await loadRound(tx, round.id);
    await recordEvent(tx, round, opts.mode === 'admin_override' ? 'round_override' : 'round_finalized', opts.actor,
      { status: claimedRound.status }, { status: 'finalized', outcome: opts.action }, {
        mode: opts.mode,
        reason: opts.reason,
        voters: opts.voters,
        publication,
      });
    return completed;
  });
  return { round: finalRound, outcome: opts.action, publication };
}

/**
 * Apply the aggregation verdict to a round: auto-finalize on unanimity,
 * escalate on disagreement / missed deadline, otherwise leave it open.
 */
async function settleRound(
  engine: BrainEngine,
  round: ReviewRoundRow,
  nowMs: number,
): Promise<{ round: ReviewRoundRow; aggregate: AggregationResult; finalization: FinalizeResult | null; finalizationError: string | null }> {
  // Callers may carry a row loaded before another vote committed. Reloading the
  // version makes every verdict claim conditional on the current vote epoch.
  round = await loadRound(engine, round.id);
  const { assignments, votes } = await loadAggregationInputs(engine, round.id);
  const aggregate = aggregateRound({ assignments, votes, dueAtMs: Date.parse(round.due_at), nowMs });
  if (round.status !== 'open') return { round, aggregate, finalization: null, finalizationError: null };

  if (aggregate.verdict === 'escalate') {
    return { round: await markEscalated(engine, round, aggregate.reason, 'system'), aggregate, finalization: null, finalizationError: null };
  }
  if (aggregate.verdict === 'auto_accept' || aggregate.verdict === 'auto_reject') {
    const voters = assignments.map(a => a.reviewer_email);
    try {
      const finalization = await finalizeRoundInternal(engine, round, {
        action: aggregate.verdict === 'auto_accept' ? 'accepted' : 'rejected',
        mode: 'auto_unanimous',
        actor: 'system:unanimous',
        reason: null,
        voters,
      });
      return { round: finalization.round, aggregate, finalization, finalizationError: null };
    } catch (error) {
      // The vote itself is durable. Surface the publication failure without
      // discarding it — Admin picks the round up from the escalation queue.
      const message = error instanceof Error ? error.message : String(error);
      const current = await loadRound(engine, round.id);
      return { round: current, aggregate, finalization: null, finalizationError: message };
    }
  }
  return { round, aggregate, finalization: null, finalizationError: null };
}

export interface ReviewerScope {
  /** Server-derived Portal identity. */
  email: string;
  /** Source ids the caller may currently WRITE to, re-read per request. */
  allowedWriteSources: string[];
}

export interface DeckCard {
  assignment_id: number;
  round_id: number;
  target_type: ReviewTargetType;
  target_id: number;
  source_id: string;
  page_slug: string;
  page_title: string | null;
  headline: string;
  preview: string;
  evidence_count: number;
  proposal_snapshot_hash: string;
  due_at: string;
  proposed_at: string;
  policy_kind: ReviewPolicyKind;
  details_opened: boolean;
}

interface AssignmentContext {
  assignment: ReviewAssignmentRow;
  round: ReviewRoundRow;
}

async function loadAssignmentContext(engine: BrainEngine, assignmentId: number): Promise<AssignmentContext> {
  const rows = await engine.executeRaw<ReviewAssignmentRow & { round_json: null }>(
    `SELECT * FROM ai_review_assignments WHERE id = $1`,
    [assignmentId],
  );
  const assignment = rows[0] ? normalizeAssignmentRow(rows[0]) : null;
  if (!assignment) throw new ReviewConflictError('assignment not found', 'not_found');
  const round = await loadRound(engine, Number(assignment.round_id));
  return { assignment, round };
}

function assertReviewerScope(ctx: AssignmentContext, scope: ReviewerScope): void {
  const email = normalizeEmail(scope.email);
  if (!email) throw new ReviewConflictError('unauthenticated reviewer', 'unauthenticated');
  if (normalizeEmail(ctx.assignment.reviewer_email) !== email) {
    throw new ReviewConflictError('assignment belongs to another reviewer', 'foreign_assignment');
  }
  const allowed = new Set((scope.allowedWriteSources || []).map(s => String(s).trim()).filter(Boolean));
  if (!allowed.has(ctx.round.source_id)) {
    throw new ReviewConflictError('source access was revoked', 'source_access_revoked');
  }
}

/** Reviewer deck. Deliberately blind: no other reviewer's vote is exposed. */
export async function listReviewerDeck(
  engine: BrainEngine,
  scope: ReviewerScope,
  opts: { limit?: number; targetType?: ReviewTargetType } = {},
): Promise<{ cards: DeckCard[]; total: number }> {
  const email = normalizeEmail(scope.email);
  const allowed = (scope.allowedWriteSources || []).map(s => String(s).trim()).filter(Boolean);
  if (!email || allowed.length === 0) return { cards: [], total: 0 };
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
  const targetType = opts.targetType ? assertTargetType(opts.targetType) : null;

  type DeckRow = {
    assignment_id: number; round_id: number; target_type: ReviewTargetType; target_id: number;
    source_id: string; proposal_snapshot_hash: string; due_at: string; policy_kind: ReviewPolicyKind;
    details_opened_at: string | null; total_count: number;
  };
  const batchSize = Math.max(50, limit);
  let offset = 0;
  let rawTotal = 0;
  const cards: DeckCard[] = [];
  const staleRoundIds = new Set<number>();

  // Filter proposal freshness without allowing stale rows at the front of the
  // queue to starve valid assignments behind SQL LIMIT. Keep the result set
  // stable while paging, then escalate stale rounds after the scan.
  while (cards.length < limit) {
    const rows = await engine.executeRaw<DeckRow>(
      `SELECT a.id AS assignment_id, r.id AS round_id, r.target_type, r.target_id, r.source_id,
              r.proposal_snapshot_hash, r.due_at::text AS due_at, r.policy_kind, a.details_opened_at,
              count(*) OVER()::int AS total_count
         FROM ai_review_assignments a
         JOIN ai_review_rounds r ON r.id = a.round_id
        WHERE a.reviewer_email = $1
          AND a.status = 'pending'
          AND r.status = 'open'
          AND r.source_id = ANY($2::text[])
          AND ($3::text IS NULL OR r.target_type = $3)
          AND NOT EXISTS (
            SELECT 1 FROM ai_review_votes v WHERE v.assignment_id = a.id AND v.active = true
          )
        ORDER BY r.due_at ASC, a.id ASC
        LIMIT $4 OFFSET $5`,
      [email, allowed, targetType, batchSize, offset],
    );
    if (offset === 0) rawTotal = Number(rows[0]?.total_count ?? 0);
    if (rows.length === 0) break;
    offset += rows.length;
    for (const row of rows) {
      const proposal = await loadProposalIdentity(engine, row.target_type, Number(row.target_id)).catch(() => null);
      if (!proposal || proposal.status !== 'pending' || proposal.snapshot_hash !== row.proposal_snapshot_hash) {
        staleRoundIds.add(Number(row.round_id));
        continue;
      }
      cards.push({
        assignment_id: Number(row.assignment_id),
        round_id: Number(row.round_id),
        target_type: row.target_type,
        target_id: Number(row.target_id),
        source_id: row.source_id,
        page_slug: proposal.page_slug,
        page_title: proposal.page_title,
        headline: proposal.headline,
        preview: proposal.preview,
        evidence_count: proposal.evidence_count,
        proposal_snapshot_hash: proposal.snapshot_hash,
        due_at: row.due_at,
        proposed_at: proposal.proposed_at,
        policy_kind: row.policy_kind,
        details_opened: Boolean(row.details_opened_at),
      });
      if (cards.length >= limit) break;
    }
    if (rows.length < batchSize) break;
  }
  for (const roundId of staleRoundIds) {
    const round = await loadRound(engine, roundId).catch(() => null);
    if (round?.status === 'open') await markEscalated(engine, round, 'stale_proposal', 'system:deck');
  }
  return { cards, total: Math.max(cards.length, rawTotal - staleRoundIds.size) };
}

export interface ReviewerItemDetail extends DeckCard {
  detail: string;
  provenance: ReviewProvenance;
}

export async function getReviewerItem(
  engine: BrainEngine,
  scope: ReviewerScope,
  assignmentId: number,
  opts: { markDetailsOpened?: boolean } = {},
): Promise<ReviewerItemDetail> {
  const ctx = await loadAssignmentContext(engine, assignmentId);
  assertReviewerScope(ctx, scope);
  const proposal = await loadProposalIdentity(engine, ctx.round.target_type, ctx.round.target_id);
  if (opts.markDetailsOpened) {
    await engine.executeRaw(
      `UPDATE ai_review_assignments SET details_opened_at = COALESCE(details_opened_at, now()) WHERE id = $1`,
      [ctx.assignment.id],
    );
  }
  return {
    assignment_id: Number(ctx.assignment.id),
    round_id: Number(ctx.round.id),
    target_type: ctx.round.target_type,
    target_id: Number(ctx.round.target_id),
    source_id: ctx.round.source_id,
    page_slug: proposal.page_slug,
    page_title: proposal.page_title,
    headline: proposal.headline,
    preview: proposal.preview,
    evidence_count: proposal.evidence_count,
    proposal_snapshot_hash: proposal.snapshot_hash,
    due_at: ctx.round.due_at,
    proposed_at: proposal.proposed_at,
    policy_kind: ctx.round.policy_kind,
    details_opened: Boolean(ctx.assignment.details_opened_at) || Boolean(opts.markDetailsOpened),
    detail: proposal.detail,
    provenance: proposal.provenance,
  };
}

export interface CastVoteInput {
  assignmentId: number;
  decision: ReviewDecision | string;
  reasonCode?: unknown;
  comment?: unknown;
  /** Echo of the hash the reviewer actually saw. */
  proposalSnapshotHash?: unknown;
  idempotencyKey?: unknown;
  nowMs?: number;
}

export interface CastVoteResult {
  vote: ReviewVoteRow;
  round: ReviewRoundRow;
  aggregate: AggregationResult;
  replayed: boolean;
  finalization: FinalizeResult | null;
  finalizationError: string | null;
}

function derivedIdempotencyKey(input: { assignmentId: number; decision: string; reasonCode: string | null; comment: string | null }): string {
  return createHash('sha256')
    .update(String(input.assignmentId))
    .update('\0')
    .update(input.decision)
    .update('\0')
    .update(input.reasonCode ?? '')
    .update('\0')
    .update(input.comment ?? '')
    .digest('hex')
    .slice(0, 48);
}

/**
 * Record one reviewer's vote. Append-only: replacing a vote supersedes the old
 * row instead of deleting it. Replaying the same idempotency key returns the
 * stored vote without producing a second one.
 */
export async function castReviewerVote(
  engine: BrainEngine,
  scope: ReviewerScope,
  input: CastVoteInput,
): Promise<CastVoteResult> {
  const ctx = await loadAssignmentContext(engine, Number(input.assignmentId));
  assertReviewerScope(ctx, scope);
  const nowMs = input.nowMs ?? Date.now();

  const decision = String(input.decision ?? '');
  if (decision !== 'approve' && decision !== 'reject') {
    throw new ReviewConflictError('decision must be approve or reject', 'invalid_decision');
  }
  let reasonCode: string | null = null;
  let comment: string | null = null;
  if (decision === 'reject') {
    const validated = validateRejectReason(ctx.round.target_type, input.reasonCode, input.comment);
    if (!validated.ok) throw new ReviewConflictError(`reject reason rejected: ${validated.error}`, validated.error!);
    reasonCode = validated.reasonCode!;
    comment = validated.comment ?? null;
  }

  // Network retries can arrive after the first request already finalized the
  // round. Honor an explicit idempotency key before rejecting a closed round;
  // otherwise the client receives 409 even though its vote succeeded.
  const explicitIdempotencyKey = typeof input.idempotencyKey === 'string'
    ? input.idempotencyKey.trim().slice(0, 128)
    : '';
  if (explicitIdempotencyKey) {
    const replay = await engine.executeRaw<ReviewVoteRow>(
      `SELECT * FROM ai_review_votes WHERE assignment_id = $1 AND idempotency_key = $2`,
      [ctx.assignment.id, explicitIdempotencyKey],
    );
    if (replay[0]) {
      if (replay[0].decision !== decision
        || (replay[0].reason_code ?? null) !== reasonCode
        || (replay[0].comment ?? null) !== comment) {
        throw new ReviewConflictError('idempotency key was already used for a different vote payload', 'idempotency_conflict');
      }
      const settled = await settleRound(engine, ctx.round, nowMs);
      return {
        vote: normalizeVoteRow(replay[0]),
        round: settled.round,
        aggregate: settled.aggregate,
        replayed: true,
        finalization: settled.finalization,
        finalizationError: settled.finalizationError,
      };
    }
  }

  if (ctx.round.status !== 'open') {
    throw new ReviewConflictError(`review round is ${ctx.round.status}`, 'round_closed');
  }

  // A vote arriving after the deadline does not silently land: the round is
  // already Admin's problem, and the frozen assignment list stays honest.
  if (Number.isFinite(Date.parse(ctx.round.due_at)) && nowMs >= Date.parse(ctx.round.due_at)) {
    const escalated = await markEscalated(engine, ctx.round, 'deadline_missed', 'system');
    throw new ReviewConflictError(
      `voting deadline passed at ${escalated.due_at}; the round escalated to an administrator`,
      'round_escalated',
    );
  }

  const proposal = await loadProposalIdentity(engine, ctx.round.target_type, ctx.round.target_id);
  const echoed = typeof input.proposalSnapshotHash === 'string' ? input.proposalSnapshotHash.trim() : '';
  if (proposal.status !== 'pending' || proposal.snapshot_hash !== ctx.round.proposal_snapshot_hash) {
    throw new ReviewConflictError('proposal changed after the round was opened', 'stale_proposal');
  }
  if (echoed && echoed !== ctx.round.proposal_snapshot_hash) {
    throw new ReviewConflictError('the card you voted on is out of date', 'stale_proposal');
  }

  const idempotencyKeyRaw = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  const idempotencyKey = idempotencyKeyRaw.slice(0, 128)
    || derivedIdempotencyKey({ assignmentId: Number(ctx.assignment.id), decision, reasonCode, comment });

  const replay = await engine.executeRaw<ReviewVoteRow>(
    `SELECT * FROM ai_review_votes WHERE assignment_id = $1 AND idempotency_key = $2`,
    [ctx.assignment.id, idempotencyKey],
  );
  if (replay[0]) {
    if (replay[0].decision !== decision
      || (replay[0].reason_code ?? null) !== reasonCode
      || (replay[0].comment ?? null) !== comment) {
      throw new ReviewConflictError('idempotency key was already used for a different vote payload', 'idempotency_conflict');
    }
    const settled = await settleRound(engine, ctx.round, nowMs);
    return {
      vote: normalizeVoteRow(replay[0]),
      round: settled.round,
      aggregate: settled.aggregate,
      replayed: true,
      finalization: settled.finalization,
      finalizationError: settled.finalizationError,
    };
  }

  let voteWrite: { vote: ReviewVoteRow; round: ReviewRoundRow };
  try {
    voteWrite = await engine.transaction(async (tx) => {
      // Serialize competing votes for the same frozen assignment on PostgreSQL,
      // not only inside one PGLite process.
      await tx.executeRaw(`SELECT id FROM ai_review_assignments WHERE id = $1 FOR UPDATE`, [ctx.assignment.id]);
      // The assignment lock alone is insufficient: a deadline sweep or Admin
      // finalization may close the round after the preflight checks above.
      const lockedRows = await tx.executeRaw<ReviewRoundRow>(
        `SELECT * FROM ai_review_rounds WHERE id = $1 FOR UPDATE`,
        [ctx.round.id],
      );
      const lockedRound = lockedRows[0] ? normalizeRoundRow(lockedRows[0]) : null;
      if (!lockedRound || lockedRound.status !== 'open') {
        throw new ReviewConflictError(`review round is ${lockedRound?.status ?? 'missing'}`, 'round_closed');
      }
      if (Number.isFinite(Date.parse(lockedRound.due_at)) && nowMs >= Date.parse(lockedRound.due_at)) {
        throw new ReviewConflictError('voting deadline passed while the vote was being recorded', 'round_escalated');
      }
      const lockedProposal = await loadProposalIdentity(tx, lockedRound.target_type, Number(lockedRound.target_id));
      if (lockedProposal.status !== 'pending' || lockedProposal.snapshot_hash !== lockedRound.proposal_snapshot_hash) {
        throw new ReviewConflictError('proposal changed while the vote was being recorded', 'stale_proposal');
      }
      const previousActive = await tx.executeRaw<{ id: number; decision: string }>(
        `SELECT id, decision FROM ai_review_votes WHERE assignment_id = $1 AND active = true`,
        [ctx.assignment.id],
      );
      await tx.executeRaw(
        `UPDATE ai_review_votes SET active = false, superseded_at = now()
          WHERE assignment_id = $1 AND active = true`,
        [ctx.assignment.id],
      );
      const rows = await tx.executeRaw<ReviewVoteRow>(
        `INSERT INTO ai_review_votes
           (round_id, assignment_id, decision, reason_code, comment, voter_kind, actor_email,
            proposal_snapshot_hash, idempotency_key, active)
         VALUES ($1, $2, $3, $4, $5, 'portal_user', $6, $7, $8, true)
         RETURNING *`,
        [ctx.round.id, ctx.assignment.id, decision, reasonCode, comment,
          normalizeEmail(scope.email), ctx.round.proposal_snapshot_hash, idempotencyKey],
      );
      const inserted = rows[0]!;
      await tx.executeRaw(
        `UPDATE ai_review_assignments SET status = 'voted' WHERE id = $1`,
        [ctx.assignment.id],
      );
      const versionRows = await tx.executeRaw<ReviewRoundRow>(
        `UPDATE ai_review_rounds
            SET round_version = round_version + 1
          WHERE id = $1 AND status = 'open'
          RETURNING *`,
        [lockedRound.id],
      );
      if (!versionRows[0]) throw new ReviewConflictError('review round closed while recording the vote', 'round_closed');
      // Vote state and its redacted audit event commit atomically. Comments may
      // quote restricted source text, so only their presence is audited.
      await tx.executeRaw(
        `INSERT INTO ai_review_events
           (target_type, target_id, action, actor, previous_state, new_state, details)
         VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7::text::jsonb)`,
        [
          ctx.round.target_type,
          ctx.round.target_id,
          previousActive[0] ? 'vote_replaced' : 'vote_cast',
          normalizeEmail(scope.email),
          stringifyJson(previousActive[0] ? { decision: previousActive[0].decision } : null),
          stringifyJson({ decision, reason_code: reasonCode }),
          stringifyJson({
            round_id: ctx.round.id,
            assignment_id: Number(ctx.assignment.id),
            vote_id: Number(inserted.id),
            replaces_vote_id: previousActive[0] ? Number(previousActive[0].id) : null,
            has_comment: Boolean(comment),
          }),
        ],
      );
      return { vote: normalizeVoteRow(inserted), round: normalizeRoundRow(versionRows[0]) };
    });
  } catch (error) {
    if (error instanceof ReviewConflictError && error.code === 'round_escalated') {
      const current = await loadRound(engine, ctx.round.id);
      if (current.status === 'open') await markEscalated(engine, current, 'deadline_missed', 'system');
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate key|unique constraint|ai_review_votes_/i.test(message)) {
      const winner = await engine.executeRaw<ReviewVoteRow>(
        `SELECT * FROM ai_review_votes WHERE assignment_id = $1 AND idempotency_key = $2`,
        [ctx.assignment.id, idempotencyKey],
      );
      if (winner[0]
        && winner[0].decision === decision
        && (winner[0].reason_code ?? null) === reasonCode
        && (winner[0].comment ?? null) === comment) {
        const settled = await settleRound(engine, ctx.round, nowMs);
        return {
          vote: normalizeVoteRow(winner[0]),
          round: settled.round,
          aggregate: settled.aggregate,
          replayed: true,
          finalization: settled.finalization,
          finalizationError: settled.finalizationError,
        };
      }
      throw new ReviewConflictError('a concurrent vote won this assignment', 'concurrent_vote');
    }
    throw error;
  }

  const settled = await settleRound(engine, voteWrite.round, nowMs);
  return {
    vote: voteWrite.vote,
    round: settled.round,
    aggregate: settled.aggregate,
    replayed: false,
    finalization: settled.finalization,
    finalizationError: settled.finalizationError,
  };
}

/**
 * Recover a process crash between the canonical publisher and the final round
 * status update. A terminal proposal proves publication completed; a still
 * pending proposal is surfaced to Admin for inspection rather than retried
 * blindly (the interrupted publisher may have reached the filesystem).
 */
export async function recoverInterruptedFinalizations(
  engine: BrainEngine,
  opts: { nowMs?: number; staleAfterMs?: number } = {},
): Promise<{ escalated: number; finalized: number; roundIds: number[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  const staleAfterMs = Math.max(60_000, Number(opts.staleAfterMs) || 15 * 60_000);
  const threshold = new Date(nowMs - staleAfterMs).toISOString();
  const stuck = await engine.executeRaw<ReviewRoundRow>(
    `SELECT * FROM ai_review_rounds
      WHERE status = 'finalizing' AND COALESCE(finalizing_at, opened_at) <= $1
      ORDER BY id`,
    [threshold],
  );
  let escalated = 0;
  let finalized = 0;
  const roundIds: number[] = [];
  for (const rawRound of stuck) {
    const round = normalizeRoundRow(rawRound);
    const proposal = await loadProposalIdentity(engine, round.target_type, Number(round.target_id)).catch(() => null);
    if (proposal?.status === 'accepted' || proposal?.status === 'rejected') {
      const outcome = proposal.status as RoundOutcome;
      const recovered = await engine.transaction(async (tx) => {
        const rows = await tx.executeRaw<ReviewRoundRow>(
          `UPDATE ai_review_rounds
              SET status = 'finalized', outcome = $2, closed_at = now(), finalized_at = now(),
                  finalizing_at = NULL, finalized_by = COALESCE(finalized_by, 'system:recovery'),
                  finalized_mode = COALESCE(finalized_mode, 'auto_unanimous'),
                  round_version = round_version + 1
            WHERE id = $1 AND status = 'finalizing'
            RETURNING *`,
          [round.id, outcome],
        );
        if (rows[0]) {
          await recordEvent(tx, round, 'round_finalization_recovered', 'system:recovery',
            { status: 'finalizing' }, { status: 'finalized', outcome }, { proposal_status: proposal.status });
        }
        return Boolean(rows[0]);
      });
      if (recovered) {
        finalized += 1;
        roundIds.push(Number(round.id));
      }
      continue;
    }
    const interrupted = await engine.transaction(async (tx) => {
      const rows = await tx.executeRaw<ReviewRoundRow>(
        `UPDATE ai_review_rounds
            SET status = 'escalated', escalation_reason = 'publication_interrupted',
                finalizing_at = NULL, finalized_by = NULL, finalized_mode = NULL, final_reason = NULL,
                round_version = round_version + 1
          WHERE id = $1 AND status = 'finalizing'
          RETURNING *`,
        [round.id],
      );
      if (rows[0]) {
        await recordEvent(tx, round, 'round_escalated', 'system:recovery',
          { status: 'finalizing' }, { status: 'escalated' }, {
            reason: 'publication_interrupted',
            proposal_status: proposal?.status ?? 'missing',
          });
      }
      return Boolean(rows[0]);
    });
    if (interrupted) {
      escalated += 1;
      roundIds.push(Number(round.id));
    }
  }
  return { escalated, finalized, roundIds };
}

/**
 * Deadline sweep. Rounds whose votes are incomplete past `due_at` escalate to
 * Admin; a round that already has every vote settles normally (a sweep must
 * never turn a completed unanimous round into an escalation).
 */
export async function escalateOverdueRounds(
  engine: BrainEngine,
  opts: { nowMs?: number; finalizingStaleAfterMs?: number } = {},
): Promise<{ escalated: number; finalized: number; roundIds: number[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  const recovered = await recoverInterruptedFinalizations(engine, {
    nowMs,
    staleAfterMs: opts.finalizingStaleAfterMs,
  });
  const due = await engine.executeRaw<ReviewRoundRow>(
    `SELECT * FROM ai_review_rounds WHERE status = 'open' AND due_at <= $1 ORDER BY id`,
    [new Date(nowMs).toISOString()],
  );
  const roundIds: number[] = [...recovered.roundIds];
  let escalated = recovered.escalated;
  let finalized = recovered.finalized;
  for (const rawRound of due) {
    const round = normalizeRoundRow(rawRound);
    const settled = await settleRound(engine, round, nowMs);
    if (settled.round.status === 'escalated') { escalated += 1; roundIds.push(Number(round.id)); }
    else if (settled.round.status === 'finalized') finalized += 1;
  }
  return { escalated, finalized, roundIds };
}

export interface AdminRoundSummary {
  round: ReviewRoundRow;
  headline: string;
  page_slug: string;
  assigned: number;
  approvals: number;
  rejections: number;
  missing: string[];
}

export async function listReviewRounds(
  engine: BrainEngine,
  opts: { status?: RoundStatus | 'active'; limit?: number; offset?: number; nowMs?: number } = {},
): Promise<{ rounds: AdminRoundSummary[]; total: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  await escalateOverdueRounds(engine, { nowMs }).catch(() => undefined);
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const status = opts.status ?? 'escalated';
  const rows = status === 'active'
    ? await engine.executeRaw<ReviewRoundRow & { total_count: number }>(
      `SELECT *, count(*) OVER()::int AS total_count FROM ai_review_rounds
        WHERE status IN ('open','escalated','finalizing') ORDER BY due_at ASC, id ASC LIMIT $1 OFFSET $2`, [limit, offset])
    : await engine.executeRaw<ReviewRoundRow & { total_count: number }>(
      `SELECT *, count(*) OVER()::int AS total_count FROM ai_review_rounds
        WHERE status = $1 ORDER BY due_at ASC, id ASC LIMIT $2 OFFSET $3`, [status, limit, offset]);

  const rounds: AdminRoundSummary[] = [];
  for (const rawRound of rows) {
    const round = normalizeRoundRow(rawRound);
    const { assignments, votes } = await loadAggregationInputs(engine, Number(round.id));
    const aggregate = aggregateRound({ assignments, votes, dueAtMs: Date.parse(round.due_at), nowMs });
    const proposal = await loadProposalIdentity(engine, round.target_type, Number(round.target_id)).catch(() => null);
    rounds.push({
      round,
      headline: proposal?.headline ?? `#${round.target_id}`,
      page_slug: proposal?.page_slug ?? '',
      assigned: aggregate.assigned,
      approvals: aggregate.approvals,
      rejections: aggregate.rejections,
      missing: aggregate.missing,
    });
  }
  let total = Number(rows[0]?.total_count ?? rounds.length);
  if (rows.length === 0 && offset > 0) {
    const counts = status === 'active'
      ? await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ai_review_rounds WHERE status IN ('open','escalated','finalizing')`)
      : await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ai_review_rounds WHERE status = $1`, [status]);
    total = Number(counts[0]?.n ?? 0);
  }
  return { rounds, total };
}

export interface AdminRoundDetail extends AdminRoundSummary {
  detail: string;
  /** Named vote matrix — Admin only; reviewers never see this. */
  matrix: Array<{
    reviewer_email: string;
    assignment_id: number;
    decision: ReviewDecision | null;
    reason_code: string | null;
    comment: string | null;
    voted_at: string | null;
    details_opened: boolean;
  }>;
  events: Array<Record<string, unknown>>;
}

export async function getReviewRoundDetail(
  engine: BrainEngine,
  roundId: number,
  opts: { nowMs?: number } = {},
): Promise<AdminRoundDetail> {
  const nowMs = opts.nowMs ?? Date.now();
  const round = await loadRound(engine, roundId);
  const { assignments, votes } = await loadAggregationInputs(engine, roundId);
  const aggregate = aggregateRound({ assignments, votes, dueAtMs: Date.parse(round.due_at), nowMs });
  const proposal = await loadProposalIdentity(engine, round.target_type, Number(round.target_id)).catch(() => null);

  const matrixRows = await engine.executeRaw<{
    reviewer_email: string; assignment_id: number; details_opened_at: string | null;
    decision: ReviewDecision | null; reason_code: string | null; comment: string | null; voted_at: string | null;
  }>(
    `SELECT a.reviewer_email, a.id AS assignment_id, a.details_opened_at,
            v.decision, v.reason_code, v.comment, v.created_at::text AS voted_at
       FROM ai_review_assignments a
       LEFT JOIN ai_review_votes v ON v.assignment_id = a.id AND v.active = true
      WHERE a.round_id = $1
      ORDER BY a.reviewer_email`,
    [roundId],
  );

  const events = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, action, actor, created_at::text AS created_at, details
       FROM ai_review_events
      WHERE target_type = $1 AND target_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [round.target_type, round.target_id],
  );

  return {
    round,
    headline: proposal?.headline ?? `#${round.target_id}`,
    page_slug: proposal?.page_slug ?? '',
    detail: proposal?.detail ?? '',
    assigned: aggregate.assigned,
    approvals: aggregate.approvals,
    rejections: aggregate.rejections,
    missing: aggregate.missing,
    matrix: matrixRows.map(row => ({
      reviewer_email: row.reviewer_email,
      assignment_id: Number(row.assignment_id),
      decision: row.decision,
      reason_code: row.reason_code,
      comment: row.comment,
      voted_at: row.voted_at,
      details_opened: Boolean(row.details_opened_at),
    })),
    events: jsonSafe(events.filter(e => {
      const details = e.details as { round_id?: number } | null;
      return !details?.round_id || Number(details.round_id) === Number(roundId);
    })),
  };
}

export const MIN_OVERRIDE_REASON_CHARS = 8;

/**
 * Admin finalization. Only an ESCALATED round is finalizable by hand — a round
 * still collecting votes belongs to its reviewers, and a finalized round is
 * done. The override reason is mandatory and lands in the audit ledger.
 */
export async function adminFinalizeRound(
  engine: BrainEngine,
  opts: { roundId: number; actor: string; action: RoundOutcome | string; reason: unknown; nowMs?: number },
): Promise<FinalizeResult> {
  const action = String(opts.action ?? '');
  if (action !== 'accepted' && action !== 'rejected') {
    throw new ReviewConflictError('action must be accepted or rejected', 'invalid_action');
  }
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason.length < MIN_OVERRIDE_REASON_CHARS) {
    throw new ReviewConflictError(
      `an override reason of at least ${MIN_OVERRIDE_REASON_CHARS} characters is required`,
      'override_reason_required',
    );
  }
  const actor = String(opts.actor || '').trim();
  if (!actor) throw new ReviewConflictError('unauthenticated administrator', 'unauthenticated');

  const nowMs = opts.nowMs ?? Date.now();
  await escalateOverdueRounds(engine, { nowMs }).catch(() => undefined);
  const round = await loadRound(engine, Number(opts.roundId));
  if (round.status !== 'escalated') {
    throw new ReviewConflictError(`only escalated rounds can be finalized by hand (round is ${round.status})`, 'round_not_escalated');
  }
  const { assignments } = await loadAggregationInputs(engine, Number(round.id));
  return finalizeRoundInternal(engine, round, {
    action,
    mode: 'admin_override',
    actor,
    reason,
    voters: assignments.map(a => a.reviewer_email),
  });
}

export async function reviewerSummary(
  engine: BrainEngine,
  scope: ReviewerScope,
): Promise<{ pending: number; escalated_visible: number }> {
  const email = normalizeEmail(scope.email);
  const allowed = (scope.allowedWriteSources || []).map(s => String(s).trim()).filter(Boolean);
  if (!email || allowed.length === 0) return { pending: 0, escalated_visible: 0 };
  const rows = await engine.executeRaw<{ pending: number }>(
    `SELECT count(*)::int AS pending
       FROM ai_review_assignments a
       JOIN ai_review_rounds r ON r.id = a.round_id
      WHERE a.reviewer_email = $1 AND a.status = 'pending' AND r.status = 'open'
        AND r.source_id = ANY($2::text[])`,
    [email, allowed],
  );
  return { pending: Number(rows[0]?.pending ?? 0), escalated_visible: 0 };
}
