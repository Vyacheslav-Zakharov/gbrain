# Page-file effective SQL authority — offline provisioning contract

Status: read-only validator candidate, **not runtime admission or production authorization**.
No runtime, migration, existing role, policy or grant is changed by this module.
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

## Approved mixed ordinary-writer allowlist (finite inventory)

All principals: CONNECT, public USAGE; SELECT sources, pages, page_file_bindings,
config. No table privileges outside the following additions on the finite list.

| Principal | Additions |
|---|---|
| ordinary | SELECT/INSERT/UPDATE/DELETE sources, pages, config, tags, timeline_entries, content_chunks, page_versions, code_edges_chunk, code_edges_symbol; SELECT-only page_file_bindings; no page_file_operations or page_file_write_authorizations privileges |
| adapter | UPDATE pages; SELECT tags, timeline_entries, code_edges_chunk, code_edges_symbol; SELECT/INSERT/UPDATE/DELETE content_chunks; SELECT/INSERT page_versions; SELECT/INSERT/UPDATE page_file_operations; SELECT/INSERT/DELETE page_file_write_authorizations; UPDATE sources(id); UPDATE page_file_bindings(pending_op_id,indexed_raw_sha256,file_generation) |
| enrollment | UPDATE sources(id), pages(id); INSERT page_file_bindings; SELECT tags |

Ordinary and adapter have USAGE on page_generation_clock_seq. Both have
USAGE/SELECT on serial id sequences for content_chunks, page_versions and
timeline_entries. Ordinary additionally has USAGE/SELECT on serial id sequences
for pages, tags, code_edges_chunk and code_edges_symbol (adapter has none).
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

Hosted follow-up: execute the probes against the existing disposable role fixture;
then alter one condition at a time: PUBLIC/direct/column grants, membership chain,
SET-only membership, grant options, relation/function owner, trigger disabled/body
changed, extra permissive policy, RLS disabled, missing table/sequence and credential
identity mismatch. Include fresh schema and representative v142 upgrade/replay.
Verify rollback and exact target read-back for each fixture mutation. The mixed-writer fixture additionally executes ordinary page/chunk CRUD, enrolls
through the operator login, and asserts exact unchanged protected rows after
body/identity/deletion/chunk/root attacks and capability/SET ROLE/DDL denials.
The dedicated hosted workflow already executes this fixture with its required flag.
A skipped local run is discovery only, not PostgreSQL acceptance. Do not bypass
the validator to make integration green. No live/local PostgreSQL or container was
used for this offline slice.

## Finite scope and exclusions

The inventory is exactly twelve tables and eight sequences used by the mixed-writer
hosted role fixture plus their policies/constraints/triggers/functions, database and
public schema. This is not a whole-database privilege audit. Unrelated callable
SECURITY DEFINER functions, extensions, foreign servers, other schemas, server
configuration and external DBA powers remain the deployment's separate trust
boundary; success does not claim their safety. No provisioning DDL is included:
actual installation/revocation and independent pin approval require operator review.
