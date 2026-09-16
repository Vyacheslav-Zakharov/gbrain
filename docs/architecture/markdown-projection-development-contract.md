# Markdown projection: development contract and finite acceptance ledger

Status: **Development only; owner-approved process-isolated copy-worker pivot.** Bounded isolated recovery accepted at source `4844c2f45b4b615530524ccc88fc22cfd527fb2d`, hosted run `35152934953` attempt 1; see external recovery acceptance closure. The runtime admission delta below is NOT covered by that hosted proof. No activation authorization.

## Protected runtime one-shot preparation (current delta)

Acceptance rows selected from the closure: **A5/A6/A11 production executable admission** and the bounded local drain/read-only subset of **A9-status**. A8 ambiguous-COMMIT is still a hosted gate. A9-scheduler/A10 and A9-tombstone remain separate, unimplemented. Earlier pending recovery statements below describe historical evidence, superseded by the closure, not this new runtime candidate.

Actual local command: `bun scripts/markdown-projection-runtime.ts status|drain [--config /absolute/private.json]`. No config means disabled/not_required; an explicitly missing or unsafe file fails. Private JSON version 1 contains `enabled`, `connection` (host, port, database, username, password, expectedServerAddress, expectedServerPort, tls: verify-full|local-only), and `worker` (sourceId, root, inputRoots, inventoryComplete:true). No HOME/config discovery, environment credential fallback, enrollment, DDL, scheduler installation, or fixture injection. Config must be regular, single-link, current-UID, private and opened NOFOLLOW; ancestors must be protected and canonical. Runtime roots additionally require current-UID mode 0700, canonical nonoverlap with explicit input roots; unlike disposable fixtures no sticky-directory exception is accepted. The inventory completeness assertion is operator-supplied, NOT independent discovery of all application roots. Same-UID malicious mutation is outside this boundary.

The existing supervisor launches a distinct runtime child with sanitized environment, one attempt and existing whole-lifetime/reaping bounds. That child alone creates a max-one dedicated postgres.js connection, pins database/login/effective user/server, refuses superuser/BYPASSRLS/role creation/database creation, public relation ownership and page-table DML privileges. No shared pool/driver changes. Least-privilege role grants, column-level/indirect authority audit, protected enrollment and registered migration/bootstrap parity are still release gates: this preparation does not provision or certify them.

Drain reuses the unchanged worker ledger/source-lock/immutable publication algorithm and drains at most one upsert. Failure is nonzero with durable outcome unknown, never falsely acknowledged. A fresh attempt consults the durable ledger, not the preceding process exit. No automatic retry or error-clearing write. Status runs an explicit READ ONLY transaction, checks source/root policy, and reports aggregate pending/blocked/materialized counts, first pending timestamp and maximum desired/materialized generations. These maxima are source aggregates, not per-page equality or current-view guarantees. Last error and heartbeat explicitly say unavailable: durable errors/backoff/heartbeat and per-article API wiring are NOT implemented. No success receipt claims those rows closed.

Offline proof: actual processes exercise default-disabled, explicit-disabled, missing/unsafe/malformed config and fixture refusals, plus unchanged config/root listing. Read-only SQL is source-contract checked; enabled real PostgreSQL execution and read-only DB postconditions remain hosted-unexecuted. No local DB/PGlite/container used.

**Actual next hosted proof:** after independent exact-delta review and separate dispatch authorization, invoke this exact runtime CLI with a protected file and independently pinned separate nonowner login; use existing disposable engine fixture (no runtime hooks). Snapshot schema/policy/ledger/files around status and disabled calls; prove zero mutations. Prove eligible upsert canonical bytes/current-view readback, repeat idle, wrong source/root/identity and excessive-role denial, input-root exclusion, and unchanged ordinary writers. Add an externally controlled loss around COMMIT; accept either durable outcome, then fresh CLI ledger reconciliation without duplicate/stale publication. Retain all prior bounded recovery lanes. No new hosted lane is authored or claimed executed by this preparation.


## Approved isolated-worker pivot (current architecture)

