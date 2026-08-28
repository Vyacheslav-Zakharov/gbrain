# G5 runtime RLS compatibility package — DRAFT / NO-GO

Date: 2026-08-28
Decision: `gbrain_runtime NOBYPASSRLS`
Production execution: none

## Bound inputs

- Read-only catalog: `G5-RLS-RUNTIME-CATALOG-READONLY.json`
- Quarantined all-table baseline: `G5-RLS-RUNTIME-COMPAT-ALL92-BASELINE-NOEXEC.sql.txt`
- Quarantined inverse baseline: `G5-RLS-RUNTIME-COMPAT-ALL92-INVERSE-NOEXEC.sql.txt`
- Current catalog facts: database `gbrain`; 92 `public` ordinary/partitioned tables; RLS enabled on all; FORCE RLS on none; existing policies zero; current owner `gbrain`.

## Purpose

The current owner login bypasses RLS through ownership/BYPASSRLS. After ownership transfer, a NOBYPASSRLS non-owner runtime requires policies for every table it is legitimately granted. Compatibility policies preserve current row visibility while table/routine/sequence ACLs remain the privilege boundary.

## Important limitation

The quarantined baseline currently enumerates all 92 tables as exact-current design evidence. It includes sensitive tables by name, including connector-secret/audit tables. A policy does not grant table privileges, but creating an allow-all policy on an unneeded sensitive table would amplify a future accidental grant. The `.NOEXEC.sql.txt` naming is deliberate: these files must never be sourced by psql or included in S2.

Therefore this baseline is **not executable**. The final forward/inverse fragments must be regenerated from one canonical per-table/per-command runtime ACL allowlist, not automatically from every table. For each excluded table, hosted tests must prove the application uses an approved owner-controlled routine path or does not require access.

## Policy semantics

- Role: `gbrain_runtime` with `NOBYPASSRLS`.
- Final policy shape is command-specific from the same ACL model: SELECT/INSERT/UPDATE/DELETE only where required. `FOR ALL` is prohibited unless independently justified per table.
- Policy grants no table privilege.
- Exact table privileges are generated separately and must omit TRUNCATE, TRIGGER, REFERENCES, CREATE and grant options unless individually justified.
- While a permissive compatibility policy exists, new row restrictions must be RESTRICTIVE or replace this policy; another permissive policy ORs with allow-all and cannot restrict it.
- Compatibility policy requires an expiry/review date in ACL GO and must not become permanent.

## Execution position

The reviewed final policy fragment is included in S2 after:

1. `gbrain_runtime` is created as NOBYPASSRLS;
2. target table ownership is transferred to `gbrain_migration_owner`;
3. exact table ACL allowlist identity is re-attested.

It executes in the same `ON_ERROR_STOP` single transaction as the ACL package and legacy-login fencing. S2-seal re-attests committed policies and `rolbypassrls=false` from a fresh administrator connection.

## Required hosted evidence

- role NOBYPASSRLS read-back;
- exact policy count/names/tables/roles/commands/qual/with-check;
- allowed representative SELECT/INSERT/UPDATE/DELETE behavior;
- denied access to excluded tables;
- denied operations omitted from table ACLs;
- SECURITY DEFINER routine inventory and fixed search paths;
- fence denial remains effective with policies present;
- inverse fragment restores exact zero-policy baseline in rollback fixture;
- drift in table set, owner, RLS/FORCE RLS flags or existing policies aborts before mutation.

## Authorization

This package is generated design evidence only. It is not an ACL GO package. Admin topology, runtime ACL allowlist, exact-SHA application prerequisite, hosted PostgreSQL tests, independent exact review and literal artifact-bound ACL GO remain mandatory.
