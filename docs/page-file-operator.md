# Bounded page-file operator — source-wide candidate

**Hosted source-v2 acceptance: NOT RUN. Live: NOT DEPLOYED.** The candidate supports
protected `production-pilot` source admission; that is not production acceptance or
permission to activate. Never use unrestricted `offline-verification` on production
or relabel production as an offline fixture.
This standalone local executable adds no MCP operation, worker capability, UI,
migrations, background enrollment service or recovery algorithm.
V2 operates on a finite independently pinned source set; v1 retains its legacy
exact-page contract. The one-page restriction is a v1 compatibility boundary, not
a permanent source-wide deployment limitation.
Run from the repository with Bun; it is deliberately not routed through generic CLI
startup (which has unrelated configuration/update hooks).

```
bun src/commands/page-file-operator.ts --help
bun src/commands/page-file-operator.ts status
bun src/commands/page-file-operator.ts verify
bun src/commands/page-file-operator.ts enroll
bun src/commands/page-file-operator.ts inventory <source> [limit] [cursor]
bun src/commands/page-file-operator.ts reconcile <source> [limit] [cursor]
```

The angle/square-bracket forms are grammar, not runnable values. `status`, `verify`
and `enroll` require v1; `inventory` and `reconcile` require v2. Source, limit and
cursor are positional arguments, not flags. Limit defaults to 25 and is 1..100;
provide a numeric limit before a cursor.

These are invocation instructions, **not permission to provision or activate**.
Only `--help` is DB-free. The other actions require already provisioned
PostgreSQL and the matching fixed startup bootstrap (`offline-verification` for
fixtures or separately approved `production-pilot`). No schema initializer is called.
Normal file-only GBrain config must select the ordinary PostgreSQL account, not the
adapter or enrollment account. Actual engine startup verifies its ordinary identity
and effective SQL authority before registering the existing private adapter.

## Protected inputs (provision separately after approval)

All operator files are canonical absolute regular files, mode **0400**, owned by the
invoking service UID, one hard link, at most 1 MiB. Ancestors must be root/service-owned
and not group/other writable; symlinks are refused. Place files outside all indexed
roots. The operator enrollment credential is never read by status/verify, ordinary
startup, MCP or workers. Its pathname and hash must differ from the adapter credential.
The credential's actual login/effective authority is checked by the existing separate
enrollment authority service. Do not put credentials in argv, shared config or jobs.

The fixed `/etc/gbrain/page-file-operator-anchor.json` contains:

```json
{"operatorPath":"/protected/operator.json","operatorSha256":"<independently approved SHA-256 of exact operator bytes>"}
```

## V2 source approval and independent operator contract

The protected startup approval file has this strict shape:

```json
{
  "version": 2,
  "mode": "production-pilot",
  "bootstrapSha256": "<approved exact bootstrap SHA-256>",
  "sources": ["source-example", "source-other-example"]
}
```

Its independently pinned `approvalPath` and `approvalSha256` belong in the
`production-pilot` bootstrap anchor alongside `bootstrapPath` and
`bootstrapSha256`. This approval is distinct from the operator file pinned above:

```json
{
  "version": 2,
  "mode": "production-pilot",
  "bootstrap": {
    "mode": "production-pilot",
    "bootstrapPath": "/protected/bootstrap.json",
    "bootstrapSha256": "<approved exact bootstrap SHA-256>",
    "approvalPath": "/protected/source-approval.json",
    "approvalSha256": "<approved exact source-approval SHA-256>"
  },
  "enrollmentCredentialPath": "/protected/enrollment.credential",
  "enrollmentCredentialSha256": "<approved exact credential-file SHA-256>",
  "sourceIds": ["source-example", "source-other-example"]
}
```

These are non-runnable provisioning templates. V2 has no `reviewedPath` or
`reviewedSha256`. `sourceIds` is a unique nonempty list, capped at 256 per operator
contract, and must be represented in the protected host manifest. In pilot mode it
must be a subset of the v2 approval's `sources`; a v1 approval never implies
source-wide permission. Operator startup must reconstruct the same bootstrap
contract and admission as the fixed startup anchor. Runtime enrollment separately
requires both candidate and request admission to admit the source. No serialized
request, cursor or observed hash can mint or widen that authority.

The intended coverage is all eligible pages across the approved connected sources,
not a single selected page. Sweep each `sourceIds` entry separately. New eligible
pages in those sources need no page-specific deployment approval. Source admission
and enrollment do **not** grant source ACLs, tool access or business-content approval;
any business mutation remains separately authorized.

