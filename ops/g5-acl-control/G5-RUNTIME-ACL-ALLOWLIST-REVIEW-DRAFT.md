# G5 runtime ACL allowlist review — static draft / NO-GO

Date: 2026-08-28
Source: three independent read-only source-code inventories
Decision: `gbrain_runtime NOBYPASSRLS`
Production mutation: none

## Aggregate

- Live catalog tables: 92
- Tables seen in runtime source paths: 81
- Static direct-ACL candidates: 67
- Sensitive tables requiring exact compatibility disposition and later hardening: 15 (14 source-review entries plus independently identified `config`)
- Catalog tables not seen in initial static runtime paths: 11
- Unseen tables classified at exact candidate SHA: 11/11
- Unseen-table dispositions: 10 NO GRANT; 1 SELECT-only (`migration_impact_log`)
- Recorded unknowns: 24

Static evidence is not behavioral proof. No table in this document is approved for GRANT or policy creation.

## Sensitive-table compatibility and later hardening

These sensitive tables require command-exact compatibility disposition; hardened routines remain the preferred subsequent security boundary:

- `access_tokens`
- `config`
- `mcp_request_log`
- `oauth_clients`
- `oauth_codes`
- `oauth_tokens`
- `portal_access_request_grants`
- `portal_access_requests`
- `portal_acl_audit`
- `portal_source_grants`
- `portal_users`
- `source_connector_configs`
- `source_connector_secret_audit`
- `source_connector_secrets`
- `source_connectors`

Current code directly accesses all fifteen through active/configurable core configuration, authentication, Portal, audit or source-ingest surfaces. Source analysis alone proves none disabled. The proposed release split permits temporary exact per-command direct ACLs in Stage 2 to preserve behavior, with no ownership/DDL/escalation and explicit residual-risk expiry; hardened routines remain a subsequent security release. This proposal is not accepted until `G5-RUNTIME-TEMPORARY-SENSITIVE-ACL-ACCEPTANCE-PACKAGE.md` receives explicit owner approval. A table may be excluded only after protected deployment evidence proves every caller disabled/unreachable.

Preferred long-term boundary for each path remains either:

1. a narrowly scoped, reviewed database routine/interface with exact EXECUTE ACL, owner, `SECURITY DEFINER` justification, fixed safe search path, body review and negative tests; or
2. proof that the feature and every caller/background path are disabled and unreachable in this deployment.

Secret retrieval remains special: a routine can hide table ACL but cannot prevent the connector execution process from receiving decrypted credentials. The final design requires a connector-specific secret-broker boundary or explicit residual-risk acceptance.

## Unseen catalog tables

These were not found in the three initial static runtime inventories.

Exact-candidate source trace provisionally classifies the following seven deployment-local/external Intake tables as **NO GRANT to `gbrain_runtime`** because no definition or runtime caller exists in the repository:

- `intake_batches`
- `intake_events`
- `intake_files`
- `intake_link_selections`
- `intake_new_objects`
- `intake_object_link_selections`
- `intake_review_items`

Protected deployment evidence confirms the enabled Postgres connector uses schema `gbrain` with allowlist `companies/departments/positions/employees`; no `intake_*` SELECT exception is configured. Any future allowlist change requires separate review.

The four system/migration tables were traced at candidate `718c04a56dd997147b49a5c9c8161b9265a5ef71`:

- `drift_decisions` — NO GRANT;
- `file_migration_ledger` — NO GRANT to normal runtime; migration/admin only;
- `migration_impact_log` — SELECT only to preserve trusted `gbrain onboard --history` under the current shared-principal topology; unwired INSERT excluded;
- `page_generation_clock` — NO table grant; runtime uses `page_generation_clock_seq` with provisional USAGE+SELECT.

The replacement exact trace supersedes the earlier advisory `ae9ce02c` result.

## Required next evidence

1. Reconcile static entries against actual service/feature enablement.
2. Trace all dynamic SQL and routine paths.
3. Review the current Stage 2 single-role union decision against deployment topology; any service-role split is a separate topology release.
4. Bind temporary sensitive-table compatibility commands to protected deployment modes and define the later hardened interfaces/expiry.
5. Independently review and approve the complete provisional 92-table command model and 49-sequence model.
6. Complete the extension routine/operator EXECUTE allowlist; generic EXECUTE ON ALL FUNCTIONS is prohibited.
7. Review the generated guarded command-specific ACL/RLS forward and inverse NOEXEC fragments.
8. Bind transaction rollback and approved full-DB-restore rollback; use diagnostic SQL inverse only for semantic rehearsal, and run the exact inverse verifier only after full restore.
9. Hosted PostgreSQL 16 tests prove every allowed and denied command and sensitive-table behavior.
10. Independent exact review and separate ACL GO.

## Artifacts

- Full evidence: `G5-RUNTIME-ACL-ALLOWLIST-STATIC-DRAFT.json`
- Human matrix: `G5-RUNTIME-ACL-ALLOWLIST-STATIC-DRAFT.csv`
- Reconciliation: `G5-RUNTIME-ACL-RECONCILIATION-20260828.md`
- Complete table model: `G5-RUNTIME-TABLE-COMMAND-MODEL-PROVISIONAL.json` / `.csv`
- Sequence model: `G5-RUNTIME-SEQUENCE-ACL-PROVISIONAL.json`
- Guarded forward/inverse evidence: `G5-RUNTIME-ACL-RLS-COMMAND-FRAGMENT-NOEXEC.sql.txt` / `G5-RUNTIME-ACL-RLS-COMMAND-INVERSE-NOEXEC.sql.txt`
- Role/ownership transfer and assembled S2: `G5-ROLE-OWNERSHIP-TRANSFER-FRAGMENT-NOEXEC.sql.txt` / `G5-ACL-S2-ASSEMBLED-NOEXEC.sql.txt`
- Extension routine/type model: `G5-RUNTIME-EXTENSION-EXECUTE-PROVISIONAL.json`
- Guarded routine/type forward/inverse: `G5-RUNTIME-ROUTINE-TYPE-ACL-FRAGMENT-NOEXEC.sql.txt` / `G5-RUNTIME-ROUTINE-TYPE-ACL-INVERSE-NOEXEC.sql.txt`
- Exact forward/inverse verifiers: `G5-RUNTIME-ACL-EXACT-POSTCONDITIONS-NOEXEC.sql.txt` / `G5-RUNTIME-ACL-EXACT-INVERSE-POSTCONDITIONS-NOEXEC.sql.txt`
- Approved owner acceptance package and receipt: `G5-RUNTIME-TEMPORARY-SENSITIVE-ACL-ACCEPTANCE-PACKAGE.md` / `G5-RUNTIME-TEMPORARY-SENSITIVE-ACL-ACCEPTANCE-RECEIPT.json`
- Hosted plan: `G5-RUNTIME-ACL-HOSTED-PG16-VALIDATION-PLAN.md`
- Production rollback blocker: `G5-ACL-CLUSTER-ROLE-AUTH-ROLLBACK-DRAFT.md`
- Extension upgrade procedure: `G5-EXTENSION-UPGRADE-GOVERNANCE-DRAFT.md`

Authorization: **NO-GO**.
