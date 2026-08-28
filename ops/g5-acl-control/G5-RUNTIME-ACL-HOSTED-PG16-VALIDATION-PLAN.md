# G5 ACL hosted PostgreSQL 16 validation plan — DRAFT / NOEXEC

Candidate application SHA: `718c04a56dd997147b49a5c9c8161b9265a5ef71`
ACL control binding: supplied externally from the exact `G5-ACL-DRAFT-SHA256SUMS` bytes and recorded in the run receipt; this plan does not self-embed the manifest hash.
Local PostgreSQL execution: prohibited
Production execution: prohibited

## Immutable hosted substrate

- PostgreSQL service: hosted GitHub Actions only, disposable loopback container/volume.
- Hosted ACL service image: `pgvector/pgvector:0.6.0-pg16@sha256:b740286128ce8e232fe0de3c8db2267d91aedc598dfbeaefb7ffb0b79ceef1b3`.
- Job must query and bind `server_version_num`, extension versions and image digest before applying fixtures.
- Required production extension versions: `pg_trgm=1.6`, `pgcrypto=1.3`, `vector=0.6.0`. Any mismatch fails before ACL mutation; do not silently test a different catalog.

## Fixture

1. Create baseline application schema from exact candidate source under the legacy owner.
2. Create the eleven production catalog-only tables as explicit test fixtures with matching names and representative DML-safe columns; no production data.
3. Assert exact baseline closure: 92 tables, 49 sequences, 113 public routines, 190 public types, zero policies/default ACLs/explicit relation/routine/type ACLs.
4. Execute the bound `G5-ACL-S2-ASSEMBLED-NOEXEC.sql.txt` after the hosted harness validates hashes and removes only its deliberate guard. This must first transfer the event-trigger object to the exact `postgres` superuser (PostgreSQL forbids a non-superuser event-trigger owner), then exercise the real role creation, membership and `REASSIGN OWNED BY gbrain TO gbrain_migration_owner` path for the remaining objects—including the event-trigger function—not a fixture that directly creates the target end state.
5. Verify extension owners/member owners, exact routine signature owners, database/schema ownership, explicit/default/column ACL tuples and application routine owners before and after ACL changes.

## Positive tests

- Every modeled table command succeeds under `gbrain_runtime` inside per-test rollback transactions.
- All 44 serial sequences support omitted-id INSERT via USAGE, without UPDATE/setval.
- `page_generation_clock_seq` supports `nextval` through page trigger and direct `last_value` read.
- Portal identity/grant/audit triggers execute although runtime lacks direct trigger-function EXECUTE.
- Page/chunk search-vector and minion notification triggers execute.
- `similarity(text,text)` and indexed `%` pg_trgm paths work.
- `<=>` HNSW/vector search works.
- `access_tokens` omitted-id INSERT invokes `public.gen_random_uuid()`.
- Protected worker `unify-types` inserts `slug_aliases` and consumes `slug_aliases_id_seq` USAGE.
- Exact forward postcondition verifier passes.

## Negative tests

- All ten denied tables reject every SELECT/INSERT/UPDATE/DELETE command.
- All unmodeled commands on the other 82 tables fail with expected SQLSTATE.
- `oauth_clients`, `calibration_profiles`, `eval_candidates`, `takes` and `timeline_entries` DELETE fail under runtime.
- Runtime cannot TRUNCATE, TRIGGER, REFERENCES, ALTER, CREATE, SET ROLE, own objects or use sequence UPDATE/setval.
- Non-allowlisted pgcrypto/trigram/vector direct calls fail.
- Runtime cannot directly execute any of the nine application trigger/event-trigger functions.
- PUBLIC and non-runtime-role effective privileges match the exact expected matrix.
- New/unexpected table/sequence/routine/type causes catalog-closure failure.

## Rollback tests

1. Before commit: forced failure rolls back role/ownership/ACL/default-ACL/policy changes exactly in the same transaction.
2. Diagnostic SQL inverse may be exercised only as semantic evidence; it is not accepted as release rollback.
3. Post-commit exact rollback: terminate sessions; drop the disposable `gbrain` database; run the bound hosted cleanup fragment from maintenance database `postgres` to drop target roles and recreate the legacy role with exact non-secret defaults; temporarily elevate the synthetic legacy role only for logical restore because PostgreSQL requires the restored event-trigger owner to be a superuser; restore the full database; immediately seal the role `NOSUPERUSER`; reconstruct and attest extension-container owner dependencies not represented by logical dump; issue a fresh synthetic recovery credential; then run `G5-RUNTIME-ACL-EXACT-INVERSE-POSTCONDITIONS-NOEXEC.sql.txt` after removing its guard in the bound hosted harness.
4. Compare restored database/schema/catalog/ACL/role/extension/trigger receipts byte-for-byte to baseline inventory. Production remains blocked on the protected real verifier/HBA/service-auth restoration mechanism described in `G5-ACL-CLUSTER-ROLE-AUTH-ROLLBACK-DRAFT.md`.

## Required receipt

- candidate SHA/tree;
- ACL binding SHA;
- workflow/run/attempt;
- container image digest and extension versions;
- exact forward/inverse verifier hashes;
- positive/negative case counts and SQLSTATEs;
- full-restore identity result;
- `production_db_or_services_touched=false`;
- no credentials or DSNs.

No workflow/commit/run is authorized until the current exact package passes fresh independent technical review.
