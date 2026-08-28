# G5 runtime ACL reconciliation — exact source evidence / PARTIAL / NO-GO

Date: 2026-08-28
Application candidate: `718c04a56dd997147b49a5c9c8161b9265a5ef71`
Mode: read-only source analysis; no production query or mutation
Authorization: none

## Status

- Seven previously unseen `intake_*` tables: source trace complete at exact candidate SHA.
- Four system/migration tables: replacement trace completed at exact candidate SHA; the older `ae9ce02c` result remains advisory only.
- Fifteen sensitive tables (including `config`): command/service trace complete at exact candidate SHA; exact owner acceptance/expiry is approved and receipted.
- Production configuration/topology evidence remains required before generating executable grants.

## Seven unseen Intake tables

Tables:

- `intake_batches`
- `intake_events`
- `intake_files`
- `intake_link_selections`
- `intake_new_objects`
- `intake_object_link_selections`
- `intake_review_items`

Exact-source findings:

- None is defined in `src/schema.sql` or `src/core/migrate.ts` at candidate SHA.
- No exact literal or historical `-S` caller was found.
- No checked-in persistent/worker/ingest write path requires these tables.
- Generic PostgreSQL source-ingest can dynamically read an explicitly configured table, but is read-only and uses the connector identity/DSN; that does not justify general `gbrain_runtime` DML.
- R1 catalog-wide fence DDL and historical auto-RLS DDL may discover these tables; migration-owner DDL discovery is not a runtime data privilege.

Protected read-only deployment evidence (`G5-RUNTIME-SERVICE-MODE-READONLY-20260828.json`) confirms the only enabled Postgres connector uses schema `gbrain` and allowlists only `companies`, `departments`, `positions`, and `employees`; none of the seven `intake_*` tables is configured. Canonical disposition for all seven is therefore deployment-backed with high confidence:

`gbrain_runtime`: **NO GRANT**.

Exception gate: if protected deployment configuration proves that a same-database Postgres source connector explicitly allowlists one of these objects, grant `SELECT` only to the connector execution identity—not general runtime DML—after separate exact review.

Core citations: `src/commands/r1-governed-migrate.ts:552-561`; `src/core/r1-governed-migration.ts:230-254`; `src/core/migrate.ts:1646-1747`; `src/core/source-ingest/connectors/postgres.ts:34-42,45-65,69-123,175-195`; `src/core/source-ingest/executor.ts:731-824`.

## Four system/migration tables

Exact-candidate dispositions:

| Table | Runtime table commands | Disposition |
|---|---|---|
| `drift_decisions` | none | migration-owned dormant schema; NO GRANT |
| `file_migration_ledger` | none | migration/admin-only; NO persistent/worker/ingest grant |
| `migration_impact_log` | SELECT | preserve `gbrain onboard --history` because current trusted CLI shares the deployed DB principal; unwired INSERT is excluded |
| `page_generation_clock` | none | legacy migration substrate; runtime uses `page_generation_clock_seq` instead |

Sequence implications:

- `drift_decisions_id_seq`: NO GRANT while writer remains dormant.
- `migration_impact_log_id_seq`: NO GRANT while INSERT helper remains unwired.
- `page_generation_clock_seq`: runtime `USAGE + SELECT` for trigger `nextval()` and query-cache `last_value` reads.

Core citations: `src/core/migrate.ts:2033-2162,4663-4706,4861-4922,5275-5329`; `src/commands/migrations/v0_18_0-storage-backfill.ts:73-169`; `src/commands/onboard.ts:37-42,58-97`; `src/core/search/query-cache-gate.ts:100-190`; `src/schema.sql:226-254`; `src/cli.ts:1931-1935`.

## Fifteen sensitive tables

Deployment evidence confirms `GBRAIN_PORTAL_ACL_MODE=db` on active persistent/worker services and three enabled source connectors. Portal and connector tables therefore do not qualify as disabled-feature exclusions.

### Source-security recommendation

The source review initially identified fourteen tables; independent review correctly added `config` because table ACL cannot separate operational checkpoints from security/policy/credential-like keys. The source review recommended:

- command-exact temporary direct ACLs to preserve current behavior;
- hardened routine/key-namespace boundaries as the mandatory follow-up;
- zero feature exclusions, because configurable/default-off behavior is not deployment proof.

### Stage 2 compatibility disposition

The already accepted release split takes precedence for the first role transition:

