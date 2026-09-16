# Page-only CAS MVP — review candidate, production disabled

## Availability and owner contract

The owner selected a single writer channel through GBrain for protected pages: direct external file editing is excluded, canonical Markdown files and existing synchronization remain. This is not permission to freeze mixed roots, move to database-only storage, deploy, migrate, change filesystem permissions or publish business content.

The verified baseline is `b093e14245c4153d218f7ce3c629f13ed06ee797`, hosted CI run `35070352567`, attempt `1`. It includes real connected PostgreSQL bootstrap, separate executable enrollment and crash/restart recovery evidence in disposable fixtures. Its protected PostgreSQL mode is `offline-verification`; it does not admit production. Subsequent pilot admission changes are under review **HOLD**, including root scope: baseline evidence does not certify those changed bytes. No installed availability or production acceptance is claimed.

**Deployment gate:** never run unrestricted `offline-verification` against production, relabel production as offline, or bypass guards. A pilot requires separately reviewed bounded admission, exact-byte evidence and explicit owner authorization. Mixed-root cohort validation and representative already-v142 upgrade/replay proof remain pending for the new candidate. See the [finite installation/rollback/approval template](page-file-sql-authority-provisioning.md#finite-installation-rollback-and-owner-approval-template-preparation-only).

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

Derived text chunks are rebuilt transactionally and embeddings remain pending. Identity fences protect late provider results on supported database paths. Enrolled-page ordinary derived writers remain constrained by migration fences; their eventual vector completion is not claimed. File-route receipts explicitly distinguish committed canonical state/chunks from pending embeddings; pending, abort and recovery outcomes are covered by baseline receipt tests.

## Finite blockers before activation

1. **Installed writer inventory:** baseline proof covers named facts, ingest, cycle, legacy writes, enrollment races and the protected generated pull template. Inventory every actually installed helper/external writer and explicitly replace, coordinate or drain it at an authorized safe point. Correct templates are not proof of installed remediation.
2. **Actual source projection:** baseline shared mapping identity and full import forwarding of the active pack are implemented and tested. Prove the selected source/parser cohort; do not claim arbitrary custom-pack compatibility. For the pilot, require a mixed-root fixture with enrolled and ordinary unenrolled pages, plus sources/roots outside the selected cohort. Prove continuing ordinary writes/sync and no widening of checked-write, enrollment or root-mutation authority outside the approved boundary. This new admission proof is **pending**, not inherited from baseline mixed-writer evidence.
3. **Target runtime authority:** connected protected startup, actual ordinary/adapter roles, reconnect/per-borrow drift refusal and separate enrollment operator are baseline-proven. Target protected identities/catalog pins, outside-root directories, credentials and bounded pilot admission are not provisioned or approved. Keep admission on **HOLD** pending root-scope correction, independent review and exact-candidate proof.
4. **Frozen acceptance:** baseline has hosted concurrency, SQL denial, root coordination and crash/restart coverage; the old missing-suite claim is superseded. Require exact new SHA/run/attempt evidence for pilot scope and representative already-v142 upgrade/replay provisioning. Fresh migration through v142 alone is not that proof. Generic CLI recovery execution is a separate qualification. Local PostgreSQL/container testing on the shared host is prohibited.
5. **Release approval:** approve exact artifact, cohort, installation manifest, migration plan, safe point, consistent backup/restore and controlled authenticated readback separately. Accept explicit chunks-current/embeddings-pending receipts, not completed vectors. Only installed runtime and actual transport discovery can establish availability; candidate schema generation is not live checked-MCP proof.

## Verified baseline evidence and pending successor proof

The reconciliation ledger `reconciliation-b093e1424.md` (operator evidence directory
`/home/avers/.hermes/outputs/page-cas-mvp/`) records downloaded-artifact verification
for [run 35070352567](https://github.com/Vyacheslav-Zakharov/gbrain/actions/runs/35070352567),
attempt 1, exact SHA above. It reports 58 offline suite entries / 369 passing tests,
and PostgreSQL suite pass counts of 9 (DB), 5 (file), 5 (runtime authority), and 7
(SQL authority), with completed summaries and zero failures. Evidence-manifest SHA-256:
`5a224fa58206a5aec8ff1cfbb77b9b53435b0bc745c96b37e717983928ce2586`.
The ledger verified 76 evidence hashes and 2,873 source hashes; this documentation
update does not rerun or extend that attestation. Typecheck completion is supported
by the successful workflow, not a separate typecheck exit receipt.

Connected completion markers cover executable status/verify/enroll, all four SIGKILL
boundaries (journal, prepared, rename, commit), fresh protected bootstrap and explicit
terminal replay, plus dirty-root restart/reconciliation without an automatic winner.
Fixture catalog pins are explicitly disposable, not production-approved. Neither
new pilot mixed-root admission nor representative already-v142 upgrade/replay nor
actual generic `gbrain call` recovery execution is certified by that baseline.
Those receipts remain **PENDING** until independently verified for the exact successor.

## Historical local verification boundary (not successor acceptance)

Consolidation ran full `tsc --noEmit` with a 90-second wall limit and one CPU. It first failed on nullable file-only configuration at three root callers and a generic transaction test spy; the nullable runtime boundary and spy typing were corrected. The missing-config regression was observed RED before the minimal fix, then GREEN. Production rejection remains intact.

Individually bounded fresh-process tests passed for file runtime, enrollment/runtime coordination, integrated root runtime, contextual retrieval pure behavior, embedding follow-up and contextual fences, plus adjacent write-through and legacy put-page write-through. These are temporary-filesystem/in-memory PGLite results, not hosted PostgreSQL or full-suite proof. Raw consolidation receipts live outside the repository in the task output directory. No commit, push, deployment, live service/config/database change or business-file write was performed.
