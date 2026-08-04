# Multi-reviewer AI Review

On-demand reference (see CLAUDE.md Reference map). Current behavior only.

A **round** is the governance wrapper around ONE immutable proposal
(`take_proposals` or `concept_proposals`). Rounds never write canonical
content: finalization delegates to the existing guarded publishers, so page
locks, stale-source checks, file read-back and rollback stay in one place.

## Governance policy

1. **Mandatory reviewers.** For a shared source, every configured, active
   Portal user whose `source_id` or `federated_write` grants write access is
   assigned. `shared` and `internal-*` are always shared; any other source may
   declare `sources.config.review_policy='shared'` explicitly. This prevents a
   corporate source from becoming personal merely because one user has it as
   their default `source_id`. Assignments FREEZE at round creation — a later
   grant change does not add or drop a reviewer from a live round.
2. **Personal source.** If one active Portal user directly owns the source
   (`permissions.source_id === proposal.source_id`), only that owner is
   assigned. Delegated `federated_write` never turns another user into a
   mandatory reviewer of a personal area. The owner's single vote finalizes
   the round with no Admin step.
3. **Equal weight, strict-majority quorum for groups.** Every reviewer carries
   weight 1. When a shared source has more than two frozen reviewers, either
   decision auto-finalizes as soon as it reaches `floor(N / 2) + 1` votes,
   where `N` is the full frozen reviewer count. This is symmetric for accept
   and reject; it is never a majority of only those who happened to vote.
4. **Facilitation and escalation.** Shared rounds with one or two reviewers do
   not auto-finalize: after all available votes they move to Admin with
   `facilitator_required`. A completed tie for an even group, or missing votes
   past the deadline, also escalates. **Non-response is never counted as
   reject.**
5. **Admin.** Sees named votes, reason codes, comments, counts and the quorum
   threshold (or a plain facilitator label for shared `N≤2`). Can finalize ONLY
   an escalated round, and only with a mandatory override reason
   (≥ 8 characters), recorded in the audit ledger.
6. **Human-only auto-finalize.** A vote counts toward a personal decision or
   shared quorum only when it is
   the active vote of an assignment in that round, `voter_kind='portal_user'`,
   and its `actor_email` matches the frozen assignment. Model or audit output
   can never carry a proposal to accepted.
7. **Reject taxonomy.** A reject requires a stable code from
   `src/core/ai-review-reasons.ts`; some codes additionally require a comment.
   The Russian label is presentation only — the code is what is stored.
8. **Server-derived trust.** The browser supplies a decision, a reason and an
   idempotency key. Never an actor, a reviewer list, or a source id.
9. **Autopilot stays disabled.** The assignment synchronizer enrolls pending
   proposals created after the durable cutover timestamp; this is deterministic
   governance bookkeeping and does not invoke a model or generate content.

Zero eligible reviewers creates an immediately **escalated** round with
`escalation_reason='no_reviewers'`. It is visible to Admin and can never
auto-accept.

## State machine

```text
                         (personal owner | shared strict-majority quorum)
  open ─────────────────────────────────────────────► finalizing ──► finalized
   │                                                       │  (publisher OK)
   │  (facilitator_required | disagreement | deadline_missed)│
   ▼                                                       │ (publisher failed)
escalated ──(admin finalize + reason)──► finalizing ───────┘
   ▲                                                       │
   └───────────────────────────────────────────────────────┘
                    (revert on publication failure)
```

| From | To | Trigger | Guard |
|---|---|---|---|
| `open` | `open` | vote cast, round incomplete | assignment belongs to caller; source ACL live; round not overdue |
| `open` | `finalizing` | personal owner vote, or shared `N>2` reaches strict-majority quorum | CAS on `(id, status, round_version)` |
| `open` | `escalated` | shared `N≤2` finished voting, completed tie, or deadline swept with missing votes | — |
| `escalated` | `finalizing` | Admin finalize | escalated only; override reason ≥ 8 chars |
| `finalizing` | `finalized` | guarded publisher succeeded | proposal still `pending`, snapshot hash unchanged |
| `finalizing` | `escalated` | publisher threw | `publication_failed` event recorded; canonical outcome is not reported as finalized |
| `finalizing` | `escalated` | proposal changed under the round | `escalation_reason='stale_proposal'` |

