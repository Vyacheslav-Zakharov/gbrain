# Page-file effective SQL authority — offline provisioning contract

Status: the read-only validator is integrated with connected runtime admission in
verified baseline `b093e14245c4153d218f7ce3c629f13ed06ee797`, hosted run
`35070352567/1`, for disposable offline verification only. It is **not production
authorization**. Pilot admission/root-scope changes remain **HOLD** pending independent
review and exact-candidate mixed-root evidence. Never enable unrestricted
`offline-verification` on production; neither a label change nor owner approval
substitutes for reviewed bounded admission and proof. This document is preparation
only: no installation, provisioning, migration, restart or live write is authorized.
No runtime, migration, existing role, policy or grant is changed by the validator.
Reference contract: `test/e2e/page-file-sql-authority.test.ts` mixed-writer role setup;
identity/session contract: `src/core/page-file-authority.ts`; fences: migration 142.

## Principal separation

Supply protected, independently reviewed database identity and three distinct login
names: ordinary, adapter, enrollment. Runtime admission validates ordinary and
adapter through their actual logins. Enrollment actual-login validation is a
separate trusted local operator acceptance/lifecycle action, not a credential
requirement in every CLI/MCP/worker. Workers may know its protected role name but
must not receive its credential. Never validate an owner connection using SET ROLE.
Both session_user and current_user must match. All three are LOGIN, NOINHERIT,
NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS. No membership
edges are permitted, including NOINHERIT membership, SET-only paths or admin-option
membership. This conservative subset prevents direct and transitive escalation
without assuming NOINHERIT prevents SET ROLE. No principal owns the database,
public schema, critical relations/sequences or attached trigger functions.

Effective privileges include PUBLIC and inherited grants; historical direct grants
are not erased by migration 142's PUBLIC revocation. Reject every grant option on
critical tables, columns and sequences, CREATE on the database/public schema, and
SET/ALTER SYSTEM privilege on session_replication_role. The latter probe requires
PostgreSQL 15+; older or restricted catalogs fail closed, not silently skip.

## Candidate mixed ordinary-writer allowlist (finite inventory)

The add-only adapter tag and ordinary graph fixture deltas below are **candidate contract proposals requiring
independent review**, not approved production provisioning. The baseline hosted
run above does not verify these new bytes. No broad source enrollment is enabled.

All principals: CONNECT, public USAGE; SELECT sources, pages, page_file_bindings,
config. No table privileges outside the following additions on the finite list.

| Principal | Additions |
|---|---|
| ordinary | SELECT/INSERT/UPDATE/DELETE sources, pages, config, tags, timeline_entries, content_chunks, page_versions, code_edges_chunk, code_edges_symbol; SELECT-only page_file_bindings; no page_file_operations or page_file_write_authorizations privileges |
| adapter | UPDATE pages; SELECT/INSERT tags (no UPDATE/DELETE); SELECT timeline_entries, code_edges_chunk, code_edges_symbol; SELECT/INSERT/UPDATE/DELETE content_chunks; SELECT/INSERT page_versions; SELECT/INSERT/UPDATE page_file_operations; SELECT/INSERT/DELETE page_file_write_authorizations; UPDATE sources(id); UPDATE page_file_bindings(pending_op_id,indexed_raw_sha256,file_generation) |
| enrollment | UPDATE sources(id), pages(id); INSERT page_file_bindings; SELECT tags |

Ordinary and adapter have USAGE on page_generation_clock_seq. Both have
USAGE/SELECT on serial id sequences for content_chunks, page_versions and
timeline_entries. Ordinary additionally has USAGE/SELECT on serial id sequences
for pages, tags, code_edges_chunk and code_edges_symbol. The candidate adapter
adds **USAGE only** on the exact sequence returned by
`pg_get_serial_sequence('public.tags','id')`; no SELECT, UPDATE, grant option,
ALL SEQUENCES, or page/code-edge sequence authority is added.
Enrollment has no sequence privileges. No sequence UPDATE or grant options. Column-only UPDATE must
not become table UPDATE. Every actual column of the finite relation list is
checked for SELECT/INSERT/UPDATE/REFERENCES, preventing hidden column ACL widening.
Missing sequence/table/required lock column is failure.

