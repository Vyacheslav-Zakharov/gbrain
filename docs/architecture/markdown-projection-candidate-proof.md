# Source-local candidate proof — NOT executed / NOT registered

The SQL remains outside MIGRATIONS, fresh schemas and engine wiring. No DB, PGLite, container, provider, production service, migration, enrollment, commit, push or hosted dispatch was executed in this development slice. Bun compilation checks fixture syntax only, not SQL or roles.

## Protocol under test

`markdown_projection_policy` is the permanent source guard, seeded only from `sources` under table locks atomically with lifecycle triggers. Missing guard is 40001, not disabled. Source guard rows never cascade away; deletion advances epoch and blocks/tombstones retained work before cascades. Recreation changes incarnation on the retained tuple and stays disabled. Enrollment updates the same tuple, avoiding the old optional-policy MVCC hole. Root revision authority is not implemented; no FS activation is possible.

Writer key-only FOR SHARE admission is compatible across disabled writers; publisher FOR UPDATE and enrollment UPDATE conflict only with their source. Tag parent rows are locked FOR SHARE in ascending page-ID order, then old/new source guards in C order. Page insert/update recording is AFTER actual row results, avoiding phantom obligations from ON CONFLICT speculative inserts. Page deletion records before cascade; protected transaction/page context authorizes missing-parent tag cascade and is cleaned by deferred trigger. No caller-controlled setting supplies authority. SELECTs after guard lock in publisher must use a fresh RC command; publisher must never acquire page locks after guard acquisition.

TRUNCATE explicitly raises 0A000 on pages/tags/sources, even with no enabled sources. This is a documented unsupported relation-wide operation, not claimed source-local parity. A source-scoped TRUNCATE is impossible on these shared relations. Approval of this restriction or a separately proven aggregate control protocol is a deployment gate.

Ordinary writers receive no policy/ledger/helper grants. All definer functions have trusted fixed search_path and PUBLIC EXECUTE revoked. Schema owner and superuser bypass are out of contract. Whole-transaction retries for 40001/40P01 remain an integration requirement; server lock_timeout is 55P03, not freshness failure.

## Fixture and assertions

Uses actual src/schema.sql, postgres.js, independent max=1 backends, fresh verifier commands, finite server timeouts and random disposable database plus nonowner NOSUPERUSER/NOBYPASSRLS LOGIN with fixture-only RLS. Assertions include strict RR/SERIALIZABLE first/disabled/re-enrollment 40001; stale move and tag-parent routing; missing-guard rollback; same-source disabled coexistence; enrollment exclusion; unrelated disabled writes during publication; RC atomic current-epoch obligation; tags reparent/delete, rename history, source move, purge, source deletion rollback/history, incarnation reuse and role-scoped success/cross-source denial. Existing partial fixes are preserved.

The revised core assertions were authored before the SQL replacement; additional routing/lifecycle assertions followed. Nothing is claimed RED/GREEN. Bounded timeout schedules prove exclusion if they pass, not waiter-resumption correctness.

## Exact hosted commands (NOT for this machine)

Prerequisites: separate authorization and exact-byte review; genuine GitHub-hosted runner; disposable loopback pgvector PostgreSQL service; installed repository dependencies; MARKDOWN_PROJECTION_ADMIN_URL set to that service only. GITHUB_ACTIONS must already be true, never spoofed locally. No application DATABASE_URL. Service teardown is mandatory even if outer timeout interrupts fixture cleanup.

```sh
# Expected nonzero at missing-table assertion; verify reason and cleanup, not merely failure.
env -u DATABASE_URL MARKDOWN_PROJECTION_DISPOSABLE=CREATE_AND_DROP_DATABASE MARKDOWN_PROJECTION_PHASE=red timeout -k 5s 120s bun run scripts/markdown-projection-hosted-acceptance.ts
# Only after separately reviewing RED; require exit zero AND final passed JSON.
env -u DATABASE_URL MARKDOWN_PROJECTION_DISPOSABLE=CREATE_AND_DROP_DATABASE MARKDOWN_PROJECTION_PHASE=candidate timeout -k 5s 120s bun run scripts/markdown-projection-hosted-acceptance.ts
```

Capture exact SQL/fixture/schema hashes, PostgreSQL version, command/exit, final receipt and role/RLS evidence. Fixture reports only its own coverage, never full acceptance.

## Synthetic baseline gate (development revision; database execution pending)

The candidate phase now provisions its nonowner role **before** installing candidate SQL.
The fixture grants only SELECT(page_id, summary, detail) on timeline_entries and installs
an explicit source-scoped SELECT policy via the parent page. Nonempty mp-a/mp-b timeline
fixtures assert allowed summary/detail lexemes survive ordinary and retrieval-only updates,
while forbidden-source rows and lexemes remain invisible. A missing-SELECT negative control
requires the exact timeline table ACL denial; a SELECT-without-policy control must demonstrate
silent vector loss. Privileges/policy are restored before the positive baseline gate.

The same page/tag mutation routine runs after candidate installation, with distinct natural
keys and cleanup isolated from the retained concurrency fixtures. Its page/tag assertions and
search semantics must agree; sequence/generation values are deliberately not compared.
The missing-table RED remains a separate early phase, not evidence of baseline role health.
Expected 42501 failures require exact relation/function/RLS message seams, and stage/error
receipts preserve unexpected failures through cleanup. Offline guards and compilation do
not execute PostgreSQL or prove any of these semantic assertions.

**Separate real-initializer/engine lane still pending.** This lane bootstraps schema.sql only;
it does not execute PostgresEngine initialization/migrations, verify the migrated auto-RLS
event trigger, or exercise service-role engine/application authorization. Synthetic RLS
success must never be represented as deployed writer or engine compatibility proof.
Full catalog/trigger/FK inventory, every callable-helper/internal-table denial, full owner
snapshots for every refusal, UPSERT/zero-row differential coverage and per-mutation ordinary
obligation/rollback comparison remain review/implementation gates beyond this bounded slice.

## Remaining gates — explicit, not silently covered

SQL parsing/bootstrap and all authored schedules are unexecuted. Still add/prove: barrier-observed waiter resume after activation commit/rollback; stale target-source move (existing stale move covers old source); pre-install/new-source fixed snapshots; concurrent delete/enroll and stale recreate; both-source-authorized nonowner move; ordinary disabled RR/SERIALIZABLE overlap; deadlock injection with complete rollback; SET CONSTRAINTS IMMEDIATE deletion behavior; actual engine/import transactions, protected CAS denial and production-equivalent before/after grants. No immutable-root revisions, lease/current-pointer/ack implementation, full serializer, filesystem session-loss tests, retry integration, schema parity or scheduler exists. Source incarnation is in guard; obligation epoch plus page incarnation currently fences history, and explicit source-incarnation/root-revision payload fields must be added before FS publication.

Independent exact-byte review and hosted proof precede any migration registration. Deployment/activation and historical export/backfill require separate authorization. Immutable payloads plus DB-authoritative current pointer are the selected future filesystem representation, not mutable-file overwrite under a DB lock.
