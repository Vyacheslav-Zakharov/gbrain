# G5 ACL cluster-role/auth rollback — DRAFT / BLOCKED / NO-GO

Date: 2026-08-28
Production mutation: none

## Critical distinction

The previously approved G5-B full-database dump/restore posture was sufficient for the ZeroEntropy data migration because it did not, by itself, restore cluster-global role/authentication state.

The ACL transition changes cluster-global state:

- creates `gbrain_migration_owner`, `gbrain_migrator`, `gbrain_runtime`;
- seals legacy `gbrain` as NOLOGIN/NOBYPASSRLS and clears its verifier;
- creates role membership/options and database-specific role settings;
- later changes runtime credentials and HBA/ident/launcher files.

An ordinary custom-format database dump/restore does **not** remove target roles or restore the legacy SCRAM verifier, role attributes, memberships, settings, HBA/ident, service credentials or root-owned launchers. Therefore the existing full-DB-restore acceptance does not by itself close ACL rollback.

## Required protected pre-cutover package

Admin/root-only, encrypted at rest, mode `0600` within a mode `0700` directory:

1. encrypted full custom-format database dump plus validated restore list;
2. exact value-free legacy `gbrain` cluster-role attributes, connection limit, validity, settings and membership baseline; the old verifier is neither exported nor revived;
3. exact membership graph/options and `pg_db_role_setting` rows;
4. HBA/ident files, owner/mode/hash/order and validated parsed rules;
5. runtime credential file/config bytes and service launcher/unit files with owner/mode/hash;
6. cluster-wide owned-object census for legacy and target roles across every connectable database plus shared objects/tablespaces;
7. exact restore tool/scripts and a value-free manifest/receipt.

## Exact rollback state machine

Writers remain stopped throughout.

1. authenticate through the approved local `postgres` superuser path;
2. terminate target/legacy sessions and verify zero residue;
3. restore HBA/ident and reload only after syntax/order validation;
4. restore the database into the exact baseline identity;
5. remove target-role settings/memberships/owned-object residue in every database;
6. drop `gbrain_runtime`, `gbrain_migrator`, `gbrain_migration_owner` only after exact zero-owned-object/zero-session proof;
7. restore legacy `gbrain` attributes (`LOGIN INHERIT BYPASSRLS`, `rolconnlimit=-1`, `rolvaliduntil=NULL`) and issue a **new controlled recovery credential** through a protected channel that does not expose password/verifier in argv, shell history, process environment, receipts or `pg_stat_activity`;
8. restore service credential/config and root-owned launchers atomically;
9. run exact baseline verifier for database/schema/table/sequence/routine/type/extension/trigger/event-trigger/default/column ACL/RLS state, role graph/settings and HBA-independent shared state;
10. perform one bounded health/auth smoke before writer resume.

## Unresolved blocker

A safe new-recovery-credential delivery mechanism satisfying the no-argv/no-environment/no-query-log/no-`pg_stat_activity` requirement is not yet designed or tested. Until it is, post-commit ACL rollback is not operationally complete. Exact rollback means restored data/catalog/role attributes plus the receipted new credential version; it does not mean equality with the retired pre-cutover verifier.

Consequences:

- exact transaction rollback before S2 commit remains valid;
- diagnostic SQL inverse is evidence-only;
- hosted disposable tests may test target-role cleanup but cannot authorize production rollback;
- production ACL cutover remains NO-GO.