This implements approved architecture option 1: ordinary legacy DML continues on
unenrolled pages; existing enrolled-page/chunk/source/config DB fences remain
unchanged. Ordinary cannot mint transaction capabilities, edit bindings or operation
receipts, TRUNCATE relations, disable triggers, inherit/SET ROLE to another
principal, grant privileges, or own protected objects. CAS uses the private adapter.
This finite audit does not prohibit necessary unrelated application tables outside
its inventory. Their provisioning remains separately reviewed. Migration credentials
are release-only; ordinary startup must not automatically apply migrations.
Architecture approval is not permission for live deployment or provisioning.

## Candidate ordinary graph fixture compatibility (not graph CAS)

Existing ordinary ingestion/capture/reconciliation must continue before CAS
activation and outside page CAS. The disposable hosted fixture therefore adds only
`SELECT, INSERT, DELETE, UPDATE(context,origin_field)` on `public.links` to its
ordinary login, plus **USAGE only** on the exact sequence returned by
`pg_get_serial_sequence('public.links','id')`. The column UPDATE grant supports
the existing `addLink` conflict update; DELETE supports existing reconciliation.
No table-wide UPDATE, sequence SELECT/UPDATE, ALL SEQUENCES, grant option,
TRUNCATE, ownership, adapter or enrollment graph authority is added.

The fixture's ordinary-only `FOR ALL` RLS policy uses the same predicate for
`USING` and `WITH CHECK`: both `from_page_id` and `to_page_id` must resolve to
pages in the explicitly approved fixture source, and `origin_page_id` must be
NULL (existing manual/markdown semantics) or resolve to a page in that source.
An endpoint-OR policy is insufficient; checking only the outgoing endpoint or
omitting non-NULL origin checks permits cross-source reads/writes. Existing
source-scoped page visibility remains in force. This is a row-level contract:
the existing addLink LEFT JOIN can resolve an invisible/missing origin slug to
NULL; this fixture does not claim to validate caller-supplied origin strings.

The new hosted case uses the existing separate ordinary login and real
`projectContentImportCodeRefs` ingestion helper / `PostgresEngine.addLink`, with
owner readback proving both directional edges despite best-effort error catches.
It tests same-slug foreign-source isolation, conflict updates of both permitted
columns, NULL origin and deletion, exact sequence privileges, forbidden column
updates, each foreign endpoint/origin INSERT rejection, hidden foreign rows for
SELECT/UPDATE/DELETE, and adapter/enrollment graph denial. Each negative mutation
has unchanged-row-state assertions; sequence counters are deliberately excluded
because PostgreSQL nextval is nontransactional even when INSERT fails. Authored
pages, chunks, tags, bindings, operations and authorizations remain unchanged by
the graph probe; the existing enrolled-page/private-authority fence probes remain.

**Evidence status: hosted unexecuted for this candidate.** The offline fixture
shape regression is not SQL/RLS proof. This change extends only the disposable
fixture provisioning contract, not the runtime validator's twelve-table/eight-
sequence inventory or its twelve pins. `links` and its ID sequence remain outside
that finite CAS audit: the new actual-login tests supply separate fixture evidence,
not runtime graph attestation or a new graph pin. No live grant, production pin,
adapter graph write, graph CAS, migration or enrollment activation is authorized.

## Candidate add-only tag delta and writer handoff

The only new adapter privileges are `INSERT ON public.tags` and `USAGE ON` its
exact ID sequence. That tag delta leaves ordinary and enrollment privileges unchanged;
the separate ordinary graph fixture delta is specified above. Retain
all owner, membership, BYPASSRLS, trigger, column and grant-option denials.
Disposable fixtures use a separate adapter `FOR INSERT ... WITH CHECK` policy
whose page-ID predicate selects only pages in the fixture source, alongside the
existing SELECT policy. Never substitute `FOR ALL` or `WITH CHECK (true)`.
The changed tags policy catalog requires a newly independently reviewed external
`catalog:tags` pin; **do not refresh a runtime pin from the database being admitted**.
No production pin, credential, provisioning execution or migration is supplied.

