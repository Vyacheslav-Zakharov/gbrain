/**
 * v0.36.1.0 (T3) — propose_takes cycle phase.
 *
 * Scans markdown pages updated since last run, sends each page's prose to
 * a tuned LLM extractor, writes the extracted gradeable claims to the
 * `take_proposals` queue. User accepts/rejects via `gbrain takes propose`.
 *
 * Idempotency contract (D17 schema spec):
 *   take_proposal_scans is the page-level cache, including zero-result scans.
 *   take_proposals is item-level and includes claim_hash so every claim from
 *   one extractor call is retained. Bumping
 *   PROPOSE_TAKES_PROMPT_VERSION cleanly invalidates the cache so a tuned
 *   prompt re-runs proposals on every page.
 *
 * F2 fence dedup:
 *   The phase reads the page's existing `<!-- gbrain:takes:begin -->` fence
 *   (when present) and passes the canonical take rows to the extractor as
 *   "things you have already captured." This prevents duplicate proposals
 *   when a user adds prose to a page that already has takes.
 *
 * Auto-resolve posture:
 *   propose_takes only WRITES proposals to the queue. Nothing here mutates
 *   the canonical takes table. Operator opt-in via `gbrain takes propose
 *   --accept N` is the only path from queue to canonical fence (D17).
 *
 * Prompt tuning status (v0.36.1.0 ship state):
 *   The default extractor prompt was tuned against the synthetic corpus at
 *   test/fixtures/calibration/ and validated via the cat15 propose_takes
 *   eval in the gbrain-evals repo. First live run scored 0.952 F1 on
 *   training (target 0.85) and 0.922 F1 on holdout (target 0.80), with a
 *   0.03 train-holdout gap (no overfitting). PROPOSE_TAKES_PROMPT_VERSION
 *   is "v0.36.1.0-tuned-cat15". Re-tuning requires re-running cat15;
 *   bumping the version string invalidates the take_proposals idempotency
 *   cache so old proposals stay as audit history but the next cycle
 *   re-extracts fresh against the new prompt.
 *
 * The extractor LLM call is INJECTED via opts.extractor for tests, so the
 * phase can run hermetically in unit tests without touching the gateway.
 */

