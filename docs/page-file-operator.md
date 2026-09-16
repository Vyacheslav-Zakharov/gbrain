# Bounded offline page-file operator

Production remains disabled. This standalone local executable adds no MCP operation,
worker capability, UI, migrations, automatic enrollment or recovery algorithm.
It handles exactly one independently reviewed page per protected operator manifest.
Run from the repository with Bun; it is deliberately not routed through generic CLI
startup (which has unrelated configuration/update hooks).

```
bun src/commands/page-file-operator.ts --help
bun src/commands/page-file-operator.ts status
bun src/commands/page-file-operator.ts verify
bun src/commands/page-file-operator.ts enroll
```

These are invocation instructions, **not permission to provision or activate**.
Only `--help` is DB-free. The other actions require already provisioned offline
PostgreSQL and the existing fixed startup bootstrap. No schema initializer is called.
Normal file-only GBrain config must select the ordinary PostgreSQL account, not the
adapter or enrollment account. Actual engine startup verifies its ordinary identity
and effective SQL authority before registering the existing private adapter.

## Protected inputs (provision separately after approval)

All operator files are canonical absolute regular files, mode **0400**, owned by the
invoking service UID, one hard link, at most 1 MiB. Ancestors must be root/service-owned
and not group/other writable; symlinks are refused. Place files outside all indexed
roots. The operator enrollment credential is never read by status/verify, ordinary
startup, MCP or workers. Its pathname and hash must differ from the adapter credential.
The credential's actual login/effective authority is checked by the existing separate
enrollment authority service. Do not put credentials in argv, shared config or jobs.

The fixed `/etc/gbrain/page-file-operator-anchor.json` contains:

```json
{"operatorPath":"/protected/operator.json","operatorSha256":"<independently approved SHA-256 of exact operator bytes>"}
```

The pinned operator file has this strict shape (replace placeholders offline):

```json
{
  "version": 1,
  "mode": "offline-verification",
  "bootstrap": {
    "mode": "offline-verification",
    "bootstrapPath": "/protected/bootstrap.json",
    "bootstrapSha256": "<independently approved bootstrap SHA-256>"
  },
  "enrollmentCredentialPath": "/protected/enrollment.credential",
  "enrollmentCredentialSha256": "<approved exact credential-file SHA-256>",
  "reviewedPath": "/protected/reviewed-page.json",
  "reviewedSha256": "<approved exact reviewed-file SHA-256>"
}
```

The bootstrap must reconstruct exactly the same contract as the existing fixed
`/etc/gbrain/page-file-bootstrap-anchor.json`. Missing, replaced or drifting files
refuse; neither hash is recomputed to authorize observed drift. No production-mode
anchor is accepted. `reviewed-page.json` contains all and only:

```json
{
  "hostManifestSha256": "<approved manifest SHA-256>",
  "source": "source-example",
  "slug": "page-example",
  "pageId": "<exact existing page ID>",
  "revision": "<exact opaque reviewed write revision>",
  "canonicalRoot": "/canonical/source/root",
  "relativePath": "page-example.md",
  "rawSha256": "<approved exact raw-file SHA-256>"
}
```

No fuzzy lookup, default source, live-baseline refresh or automatic review generation
exists. Enrollment forwards this exact baseline to `enrollPageFileRuntime`, which
checks host/source/root/page/revision/raw bytes under its existing exclusive root
and SQL transaction gates. It then reads the exact target through the private adapter
before reporting success. Repeating enrollment retains the existing generation-zero
idempotence rules; do not re-pin a changed page to bypass stale-baseline refusal.

## Outcomes and existing recovery

Output is a small JSON status, never page bodies, SQL errors, connection URLs or
credential contents. `verified` means the existing private checked read succeeded;
`not_enrolled`, `pending_recovery`, `sync_required`, and
`page_file_root_sync_required` are observations, not repaired states. A status command
exits zero for a successfully observed non-ready state: inspect the JSON, not exit code
alone. Other failures print only `page_file_operator_failed` and exit 1; invalid argv
exits 2. Enrollment/readback uncertainty must be inspected before retrying.

Recovery already exists and is intentionally not duplicated here:

- `recover_page_file_checked` is the existing local-only operation: supply original
  `source_id`, `slug`, `operation_id`, `expected_revision`, `file_baseline`, `page`,
  `raw_markdown` and explicit `action` (`resume-exact` or `abort`). Never substitute
  a newly observed baseline or select unexpected bytes. Use the existing CLI operation
  argument interface; `gbrain --tools-json` describes its exact parameters.
- Root reconciliation's existing invocation is
  `gbrain sources pull source-example --recover-root --yes`. It observes current files,
  does not rerun Git, and still refuses outstanding page intents. Sync afterward is a
  separately authorized action, not part of this operator command.

## Local verification boundary

```
bun test test/page-file-operator.serial.test.ts
bun run typecheck
```

The new tests use real protected filesystem fixtures and mocked DB/runtime boundaries
(serial quarantine). They prove independent pins, credential-path separation/lazy
loading, remote denial, exact baseline forwarding, readback, redaction and dirty/pending
classification. They do **not** claim a real PostgreSQL operator enrollment execution.
The existing connected PostgreSQL/bootstrap evidence and the parallel crash acceptance
work remain separate. No live DB/container/provisioning or production activation is
performed by this change.