`finalizing` is a claim state, not a normal resting state. A CAS makes two
concurrent finalizations deterministic. `finalizing_at` additionally lets the
deadline sweep recover a process crash: a terminal proposal closes the round;
a still-pending proposal escalates as `publication_interrupted` for inspection.

## Tables

Created by `src/schema.sql` (fresh installs), mirrored in
`src/core/pglite-schema.ts`, and added to existing brains by migration 135
(`ai_review_multi_reviewer`). Migration 136 adds the auditable
`finalized_mode='auto_quorum'` value.

- **`ai_review_rounds`** — one row per governance round. Partial unique index
  `(target_type, target_id) WHERE status IN ('open','escalated','finalizing')`
  enforces one LIVE round per proposal while closed rounds accumulate for audit.
- **`ai_review_assignments`** — the frozen reviewer list; `UNIQUE (round_id,
  reviewer_email)`. `details_opened_at` is a UX metric, not a gate.
- **`ai_review_votes`** — append-only. `UNIQUE (assignment_id) WHERE active`
  gives exactly one live vote per assignment; `UNIQUE (assignment_id,
  idempotency_key)` makes replay free. Changing a vote supersedes the prior row
  (`active=false`, `superseded_at`) — nothing is deleted.

Audit reuses the existing **`ai_review_events`** ledger with the round id in
`details`: `round_opened`, `vote_cast`, `vote_replaced`, `round_escalated`,
`round_finalized`, `round_override`, `publication_failed`, plus the publisher's
own `accept` / `reject` rows. **Reviewer comments are NOT copied into the event
details** (they can quote confidential source text); the event records
`has_comment` and the reason code.

## Modules

| File | Role |
|---|---|
| `src/core/ai-review-aggregation.ts` | Pure. `resolveMandatoryReviewers` (ACL → frozen list + `personal`/`shared`), `aggregateRound` (verdict + counts + `missing`), `resolveRoundDeadlineHours`. No DB, no clock. |
| `src/core/ai-review-reasons.ts` | Pure. Reject taxonomy + `validateRejectReason` (fail-closed). |
| `src/core/ai-review-rounds.ts` | Persistence + state machine. Round creation, reviewer deck, vote, deadline sweep, finalization, Admin queries. |

## Deadline

Default 72 hours; override with the config key
`ai_review.round_deadline_hours` (clamped to 1 … 720). A round past `due_at`
with missing votes escalates. Two things drive the sweep: the Admin round list
(and `POST /admin/api/ai-review/rounds/sweep`), and a vote attempt itself — a
late vote escalates the round and returns `round_escalated` instead of landing
silently, so the sweeper and a straggler can never race.

A sweep re-aggregates first, so a reached quorum finalizes rather than becoming
a deadline escalation.

## HTTP surface

Reviewer (Portal session; identity + ACL re-derived per request):

```text
GET  /portal/review                              # SPA, same bundle as /portal
GET  /portal/api/review/summary
GET  /portal/api/review/deck?limit=&type=
GET  /portal/api/review/items/:assignmentId      # marks details_opened
POST /portal/api/review/items/:assignmentId/vote # Idempotency-Key header
```

Admin (`requireAdmin`; mutations also `requireAdminSameOrigin`):

```text
POST /admin/api/ai-review/rounds                 # open a round
GET  /admin/api/ai-review/rounds?status=
GET  /admin/api/ai-review/rounds/:id             # named vote matrix
POST /admin/api/ai-review/rounds/:id/finalize    # escalated only, reason required
POST /admin/api/ai-review/rounds/sweep
```

Status mapping (`reviewErrorStatus` in `serve-http.ts`): `401` unauthenticated,
`403` foreign assignment / revoked source, `404` not found, `409` stale
proposal, closed round, concurrent vote or finalization, `422` bad reason code,
missing mandatory comment, missing override reason, `503` publication write
failure.

**Blindness.** Deck and item payloads carry only the reviewer's own card. The
vote response returns the caller's decision and the round status — never a
tally, a reviewer list, or another vote. The named matrix exists only on the
Admin detail endpoint.

## Portal UI

