# Page-only CAS MVP — review candidate, production disabled

## Availability and owner contract

The owner selected a single writer channel through GBrain for protected pages: direct external file editing is excluded, canonical Markdown files and existing synchronization remain. This is not permission to freeze mixed roots, move to database-only storage, deploy, migrate, change filesystem permissions or publish business content.

Registered checked operations now have an integrated file-backed path, but trusted runtime configuration accepts only `isolated-integration`, PGLite and temporary local roots. `production` deliberately throws `file_runtime_prerequisites_pending`. No real PostgreSQL acceptance or deployed availability is claimed. The worktree is uncommitted, not an immutable release artifact.

CAS protects one existing page, not a multi-page package. A revision match is not owner approval of an exact before/after package. Tool allowlists require separate authorization.

## Candidate operations

- `get_page_checked`: exact source/slug, no alias/fuzzy routing; returns an opaque revision and complete editable database snapshot. Explicitly enrolled file pages also return original `raw_markdown` and binding ID/generation/raw digest.
- `put_page_checked`: update-only, complete `page`, original `expected_revision`. File-backed replacement additionally requires exact approved `raw_markdown`, `file_baseline` and UUID `operation_id`; repeat intent is checked against durable evidence. File edits are **body-only**: title/type/frontmatter/timeline/authored tags remain unchanged. There is no serializer round-trip promise for caller-modified bytes: callers must preserve all unrelated authored bytes in the exact replacement.
- `recover_page_file_checked`: trusted local-only explicit `resume-exact` or `abort` for exact prior intent. Unexpected bytes are preserved as conflicts. Reads do not silently recover. Root recovery is separately exposed through connected `sources pull --recover-root --yes`; it reconciles current observations without rerunning Git.
- Non-enrolled database-only pages retain the narrower no-filesystem eligibility checks. Their editable fields are type/title/body, with unchanged frontmatter/timeline and separately preserved tags. Do not remove these restrictions to admit production file pages without enrollment.
- Remote replacement snapshots requiring private-fact/takes redaction fail closed. Empty source grants, namespace violations, stale revisions and deleted/recreated identities are rejected. Authorization and eligibility are rechecked on apply; transport scope enforcement remains mandatory.

## Persistence and synchronization

Explicit trusted enrollment binds existing canonical file bytes to a page incarnation. Native root/path locks, journal evidence and short database transactions coordinate replacement and recovery. Prepared uncertainty is `pending_recovery`, not rollback. Canonical chunks get fresh identities; provider work stays outside transactions. No graph, link, timeline or fact extraction is added by checked replacement.

With a trusted coordination host, actual root pull uses exclusive root coordination and durable dirty-state tracking; dirty roots block checked reads/writes, enrollment and sync until explicit reconciliation. Full import can index a mixed enrolled/unenrolled root, and captured old sync work cannot overwrite a checked winner. Without a host, enrolled-root mutation still refuses; that fallback is not an activated production synchronization path.

The integrated test executes registered CAS → actual source pull against temporary local Git → actual `runImport` → checked reread, including pending-file preservation. This is no longer merely a set of file primitives, but it does not prove every incremental/checkpoint/scheduled caller or production topology.

Derived text chunks are rebuilt transactionally and embeddings remain pending. Identity fences protect late provider results on supported database paths. Enrolled-page ordinary derived writers remain constrained by migration fences; their eventual vector completion and file-route receipt disclosure are not established by database-only embedding tests.

## Finite blockers before activation

1. **Writer coverage:** complete shared enrollment/write coordination for remaining direct GBrain writers. The registered legacy `put_page` gate is proven, but an absence check elsewhere does not serialize enrollment. Generated hooks/helpers still contain direct `git pull --rebase`; inventory and replace or drain existing generated instances at authorized cutover. Sole-writer approval does not make these internal paths safe automatically.
2. **Actual source projection:** enrolled import rejects `activePack`, forced rechunk, explicit inference and code files (`import-file.ts`). File projection uses default `parseMarkdown`. Prove representative intended source/schema fixtures and implement matching custom-pack projection where required; do not silently substitute a default parser or exclude required pages.
3. **Runtime authority and lifecycle:** production adapter/host validation, stable outside-root coordination directories, ownership, enrollment/recovery and actual runtime-role separation remain unproven. Migration PUBLIC revokes do not establish least privilege; the adapter currently mints authorization through its engine. Keep the production guard closed.
4. **Frozen acceptance:** obtain independent review and exact-artifact hosted PostgreSQL concurrency, role denial, clean/upgrade/replay, configuration drift and restart recovery evidence. Local PG/container/QEMU testing on the shared host is prohibited. The dedicated workflow includes file adapters, but currently omits root-runtime, root-transition and runtime-coordination suites; its complete-inventory assertion must fail until those are listed. Adapter E2E is not registered production-runtime proof.
5. **Release approval:** resolve receipt/derived-state limitations and production cohort fit, then separately approve exact artifact, migration, writer safe point, backup and controlled authenticated fixture. Only verified installed runtime availability can justify team/tool-access updates.

## Local verification boundary

Consolidation ran full `tsc --noEmit` with a 90-second wall limit and one CPU. It first failed on nullable file-only configuration at three root callers and a generic transaction test spy; the nullable runtime boundary and spy typing were corrected. The missing-config regression was observed RED before the minimal fix, then GREEN. Production rejection remains intact.

Individually bounded fresh-process tests passed for file runtime, enrollment/runtime coordination, integrated root runtime, contextual retrieval pure behavior, embedding follow-up and contextual fences, plus adjacent write-through and legacy put-page write-through. These are temporary-filesystem/in-memory PGLite results, not hosted PostgreSQL or full-suite proof. Raw consolidation receipts live outside the repository in the task output directory. No commit, push, deployment, live service/config/database change or business-file write was performed.