The copy caller is `python3 scripts/markdown-projection-isolated-supervisor.py`,
with an explicit JSON document on stdin. It launches the actual Bun executable
`markdown-projection-isolated-worker.ts`; no Portal engine, shared connection pool,
engine-facade dependency, driver patch, HOME discovery or inherited DB environment.
The development admission is intentionally HOSTED_DISPOSABLE_ONLY with an
`mp_accept_` database and independently supplied server identity. This is not a
production admission package or authorization to enable a source.

Worker owns one postgres.js connection. Connection close, uncaught exception and
unhandled rejection are terminal nonzero process failures, never ignored errors.
A new process can retry the durable pending obligation only after the prior child
and its tracked group/session are reaped. Supervisor's full child-lifetime deadline
is 20 seconds by default, plus bounded TERM/KILL cleanup (two seconds each).
Library retries are bounded to three; CLI executes one attempt. Earlier attempt
errors remain in the returned receipt even if a later attempt succeeds. Driver
messages/config/SQL are suppressed in favor of stable failure codes; no credentials
are passed in argv or forwarded output. No raw private diagnostics are persisted.
Success requires unique completion, zero exit and reaping; marker-then-hang fails.
No claim is made about deliberately escaped descendant sessions.

Existing worker immutable-file creation, protected root, fsync/readback and exact
conditional generation/current-pointer acknowledgement are unchanged. Process
isolation contains dead-driver callbacks; it does not make PostgreSQL and files an
atomic transaction. A kill around COMMIT can have an unknown outcome: reread the
ledger on retry, never infer unacknowledged state solely from a nonzero exit.
No new mutable pathname, weakened safety assertion or acknowledgement-on-error.

Finite pivot additions (supersede stale implementation-state prose below):

| ID | Entrypoint / acceptance | Evidence / remaining gate |
|---|---|---|
| A7-isolated | Actual private child admission/fail-stop; no Portal pool | Offline subprocess checks, including actual executable with simulated driver; real hosted backend termination/recovery PENDING |
| A8-isolated | Full-lifetime deadline; versioned final receipt binds caller run UUID, attempt and PID; reaping before retry/removal; primary plus cleanup errors retained | Actual supervisor CLI and shared hosted caller regression: TERM-resistant child with injected inventory failure remains alive, failed evidence retained, no retry, root/manual sentinel preserved; fixture then SIGKILLs and reaps. Missing/malformed receipt also refuses cleanup. Real PG crash/ambiguous-COMMIT recovery remains PENDING |
| A11-isolated | Explicit MARKDOWN_PROJECTION_WORKER_MODE=isolated; actual executable healthy completion, independent canonical bytes/current pointer | VERIFIED first healthy run 35150532582 attempt 1, source a0a982b065cea66a52b85a8c4d950c85d29ee1d5, workflow 6da809cb59f3bdfd1cb1cca6f08ba179c3017874; parent artifacts mp-preengine-parent-artifacts, engine exit 0, own PID 4047 reaped/exit 0. Legacy races excluded-not-passed. New fault candidate is not covered by that run. |
| A12-isolated | Hosted real backend loss before/after durable file; concurrent blocked newer writer; SIGKILL after durable file before ACK; same supervisor/validator; independent pending/current/manual readback | Authored in isolatedRecovery through actual executable, not executed on PostgreSQL. Scoped review and fresh exact-source hosted proof PENDING. No driver modifications or exception suppression. |
| A9-scheduler | Protected production admission, bounded scheduler/retries/backoff and heartbeat; measured <=1 minute/alert >5 minutes | NOT IMPLEMENTED/NOT MEASURED; production remains disconnected. |
| A9-status | API/CLI distinguish DB saved/pending/materialized/conflict; first-pending age, generation and last error | Production caller/status wiring and end-to-end assertions PENDING; fixture receipts are not a status API. |
| A9-tombstone | Owned-file tombstone cleanup, rename/source move/purge/recreate histories and manual-file protection | Worker drains upserts only. Tombstone execution/ownership policy and hosted acceptance PENDING; no deletion authorization. |

