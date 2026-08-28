# G5 PostgreSQL role separation runbook — DRAFT / NO-GO

Status: DRAFT, non-authorizing
Date: 2026-08-28
Depends on: `ACL-TOPOLOGY-READONLY-20260828.md`
Production mutation performed by this draft: none

Decision supersession: the topology report accurately records why a non-owner without policies would lose access, but its preliminary “runtime must retain BYPASSRLS” conclusion is superseded by the owner decision in this runbook: `gbrain_runtime NOBYPASSRLS` plus an exact command-specific compatibility-policy package.

## Objective

Separate PostgreSQL authority into:

1. `gbrain_migration_owner` — NOLOGIN owner of the database/application objects and R1 fence authority.
2. `gbrain_migrator` — LOGIN, NOINHERIT execution role with no reusable password. PostgreSQL allows it to `SET ROLE gbrain_migration_owner`; launcher exclusivity is enforced externally by a dedicated OS identity and ordered Unix-socket peer/ident rules.
3. `gbrain_runtime` — LOGIN, non-owner application role with exact runtime DML/EXECUTE grants, no ownership, no schema/database CREATE, and no direct or transitive membership path to owner/migrator.

The role graph alone cannot authenticate the governed launcher. Possession of a password-bearing migrator credential would equal owner authority, so a reusable migrator password is prohibited. Proposed boundary: dedicated OS account `gbrain-migrator` with locked password, `/usr/sbin/nologin`, no SSH keys, no user cron, no writable home and no interactive sudo; local Unix socket only; exact `pg_ident` mapping; explicit HBA denial on TCP and for every other OS identity; and a root-owned system service whose fixed `ExecStart` has no arbitrary operator-supplied phase/command path. Runtime service identities must be unable to assume, invoke or write any dependency of that account/service. Final rules require admin topology, OS reachability proof and independent review.

## RLS compatibility contract

All 92 current tables have RLS enabled, no FORCE RLS, and zero policies. The approved direction is `gbrain_runtime NOBYPASSRLS` plus a separate exact, generated and reviewed RLS-policy compatibility package.

The compatibility policies are role-scoped and do not grant table privileges. Exact table/sequence/routine ACL allowlists remain the privilege boundary. Any temporary permissive allow-all compatibility policy must have an explicit expiry/review date and must not become permanent. While it exists, any new row restriction must be `RESTRICTIVE` or replace the compatibility policy in a separately reviewed release; adding a permissive policy would OR with allow-all and provide no restriction.

## Hard gates

No ACL mutation until all pass:

- [ ] admin-only topology completed, including ordered HBA/ident rules and shared-object ownership;
- [ ] approved executor proven PostgreSQL superuser (required for BYPASSRLS role creation/alteration);
- [x] application prerequisite release `718c04a56dd997147b49a5c9c8161b9265a5ef71` disables automatic DDL under runtime mode and fails closed on pending/untrusted schema watermark; hosted run `33190352938` passed;
- [x] runtime pending-migration probe proven read-only before its decision by exact-SHA hosted PostgreSQL 16 validation;
- [ ] peer/ident dedicated-OS-identity package exact, rollback-tested and independently reviewed;
- [x] exact candidate SHA `718c04a56dd997147b49a5c9c8161b9265a5ef71` and hosted PostgreSQL tests pass; receipt SHA-256 `8dbb75a67ef576024797a97f11957bd05005f42511bad2975847fe5ac732022f`;
- [ ] generated ownership/ACL SQL and inverse rollback SQL independently reviewed;
- [ ] encrypted backup/rollback credential package recovery-tested;
- [ ] maintenance window and writer-stop plan approved;
- [ ] literal ACL GO binds candidate SHA, topology hash, SQL-package hash, HBA/ident package, launcher/control bytes, application prerequisite SHA, secret-delivery procedure, run ID, residual-risk expiry and rollback-package hash.
- [ ] exact NOBYPASSRLS compatibility-policy SQL and inverse package generated from the same topology, hosted-tested, hash-bound and independently reviewed;

A G5 migration GO does not authorize this ACL runbook. ACL GO is separate.

## Phase A — finish read-only admin topology

Run as an authenticated PostgreSQL administrator with `default_transaction_read_only=on` and record value-free evidence:

- identity, database/schema owners and approved superuser executor;
- exact ordered `pg_hba_file_rules` and `pg_ident` mappings;
- complete recursive role-membership graph and membership options;
- role/database settings from `pg_db_role_setting`;
- database/schema/table/view/sequence/routine/type/extension owners;
- explicit ACL rows including grantor, grantee and grant options;
- default ACLs by owner/schema/object type;
- RLS flags/policies;
- complete `pg_proc` identity signatures, `prokind`, owner, ACL, `prosecdef` and `search_path` posture;
- sequence-column dependencies and exact runtime sequence operations;
- materialized/partitioned/foreign tables, types/domains, large objects, publications/subscriptions, event triggers and FDW/server objects, even if zero;
- extension ownership, membership and upgrade requirements;
- all objects/shared objects owned by legacy `gbrain` outside database `gbrain`;
- all live and dormant credential consumers, jobs, ingest paths and manual tools;
- exact SCRAM/runtime credential-delivery mechanism without log/history exposure.

Do not include password hashes, URLs, SQL text or secrets in receipts.

## Phase B — application prerequisite release

Status: **COMPLETE AS A CODE/HOSTED ARTIFACT; NOT DEPLOYED TO PRODUCTION.** Canonical evidence: `G5-STAGE1-EXACT-SHA-EVIDENCE.json`. Exact commit `718c04a56dd997147b49a5c9c8161b9265a5ef71`, tree `b2b0eb03230ac447cf1b3d7cad8fa18468ae2e8d`, hosted run `33190352938`, full gate success with `r1-fence-lift-postgres=success`.

Ship an exact-SHA application release with two modes:

- **runtime mode:** never applies DDL. If migration is pending, startup fails closed.
- **migration mode:** explicit command only under dedicated OS identity, peer-authenticated as `gbrain_migrator`, then `SET ROLE gbrain_migration_owner` before any DDL-capable code path.

The runtime pending-migration check must create no migration tables, lock tables, extensions, advisory migration setup, schema repair or other DDL before deciding.

Required hosted tests:

- runtime starts and performs representative reads/writes with no pending migration;
- runtime fails on pending migration with zero DDL;
- concurrent service startup and probe paths remain read-only;
- runtime cannot CREATE/ALTER/DROP/TRUNCATE, disable/drop triggers, replace functions or SET ROLE owner/migrator;
- runtime cannot bypass R1 fence after setting the custom GUC and acquiring advisory lock `7671003001`;
- migrator before SET ROLE cannot mutate owner objects;
- migrator after SET ROLE can execute exact migration and rollback;
- no TCP/password path authenticates `gbrain_migrator`;
- another OS identity cannot peer-map to `gbrain_migrator`;
- receipts record `current_user` and `session_user` without credentials.

## Writer-fence authority

The fence function must be exact and hash-bound:

- owned by `gbrain_migration_owner`;
- `SECURITY INVOKER` (`prosecdef=false`), never SECURITY DEFINER for a `current_user` predicate;
- bypass predicate authorizes only `current_user = 'gbrain_migration_owner'`;
- schema-qualified objects and fixed safe `search_path` posture;
- exact function body/trigger definitions and owners attested.

Tests must prove runtime and migrator-before-SET-ROLE are denied; migrator-after-SET-ROLE passes. A SECURITY DEFINER version would make `current_user` equal the function owner for every caller and is prohibited.

## Phase C — generate exact SQL package (still no mutation)

Generate, do not hand-write, an exact package containing:

1. role attributes and membership options;
2. database/schema/application ownership transfer;
3. exact runtime database/schema/table/sequence/routine grants;
4. removal of unintended grants from all roles and PUBLIC;
5. default privileges issued **for `gbrain_migration_owner`**;
6. extension-level disposition;
7. exact postcondition queries;
8. enumerated inverse rollback package.

Illustrative role shape only:

```sql
CREATE ROLE gbrain_migration_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE gbrain_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
CREATE ROLE gbrain_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
GRANT gbrain_migration_owner TO gbrain_migrator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
```

Never place passwords in SQL files, argv, receipts, shell history, Markdown, process environment, `pg_stat_activity` or client history. Runtime secret delivery needs a separately reviewed protected mechanism. Migrator has no password.

Package requirements:

- exact bounded `ALTER ... OWNER` list for independently ownable objects plus topology-bounded `REASSIGN OWNED BY gbrain TO gbrain_migration_owner` where required to transfer PostgreSQL-16 extension ownership. Cluster-wide discovery must prove legacy `gbrain` owns no object in another database before S2. Discovery of any such object aborts this package pending a separately reviewed cross-database state machine; this single-database transaction may not attempt cross-database reassignment;
- distinguish independent objects from dependent indexes/triggers;
- revoke existing unwanted PUBLIC EXECUTE;
- globally revoke hard-wired PUBLIC function/type defaults for both exact object-creator roles (`gbrain_migration_owner`, `postgres`); PostgreSQL schema-specific defaults are additive and cannot subtract the global defaults;
- exact runtime routine signatures only; generic EXECUTE ON ALL FUNCTIONS is prohibited;
- exact schema USAGE, table DML, and sequence USAGE/SELECT/UPDATE only as behavior proves necessary;
- omit runtime TRUNCATE, TRIGGER, REFERENCES, database/schema CREATE, grant options and all owner membership;
- default table privileges omit TRUNCATE/TRIGGER/REFERENCES;
- exact before/after ACL rows include grantor/grantee/grant options;
- PostgreSQL-16 membership syntax is parse-tested and `admin_option`, `inherit_option`, and `set_option` are read back exactly;
- transfer `pg_trgm` and `pgcrypto` through the reviewed topology-bounded `REASSIGN OWNED` package; distinguish extension ownership from extension-member object dependencies in postconditions;
- keep `vector` intentionally admin-owned unless exact review approves otherwise;
- if `public` remains owned by `pg_database_owner`, prove the new database owner is its effective owner rather than requiring `pg_namespace.nspowner` to equal the named role.

## Phase D — fail-closed cross-plane state machine (literal ACL GO required)

Every transition writes an independently protected value-free checkpoint. No step may infer success from process exit alone.

### S0 — staged, inactive

- Verify exact SHA/manifests/backups, SQL/inverse packages, launcher and no unrelated migration.
- Create dedicated OS identity and stage root-owned launcher, HBA/ident and service/config files at inactive paths.
- Validate ownership/modes, parser/config syntax, exact first-match HBA behavior and inverse files without reload or service switch.
- Failure recovery: remove staged files/account only through exact inverse package; production remains unchanged.

### S1 — writers stopped and authority re-attested

- Stop all GBrain DB writers; Autopilot remains HOLD.
- Prove no unexpected configured/dormant writer remains.
- Acquire ACL coordination lock, then re-attest exact topology, current owners/ACL/default ACLs, pending-migration state, legacy sessions and package hashes.
- Any mismatch returns to containment with writers stopped; do not apply SQL.

### S2 — one atomic database transaction

Run the exact SQL package with `psql -X -v ON_ERROR_STOP=1 --single-transaction` (or equivalent proven transaction wrapper). The same transaction must:

1. verify transaction/backend identity and coordination lock;
2. re-check every bounded precondition;
3. create roles and parse-tested PostgreSQL-16 membership options;
4. perform reviewed ownership/extension transfer;
5. apply explicit/default ACL changes;
6. apply the exact command-specific RLS compatibility fragment generated from the same canonical runtime ACL allowlist and attest its canonical allowlist hash;
7. remove legacy `gbrain` ownership, grants, default ACLs, memberships, CREATE and role/database settings;
8. execute `ALTER ROLE gbrain NOLOGIN NOINHERIT NOBYPASSRLS PASSWORD NULL`;
9. request termination of legacy sessions using the approved admin mechanism;
10. execute all database postcondition queries and abort unless every result is exact.

No canary write occurs while legacy `gbrain` remains login-capable. Transaction failure rolls back transactional role/ownership/ACL changes; backend termination is an intentional non-transactional side effect and is not described as rolled back. Writers remain stopped and S0 auth files remain inactive.

### S2-seal — fresh committed-state attestation

After S2 commits and before S3, open a fresh administrator connection and re-attest committed role attributes, `rolpassword IS NULL`, memberships/options, database/schema/object/extension ownership, explicit/default ACLs, the exact `(schema,table,policy,command,role,qual,with_check)` set and cluster-wide legacy residue. Re-terminate and read back any legacy session. Only a value-free exact PASS receipt permits S3. Any mismatch leaves writers stopped and invokes R2 full database plus cluster-role/auth restoration; the generated SQL inverse is diagnostic rehearsal only and is never the release rollback.

### S3 — activate authentication boundary

- Atomically install approved HBA/ident and root-owned executor/service files; validate then reload PostgreSQL.
- Read back active configuration and prove first-match behavior: dedicated OS identity succeeds over Unix socket; all other OS identities fail; every TCP/password path for `gbrain_migrator` fails.
- Prove no arbitrary shell/SSH/sudo/cron/direct-psql path can assume the dedicated account.
- Failure recovery: enter rollback checkpoint R3, restore/reload exact prior HBA/ident package, then R2 perform the protected full database plus cluster-role/auth restoration; remain stopped until all legacy postconditions are restored.

### S4 — runtime credential/config switch

