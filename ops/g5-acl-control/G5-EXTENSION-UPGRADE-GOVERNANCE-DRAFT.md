# G5 extension upgrade/recreation procedure — DRAFT / NO-GO

Candidate: `718c04a56dd997147b49a5c9c8161b9265a5ef71`
Production mutation: none

## Rule

No `CREATE EXTENSION`, `ALTER EXTENSION ... UPDATE`, extension recreation, schema move, member add/drop or package upgrade may run under `gbrain_runtime` or ordinary `gbrain_migration_owner` automation.

Every pg_trgm/pgcrypto/vector extension change is an admin-only governed release:

0. bind exact OS package/container image digest, extension control file, versioned update SQL scripts and shared-library bytes with trusted package provenance and a binary rollback source;
1. stop writers and acquire the exact release advisory lock;
2. authenticate as exact `session_user=current_user=postgres` superuser through the approved local admin path;
3. capture extension name/version/owner/schema and exact `pg_depend(deptype='e')` member OID/signature/type/operator/opclass/access-method inventory;
4. attest pre-change runtime routine/type ACL tuples and default ACLs;
5. run the single reviewed extension update command as `postgres`;
6. reconcile topology:
   - extension owner `pg_trgm` and `pgcrypto` → `gbrain_migration_owner`;
   - extension owner `vector` → `postgres`;
   - all extension-member routines/types/operators/opclasses remain admin-owned unless an exact reviewed exception says otherwise;
7. reapply default PUBLIC revocation for functions/types created by both `postgres` and `gbrain_migration_owner`;
8. regenerate the exact routine/type/operator allowlist and all catalog-closure/verifier artifacts;
9. run hosted positive indexed `%`, `<=>`, default UUID and negative direct-call tests at the new exact versions;
10. independent exact review and a separate extension-upgrade GO are required before writer resume.

Any new/missing member, owner drift, PUBLIC EXECUTE/USAGE, unexpected runtime grant or extension version mismatch fails closed. Fixed counts such as 104 routines are version-bound evidence, not upgrade-compatible assumptions.

The current ACL hosted test may validate only the pinned production versions and package/image digest. It must not be represented as approval for a future extension package upgrade.

Rollback before commit is transaction rollback where PostgreSQL permits it. Post-commit rollback follows the separately approved full database + cluster-role/auth restoration package; diagnostic ACL inverse is not sufficient.