General driver patch development is stopped. The committed `4b33e3a97` generic
engine facade change is not needed by this caller. It is deliberately preserved
for review, not silently reverted: final worker branch should omit/revert its
feature-specific broad changes only after a scoped dependency and unrelated-caller
review. Existing rollback diagnosis script remains untouched. Scheduler, durable
error/lag status, nonowner grants and production deployment remain open gates.

## Blocking delta review disposition

The source-local replacement is authored, **not SQL-proven**. `markdown_projection_policy` is now the permanent source guard (the name is retained for candidate compatibility), seeded from sources only under installation locks. Each relevant writer locks the key-only tuple FOR SHARE before consuming enabled/alive/epoch. Enrollment updates that same tuple; fixed snapshots predating activation must receive 40001, not silently skip obligations. Publication uses FOR UPDATE on only its source, followed by fresh READ COMMITTED render-state reads. No global ordinary-DML lock remains.

Source create initializes disabled authority; deletion updates rather than removes the guard, blocks retained work and makes it tombstones before cascades; recreation updates the retained tuple with a new source incarnation and stays disabled. Old policy generation/history is retained in blocked obligations. Page BEFORE DELETE records a tombstone and protected transaction/page deletion context; tag cascades require that context when the parent is missing. A deferred trigger cleans context at commit. An early SET CONSTRAINTS IMMEDIATE can cause a cascade to fail closed; this candidate does not certify that mode.

Tags lock OLD/NEW parents FOR SHARE in page-ID order before deriving sources. Page moves lock both OLD/NEW guards, deduplicated in C collation order. Arbitrary multi-statement/multi-row SQL can still deadlock: callers must retry the **whole transaction** on 40001/40P01, and bounded lock timeouts may report 55P03. Engine retry integration is not implemented. No deployment-supported isolation is certified until hosted proof.

MP-B2's real non-owner scoped LOGIN success/denial assertions and MP-B4 rollback/history/recreation assertions are preserved. Additional fixture schedules require exact 40001 for RR/SERIALIZABLE activation and stale parent routing, missing-guard refusal, same-source disabled SHARE coexistence, unrelated writers during publication, fresh RC atomic obligation, and source incarnation rotation. Core regression assertions preceded this SQL edit; no observed RED/GREEN. Role topology remains fixture-local, not a production grant.

**Explicit aggregate exception:** TRUNCATE on pages/tags/sources is unsupported and raises 0A000 even while disabled. A relation-wide TRUNCATE has no source filter; it cannot meet source-only semantics. This is a visible candidate restriction, not restored baseline parity or a global DML rejection. Installation/activation requires approval of this restriction or a separately proven aggregate-control implementation. Source-scoped DELETE remains supported by the candidate.

**Next gate:** independent exact-byte review, then separately authorized disposable hosted proof. Missing schedules/production integration remain listed in the proof document; no deployment, registration or activation is authorized.
Authority: owner approved future current-latest Markdown copies, separate protected per-source roots, local copy only. The mandatory future-markdown-guarantee audit dated 2026-09-16 supplied the writer coverage and risk inventory. Its earlier research-only scope is superseded only for development, not migration/deployment/activation.

## Scope and fail-closed decisions

- Current latest eligible article, not an archive of every intermediate revision. Coalesce superseded generations, never publish stale generations as current.
- Disabled sources have no filesystem IO, new obligations or projection jobs. Mandatory SQL triggers still read/lock source guards (and deletion context); literal zero projection DB access is not promised. The pure preview absent/disabled/db_only early return remains zero DB/IO. Missing guards fail closed. Unknown policy blocks. No implicit opt-in from remote_url, local_path, sync.repo_path or frontmatter.
- `filesystem_authoritative` without separately enrolled projection policy blocks; never write back input files. Production policy enumeration and source exceptions require explicit trusted enrollment. Sandbox/remote caller cannot acquire new filesystem authority asynchronously.
- Separate protected per-source root outside **all** import/sync/attachment roots, never imported back. Enrollment must prove canonical physical paths, non-overlap across sources, ownership/mode and no symlinks. A `managed: true` preview input is not proof of those facts.
- Existing backlog is excluded. Enabling policy stores a transactionally ordered activation watermark; enrollment does NOT scan pages or insert obligations. Only subsequent committed eligible mutations create obligations, including future changes to previously existing articles. Reconciliation may inspect existing obligations, not backfill old pages. Historical recovery needs separate approval.
- No Git commands, commits, remote backup, push, branch/PR handling in this initial release. Local Markdown != remote durability.
- No changes to CAS, frozen manual-only successor, roles, production services, schema or config in this slice.

