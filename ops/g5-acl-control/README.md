# G5 ACL hosted PostgreSQL 16 harness

This directory freezes the independently reviewed 44-entry Stage 2 ACL control package.

- Control manifest SHA-256: `95d8cb37d43fe624a725dfa4d13898415d4352fcf6f08df02eb455090521aef3`
- Application candidate: `718c04a56dd997147b49a5c9c8161b9265a5ef71`
- Assembled guarded S2 SHA-256: `6eee5632ef38da42c687329738ee75027360dec81c825a0cb6046a7fd782bc47`
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
