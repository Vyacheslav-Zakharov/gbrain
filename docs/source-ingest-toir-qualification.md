# Directory pilot candidate — remediation verified, deployment pending

The directory guard is opt-in. Transformed runs deliberately HOLD accepted-full-baseline promotion; an approved fixed-snapshot pilot is not automatic synchronization qualification. Use the ordinary reviewed-profile operation path: catalog article compilation does not yet preserve top-level `directory_guard`.

## Closed remediation findings

- First-bootstrap persistence requires a positive matching readback before page writes. Regression injections delete or change the persisted pin and prove pre-write refusal.
- Privacy-hidden ownership accepts only source/profile/slug-qualified `success` or `unchanged` sync bindings. Pending, skipped, archived and failed states are rejected.
- Guarded renderer frontmatter is deterministic across JSONB round trips, including nested objects. Unguarded legacy rendering order is unchanged. The prior replay defect was insertion-order-sensitive import hashing, not a meaningful article change; it caused a real extra DB version despite clean Git. No global importer hash migration or hash-restoration workaround is applied.
- Native test lifecycle uses the documented beforeAll/beforeEach/afterAll engine pattern; no isolation allowlist suppression.

## Evidence and limits

Parent focused run: 16 tests passed, 205 assertions across four files. Project typecheck and test-isolation gate passed. Independent bounded review accepted the remediation code. A new saved-input actual native-executor replay persisted 28 equipment pages and 55 owned links in isolated PGlite/temp Git; identical replay preserved DB content hashes, page versions, all graph rows, Markdown and Git HEAD. All 28 readable bodies match the previously reviewed pilot. Historical failed evidence is retained separately. This is not live publication or PostgreSQL proof.

`test/e2e/source-ingest-directory-guard.test.ts` is a separate real-PostgreSQL lane. It requires an explicitly opted-in ephemeral PG16 database named `gbrain_directory_guard_test`, initialized by the hosted workflow. It uses randomized owned identities and exact cleanup, not global truncation. Missing DATABASE_URL skips and is not a qualification pass. Hosted workflow execution is required; source preparation is not its result.

Remaining gates: hosted exact-source qualification, composition with the actual installed custom runtime, guard-preserving installation/rollback and a clean authorized registered publication root. Never replace an installed source tree with the development base merely because the six feature files are byte-disjoint from its customizations. Preserve unrelated dirty content; temporary removal requires its own authorization. Deployment authorization does not waive verification.