## Implemented vertical entry (not a guarantee)

`src/core/markdown-projection.ts:materializeMarkdownProjection` is the proposed caller. It returns `not_required` before touching snapshot for absent/disabled/db_only. Enabled requests validate source-scoped lexical root/path/article eligibility and deterministically render a **preview**. Original sourcePath is never a destination. Attachments and dot/absolute/escape paths block. Conservative slug alphabet excludes dots and unusual characters pending a tested encoding contract; no token normalization.

A valid plan returns `pending`, `materialized:false`, `reason:durable_adapter_not_connected`. This is an in-memory pending preview, **not a persisted obligation** and not proof that any article is saved. Renderer `preview-v1` is not the final full-page serializer: complete canonical frontmatter/type/timeline serialization is a later acceptance criterion. The function has no engine/FS/provider imports or capabilities. It is not wired to production writers, CLI or scheduler. No DB coverage is claimed.

## Atomic obligation and writer authority

PostgreSQL ledger key: brain identity + source + immutable page identity/incarnation, never slug/content_hash alone. Store desired generation/operation/path, previous owned path/hash, policy/root generation, renderer version, first-pending time, attempted/materialized generation/hash, lease/fence, retries, next retry, last error, conflict. Ledger survives purge without cascading foreign key deletion; retain tombstone identity and previous ownership metadata.

Same transaction as each authorized pages/tags mutation must upsert obligation and advance monotonic generation. Failure rolls back mutation. Narrow triggers cover pages INSERT/UPDATE/DELETE and tag INSERT/UPDATE/DELETE; reparent tags invalidates both pages. Ignore retrieval timestamps/embedding-only changes. Source move requires old-source tombstone plus new-source obligation. Rename retains old path. Soft delete/purge emits tombstone; restore creates a newer generation; same-slug recreation gets a new incarnation. Policy/root changes fence old work; disabling existing obligations requires explicit status, never false completion.

Triggers do not do filesystem/network IO or grant writer privileges. Existing CAS/protected-write rights remain prerequisites; no ordinary SQL fallback around protected writers. Dedicated materializer receives only scoped ledger/snapshot/ack authority, not page mutation or enrollment rights. PGLite/other engines remain unsupported/blocked for enabled policy until equivalent parity evidence; do not silently downgrade required projection.

## Latest-version publication / crash / conflict contract

Read a coherent immutable snapshot of all render inputs (page, tags, canonical metadata, timeline) with generation. Hash full deterministic bytes, not existing content_hash; no retry clock fields. Lease is not publication authority. Final installation must serialize with every page/tag/delete/source-policy writer, validate generation/root generation/fence under the shared DB locking protocol, then install and conditionally acknowledge exact generation/hash. A standalone advisory lock observed only by workers is insufficient. Until the common locking protocol is proven, publication remains blocked; no mutable-file overwrite is allowed.

Chosen future representation: immutable create-only generation payloads named by source/page incarnation, policy epoch, generation and content hash, plus a **DB-authoritative current manifest pointer** updated conditionally under the source guard. Readers resolve latest through that pointer. No mutable current.md or symlink overwrite is allowed: a surviving worker after DB-session death cannot be fenced by a DB lock alone. A stale worker may create an orphan immutable payload, never overwrite newer bytes or advance the current pointer.

Generations are internal transient artifacts, not a user-visible every-edit archive; bounded safe GC requires later proof/approval. Physical root protection, ownership, fsync/read-back, exact crash recovery and conflict detection remain required. Original attachments/input roots remain untouched. ENOSPC/EACCES/root drift remain visible pending/blocked; no filesystem adapter is implemented here.

