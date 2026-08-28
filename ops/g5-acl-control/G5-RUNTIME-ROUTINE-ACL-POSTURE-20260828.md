# G5 runtime routine ACL posture — read-only / provisional / NO-GO

Date: 2026-08-28
Candidate: `718c04a56dd997147b49a5c9c8161b9265a5ef71`
Production mutation: none

## Live catalog

- Public routines: 113
- Owner `postgres`: 104 (primarily extension surfaces)
- Owner legacy `gbrain`: 9 application routines
- SECURITY DEFINER: 0
- Explicit routine ACL: 0
- Effective default PUBLIC EXECUTE: 113
- Routine-level configured `search_path`: 0
- User triggers: 8
- Event triggers: 1

Evidence:

- `G5-RUNTIME-ROUTINES-CATALOG-READONLY.tsv`
- `G5-RUNTIME-TRIGGER-ROUTINE-DEPENDENCIES-READONLY.tsv`

## Application-owned routines

- `auto_enable_rls()` — enabled `ddl_command_end` event trigger; migration/DDL surface.
- `bump_page_generation_clock_fn()` — pages trigger.
- `bump_page_generation_fn()` — pages trigger.
- `notify_minion_job_change()` — minion jobs trigger.
- `portal_acl_audit_append_only()` — Portal audit guard trigger.
- `portal_acl_guard_personal_grant()` — Portal grant invariant trigger.
- `portal_acl_guard_user_identity()` — Portal identity invariant trigger.
- `update_chunk_search_vector()` — content chunk trigger.
- `update_page_search_vector()` — pages trigger.

All are SECURITY INVOKER. They are invoked through pre-existing trigger/event-trigger bindings; trigger execution does not justify a generic direct runtime EXECUTE grant. Ownership must transfer to `gbrain_migration_owner`. Direct PUBLIC EXECUTE should be removed unless a separately reviewed direct call exists.

## Extension routines

The 104 extension routines must not be handled with `EXECUTE ON ALL FUNCTIONS`. Exact source/operator/default tracing produced this provisional runtime allowlist:

- `similarity(text,text)` — direct pg_trgm fuzzy SQL;
- `similarity_op(text,text)` — backing procedure for `%`;
- `cosine_distance(vector,vector)` — backing procedure for `<=>`;
- `public.gen_random_uuid()` — runtime `access_tokens` INSERT uses the database default.

Type USAGE candidates: `vector`, `gtrgm`. All other extension routines are denied direct runtime EXECUTE provisionally. Ownership disposition remains: `vector` admin-owned; `pg_trgm`/`pgcrypto` transfer only through the reviewed topology package.

Hosted PostgreSQL 16 must prove that GIN/HNSW operator-class support still works after PUBLIC EXECUTE revoke and that negative direct calls to non-allowlisted crypto/vector/trigram routines fail. Exact evidence: `G5-RUNTIME-EXTENSION-EXECUTE-PROVISIONAL.json` and the guarded routine/type forward/inverse fragments.

The forward fragment requires exact `session_user=current_user=postgres` with superuser authority, then attests: nine application routines owned by `gbrain_migration_owner`; 104 extension-member routines owned by `postgres`; extension owners `pg_trgm/pgcrypto → gbrain_migration_owner`, `vector → postgres`. Default PUBLIC function/type privileges are revoked for both `gbrain_migration_owner` and `postgres` in `public`, covering future migration-owner objects and admin-owned vector upgrades.

## Provisional ACL rules

- `gbrain_runtime`: no direct EXECUTE on the nine application trigger/event functions unless a direct caller is proven.
- `gbrain_migration_owner`: owns application routines and trigger definitions.
- PUBLIC: revoke application routine EXECUTE in the generated package after hosted trigger behavior proof.
- Extension routines: four-signature provisional allowlist; executable conversion blocked until exact review and hosted opclass/default-expression proof.
- Rollback: transaction rollback before commit; approved full database restore after commit. Routine/type SQL inverse is diagnostic semantic rehearsal only.

Authorization: **NO-GO**.