Migration 141's BEFORE tag trigger and migration 142's page fence are unchanged.
Each INSERT updates its parent revision, **including an INSERT ... ON CONFLICT DO
NOTHING that finds an existing tag**. After the existing-page UPDATE and before
each subsequent tag INSERT, the writer must read the current locked page revision
and refresh its private transaction authorization using DELETE + INSERT, bound to
the same transaction ID, page, prepared operation and pending binding. Never grant
UPDATE on authorizations, remove `expected_revision`, use an ordinary connection,
or batch multiple tag rows under one stale token. Preserve old authored/enrichment
tags; return the final revision only after all trigger-visible statements complete.

`test/page-file-tag-fence.test.ts` executes the shared SQL fence probe in isolated
PGLite: missing/stale authorization denied, page UPDATE and tag INSERT rotate
revision, duplicate conflict rotates revision, refreshed token permits add-only
writes, non-prepared operation denied, transaction rollback preserves baseline.
This is trigger/transaction evidence, **not actual login/RLS attestation**.
`test/e2e/page-file-sql-authority.test.ts` runs the same probe through the real
adapter login and adds ordinary denial, UPDATE/DELETE denial, cross-source RLS,
missing/excess privileges, policy drift and disabled-trigger probes. These hosted
probes must run on the exact reviewed candidate in a disposable fixture before
any release approval; offline GREEN does not certify them or full ordinary-put
compatibility. This change alone supplies no writer, file commit, or broad sweep.

## Required catalog and RLS evidence

Every listed table must be an ordinary table with RLS enabled and active for the
actual login. Required named enabled fences are checked on sources, config, pages,
content_chunks; page revision, tag revision and page generation/clock triggers are
also required. Every table additionally requires a protected SHA-256 catalog pin.
The SELECT catalog probes return canonical JSONB text containing:

- exact columns/types/nullability/defaults and constraints/validation state;
- table owner, RLS and FORCE RLS flags;
- **all** policies, role names, commands, permissiveness, USING and WITH CHECK;
- **all** non-internal triggers, enabled state and definitions;
- attached function owner, SECURITY DEFINER status, search_path/config and full body.

Pins must be reviewed against approved schema/migration bytes and intended
source-scoped RLS predicates. In particular SECURITY DEFINER fences must have a
trusted offline owner and fixed search_path; owners must not be online service
principals. Extra permissive policies, wrong trigger bodies, disabled fences,
wrong ownership and any definition drift invalidate the pin. A mere policy count
or trigger name is NOT accepted as sufficient evidence. FORCE RLS is not newly
mandated for these non-owner principals; its reviewed value is pinned.

**Never auto-enroll observed catalog hashes.** The validator compares against pins
supplied by a protected independently approved manifest. Fixture hashes in unit
tests are synthetic evidence-format tests, not real schema attestation. Catalog
serialization may differ across PostgreSQL versions/search_path; review and pin
for the exact supported server major and fixed `pg_catalog, public` search_path.
No actual production pins or credentials are supplied by this artifact.

## Real PostgreSQL integration seam

`pageFileSqlAuthorityQueries(expected)` exposes the exact SELECT-only probes and
stable evidence IDs. Bind `[expected.role, expected.database]` on every query.
`verifyPageFileSqlAuthority(query, expected)` collects and validates them without
opening a connection. `validatePageFileSqlAuthority(rows, expected)` is the pure
fixture-driven validator. Its only failure diagnostic is
`page_file_sql_authority_invalid`; driver messages, URLs, raw rows and SQL are
never returned. Missing, extra, duplicate, null or non-boolean evidence denies.

The caller must reserve one physical connection and own a read-only repeatable-read
transaction around collection, with a fixed trusted search_path, finite statement
and lock timeouts, row_security on and session_replication_role origin. Validate
ordinary and adapter before service registration; revalidate on new physical
sessions/reconnect and after authorized provisioning changes. Validate enrollment
separately in the trusted local operator lifecycle before its enrollment action. This module does
not establish transactional runtime admission, cache results, repair drift, select
credentials, issue DDL, or mutate business data. A verdict is point-in-time evidence,
not protection against later owner-authorized changes.

