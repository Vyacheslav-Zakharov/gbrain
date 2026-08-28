# GBrain PostgreSQL ACL topology — read-only evidence

Status: READ-ONLY / PARTIAL ADMIN DISCOVERY
Date: 2026-08-28
Production mutation: none
Secrets recorded: none

## Endpoint and runtime identity

- PostgreSQL version: 16.15 (`server_version_num=160015`).
- Database: `gbrain`.
- Endpoint: numeric loopback `127.0.0.1:5432`.
- Current/session role: `gbrain` / `gbrain`.
- Database owner: `gbrain`.
- Credential source: `/home/avers/.gbrain/config.json`, mode `0600`; secret value not recorded.
- Live services `gbrain-persistent` and `gbrain-worker` use the same GBrain config-backed database identity. Autopilot is inactive.

## Current role

`gbrain`:

- LOGIN: true
- SUPERUSER: false
- CREATEDB: false
- CREATEROLE: false
- REPLICATION: false
- BYPASSRLS: true
- INHERIT: true
- member/set-capable as `pg_database_owner` because it owns database `gbrain`
- not a member of `postgres`

## Ownership and privileges

- Schema `public` owner: `pg_database_owner` (therefore current database owner `gbrain`).
- `public` CREATE for current role: true.
- `public` CREATE for PUBLIC: false.
- Owned by `gbrain` in `public`:
  - 92 ordinary tables
  - 49 sequences
  - 9 application routines
  - 8 non-internal triggers across 6 tables
- Extensions:
  - `pg_trgm`: owner `gbrain`, schema `public`
  - `pgcrypto`: owner `gbrain`, schema `public`
  - `vector`: owner `postgres`, schema `public`
  - `plpgsql`: owner `postgres`, schema `pg_catalog`
- `gbrain` has CONNECT, TEMP and CREATE on database `gbrain`.
- Information-schema inventory reports all table privileges for `gbrain` across 93 visible table/view objects: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER.

## RLS

- Tables with RLS enabled: 92/92.
- Tables with FORCE RLS: 0.
- Policies in `public`: 0.

Consequence: a non-owner runtime role without `BYPASSRLS` receives no row access even if table DML is granted. To preserve current behavior in the first role-separation release, the runtime login must remain non-owner but retain `BYPASSRLS`. Removing BYPASSRLS requires a separate reviewed RLS-policy release.

## Startup migration coupling

Normal CLI/service startup calls `connectEngine()`, which invokes `tryRunPendingMigrations(engine)` for every non-probe startup. Therefore a non-owner runtime can operate only when no migration is pending; future upgrades need a dedicated migration step and a fail-closed runtime mode that refuses pending migrations without attempting DDL.

## Live connections observed

- Only role `gbrain` was observed for database `gbrain`.
- Application names included `postgres.js`; read-only probes used `g5-acl-readonly-topology`.
- No passwords, SQL text, or protected URLs were recorded.

## Incomplete admin-only evidence

The approved `sudo -n -u postgres psql` read-only probe did not execute because local sudo requires an interactive password. No password was requested or accepted.

Still required before any ACL GO:

1. exact local admin execution method;
2. `pg_hba_file_rules` relevant to database `gbrain` and proposed role names;
3. admin ownership/role-creation capability;
4. exact password-auth method and credential rotation mechanism;
5. current default ACL rows as admin if hidden from `gbrain`;
6. confirmation that `REASSIGN OWNED` scope will not affect another database or shared object unexpectedly.

## Verdict

Role separation is required to make the writer fence an authorization boundary. The current single login is not sufficient. ACL mutation remains NO-GO until the separate runbook is finalized, independently reviewed, hash-bound, and explicitly approved.
