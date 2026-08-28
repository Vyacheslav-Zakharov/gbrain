# G5 ACL hosted PostgreSQL 16 harness

This directory freezes the independently reviewed 44-entry Stage 2 ACL control package.

- Control manifest SHA-256: `c7814602e959baf2e8d5c9a05e6c18757f97431b9f9ee9ecacdf38de10581acd`
- Application candidate: `718c04a56dd997147b49a5c9c8161b9265a5ef71`
- Assembled guarded S2 SHA-256: `15a60a358a19c49c52285d3bc49af3d5e670c510b064e9c5de0b25d88c075f71`
- PostgreSQL service: GitHub-hosted disposable loopback container only, pinned `pgvector 0.6.0 / PostgreSQL 16` image digest.

The blocking `g5-acl-hosted-postgres` job in `.github/workflows/test.yml`:

1. verifies the external 44-entry binding and unchanged application source;
2. creates a disposable legacy-owned baseline from the exact candidate;
3. validates extension/catalog closure and creates a full custom-format backup;
4. applies the guarded package only after exact guard removal by the reviewed helper;
5. re-runs exact postconditions from a fresh administrator connection;
6. runs separate runtime/migrator login probes, the complete 92-table command matrix, sequence checks and extension routine positive/negative checks;
7. drops the disposable database, cleans/recreates cluster roles, restores the backup, issues a fresh synthetic credential and proves the exact restored baseline;
8. uploads value-free receipts.

No local or production PostgreSQL execution is supported. A hosted pass does not authorize production ACL mutation, deployment, HBA/ident changes, credential rotation, service restart or extension upgrade. Those remain separately governed NO-GO gates.