## Status and scheduling

Write API separates DB saved from projection `pending|not_required`; cannot return materialized on enqueue. Read status exposes desired/materialized generations, first pending age (not reset by each retry), attempt/error/blocked/conflict and scheduler heartbeat. Portal stays DB-first with unchanged ACL/attachment behavior when worker stops. Healthy latency target <=1 minute and alert >5 minutes are acceptance targets requiring measurements, not achieved promises.

Proposed protected local CLI `markdown-projection status|drain` is bounded by source, batch and deadline, rejects remote/untrusted execution for drain, never enables policy. Minions handler is protected, source-scoped and provider-free. Periodic trusted scheduling wakes ledger draining/reconciliation; job completion is not file completion. Recover expired leases, prevent duplicate publication, expose worker-down/lag alerts. No scheduling is installed in this slice.

## Concrete inspected integration points

- `src/core/postgres-engine.ts:1058–1144`: putPage upsert and direct/batch deletes; `3541–3564` tags; `4874–4902` revert; `5062–5075` rename. Hooking putPage alone misses SQL/tag/delete paths. Mirror engine API changes in `pglite-engine.ts` without claiming enabled support prematurely.
- `src/core/import-file.ts:742–822`: page/version/tags transaction; trigger obligations must remain invisible until commit. `src/core/operations.ts:978–1064` put_page result; `1404–1459` deletion and `2033–2066` tags need accurate status, not write-through success inference.
- `src/core/migrate.ts` MIGRATIONS (baseline latest 140, at 6172): next reviewed migration owns tables/triggers/privileges; `src/schema.sql`, `src/core/pglite-schema.ts` and bootstrap probe parity require review. No migration number allocated or migration executed here.
- `src/core/write-through.ts` is existing best-effort input-root behavior, not the adapter; do not silently redirect it or source-ingest durability semantics. `src/commands/sync.ts:3086–3143` reverse-sync deletion makes root exclusion mandatory.
- `src/cli.ts:1638,1704` dispatch / `src/commands/jobs.ts` MinionWorker construction and handler registration: future CLI and protected handler seam. `src/core/minions/protected-names.ts` controls trusted submission, `worker.ts:930–976` dispatch/lease context, `queue.ts` persists jobs. Jobs do not replace atomic ledger. `src/core/operations.ts` defines generated status/ACL contract; doctor/status should surface lag separately.

## Finite acceptance ledger

| ID | Acceptance | State / proof boundary |
|---|---|---|
| A1 | Exact-base isolated worktree; baseline stays clean | Verified via git; no commit/push/deploy |
| A2 | Absent/disabled/db_only caller has zero IO/DB writes | Offline passing real temp fixture; capability-free implementation; no DB instantiated |
| A3 | Enabled source-scoped deterministic preview; unsafe roots/paths/attachments block; explicit pending | Offline passing caller test; no physical-root or publish proof |
| A4 | Atomic obligations across all writers/SQL/tags, rollback, watermark and purge tombstones | Synthetic baseline/candidate hosted run 35099879925 attempt 1 passed; not all writers. A4-engine below remains hosted-pending; registration prohibited |
| A5 | Full canonical serializer and generation/hash snapshots, rights and engine admission | Pending integration/proof |
| A6 | Guarded physical roots, ownership, symlink races, conflicts and attachments unchanged | Pending real-FS adapter tests |
| A7 | Shared writer serialization, two workers, stale retry/delete/rename/source-move/recreate | Actual worker hosted connected. Two independent worker-engine sessions plus observer termination at before_write/after_write authored; actual PID separation, terminated-backend absence, stale ACK rejection and latest-pointer preservation required. New schedules hosted-unexecuted; remaining mutation schedules open |
| A8 | Crash/fsync/install/ack/restart and bounded retry/reconciliation | First hosted exception/rollback/retry passed; real SIGKILL-after-durable-file recovery authored through worker, hosted-unexecuted. Offline supervisor SIGKILL/group-reaping passed; not DB proof |
| A9 | Accurate API/CLI/status, protected job and scheduler, portal/reverse-sync isolation | Pending production-call-path implementation and tests |
| A10 | Measured <=1min healthy latency, >5min alert; stopped worker | Pending controlled acceptance measurements |
| A11 | Independent exact-artifact review + hosted DB acceptance | First reviewed synthetic hosted run passed; new engine-lane bytes require fresh review then separately authorized exact-SHA run. No local DB execution |
| A4-engine | Real initializer/migrations + service-owner page/tag engine differential | VERIFIED prior source f8498893e34185feeff530e457a1dcc26712863a, workflow 2004a0d7bc4e5b078b80f0ea5d66894f583e6a8e, run 35102301457 attempt 1: engine exit 0, baseline/candidate complete, cleanup passed. Filesystem disconnected in that run; application-auth excluded |
| A12 | Separate activation/rollout and any historical backfill approval | Not authorized; gates remain closed |

