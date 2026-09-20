# Frozen backup v3: hosted qualification blocked at target admission

This is an **offline admission reproduction**, not a hosted backup/restore fixture.
Finite acceptance row 8 remains OPEN. No PostgreSQL qualification or production
capture is claimed. Do not execute `owner-capture.sh`: it is an exact reviewed
reference copy, not authorization.

## Exact categorical constraint

The SHA-256-pinned `capture.py`
`e95c15c162d3f95932eb95373f5cf246791dff8776957ca3aad02bfe42cad374`
contains only two modes:

- Lines 148 and 160–162: `production` requires exact identity
  `{'host':'avers-analyst','database':'gbrain','cluster':'7552810389285094085'}`.
  A truthful synthetic hosted host/cluster is rejected with `Refusal: target identity`.
- Lines 164–168: `fixture` requires the exporter to be beneath the fixture
  directory, itself beneath the executor directory, and requires exact argv
  `[exe, '--simulated-db']`. The fixed real PostgreSQL binary escapes this
  containment; copying a binary beneath the fixture does not admit real dump argv.
- Lines 130–137: real export uses the fixed PostgreSQL 16 binary, Unix socket
  `/var/run/postgresql`, port `5432`, user `postgres`, database `gbrain`, launched
  through `/usr/sbin/runuser --user postgres --`.

A disposable database can be named `gbrain` and use the fixed socket/port, but it
cannot truthfully claim the production host and PostgreSQL system identifier.
Copying those production identity literals into synthetic authorization/fence
receipts would manufacture identity, not establish hosted qualification. The
executor compares declarations rather than independently discovering the server;
that fact does not authorize misrepresentation. No such receipts were created by
this admission probe. No guards or frozen bytes were changed.

## Runnable offline proof

From this directory:

```sh
timeout --signal=TERM --kill-after=3s 20s python3 -B probe_admission.py
timeout --signal=TERM --kill-after=3s 120s python3 -B -m unittest -v test_capture test_regressions test_output_bounds
```

The first command invokes the unmodified real CLI in dry-preflight mode with four
synthetic manifests. It asserts exact refusals and absent output, without mocks,
`--execute`, database access, source-content reads, sudo, runuser or networking.
It does inspect pathname metadata as the frozen CLI requires. Root paths in these
manifests do not exist and are not production paths. All probe writes are isolated
beneath this test-only directory. Cleanup removes only the probe's own manifests;
no exporter is launched and no unknown writer lifetime is asserted safe.

The second command reruns the three exact reviewed test modules (30 tests),
including output-bound regressions. Existing modules use simulated exporters,
real local OpenSSL CMS, and explicitly inert/mocked production-grammar checks.
Those legacy mocks are not the new admission proof and never count as real
PostgreSQL or privileged-launch acceptance.

## Deliberately not authored or executed

No hosted workflow or fake green row-8 fixture was created after admission failed.
In particular, ordinary peer-auth success/refusal, real runuser export, real
PostgreSQL restore/readback, hosted root/cluster cleanup, and hosted run/attempt
receipts remain unexecuted. A push/manual workflow claiming those behaviors would
be unreachable under the frozen truthful target contract. Existing workflows and
all production source files are unchanged. No commit, push or dispatch occurred.

Proceeding requires a separately scoped decision about the frozen executor's
synthetic-target admission contract. This packet does not propose a bypass,
change production authority, or expand into a new supervisor architecture.