import { randomUUID, createHash } from 'node:crypto';
import { BaseCyclePhase, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { GBrainError } from '../types.ts';
import type { Page, PageFilters } from '../types.ts';
import type { OperationContext } from '../operations.ts';
import type { BrainEngine } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';
import { withPageLock } from '../page-lock.ts';


/**
 * Bump when the extractor prompt or the JSON output shape changes. Old
 * verdicts in `take_proposals` (composite key includes prompt_version) stay
 * valid as audit history; new runs re-spend LLM tokens on every page.
 */
export const PROPOSE_TAKES_PROMPT_VERSION = 'v0.36.1.2-ru-governed-v1';
const PROPOSE_TAKES_ROLLOUT_COMPATIBLE_PROMPT_VERSIONS = [
  'v0.36.1.0-tuned-cat15',
  'v0.36.1.1-ru-v1',
] as const;
const PENDING_CLAIM_WRITE_ATTEMPTS = 3;

class PendingClaimWriteConflict extends Error {
  constructor() {
    super('pending claim changed concurrently');
    this.name = 'PendingClaimWriteConflict';
  }
}

/**
 * Tuned extractor prompt, validated against the hand-labeled synthetic
 * corpus at test/fixtures/calibration/. Measured F1 on first live run
 * via gbrain-evals cat15 (claude-sonnet-4-6 extractor, claude-haiku-4-5
 * matcher judge):
 *
 *   training avg F1: 0.952 (target 0.85, exceeded by 10 points)
 *   holdout  avg F1: 0.922 (target 0.80, exceeded by 12 points)
 *   train-holdout gap: 0.03 (no overfitting signal)
 *
 * Per-genre F1 floor: 0.80 (people-pages, the hardest genre). The
 * concept-with-timeline and meeting-notes genres scored at 1.00 on
 * holdout pages.
 *
 * Design choices baked into the prompt:
 *   - Worked example list seeds the model's notion of "gradeable claim"
 *     so it doesn't drift into pure-fact extraction.
 *   - NOT-gradeable list catches the most common over-extraction modes
 *     (pure facts, direct quotes, restatements).
 *   - conviction inference rules anchored to specific hedging language
 *     ("I bet"/"strong conviction"=0.7-0.85, "I think"/"moderate"=0.5-0.7).
 *   - kind enum kept narrow ('prediction'|'judgment'|'bet') — the v1
 *     stub's 4-tag enum bled into noise classification.
 *
 * Replaces the v0.36.1.0-stub. If you re-tune, run cat15 against the
 * fixtures before bumping PROPOSE_TAKES_PROMPT_VERSION; the train-holdout
 * gap should stay < 0.10 (overfitting threshold).
 */
export const EXTRACT_TAKES_PROMPT = `Extract gradeable claims from the prose below.

A "gradeable claim" is a prediction, recommendation, or interpretive judgment
that could turn out wrong over time. Examples:
- "X company will hit ARR milestone by Q3" (prediction)
- "Y founder is going to struggle with execution" (judgment)
- "Z market will compress in 18 months" (prediction)
- "I bet alice wins the round" (bet)

NOT gradeable (do NOT extract these):
- Pure facts ("X was founded in 2020")
- Direct quotes from others without endorsement
- Restatements of an earlier claim in the same page

For each gradeable claim, output a JSON object with:
- claim_text   (string, <=200 chars, сформулируйте claim_text на русском языке)
- kind         ('prediction' | 'judgment' | 'bet')
- holder       ('world' | 'people/<slug>' | 'companies/<slug>' | 'brain' — default 'brain' when author asserts the claim)
- weight       (number 0..1 inferred from hedging language: 'I bet'/'strong conviction'=0.7-0.85,
                'I think'/'moderate conviction'=0.5-0.7, 'maybe'/'I'd guess'=0.3-0.5)
- domain       (short tag — e.g. 'tactics', 'macro', 'hiring', 'geography', 'pricing')

Не переводите имена собственные, названия продуктов, идентификаторы и термины,
если перевод искажает смысл. Не добавляйте сведения, которых нет в PAGE PROSE.

Output ONLY a JSON array of these objects. No prose. No commentary. If no
gradeable claims, return [].

EXISTING FENCE ROWS (already captured — do NOT propose duplicates):
{EXISTING_TAKES_JSON}

REJECTED CLAIMS FOR THIS PAGE (reviewed as unnecessary or defective):
{REJECTED_CLAIMS_JSON}

Do NOT recreate an exact or semantically equivalent rejected claim by paraphrasing it.
Only emit a related claim when PAGE PROSE now supports a materially different subject,
scope, modality, condition, or time boundary. Rejected claims are governance feedback,
not evidence that the underlying page text is false.

PAGE PROSE:
{PAGE_BODY}
`;

/** One proposed take, as the extractor produces it. */
export interface ProposedTake {
  claim_text: string;
  kind: 'fact' | 'take' | 'bet' | 'hunch';
  holder: string;
  weight: number;
  domain?: string;
}

interface HistoricalProposalRow {
  id: number;
  status: string;
  content_hash: string;
  prompt_version: string;
  claim_hash: string;
}

/** Extractor function signature — injected for tests; production calls gateway. */
export type ProposeTakesExtractor = (input: {
  pagePath: string;
  pageBody: string;
  existingTakes: Array<{ claim: string; kind: string; holder: string; weight: number }>;
  rejectedClaims: Array<{ proposal_id: number; claim: string; reason: string }>;
  modelHint?: string;
}) => Promise<ProposedTake[]>;

export interface ProposeTakesOpts extends BasePhaseOpts {
  /** Brain repo root for fs-source page walking. Optional — defaults to engine pages. */
  repoPath?: string;
  /** Limit pages processed in this cycle (for triage / quick smoke). Default: 100. */
  pageLimit?: number;
  /** Inject the LLM call for tests; production uses gateway.chat. */
  extractor?: ProposeTakesExtractor;
  /** Override prompt_version (tests). */
  promptVersion?: string;
  /** Override model id (tests + config). */
  model?: string;
  /** Skip pages that already have a complete takes fence. Default: true. */
  skipPagesWithFence?: boolean;
}

export interface ProposeTakesResult {
  pages_scanned: number;
  cache_hits: number;
  cache_misses: number;
  proposals_inserted: number;
  proposals_suppressed: number;
  budget_exhausted: boolean;
  warnings: string[];
}

/**
 * Compute the content_hash key for the idempotency cache. SHA-256 of the
 * page body suffices — page slug + prompt_version are separate columns in
 * the composite unique index.
 */
export function contentHash(pageBody: string): string {
  return createHash('sha256').update(pageBody).digest('hex');
}

/** Stable item-level key. Keeps same-page multi-claim output lossless. */
export function proposalClaimHash(proposal: ProposedTake): string {
  return createHash('sha256').update(JSON.stringify({
    claim_text: proposal.claim_text.trim(),
    kind: proposal.kind,
    holder: proposal.holder,
    weight: proposal.weight,
    domain: proposal.domain?.trim() || null,
  })).digest('hex');
}

/**
 * Detect whether a page already has a complete `<!-- gbrain:takes:begin -->`
 * fence. We DO propose against pages with fences (F2 dedup) but the operator
 * may opt to skip-with-fence pages via skipPagesWithFence:true for a faster
 * pass. The fence shape mirrors src/core/takes-fence.ts.
 */
export function hasCompleteFence(pageBody: string): boolean {
  return /<!---?\s*gbrain:takes:begin[\s\S]*?gbrain:takes:end\s*-->/.test(pageBody);
}

/**
 * Parse the existing fence into rows so the extractor can dedupe.
 * Returns [] when no fence is present. Best-effort — malformed fences
 * surface to the operator via the existing v0.28 fence parser, not here.
 */
export function extractExistingTakesForDedup(pageBody: string): Array<{
  claim: string;
  kind: string;
  holder: string;
  weight: number;
}> {
  const fenceMatch = pageBody.match(/<!---?\s*gbrain:takes:begin\s*-->([\s\S]*?)<!---?\s*gbrain:takes:end\s*-->/);
  if (!fenceMatch) return [];
  const body = fenceMatch[1] ?? '';
  const rows: Array<{ claim: string; kind: string; holder: string; weight: number }> = [];
  for (const line of body.split('\n')) {
    const cells = line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    // Skip header + separator rows.
    if (cells.length < 4) continue;
    if (cells[0] === '#' || cells[0]?.match(/^-+$/)) continue;
    const claim = cells[1] ?? '';
    if (!claim || claim.startsWith('~~')) continue; // strikethrough = inactive, doesn't count for dedup
    const kind = cells[2] ?? 'take';
    const holder = cells[3] ?? 'brain';
    const weight = Number.parseFloat(cells[4] ?? '0.5');
    rows.push({
      claim: claim.replace(/^~~|~~$/g, ''),
      kind,
      holder,
      weight: Number.isFinite(weight) ? weight : 0.5,
    });
  }
  return rows;
}

/**
 * Production extractor — calls gateway.chat with the EXTRACT_TAKES_PROMPT
 * and parses the JSON array output. Returns [] on parse failure (logged as
 * warning, not thrown — one bad page must not abort the phase).
 *
 * Stub-prompt note: the v0.36.1.0 ship-state prompt is a placeholder. Real
 * extractor lands when T19 corpus build produces the tuned prompt. Until
 * then, the production extractor returns whatever the stub LLM produces —
 * empirically often a sparse list or [].
 */
export async function defaultExtractor(
  input: Parameters<ProposeTakesExtractor>[0],
): Promise<ProposedTake[]> {
  const prompt = EXTRACT_TAKES_PROMPT
    .replace('{EXISTING_TAKES_JSON}', JSON.stringify(input.existingTakes, null, 2))
    .replace('{REJECTED_CLAIMS_JSON}', JSON.stringify(input.rejectedClaims, null, 2))
    .replace('{PAGE_BODY}', input.pageBody);

  const result = await gatewayChat({
    messages: [{ role: 'user', content: prompt }],
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens: 2048,
  });

  // ChatResult.text is already the concatenated text content.
  return parseExtractorOutput(result.text);
}

/**
 * Parse extractor output into ProposedTake[]. Handles common LLM output
 * sins (markdown fence wrapping, leading/trailing prose, single-object
 * instead of array). Returns [] on any unrecoverable parse error rather
 * than throwing.
 */
export function parseExtractorOutput(raw: string): ProposedTake[] {
  if (!raw || raw.trim().length === 0) return [];
  let text = raw.trim();
  // Strip markdown code fence wrapper.
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  // First-array-or-object substring extraction (defends against leading prose).
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  if (firstArr === -1 && firstObj === -1) return [];
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProposedTake[] = [];
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const claim_text = typeof r.claim_text === 'string' ? r.claim_text.trim() : '';
    if (!claim_text || claim_text.length > 500) continue;
    const kind = ['fact', 'take', 'bet', 'hunch'].includes(r.kind as string)
      ? (r.kind as ProposedTake['kind'])
      : 'take';
    const holder = typeof r.holder === 'string' && r.holder.length > 0 ? r.holder : 'brain';
    const weightRaw = typeof r.weight === 'number' ? r.weight : 0.5;
    const weight = Math.max(0, Math.min(1, weightRaw));
    const domainText = typeof r.domain === 'string' ? r.domain.trim() : '';
    const domain = domainText || undefined;
    out.push({ claim_text, kind, holder, weight, domain });
  }
  return out;
}