### Inventory, reconciliation and repeat sweeps

`inventory` observes existing bindings through checked reads and previews unbound
pages without reading the enrollment credential. `pending_enrollment` with reason
`checked_enrollment_required` is not proof of parser/index equivalence or final
eligibility. `reconcile` constructs an exact current page/revision/path/raw-digest
observation and uses the separate enrollment authority through the real runtime.
Enrollment rechecks identity, parser/index agreement, bytes and admission under
root/row coordination, then the operator performs a checked readback. It does not
edit business content, migrate, sync, recover or refresh stale intent into success.
Existing bindings are verified, never reenrolled (including generation > 0).

Both return `{status:"complete", source, items, nextCursor}` for a completed batch.
`complete` means the batch returned, **not** that all pages are enrolled. Each item
contains `source`, `slug`, `status` and, where applicable, `reason`:

| Status | Meaning |
|---|---|
| `verified` | Existing binding passed checked readback. |
| `pending_enrollment` | Inventory observation only; `checked_enrollment_required`. |
| `enrolled` | Reconcile enrolled and checked-read the target. |
| `ineligible` | Unbound `deleted_page` or `non_markdown`; no enrollment. |
| `blocked` | Known fail-closed reason; skipped, not repaired. |

Blocked reasons are `pending_recovery`, `sync_required`,
`page_file_root_sync_required`, `ineligible_page`, `missing_file`, `unsafe_file`,
`invalid_binding`, `path_collision`, `file_too_large`, `invalid_utf8`, `file_changed`,
`binding_changed`, `page_file_binding_changed`, `page_file_enrollment_stale`,
`page_file_gate_busy`, `page_file_root_gate_unavailable`, and
`page_file_inventory_limit`. Unexpected failures abort with the redacted operator
error rather than silently skipping. Earlier successful enrollments are not rolled
back if a later item fails; this is not an atomic multi-page operation.

Pagination uses source-local C-collation slug order and a limit-plus-one query.
Follow `nextCursor` until null, preserving the exact source and protected policy.
The cursor is progress only, bound to the operator-file digest and source, not an
authorization token. New-binding collision observation is separately capped at
1,024 sources and 10,000 nondeleted page paths; exceeding either cap blocks rather
than treating a truncated inventory as unique. Duplicate/out-of-order/foreign rows
and policy/source cursor mismatches fail closed.

After completion, **repeat from no cursor** to discover future pages, including
slugs sorting before the old cursor, and reconsider previously skipped pages after
separate remediation. An inventory sweep does not enroll; start reconciliation at
no cursor to cover its full source. There is no automatic new-page enrollment
service. Inspect every item/reason and cursor, not just exit zero.

## V1 legacy exact-page compatibility

The pinned v1 operator file retains this strict shape (replace placeholders offline):

```json
{
  "version": 1,
  "mode": "offline-verification",
  "bootstrap": {
    "mode": "offline-verification",
    "bootstrapPath": "/protected/bootstrap.json",
    "bootstrapSha256": "<independently approved bootstrap SHA-256>"
  },
  "enrollmentCredentialPath": "/protected/enrollment.credential",
  "enrollmentCredentialSha256": "<approved exact credential-file SHA-256>",
  "reviewedPath": "/protected/reviewed-page.json",
  "reviewedSha256": "<approved exact reviewed-file SHA-256>"
}
```

The bootstrap must reconstruct exactly the same contract as the existing fixed
`/etc/gbrain/page-file-bootstrap-anchor.json`. Missing, replaced or drifting files
refuse; neither hash is recomputed to authorize observed drift. Generic `production`
mode is refused. The v1 `production-pilot` variant requires matching protected
bootstrap admission with exact `source`/`slug` (approval `version: 1`,
`mode: "production-pilot"`, `bootstrapSha256`, `source`, `slug`); it never becomes
source-wide. `reviewed-page.json` contains all and only:

```json
{
  "hostManifestSha256": "<approved manifest SHA-256>",
  "source": "source-example",
  "slug": "page-example",
  "pageId": "<exact existing page ID>",
  "revision": "<exact opaque reviewed write revision>",
  "canonicalRoot": "/canonical/source/root",
  "relativePath": "page-example.md",
  "rawSha256": "<approved exact raw-file SHA-256>"
}
```