## First actual worker (supersedes pending adapter descriptions)

`drainMarkdownProjectionOnce` uses the real Engine transaction/executeRaw contract,
explicit READ COMMITTED, source guard UPDATE lock, one-query page/tags snapshot,
canonical serializer with recursively sorted metadata, protected Linux descriptor-root
create-only payloads, fsync/readback and conditional DB completion. The unregistered
worker SQL delta supplies root binding, completion columns and the authoritative
`markdown_projection_current` view; raw retained pointer columns are NOT current.
No mutable alias exists. Production callers/scheduler remain disconnected.

Offline real-temp-FS tests and project typecheck pass. Tests inject exceptions at
write/ack seams, not SIGKILL or a real PostgreSQL backend death. The first missing
module was observed RED, followed by caller GREEN; adversarial cases were added
subsequently (not individually observed RED). Prior engine artifact identity and
completion/cleanup receipts were independently reread; that proof predates these
worker bytes. That historical limitation is superseded by the first-worker receipt below.
Hosted lane invoked the worker and passed rollback/retry, exact canonical bytes, hash,
current view and idle repeat. The new race/crash delta has NOT been dispatched.

Remaining seams: separate nonowner worker authorization/enrollment and complete root
inventory/admission, scheduler/CLI/status, tombstone handling, stale two-worker real
backend-death concurrency and process/power-loss tests, error/lag persistence and GC.
Roots must be trusted precreated mode 0700; same-UID malicious writers are outside
this protection. No archive/import/backfill/attachments/manual-file mutation.

## First worker receipt and next finite proof

Verified downloaded identity: source `b5f1ba3561bf85df1511945fdcb9820325b11ad6`,
workflow `8affe345efe43e7e1f7a669eff1a15f480f18de7`, run `35104957553`, attempt 1.
`engine.exit=0`, `worker.complete` passed with `filesystemWorkerConnected:true`,
engine complete passed, cleanup errors empty, final catalog `0|0`, supervised groups
and sessions empty. Service-owner fixture only; no application-role proof.

New `scripts/markdown-projection-worker-races.ts` is called from the actual hosted
engine lane after first-worker assertions. No worker/product/SQL privileges changed.
Two schedules terminate a real independently observed worker backend, commit a newer
ordinary engine write, publish via a second independent worker, then resume the stale
worker and require real ACK failure plus byte/pointer preservation. A separate real
worker child stops after fsync/readback before ACK; the bounded Python supervisor
SIGKILLs it, reuses existing process-group/session reaping, and parent verifies backend
absence, unchanged pending obligation, exact-path/bytes retry and idle repeat.
These are **executable hosted assertions, not executed backend-death/crash proof**.
No local DB, PGLite, containers, production writes, commit or dispatch in preparation.
No production defect was demonstrated; no product fix or claimed RED/GREEN cycle.
Next: exact-delta review and separately authorized immutable hosted run; require both
`worker.backend-race` receipts and `worker.process-crash` plus aggregate exit/cleanup.

## Historical executed proof and task history