/**
 * BaseCyclePhase subclass. Walks pages, checks idempotency cache, calls
 * extractor, writes proposals.
 */
class ProposeTakesPhase extends BaseCyclePhase {
  readonly name = 'propose_takes' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.propose_takes.budget_usd';
  protected readonly budgetUsdDefault = 5.0;

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof GBrainError) return err.problem;
    if (err instanceof Error) {
      if (err.message.includes('content_hash')) return 'CALIBRATION_PROPOSAL_DEDUP_FAIL';
      if (err.message.includes('budget') || err.message.includes('Budget')) return 'CALIBRATION_GRADE_BUDGET_EXHAUSTED';
    }
    return 'PROPOSE_TAKES_UNKNOWN';
  }

  protected async process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    _ctx: OperationContext,
    opts: ProposeTakesOpts,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }> {
    const extractor = opts.extractor ?? defaultExtractor;
    const promptVersion = opts.promptVersion ?? PROPOSE_TAKES_PROMPT_VERSION;
    const pageLimit = opts.pageLimit ?? 100;
    const skipPagesWithFence = opts.skipPagesWithFence ?? false;
    const proposalRunId = `propose-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 8)}`;

    const result: ProposeTakesResult = {
      pages_scanned: 0,
      cache_hits: 0,
      cache_misses: 0,
      proposals_inserted: 0,
      proposals_suppressed: 0,
      budget_exhausted: false,
      warnings: [],
    };

    // Load pages eligible for proposal. Source-scoped per BaseCyclePhase.
    const pageFilters: PageFilters = {
      ...scope,
      limit: pageLimit,
      sort: 'updated_desc',
    };
    const pages: Page[] = await engine.listPages(pageFilters);

    if (opts.reporter) {
      opts.reporter.start('propose_takes.pages' as never, pages.length);
    }

    for (const page of pages) {
      result.pages_scanned += 1;
      this.tick(opts);

      // Skip pages that have NO prose body (e.g. metadata-only entity stubs).
      const body = page.compiled_truth ?? '';
      if (body.trim().length === 0) continue;
      if (skipPagesWithFence && hasCompleteFence(body)) continue;

      const ch = contentHash(body);
      const existingTakes = extractExistingTakesForDedup(body);

      // Atomically claim this page-level scan. Completed/running rows are cache
      // hits; failed rows are reclaimed for retry. This also caches [] results.
      const sourceId = page.source_id ?? scope.sourceId ?? 'default';
      const modelId = opts.model ?? 'claude-sonnet-4-6';
      if (promptVersion === PROPOSE_TAKES_PROMPT_VERSION) {
        let compatibleHit = false;
        for (const compatibleVersion of PROPOSE_TAKES_ROLLOUT_COMPATIBLE_PROMPT_VERSIONS) {
          const compatible = await engine.executeRaw<{ id: number }>(
            `SELECT id FROM take_proposal_scans
               WHERE source_id=$1 AND page_slug=$2 AND content_hash=$3
                 AND prompt_version=$4 AND status IN ('running','completed')
               LIMIT 1`,
            [sourceId, page.slug, ch, compatibleVersion],
          );
          if (compatible.length > 0) {
            compatibleHit = true;
            break;
          }
        }
        if (compatibleHit) {
          result.cache_hits += 1;
          continue;
        }
      }
      const scanRows = await engine.executeRaw<{ id: number }>(
        `INSERT INTO take_proposal_scans
           (source_id, page_slug, content_hash, prompt_version, proposal_run_id, model_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'running')
         ON CONFLICT (source_id, page_slug, content_hash, prompt_version)
         DO UPDATE SET status = 'running', proposal_run_id = EXCLUDED.proposal_run_id,
                       model_id = EXCLUDED.model_id, error_text = NULL, started_at = now(), completed_at = NULL
         WHERE take_proposal_scans.status = 'failed'
         RETURNING id`,
        [sourceId, page.slug, ch, promptVersion, proposalRunId, modelId],
      );
      if (scanRows.length === 0) {
        result.cache_hits += 1;
        continue;
      }
      const scanId = scanRows[0]!.id;
      result.cache_misses += 1;

      // Budget pre-check before the LLM call. Estimate: ~1500 input tokens + 500 output.
      const budget = this.checkBudget({
        modelId: opts.model ?? 'claude-sonnet-4-6',
        estimatedInputTokens: 1500,
        maxOutputTokens: 500,
      });
      if (!budget.allowed) {
        result.budget_exhausted = true;
        result.warnings.push(
          `budget exhausted at page ${result.pages_scanned}/${pages.length} (cumulative $${budget.cumulativeCostUsd.toFixed(4)} / cap $${budget.budgetUsd.toFixed(2)})`,
        );
        break;
      }

      // Call the extractor. Errors on a single page log a warning but do not abort.
      let proposals: ProposedTake[];
      try {
        const rejectedClaims = await engine.executeRaw<{ proposal_id: number; claim: string; reason: string }>(
          `SELECT tp.id AS proposal_id,
                  COALESCE(rev.proposed_payload->>'claim_text', tp.claim_text) AS claim,
                  COALESCE(ev.details->>'reason_code', ev.details->>'reason', 'reviewed_reject') AS reason
             FROM take_proposals tp
             LEFT JOIN LATERAL (
               SELECT proposed_payload FROM ai_review_revisions
                WHERE target_type='take_proposal' AND target_id=tp.id AND status='draft'
                ORDER BY id DESC LIMIT 1
             ) rev ON true
             LEFT JOIN LATERAL (
               SELECT details FROM ai_review_events
                WHERE target_type='take_proposal' AND target_id=tp.id AND action='reject'
                ORDER BY id DESC LIMIT 1
             ) ev ON true
            WHERE tp.source_id=$1 AND tp.page_slug=$2 AND tp.status='rejected'
            ORDER BY tp.acted_at DESC NULLS LAST, tp.id DESC
            LIMIT 50`,
          [sourceId, page.slug],
        );
        proposals = await extractor({
          pagePath: page.slug,
          pageBody: body,
          existingTakes,
          rejectedClaims,
          modelHint: opts.model,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await engine.executeRaw(
          `UPDATE take_proposal_scans SET status = 'failed', error_text = $2, completed_at = now() WHERE id = $1`,
          [scanId, msg.slice(0, 2000)],
        );
        result.warnings.push(`extractor failed on ${page.slug}: ${msg}`);
        continue;
      }

      // Item-level idempotency preserves every distinct same-page claim. The
      // transaction makes a newer revision replace an older pending row of the
      // same exact identity. Canonical identity locks plus row locks serialize
      // mixed legacy-MD5/current-SHA histories; migration 133's partial UNIQUE
      // index remains an additional guard for rows using the same hash contract.
      for (const p of proposals) {
        const claimHash = proposalClaimHash(p);
        let writeResult: { inserted: Array<{ id: number }>; suppressed: boolean } | undefined;
        for (let attempt = 1; attempt <= PENDING_CLAIM_WRITE_ATTEMPTS; attempt += 1) {
          try {
            writeResult = await withPageLock(
              `ai-review-claim:${sourceId}:${page.slug}:${claimHash}`,
              async () => engine.transaction(async tx => {
                // Lock the complete exact-identity history. Do not key this lookup only
                // by claim_hash: migrations 131/133 left a mixed legacy-MD5/current-SHA
                // population. Field equality is the stable cross-version contract.
                const history = await tx.executeRaw<HistoricalProposalRow>(
                  `SELECT id, status, content_hash, prompt_version, claim_hash
                   FROM take_proposals
                   WHERE source_id = $1 AND page_slug = $2
                     AND claim_text = $3 AND kind = $4 AND holder = $5 AND weight = $6
                     AND COALESCE(NULLIF(BTRIM(domain), ''), '') = COALESCE($7, '')
                   ORDER BY id DESC
                   FOR UPDATE`,
                  [sourceId, page.slug, p.claim_text, p.kind, p.holder, p.weight, p.domain ?? ''],
                );
                const blockingTerminal = history.find(row => ['accepted', 'rejected', 'deferred'].includes(row.status));
                const pendingHistory = history.find(row => row.status === 'pending');
                const supersededHistory = history.find(row => row.status === 'superseded');
                if (blockingTerminal || (supersededHistory && !pendingHistory)) {
                  return { inserted: [], suppressed: true };
                }
                const exact = history.find(row => row.content_hash === ch && row.prompt_version === promptVersion);
                const keepPendingId = exact?.status === 'pending' ? exact.id : null;
                await tx.executeRaw(
                  `WITH superseded AS (
                     UPDATE take_proposals
                        SET status='superseded', acted_at=now(), acted_by='system:propose_takes'
                      WHERE source_id=$1 AND page_slug=$2
                        AND claim_text=$3 AND kind=$4 AND holder=$5 AND weight=$6
                        AND COALESCE(NULLIF(BTRIM(domain), ''), '')=COALESCE($7, '')
                        AND status='pending' AND ($8::bigint IS NULL OR id <> $8)
                      RETURNING id
                   )
                   INSERT INTO ai_review_events
                     (target_type, target_id, action, actor, previous_state, new_state, details)
                   SELECT 'take_proposal', id, 'supersede', 'system:propose_takes',
                          '{"status":"pending"}'::jsonb, '{"status":"superseded"}'::jsonb,
                          jsonb_build_object('replacement_content_hash', $9::text, 'replacement_prompt_version', $10::text)
                     FROM superseded`,
                  [sourceId, page.slug, p.claim_text, p.kind, p.holder, p.weight, p.domain ?? '', keepPendingId, ch, promptVersion],
                );
                if (exact) return { inserted: [], suppressed: false };
                const rows = await tx.executeRaw<{ id: number }>(
                  `INSERT INTO take_proposals
                     (scan_id, source_id, page_slug, content_hash, prompt_version, proposal_run_id,
                      claim_text, claim_hash, kind, holder, weight, domain, dedup_against_fence_rows, model_id)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                   ON CONFLICT DO NOTHING
                   RETURNING id`,
                  [
                    scanId,
                    sourceId,
                    page.slug,
                    ch,
                    promptVersion,
                    proposalRunId,
                    p.claim_text,
                    claimHash,
                    p.kind,
                    p.holder,
                    p.weight,
                    p.domain ?? null,
                    JSON.stringify(existingTakes),
                    modelId,
                  ],
                );
                if (rows.length === 0) throw new PendingClaimWriteConflict();
                return { inserted: rows, suppressed: false };
              }),
            );
            break;
          } catch (error) {
            if (!(error instanceof PendingClaimWriteConflict) || attempt === PENDING_CLAIM_WRITE_ATTEMPTS) throw error;
          }
        }
        if (!writeResult) throw new PendingClaimWriteConflict();
        result.proposals_inserted += writeResult.inserted.length;
        if (writeResult.suppressed) result.proposals_suppressed += 1;
      }
      // A successful extraction under a newer prompt replaces only older pending
      // proposals for this exact source revision. Accepted/rejected history stays intact.
      await engine.executeRaw(
        `WITH superseded AS (
           UPDATE take_proposals
              SET status = 'superseded', acted_at = now(), acted_by = 'system:propose_takes'
            WHERE source_id = $1 AND page_slug = $2 AND content_hash = $3
              AND status = 'pending' AND prompt_version <> $4
            RETURNING id
         )
         INSERT INTO ai_review_events
           (target_type, target_id, action, actor, previous_state, new_state, details)
         SELECT 'take_proposal', id, 'supersede', 'system:propose_takes',
                '{"status":"pending"}'::jsonb, '{"status":"superseded"}'::jsonb,
                jsonb_build_object('replacement_prompt_version', $4)
           FROM superseded`,
        [sourceId, page.slug, ch, promptVersion],
      );
      await engine.executeRaw(
        `UPDATE take_proposal_scans
            SET status = 'completed', proposal_count = $2, completed_at = now(), error_text = NULL
          WHERE id = $1`,
        [scanId, proposals.length],
      );
    }

    if (opts.reporter) opts.reporter.finish();

    // v0.42 Wave B3: receipt + rollup for propose_takes. Source-scoped
    // via the read scope. Receipt only when proposals actually written.
    const sourceIdForReceipt = scope.sourceId ?? 'default';
    if (result.proposals_inserted > 0) {
      try {
        await writeReceipt(engine, {
          kind: 'takes.proposed',
          source_id: sourceIdForReceipt,
          run_id: proposalRunId,
          round: 'single',
          extracted_at: new Date().toISOString(),
          total_rows: result.proposals_inserted,
          cost_usd: 0, // tracker isn't exposed at this layer; cost tracked centrally
          summary:
            `Proposed ${result.proposals_inserted} new takes from ${result.pages_scanned} pages ` +
            `(${result.cache_hits} cached).`,
        });
      } catch (err) {
        console.error(`[propose_takes] receipt write failed: ${(err as Error).message}`);
      }
    }
    await upsertExtractRollup(engine, {
      kind: 'takes.proposed',
      source_id: sourceIdForReceipt,
      round_completed_delta: result.budget_exhausted ? 0 : 1,
      halt_delta: result.budget_exhausted ? 1 : 0,
    });

    return {
      summary: `propose_takes: scanned ${result.pages_scanned} pages, ${result.cache_hits} cached, ${result.proposals_inserted} new proposals, ${result.proposals_suppressed} governed suppressions (run ${proposalRunId})`,
      details: { ...result, proposal_run_id: proposalRunId, prompt_version: promptVersion },
      status: result.budget_exhausted ? 'warn' : 'ok',
    };
  }
}

/**
 * Public entry point — mirrors the v0.23 `runPhaseSynthesize` shape so the
 * cycle orchestrator in cycle.ts can call it uniformly.
 */
export async function runPhaseProposeTakes(
  ctx: OperationContext,
  opts: ProposeTakesOpts = {},
) {
  return new ProposeTakesPhase().run(ctx, opts);
}

/** Test-only access to the class for subclassing in tests. */
export const __testing = {
  ProposeTakesPhase,
  parseExtractorOutput,
  contentHash,
  proposalClaimHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
};
