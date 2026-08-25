# R1 production-clone dump lifecycle

Status: binding for R1 clone work
Owner: Vyacheslav
Created: 2026-08-25

## Scope

This policy covers the read-only production PostgreSQL dump used to create the isolated Docker clone for R1.0/R1.1/R1.2/R1.5 rehearsal. It does not authorize any production write.

## Controls

- The dump is streamed directly from `pg_dump` into GnuPG AES256 symmetric encryption; no plaintext dump file may be written.
- Encryption passphrase is generated locally, mode `0600`, and stored separately from the encrypted dump under the same mode-`0700` secure evidence root.
- Authorized access: Vyacheslav and the current Hermes execution session on this host only.
- The encrypted dump, key, decrypted restore stream, clone volume, and derived private retrieval corpus must never be sent through chat, committed to Git, uploaded, or included in the independent audit package.
- Audit artifacts may contain only hashes, byte counts, aggregate table/vector counts, synthetic labels, and redacted command receipts.
- Docker clone binds only to loopback and uses a randomly generated clone-only password.
- Plaintext exists only in the isolated Docker volume and in process pipes during restore.
- Destruction deadline: immediately after R1 production cutover + 48-hour observation, or `2026-09-05T23:59:59+05:00`, whichever occurs first.
- Destruction requires: stop/remove clone container and volume; securely remove passphrase and encrypted dump; record filenames, hashes-before-destruction, time, and successful absence checks. Do not claim secure physical overwrite on SSD; encryption-key destruction is the primary confidentiality control.
- If inspection discovers a live credential stored in dumped tables or logs, stop, report the affected key name/location without value, and rotate after rehearsal.

## STOP conditions

- encryption or restore-list validation fails;
- plaintext dump appears on disk;
- secure root permissions are wider than `0700` or files wider than `0600`;
- clone port is not loopback-only;
- any artifact contains a secret or private page content;
- disk free space drops below the predeclared clone safety threshold.