- Generate/install runtime credential through the separately reviewed no-log mechanism.
- Atomically replace the `0600` runtime config, invalidate old config copies/verifier material and terminate stale pools/sessions.
- Read back only secret-version identifiers, owner/mode and non-secret endpoint/role identity.
- Failure recovery: enter R4, restore prior config/auth files, then R3 and R2; rollback issues a newly controlled recovery credential rather than reviving the old verifier.

### S5 — canary and service rollout

- Canary is `gbrain-persistent`, loopback-only. Worker, ingest writer paths and Autopilot remain stopped.
- Verify session/current role, exact harmless read/write probes and cleanup, fence denial and zero owner/migrator/legacy sessions.
- Start worker and persistent services sequentially, proving new PIDs/readiness and role identity after each.
- Any failed canary/rollout stops writers and enters R5→R4→R3→R2; no ad-hoc grant repair.

## Mandatory postconditions

- database/application/fence ownership matches exact package;
- live services connect only as `gbrain_runtime`;
- no service connects as owner/migrator/legacy `gbrain`;
- runtime owns zero objects and has no direct/transitive SET ROLE path;
- runtime has database/schema CREATE=false;
- runtime cannot alter/drop/disable fence objects or reach a dangerous routine path;
- migrator is reachable only from dedicated OS peer/ident path, never TCP/password;
- legacy `gbrain` is NOLOGIN with NULL verifier and owns zero cluster-wide objects/shared objects, has no ACL/default-ACL/settings/membership/CREATE/session residue; any exception must be enumerated, risk-accepted and hash-bound rather than hidden behind “targeted” scope;
- explicit/default ACL read-back matches package, including PUBLIC;
- extension ownership/disposition matches package;
- expected application workflows pass;
- runtime is NOBYPASSRLS; exact compatibility policies and expiry/review date match their bound package;
- Autopilot remains HOLD;
- receipts contain authenticated admin actor, timestamps, run ID, exact before/after inventories and no secrets.

## Rollback

Before ACL GO, generate and recovery-test a protected full database plus cluster-role/auth rollback package covering:

- database/schema/table/view/sequence/routine/type/extension owners;
- explicit/default ACLs including PUBLIC;
- memberships/options, role attributes and role/database settings;
- HBA/ident changes and dedicated OS executor;
- service config/credential files and atomic switch;
- active-session termination;
- admin-only legacy LOGIN restoration;
- objects/migrations created after separation;
- final disposition/dependencies of new roles.

Rollback order: stop writers, terminate new-role sessions, restore the full database, remove target-role settings/memberships/owned-object residue across every database, drop target roles, restore HBA/ident and service config, issue a **new controlled legacy recovery credential** through the approved protected mechanism, then verify legacy role attributes and canary first. The old verifier is not revived. If restoration cannot be proven, remain stopped/contained. Define encrypted-package key custody, recovery test and rotation; never improvise grants during outage. SQL inverse fragments are diagnostic semantic evidence only.

Named rollback checkpoints:

- **R5:** stop canary/rolled-out services; prove zero writer sessions.
- **R4:** restore prior service/config files atomically and revoke the failed runtime credential version.
- **R3:** restore/reload prior HBA/ident and OS executor state; prove active first-match rules.
- **R2:** restore the exact full database backup, clean target cluster roles/settings/memberships/shared residue, restore legacy role attributes (`LOGIN INHERIT BYPASSRLS`, connection limit and validity baseline), issue a newly controlled recovery credential, and run the exact database/cluster baseline verifier before fresh connect.
- **R1:** verify old canary behavior while all other writers remain stopped.
- **R0:** restore services sequentially, close rollback receipt and retain failed artifacts.

Every R transition requires its own protected read-back receipt; process exit is never sufficient.

## Known blockers

1. Local sudo requires an interactive password; admin/HBA topology is incomplete.
2. Exact command-specific RLS/ACL/ownership package is generated and hash-bound; hosted PostgreSQL 16 behavior/full-restore proof is still required.
3. Table/sequence/routine/type allowlists are complete provisionally; operator/opclass and real application behavior remain hosted-test gates.
4. Coordinator/launcher argv, executed-runtime identity and authorization trust anchor remain unresolved.
5. Peer/ident HBA ordering and dedicated OS executor installation require authenticated admin/root access.
6. Legacy `gbrain` ownership outside this database/shared-object scope is unknown.

Resolved in Stage 1 exact commit `718c04a56dd997147b49a5c9c8161b9265a5ef71`: runtime no-auto-DDL/fail-closed startup prerequisite, read-only pending probe, and SECURITY INVOKER owner-identity writer fence with negative GUC/advisory-lock bypass proof.

## Authorization state

ACL mutation: **NO-GO**.
G5-A/G5-B1/G5-B2: **NO-GO**.