- Stage 2 must preserve current Avers behavior using exact per-table/per-command grants where the deployed feature is active;
- no runtime ownership, role membership, database/schema CREATE, TRIGGER, TRUNCATE, REFERENCES, grant option, or DDL;
- hardened OAuth/Portal/connector-secret routines remain a subsequent security release and receive explicit residual-risk/expiry tracking;
- any feature proven disabled by protected deployment evidence may instead be excluded.

Therefore no broad sensitive-table exclusion or broad grant is generated from source evidence alone.

| Table | Exact current commands | Source-security recommendation | Stage 2 provisional disposition |
|---|---|---|---|
| `access_tokens` | SELECT, INSERT, UPDATE | temporary exact direct ACL | same commands if legacy bearer/admin auth path active |
| `mcp_request_log` | INSERT; admin SELECT | temporary exact direct ACL | INSERT + SELECT if persistent/Admin share runtime identity |
| `config` | SELECT, INSERT, UPDATE, DELETE | key-namespace hardening required | temporary exact commands only under explicit acceptance/expiry |
| `oauth_clients` | SELECT, INSERT, UPDATE; CLI DELETE exists in source | temporary exact direct ACL | SELECT/INSERT/UPDATE only; CLI DELETE belongs governed admin path and is excluded from runtime |
| `oauth_codes` | SELECT, INSERT, DELETE | temporary exact direct ACL | same for active OAuth HTTP service |
| `oauth_tokens` | SELECT, INSERT, DELETE | temporary exact direct ACL | same for active OAuth HTTP service |
| `portal_users` | SELECT, INSERT, UPDATE | hardened routine preferred | temporary exact commands under accepted compatibility risk |
| `portal_source_grants` | SELECT, INSERT, UPDATE, DELETE | hardened routine preferred | temporary exact commands; no ownership/DDL; audit/version behavior tested |
| `portal_access_requests` | SELECT, INSERT, UPDATE | hardened routine preferred | temporary exact commands |
| `portal_access_request_grants` | SELECT, INSERT, UPDATE | hardened routine preferred | temporary exact commands |
| `portal_acl_audit` | INSERT, SELECT | hardened routine preferred | append/read only; no UPDATE/DELETE |
| `source_connector_configs` | SELECT, INSERT, UPDATE | temporary exact direct ACL | same for active Admin/worker surfaces; no DELETE |
| `source_connector_secret_audit` | SELECT, INSERT | temporary exact direct ACL | append/read only |
| `source_connector_secrets` | SELECT, INSERT, UPDATE, DELETE | hardened routine preferred | temporary exact commands only if connector execution/rotation active; highest residual risk |
| `source_connectors` | SELECT, INSERT, UPDATE, DELETE | temporary exact direct ACL | deployed Admin/runtime commands only |

## Service-surface evidence

- Persistent HTTP/OAuth/MCP: auth/token tables and request log; read connector config/catalog/audit.
- Source-Ingest worker: connector config read and secret retrieval.
- Portal authority: user/grant/request/audit transaction set.
- Trusted CLI/Admin: management commands; must not be conflated with anonymous remote MCP authority.
- Migration owner: schema/migration/import/export paths do not justify runtime grants.

Key citations:

- `src/commands/auth.ts:69-181,304-324,406-450`
- `src/commands/serve-http.ts:679-700,3820-3886,5044-5163`
- `src/core/oauth-provider.ts:198-339,434-560,579-835,882-976,1078-1123`
- `src/mcp/http-transport.ts:193-242`
- `src/core/portal-access-control.ts:119-180,240-258,314-586`
- `src/core/portal-access-control-authority.ts:19-22,76-127`
- `src/core/connector-config.ts:93-171,219-270,358-435`
- `src/core/source-ingest/executor.ts:761-766`
- `src/core/source-ingest/source-fetch.ts:39-74`
- `src/core/operations.ts:3037-3233`

## Remaining gates before canonical grant generation

1. Target-role binding package. Current read-only census proves deployed application sessions share legacy `gbrain`; Stage 2 therefore uses one command-union `gbrain_runtime` unless a separately reviewed service-role split is introduced. Feature-mode evidence confirms Portal DB authority and connector catalog active.
2. Complete exact extension routine/operator allowlist; table and sequence inventories are now complete provisionally.
3. Review the generated 92-table command union and 49-sequence model; any future service-role split is a separate topology change.
4. Independently review the generated guarded NOEXEC ACL/RLS forward/inverse fragments, convert only after approval to an executable package, and prove it with hosted positive/negative command tests.
5. Explicit residual-risk owner acceptance and expiry for temporary sensitive direct access using `G5-RUNTIME-TEMPORARY-SENSITIVE-ACL-ACCEPTANCE-PACKAGE.md`.
6. Independent exact review and separate literal ACL GO.