No fuzzy lookup, default source, live-baseline refresh or automatic review generation
exists. Enrollment forwards this exact baseline to `enrollPageFileRuntime`, which
checks host/source/root/page/revision/raw bytes under its existing exclusive root
and SQL transaction gates. It then reads the exact target through the private adapter
before reporting success. Repeating enrollment retains the existing generation-zero
idempotence rules; do not re-pin a changed page to bypass stale-baseline refusal.

## Ordinary compatibility is not content approval

Source approval does not freeze ordinary unenrolled pages or implicitly enroll new
ones. The enrolled remote `put_page` candidate has a source-bound data-only
`putOrdinary` path for metadata, add-only tags, chunks and write-through, separate
from body-only checked replacement. Local/subagent enrolled ordinary writers and
code-reference enrichment remain refused. Neither enrollment nor writer
compatibility approves business edits. See the [compatibility boundary](page-cas-mvp.md#ordinary-compatibility-boundary)
for recovery/post-hook and hosted-evidence limits.

## Outcomes and existing recovery

Output is a small JSON status, never page bodies, SQL errors, connection URLs or
credential contents. `verified` means the existing private checked read succeeded;
`not_enrolled`, `pending_recovery`, `sync_required`, and
`page_file_root_sync_required` are observations, not repaired states. A status command
exits zero for a successfully observed non-ready state: inspect the JSON, not exit code
alone. Other failures print only `page_file_operator_failed` and exit 1; invalid argv
exits 2. Enrollment/readback uncertainty must be inspected before retrying.

Recovery already exists and is intentionally not duplicated here:

- `recover_page_file_checked` is the existing local-only operation: supply original
  `source_id`, `slug`, `operation_id`, `expected_revision`, `file_baseline`, `page`,
  `raw_markdown` and explicit `action` (`resume-exact` or `abort`). Never substitute
  a newly observed baseline or select unexpected bytes. Exact generic CLI grammar:

  ```text
  gbrain call --source <exact-source> recover_page_file_checked '<original-intent JSON plus explicit action>'
  ```

  This is a non-runnable template, not an approval or example payload. The JSON
  must contain all fields above and its `source_id` must match the exact source.
  `gbrain --tools-json` describes parameters; it does not establish a direct
  `gbrain recover_page_file_checked` verb. This operation refuses remote/unset
  callers; the standalone operator has no `recover` action.
- Root reconciliation's existing invocation is
  `gbrain sources pull source-example --recover-root --yes`. It observes current files,
  does not rerun Git, and still refuses outstanding page intents. Sync afterward is a
  separately authorized action, not part of this operator command.

## Local verification boundary

```
bun test test/page-file-operator.serial.test.ts
bun run typecheck
```

The serial tests use protected filesystem fixtures and mocked DB/runtime boundaries.
Separately, baseline hosted run `35070352567/1` executed the real PostgreSQL operator:
status/verify without enrollment credentials, remote/unset and stale-baseline refusal,
exact enrollment, idempotent repeat and enrolled readback. The baseline also completed
four crash/fresh-bootstrap recovery boundaries and dirty-root reconciliation. See the
[baseline evidence ledger summary](page-cas-mvp.md#verified-baseline-evidence-and-pending-successor-proof).

The current local source-v2 runtime report records actual-call-chain PGLite evidence
for sibling/future-page enrollment, independent admission denials, operator
pagination and repeated sweeps. It mocks PostgreSQL transport/catalog discovery;
it is not a connected executable PostgreSQL receipt. The separate hosted v2
fixture is authored but **NOT RUN**, and live installation is **NOT DEPLOYED**.
The later v1 proof at `dd76211bc` is legacy evidence, not source-v2 acceptance.
Implementation references: `src/commands/page-file-operator.ts`,
`src/core/page-file-bootstrap.ts`, `src/core/page-file-runtime.ts` and
`src/core/page-file-authority.ts`.

Baseline crash proof called registered handlers in child processes, **not** the generic
`gbrain call` executable. That exact CLI acceptance remains pending; do not relabel
handler evidence as CLI execution. Exact source-v2 successor acceptance is
pending; legacy v1 upgrade/replay receipts must not be relabeled as v2. No production installation, credential provisioning or business write is
authorized by these tests or by this runbook. Use the [owner approval template](page-file-sql-authority-provisioning.md#finite-installation-rollback-and-owner-approval-template-preparation-only)
for a separately reviewed, finite future window.