Verified baseline: hosted `35070352567/1` completed seven SQL-authority tests,
real connected ordinary/adapter bootstrap, separate executable operator enrollment,
reconnect/per-borrow refusal, four crash/restart boundaries and dirty-root recovery.
The mixed-writer fixture exercises ordinary DML alongside enrolled-page fences.
Its twelve catalog pins are marked `disposable-fixture-only-not-production-approved`.
See the [baseline evidence summary](page-cas-mvp.md#verified-baseline-evidence-and-pending-successor-proof).

Pending proof is finite and distinct: representative already-v142 upgrade/replay
provisioning, exact successor pilot mixed-root scope, actual target role/catalog
compatibility and installed readback. Fresh migration through v142 does not establish
upgrade/replay. Seven SQL-authority cases do not certify every catalog mutation:
map evidence explicitly for PUBLIC/direct/column grants, membership/SET ROLE, grant
options, owners, triggers/functions, permissive policies, RLS, missing objects and
credential mismatch; mark uncovered cases pending rather than asserting coverage.
Each authorized rehearsal needs rollback and exact target readback. Do not bypass
the validator or promote fixture pins to pass a gate. No local PostgreSQL/container
or production access is required or authorized by this documentation update.

## Finite scope and exclusions

The validator inventory is exactly twelve tables and eight sequences from the
mixed-writer contract, plus their policies/constraints/triggers/functions, database and
public schema. This is not a whole-database privilege audit. Unrelated callable
SECURITY DEFINER functions, extensions, foreign servers, other schemas, server
configuration and external DBA powers remain the deployment's separate trust
boundary; success does not claim their safety. The disposable fixture additionally
provisions ordinary `links` and its ID sequence as described above; these are not
added to the validator inventory. No production provisioning DDL is included:
actual installation/revocation and independent pin approval require operator review.

## Finite installation, rollback and owner approval template (preparation only)

**Decision: HOLD. Authorization: NOT GRANTED. Execution: NOT STARTED.**
This is a decision record, not executable configuration. `UNRESOLVED` is a blocking
value, never a wildcard or permission to discover-and-approve a live value automatically.
Baseline evidence above is known; none of the target-specific values below is inferred
from it. Keep credentials out of this record; reference protected paths and approved
hash manifests only. Do not copy the offline operator example onto production.

### 1. Exact target and frozen package

| Required field | Value / receipt |
|---|---|
| Brain/database identity, server identifier and PostgreSQL major | UNRESOLVED |
| Host identifier, service UID and exact affected units/entrypoints | UNRESOLVED |
| Currently installed SHA, runtime artifact hashes and rollback artifact | UNRESOLVED |
| Successor full SHA, immutable artifact location and SHA-256 manifest | UNRESOLVED |
| Exact successor CI run/attempt, evidence manifest hash and independent review verdict | UNRESOLVED |
| Bounded admission mode/contract and root-scope review receipt | UNRESOLVED — HOLD |
| Explicit source IDs, page IDs/slugs, canonical roots/relative paths, excluded sources/roots | UNRESOLVED |
| Cohort count, parser/schema-pack identity, mapping generation and reviewed page revisions/raw hashes | UNRESOLVED |
| Mixed-root pilot acceptance receipt (enrolled + unenrolled + out-of-cohort) | PENDING |
| Current migration ledger and representative already-v142 upgrade/replay receipt | UNRESOLVED / PENDING |
| Ordinary/adapter/enrollment principals, approved grants/RLS/catalog pins | UNRESOLVED |
| Protected bootstrap/operator/host/review manifests, anchor paths and each SHA-256 | UNRESOLVED |
| Separate credential paths/hash references, directory owners/modes, lock/journal locations | UNRESOLVED |
| Installed helper/external-writer inventory with replace/coordinate/drain disposition | UNRESOLVED |
| Consistent DB/files/Git/journal/binding/manifest backup locations, hashes and restore rehearsal receipt | UNRESOLVED |
| Authorized window start/end, finite deadlines and evidence destination/custodian | UNRESOLVED |

The mixed-root receipt must show continuing sync and ordinary unenrolled writes in
the selected root, checked/enrollment denial outside the approved cohort, and root
operations constrained to explicitly approved roots. A selected page must not grant
implicit authority over every source/root on the host. Include negative out-of-cohort
cases and unchanged-target readbacks. Baseline mixed-writer tests do not close this
new pilot admission gate. No generic production/offline-mode escape hatch is allowed.

### 2. Finite future installation sequence — gated, not authorized here

1. Freeze the exact package and complete every field above. Obtain independent review
   of root scope and exact-candidate hosted proof. Any mismatch or missing receipt stops.
2. Record owner approval below for a finite installation/acceptance window. Separately
   identify the provisioning owner and enrollment/recovery operator; approval of an
   architecture or a passing CI run is not this authorization.
3. At an authorized safe point, drain only the enumerated writers/jobs. Capture and
   validate the consistent backup set and prove the rollback boundary before mutation.
4. Install only reviewed runtime, protected inputs and enumerated helper replacements;
   apply only the approved migration/grant plan. Read back exact hashes, owners/modes,
   roles/catalog and target identities. Do not re-pin drift or expose enrollment secrets
   to ordinary CLI/MCP/workers. Any unexpected difference leaves the service held.
5. Start/restart only explicitly approved units. Verify protected admission, then use
   the separate operator for exact approved enrollment and readback. Status exit zero
   alone is not readiness. No automatic enrollment or recovery is permitted.
6. Perform only the approved controlled fixture/readbacks: file/DB/revision agreement,
   stale rejection, truthful derived state, ordinary writes/continuing sync and mixed-root
   confinement. Capture authenticated tools/list with checked schemas and no remote
   recovery. If required, execute exact generic CLI recovery under its own approved
   original intent; baseline handler proof does not substitute for that receipt.
7. Preserve the evidence and request final owner acceptance. Publish availability or
   change tool allowlists only after separately authorized installed readback. Business
   content writes still require exact before/after approval; no automatic continuation.

### 3. Rollback and stop record

- Trigger: identity/hash/catalog/scope mismatch, failed readiness, unexpected bytes,
  uncoordinated writer, expired window or failed acceptance. Stop new checked writes;
  preserve pending intent, journals and diagnostic evidence without choosing a winner.
- Rollback executor, authority/window, exact prior artifact and hashes: **UNRESOLVED**.
- Previous-runtime compatibility with the resulting schema/bindings: **PENDING**.
  If absent, an application-only downgrade is forbidden; use an explicitly approved,
  rehearsed consistent DB + canonical files + Git + journal + manifest restore plan.
- Backup set, restore order, permitted data-loss boundary, timeout and target readback:
  **UNRESOLVED**. Do not delete bindings/journals, disable fences or run raw SQL to
  force recovery. Exact page recovery and root reconciliation are separate authorized
  operations; see the [operator runbook](page-file-operator.md#outcomes-and-existing-recovery).
- Terminal outcome receipt: **PENDING**. Record installed version/hashes, DB/file
  consistency, pending intents, ordinary service state and any continued HOLD. An exit
  code or restored binary alone does not prove rollback of data or operational safety.

### 4. Explicit owner decisions — all unresolved

```text
Package full SHA / artifact-manifest SHA-256: UNRESOLVED
Target/cohort manifest SHA-256: UNRESOLVED
Independent reviewer and accepted evidence/qualifications: UNRESOLVED
Release approver / provisioning owner / enrollment-recovery operator: UNRESOLVED
Allowed actions, exact fixture/original-intent hash, forbidden actions: UNRESOLVED
Window start/end, deadlines, rollback authority and plan hash: UNRESOLVED
Installation + controlled acceptance decision: HOLD — NOT AUTHORIZED
Approver identity / dated decision / immutable approval record: UNRESOLVED
Final installed acceptance and tool-publication decision: PENDING — NOT AUTHORIZED
Business-page before/after approval: NOT GRANTED
```

Any change of bytes, target, cohort, root scope or window invalidates the corresponding
approval and requires an explicit new decision. Documentation completion never flips
HOLD to GO. This task performs no deployment, provisioning, restart or live write.
