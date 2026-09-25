# Pure same-run identity planning

`planSourceIngestIdentities(input: IdentityPlanInput): IdentityPlan` is a pure,
synchronous complete-batch preflight. It throws on invalid identity/graph input;
it does not call an engine or write pages, links, files, checkpoints or sync state.

## Input contract

- `sourceId`, `profileId`: the one publishing scope.
- `planned: readonly PlannedIdentity[]`: the **whole selected batch**, after the
  executor has resolved canonical/adoption/generated slugs and authorized creates.
  Fields: `sourceId`, `profileId`, `externalId`, `slug`, `type`, and
  `mode: 'create' | 'adopt' | 'existing' | 'binding-only'`.
- `existing: readonly CanonicalBinding[]`: trusted, source-qualified bindings to
  live canonical pages, with **actual canonical page type**. These can come from
  successful sync-state/page joins or explicitly approved adoption mappings whose
  pages were read and verified. Adoption evidence is not fabricated successful
  sync state. Non-create planned entries require this evidence for the exact key.
- `requirements: readonly GraphRequirement[]`: normalized selected graph
  references with `fromExternalId`, target `sourceId`, `profileId`, `externalId`,
  and `expectedType` (typed from `SourceLinkRule.target.type`). The caller evaluates
  selection, rule conditions, linked collection extraction and blank/optional
  values before passing references. Every supplied reference is mandatory.

Keys include source, profile and exact external ID (JSON tuple, no delimiter
ambiguity). Same-profile **and same-source** references may use planned identities.
All other references require existing canonical bindings. Duplicate planned IDs,
planned page claims, duplicate canonical keys, conflicting canonical identities,
type mismatches, missing references and same-batch cycles fail before a plan is
returned. Canonical aliases across profiles are allowed if page types agree.

## Facility binding

Represent an approved nonwriting facility as `mode: 'binding-only'`, with its
canonical slug/type and corresponding verified `existing` binding. Its type is
compared to that canonical page, **not** the candidate equipment profile's output
type. It can be a target but cannot originate page/graph writes and is omitted
from `writeOrder`. A facility with no verified canonical binding is refused.

## Output and executor integration

`targets` has exactly the same positional order as `requirements`, each containing
`{ slug, sourceId, type, origin: 'existing' | 'planned' }`. `writeOrder` contains
copies of writable planned identities in deterministic parent-first DAG order;
ready-node ties use exact external-ID lexical order. Every supplied reference
between writable batch entries is treated as a dependency (even when its target
already exists). Cycles, including self references, are refused.

The guarded native executor performs whole-batch identity resolution **before**
graph planning and before the first page write. Build these inputs from
resolved identities and source-qualified canonical reads. Do not downgrade them
into the executor's current `(profileId, externalId)` key without preserving/checking
source uniqueness: that legacy key is not source-qualified. Publish pages in
`writeOrder`, then their links, or publish all pages followed by a graph phase.
Do not mark baselines/checkpoints successful before required graph publication.

## Limits and verification

This module is wired into guarded executor runs. The pure module itself does not implement profile parsing,
record filtering, slug rendering, explicit-create authorization, connector/object
provenance checks, page occupancy/deletion checks, existing-database graph cycle
checks, transactions, rollback or concurrent-write protection. Those remain caller
obligations. A planned identity is not proof of a persisted page. A stale canonical
snapshot must be revalidated by the write boundary. Linked collections have no
schema target-type field; the adapter must obtain a target type rather than guess.
The deterministic queue favors simplicity over optimal asymptotic sorting cost.

Focused pure tests need no engine. The native synthetic integration additionally
uses one in-memory PGLite engine and a disposable Git repo. Tests can be isolated
with clean `env -i`, temporary HOME and `--max-concurrency=1`.

The adapter verifies canonical nonwriting facilities by source/type, preserves
source-qualified target keys, checks ownership/persisted cycles and publishes in
parent-first order before applying a canary limit. Linked collections remain a
fail-closed capability gap. Raw upstream binding and baseline promotion rules are
specified in `source-ingest-directory-guard-contract.md`.

Full transformed-scope promotion receipts remain unsupported: all transformed
runs HOLD. Missing first-bootstrap pin after HOLD publication is open blocker R3.
No unattended auto-update readiness, full suite, installation or live qualification
is claimed.
