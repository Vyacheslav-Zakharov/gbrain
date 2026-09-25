# Native directory identity guard — candidate integration

`prepareDirectorySnapshot(DirectoryGuardInput)` is pure. Native `source-fetch.ts`
uses it before SQL/projection/selection; `executor.ts` consumes the prepared snapshot
and performs whole-selected-batch identity/graph preflight before page publication.
The profile supports `directory_guard`; this change adds no profile-schema fields.
No installation, production execution or runtime parity is claimed.

## Input and binding

Pass complete raw `SourceRecord.data` rows and explicit source/profile/policy.
`complete: true` is an adapter attestation, not independently proven pagination.
The native adapter requires fetchAll, disallows sample/incremental shortcuts and
rejects a final nonempty cursor. Wrapper IDs must equal the policy ID field.

**Required internal API:** `upstreamBinding = {connectorInstanceId, objectName,
alias, sourceTableId, resolvedCatalogId}`. All properties are required; the last
two are strings or null. Values identify the resolved connector instance, resolved
object, transform alias, requested source_table_id and resolved config/base-view
catalog ID. Use the actual resolved upstream, not the top-level profile labels.
The adapter constructs this explicitly; connector config and credentials are never
included or hashed. Registered instance IDs must remain stable identities; retargeting
an instance's endpoint in place is an operator-controlled catalog change, not a
credential-fingerprinting feature.

The baseline envelope is `{version:1, sourceId, profileId, upstreamBinding,
upstreamBindingHash, policyHash, snapshotHash, knownIdentityRecords}`.
SHA-256 uses recursively key-sorted JSON. The complete allowlisted raw projection,
policy and upstream binding enter the snapshot hash. Baseline binding/hash mismatch
STOPs even in preview. Old envelopes without binding STOP; no automatic migration.
Changed upstream requires explicit separately approved rebaseline. Without an
accepted baseline, run requires the exact upstream-bound reviewed bootstrap hash;
preview does not confer approval. Prefer native preview `onGuardPrepared` to obtain
the resolved envelope/hash for review rather than reconstructing catalog resolution.

## Validation

All raw rows, including outside selection/scope, undergo ID/key/site safety,
duplicate ID, parent existence/site/cycle, dates, anchors and known-identity checks.
Known IDs cannot disappear; created timestamp loss/change/appearance, key changes,
and simultaneous name+type changes STOP. Independent name/type changes remain
allowed subject to type policy and anchors. No deletions are inferred.

Policy names exact fields and passport allowlist. Roots default to null;
`rootParentValues` explicitly permits null and/or empty string. Empty-string roots
normalize to null in identities while raw projection preserves the empty string.
Missing/unsafe parents STOP. Dates require a declared format and fixed UTC offset.
Only safe scalar passport fields are admitted; virtual collections are excluded.
Records, identities, upstream binding and baseline envelope are frozen.

## Publication and promotion

Native preflight resolves canonical/adoption/create targets, approved nonwriting
facility bindings, target types, ownership, same-run and persisted graph cycles.
It orders parents first, then applies executor limit. Linked collections and
non-source-qualified/non-external-ID graph targets remain unsupported and fail closed.
Guarded runs do not trust checkpoint completion; fingerprint includes snapshot hash.
Existing source-scoped refreshing lock and prior-baseline comparison remain in place.
The compare/set is not an atomic CAS against out-of-band config writers.

Default/explicit HOLD, executor-limited, failed, selection-truncated and empty-output
runs never promote. Nontransformed full promotion requires a positive receipt:
every raw identity except a canonical nonwriting binding verified during this
preflight has exactly one successful written/unchanged result, no skip/failure,
no limit, and at least one writable identity. A `full` flag alone is insufficient.

**BLOCKER: ALL transformed runs HOLD baseline promotion**, including SQL returning
all rows, WHERE false and SQL LIMIT without executor limit. A positive transformed
full-scope acceptance receipt is not implemented. Automatic full SQL promotion is
unsupported, not ready.

First publication persists immutable metadata at the baseline key plus
`.first_bootstrap`, only after raw/identity/graph preflight and before the first
page write (including canaries). Publication requires a positive matching readback:
a missing pin after persistence STOPs, as does a changed pin. It contains the baseline envelope minus
knownIdentityRecords: it is NOT an accepted baseline. Preview validates but never
persists the pin or mints approval. While the accepted baseline is absent, only
an identical prepared snapshot/policy/upstream binding can pass, regardless of a
replacement approved_bootstrap_hash. Missing pin plus any successful/unchanged
sync state for the publish source/profile STOPs with rebaseline_required; malformed
or different pins STOP. The executor rechecks at the write boundary under the
existing source-wide lock. Accepted baselines retain normal identity-update rules;
the historical pin does not freeze legitimate later full updates.

Guarded rendering sorts top-level frontmatter keys and serializes nested values with
stable key order, so first publication and replay preserve DB content_hash and page
versions across JSONB key reordering. Legacy non-guarded rendering is unchanged;
this is not a global importer hash migration. Existing pre-fix guarded hashes may
need one normalization import.

Config/catalog operators are trusted and must honor the source-wide lock and never
rewrite/delete pins as a bootstrap shortcut. Compare/set is NOT atomic CAS against
out-of-band writers. SQL remains HOLD, not automatic-update ready.

Privacy-hidden external_ref is accepted only with exact owner.profile_id and a
successful source-qualified current profile/connector/object/external-ID sync binding
to the same target slug. Successful means exactly `last_result IN ('success','unchanged')`;
pending, skipped, archived and failed states do not establish ownership.
Hidden foreign/unbound owners and visible mismatches STOP.

## Verification scope

Synthetic pure tests and a single isolated in-memory PGLite/native Git fixture cover
raw STOP, upstream retarget/bootstrap rejection, first full promotion, idempotence,
limited/HOLD/failure retention, valid SQL empty/canary output and nontransform
selection completeness. Post-preflight pin disappearance/change injections prove zero
new equipment pages, links or sync state; unsuccessful hidden-owner bindings STOP
without page/graph changes. The native fixture uses the documented shared-engine
beforeAll/beforeEach reset/afterAll disconnect lifecycle and passes the repository
test-isolation gate without suppression. No PostgreSQL service, Docker, full suite or live writes.
