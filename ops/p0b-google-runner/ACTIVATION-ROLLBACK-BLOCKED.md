# P0-B activation and rollback gate

Status: **UNFINALIZED_NOEXEC**.

This package contains no activation or rollback executable. The `.service.NOEXEC`,
`.timer.NOEXEC`, and `legacy-embed-fence.sql.NOEXEC` files are review templates only;
their suffixes are intentional and they must not be renamed, installed, enabled, or
applied.

Activation and rollback remain blocked until all of the following are independently
ratified against exact candidate/package bytes:

1. the final PostgreSQL schema is rehearsed on PostgreSQL 16;
2. content and control-table ACL and RLS authority are proven from catalog-derived
   receipts;
3. the dedicated provider executable and credential-fd handoff are implemented and
   reviewed without environment, argv, log, query, or receipt secret paths;
4. every legacy ZE/default embedding job is inventoried and the fail-closed fence is
   proven under activation races;
5. rollback preservation/restore semantics are finalized and rehearsed.

No current live service, timer, database, provider, or credential store is modified by
this offline package.