Strict sequence: test missing caller RED (assertion undefined/function), implement disabled slice GREEN (1 test), extend enabled caller RED (expected pending, got not_required), implement pure enabled contract GREEN (2 tests, 57 assertions). Receipts: `projection-red-1.log`, `projection-green-1.log`, `projection-red-2.log`, `projection-green-2.log` in the external development-start report directory. Exact command: `timeout -k 3s 25s bun test test/markdown-projection.test.ts`. Only this file ran. Initial prerequisite run failed because isolated worktree lacked dependencies; read-only reuse via temporary node_modules symlink to installed dependencies resolved it without install/postinstall; the symlink was removed after verification. No dependencies modified. Narrow Bun compilation succeeded (not a project typecheck). A combined typecheck command was blocked by an execution safety guard; no typecheck coverage is claimed. No broad tests or DB/provider calls.

**Current evidence supersedes earlier unexecuted-SQL descriptions above:** source `8108cc95ee29c9e5caadcb8c3f2e2cf5dda42850`, workflow `c83258fdaf5b7b9bd3eafe9fec1c0edc2ae2669e`, run `35099879925`, attempt 1: synthetic RED exit 1 at missing table, candidate exit 0/final passed, cleanup passed (parent-verified downloaded artifacts). Filesystem worker remains disconnected. This does not certify initializer, migrations, service-engine callers, application authorization or files.

**Next gate:** review the separate real-engine lane, then commit/push/hosted dispatch only with separate authorization. The wrapper requires hosted socat, sudo/unshare/setpriv and frozen repository dependencies; it exposes only a Unix-socket relay to the dedicated PostgreSQL service inside a loopback-only network namespace. It does not install dependencies. Full initSchema calls schema rendering, runMigrations and verifySchema, including migration v35 auto-RLS. The disposable service login is explicitly verified as superuser/BYPASSRLS and table owner; this is not nonowner or application-auth proof. Baseline completes before unchanged candidate SQL installation; candidate inventories auto-RLS and checks real putPage insert/conflict, getPage, addTag/removeTag/getTags, searchKeyword, softDeletePage/restorePage/deletePage and transaction rollback with observer-visible obligations. Raw SQL only seeds timeline/chunks and observes catalog/ledger. Rename, versions, batch purge, import/registered operations, auth, retry/concurrency integration and serializer/FS/scheduler remain separate open rows. Do not close A4-engine until a real hosted receipt passes. No local database or provider was run.

### Runtime hosted extension preparation (not hosted proof)

Actual protected status/drain CLI fixture is now wired after unchanged isolated
healthy/recovery or selected legacy gates. A generated nonowner login receives
source-constrained reads and acknowledgement-column updates only; policy source_id
UPDATE is needed for SELECT FOR UPDATE, not policy enablement. Runtime bytes remain
unchanged. All fixture provisioning stays inside the generated disposable database.

Finite remaining gates (none inferred from offline green):
- H1: hosted enabled CLI status/drain, independent row/catalog/file snapshots and
  digest/generation/current-view readback; implementation authored, execution pending.
- H2: service-side statement audit proving actual BEGIN READ ONLY and no DML/DDL,
  independent runtime session identity observation; pending, not claimed by snapshots.
- H3: ordinary nonowner writer coexistence after runtime drain, other-source post-drain
  equality, expanded wrong login/database and symlink/hardlink refusal; pending.
- H4: indirect/security-definer and inherited/column authority certification; fixture
  inventories callable SECURITY DEFINERs but does not approve production authority.
- A8: external ambiguous-COMMIT loss plus fresh actual CLI durable reconciliation; pending.
- A10: scheduler/restart lifetime and durable error/backoff/heartbeat; pending.
- T1: tombstone processing and obsolete publication collection; pending.
- R1: registered migration/bootstrap parity, enrollment watermark, production ACLs
  and source/ACL coexistence; pending. No install or production readiness approval.
- V1: independent scoped patch review, then separate commit/push/dispatch authority
  and exact source/workflow SHA hosted proof; pending. Prior run covers baseline only.
