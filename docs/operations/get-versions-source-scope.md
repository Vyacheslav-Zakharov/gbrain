# Source-aware version history

`get_versions` accepts optional `source_id`. Explicit remote sources are checked
by `resolveRequestedScope` against the read grant, not the personal write source.
Without a source parameter, the operation probes the exact slug in each granted
source and reads snapshots from the unique matching source. Two matching pages
produce `ambiguous_slug`; no matching visible page produces `page_not_found`.
An existing page without snapshots still returns `[]`. Soft-deleted pages are
not resolved. No fuzzy or alias lookup is introduced.

Every page and snapshot lookup carries a concrete source. No global enumeration
or unscoped database read is used. Empty remote scope fails with
`permission_denied`. Empty federated arrays retain the established scalar-source
fallback. Trusted local callers can select a concrete source; without any source
context the operation uses `default`, rather than historical unscoped reads.
The `__all__` sentinel is grant-bounded remotely and rejected locally; history is
a single-page/source operation. Existing takes-holder fence masking is unchanged.

## Verification

- Baseline: `9271ea929b563adb5887876c399ba277ccf6668b`.
- Baseline `src/core/operations.ts` matched installed bytes exactly; SHA-256:
  `e0828e946b869516cfce61d4df420d5a3a92340535f2b33e8e193eb485529bdc`.
- Initial regression failed with actual `[]` versus expected shared history
  (`.context/versions-red.log`); first GREEN then the focused regression matrix passed.
- Focused operation, source resolver and schema parity: 40 pass, 0 fail
  (`.context/focused.log`).
- Existing PGLite federated-page suite passed (`.context/federated.log`).
- Existing privacy suites hit their pre-existing 5-second setup timeout locally;
  hosted command explicitly provides a 60-second test timeout and 120-second
  external TERM/KILL deadline. No privacy assertions were relaxed.
- Local typecheck reached the inherited Node heap limit (SIGABRT); no local retry.
  Hosted typecheck has an explicit 4 GiB heap and 120-second deadline.
- Hosted workflow runs isolated real-Postgres MCP dispatch regression tests,
  narrow operation/privacy suites, typecheck and affected static guards on the
  exact checked-out SHA. Hosted proof is required before release; not claimed here.
- Pre-edit code graph requests used source `internal-it`: callers `not_built`,
  blast `not_found`. This is missing index evidence, not proof of zero callers.

Only `src/core/operations.ts` changes runtime bytes. No engine/schema/migration,
service configuration or installed-runtime changes are included. No deployment
or production database mutation was performed.