`portal/src/review/` renders at `/portal/review`; `portal/src/main.tsx` selects
it by pathname so the knowledge explorer and the deck share one bundle without
sharing state. The prominent top-right nav entry appears only when the session
reports `canReview` (server-derived; it gates the link, never the endpoints) and
shows the caller's live pending count from `/portal/api/review/summary`. The
summary poll runs on load, focus and every 60 seconds but is read-only; assignment
synchronization remains an explicit side effect of opening the review deck.

- Right swipe → approve. Left swipe → the mandatory Russian reason sheet
  (nothing is sent until a reason is chosen). Down swipe **from the drag
  handle** → details, which is not a vote.
- The card is `touch-action: pan-y` and only the handle is `touch-action:
  none`, so page scrolling and pull-to-refresh keep working.
- Three real buttons always duplicate the gestures; `←` `→` `↓` mirror them.
  `Esc` closes details or the reason sheet without voting.
- `prefers-reduced-motion` drops the transform/spring; an `aria-live` region
  announces "Голос сохранён" and every error.
- Concept cards derive their visible title from the proposed Markdown frontmatter
  first (a body heading is fallback only) and show a body excerpt; they never
  fall back to only an opaque target slug when proposal text exists. Details label the source area,
  source page slug/title and proposal timestamp before the source document or
  proposed concept body. Concept details also list same-source take claims used
  for synthesis; cross-source take references stay hidden unless represented in
  the target source, and a proposal with no saved basis says so explicitly.
- Thresholds live in `portal/src/review/gestures.ts` (72 px, or half that on a
  ≥ 0.5 px/ms flick, with a 1.4× dominant-axis ratio that rejects diagonals).
- One idempotency key per user ATTEMPT: a retry after a network error replays
  the same key. A failed vote keeps the card — nothing is optimistically marked
  done. A `stale_proposal` / `round_closed` / `foreign_assignment` response
  drops the card, because it is genuinely no longer this reviewer's to decide.

Approve and reject are staged in the browser for **15 seconds** before the vote
request is sent. The card stays visible, every other decision control is
disabled, and an explicit countdown button cancels the staged request. A late
Details response is discarded after staging, and the cancel handler refuses to
claim success once submission has started. Closing or reloading the page during
this window is fail-closed: no vote was sent. Once the timer expires the
existing server idempotency and immediate personal/shared finalization semantics
apply; the UI never promises undo after submission.

## Admin UI

`admin/src/pages/ReviewRounds.tsx` ("Коллективная проверка") reuses the
`AIReview.css` list/detail hierarchy. It shows per-round tallies (за / против /
без ответа) and the escalation reason, and on detail a named vote matrix with
reason codes and comments. Finalize controls render **only** for an escalated
round and stay disabled until the mandatory reason is long enough; the server
revalidates both.

## Testing

| File | Covers |
|---|---|
| `test/ai-review-aggregation.test.ts` | ACL resolution (explicit shared, personal owner-only, delegated write, read-only, deactivated, unknown source), strict-majority accept/reject quorum, facilitator requirement for `N≤2`, tie/deadline escalation, zero reviewers, system-vote rejection, superseded votes, deadline clamping, reason taxonomy. |
| `test/ai-review-rounds.test.ts` | PGLite end-to-end: creation + freeze, managed shared classification, one-live-round, deck blindness, stale-card starvation, revoked ACL, foreign assignment, payload-bound idempotency, vote supersede with round-version fencing, stale hash, quorum take/concept publication, personal one-vote finalization, facilitator/Admin path, publication failure/recovery, deadline sweep, paginated Admin queue and override. |
| `test/e2e/ai-review-rounds-postgres.test.ts` | Real PostgreSQL with separate pools: transaction-level serialization, same-assignment race, replacement-vs-finalization race, exactly-once publication, BIGSERIAL normalization and JSON-safe Portal/Admin representations. |
| `test/ai-review.test.ts` | Canonical take/concept publication, proposal+revision+audit atomicity, and canonical-content rollback when the audit transaction is forced to fail. |
| `test/portal-review-gestures.test.ts` + `test/portal-review-undo.test.ts` | Gesture classifier thresholds, flick, diagonal rejection, handle-only down swipe, keyboard parity, and the exact 15-second pre-submit countdown. |
| `test/portal-review-api.test.ts` | Route wiring: session-derived identity, strict live ACL revocation, no browser-supplied actor/reviewer list, same-origin gating, blind vote response, error→status map, reason-taxonomy parity between server and Portal mirror. |