Target-role scope correction: destructive local CLI commands `oauth_clients DELETE`, `calibration_profiles DELETE` (`calibration --undo-wave`) and `eval_candidates DELETE` (`eval prune`) are excluded from `gbrain_runtime`; they require a separately governed admin path. Read-only `migration_impact_log SELECT` remains the only trusted CLI compatibility exception.

Further exact review corrections: `takes DELETE` and migration-only `timeline_entries DELETE` are excluded; active protected worker `unify-types` requires `slug_aliases INSERT` plus `slug_aliases_id_seq USAGE`, while alias DELETE remains governed maintenance-only.

Rollback contract follows the approved G5-B posture: transaction rollback is exact before commit; after commit the sole exact rollback is full database restore. Generated SQL inverse files are diagnostic semantic rehearsal only and are not authorized release rollback artifacts. The exact inverse verifier applies only after full database restore.

Production ACL mutation: **NO-GO**.

Generated evidence artifacts:

- `G5-ROLE-OWNERSHIP-TRANSFER-FRAGMENT-NOEXEC.sql.txt` — exact role creation/membership, superuser-bound event-trigger object transfer, `REASSIGN OWNED`, legacy seal and DB/schema ACL transition; SHA-256 `30de2e1e3cbd4d08a464c5cca9adc4f84b300e186a19b8d283160275579e05fa`.
- `G5-RUNTIME-ACL-RLS-COMMAND-FRAGMENT-NOEXEC.sql.txt` — 82 exact table grants, 237 command policies, 46 sequence grant statements, explicit baseline revokes; SHA-256 `642c9c6f8d07a4f90924a247cbb14fe098f5c1b3f92c0d819138dab655a8767c`.
- `G5-RUNTIME-ACL-RLS-COMMAND-INVERSE-NOEXEC.sql.txt` — diagnostic semantic inverse only, not authorized rollback; SHA-256 `c3c461bba0f4584840656d22ced47eaed895570a06482d576264440a6bee7b70`.
- `G5-RUNTIME-ROUTINE-TYPE-ACL-FRAGMENT-NOEXEC.sql.txt` / inverse — exact `postgres` superuser forward; revoke PUBLIC EXECUTE on 113 routines, grant four provisional exact runtime signatures and two extension types, set function/type default ACLs for both object creators; diagnostic inverse only; SHA-256 `f7060054725bf7941a00e83eda0ccbefb0d7aaaa02691770ac4bc1491f7c1bca` / `cabf1da1ac5af4c2f97189507a3188fc455014b74e8b350dffe6716238f0d1d0`.
- `G5-RUNTIME-ACL-EXACT-POSTCONDITIONS-NOEXEC.sql.txt` — exact catalog/owner/ACL/grantor/grantee/grant-option/default/column/policy/role/index/extension-member/full-trigger closure; SHA-256 `8ea7680fe092ffd015c2acc9267e4435b30d0592e7ab2d65ddafd989d3d8c923`.
- `G5-RUNTIME-ACL-EXACT-INVERSE-POSTCONDITIONS-NOEXEC.sql.txt` — exact verifier after full database plus cluster-role/auth restoration with a new controlled recovery credential; SHA-256 `7cfa65a457afa7132eabc58832d9cdb4daee96c505ad75297bd13d7a5dc49e33`.
- `G5-ACL-S2-ASSEMBLED-NOEXEC.sql.txt` — component-manifest-verified deterministic one-transaction assembly of the four forward fragments; SHA-256 `49964aaa2a87edf8bd478b4a1c116f53287c566dce28cf5b29c9724355d37679`.

Every generated SQL evidence file begins with `\set ON_ERROR_STOP on` and a deliberate exception before candidate SQL, preventing false-success execution under `psql`. They may not be stripped of the guard without a new hash, review and authorization cycle.

The historical `G5-RLS-RUNTIME-COMPAT-ALL92-BASELINE-NOEXEC.sql.txt` and inverse are superseded, unsafe-to-execute evidence and are excluded from the current candidate manifest. They are not generated candidate SQL and must never enter S2.
