# Source Ingest — Stage 3 Gate: Local Executor Preconditions

Date: 2026-06-30  
Repo: `/home/avers/work/gbrain`  
Scope: mandatory gate before implementing any source-ingest page writes.

## 0. Decision summary

Stage 3 MUST NOT start by writing pages blindly. The pilot target `shared` is git-backed:

- `source_id`: `shared`
- `local_path`: `/home/avers/brain-repos/shared`
- `clone_state`: `healthy`
- `last_commit`: `7bbd555d809f8446d548245cd510403771494aa0`
- remote: `git@github.com:Vyacheslav-Zakharov/avers-brain-shared.git`

Therefore the Stage 3 executor policy for `shared` is:

> **Git-backed source mode.** Every page write MUST write the DB row and atomically write the matching Markdown file into the source `local_path` via `writePageThrough`. DB-only writes to `shared` are forbidden because the next `gbrain sync` can treat DB-only pages as deleted/missing files.

A DB-only source may be supported later only when the source has no `local_path` and is explicitly marked non-syncing. That is not the pilot.

Current preflight finding: `/home/avers/brain-repos/shared` is not clean (`?? companies/`). The Stage 3 executor must either refuse a dirty git tree by default or create/use an isolated ingest branch and verify that dirty paths are not under the generated target prefix. The safe default is **refuse dirty source repo before writes**.

## 1. H1 — storage-mode gate

### Required implementation

Before processing records, executor must resolve the target source row:

```sql
SELECT id, local_path, config FROM sources WHERE id = $1
```

Rules:

1. `local_path` present → git-backed mode.
   - Require path exists and is a directory.
   - Require git worktree preflight.
   - Use `importFromContent(..., { sourceId, sourcePath, source_kind, source_uri, ingested_via })` for DB row.
   - Then call `writePageThrough(engine, slug, { sourceId, frontmatterOverrides })`.
   - Treat write-through skipped/error as executor failure, not best-effort, because source-ingest creates externally managed pages.
2. `local_path` absent → DB-only mode only if source config explicitly permits source-ingest DB-only writes.
   - Default deny.
   - Dry-run may still run.
3. Never write DB-only pages to a source that has `local_path`.

### Commit policy

For git-backed ingest jobs:

- write files into the source repo working tree;
- create a local commit for the ingest run after all writes succeed;
- do not push automatically unless operator policy explicitly allows it;
- commit message must include `source-ingest run_id=<run_id> profile=<profile_id>`.

This matches shared repo rules: local agents should not directly push `master`; review/PR remains a human/governed step.

## 2. I3 — graph edges substage

Stage 3 page executor may be implemented without graph edges first.

If `part_of`, `located_at`, or other links are written in Stage 3, they must be a separate two-pass substage:

1. First pass: create/update all pages.
2. Second pass: resolve targets and write edges.
3. Link source must be non-reserved, e.g. `source-ingest:<profile_id>` or `source-ingest`.
   - Reserved values such as `markdown`, `frontmatter`, `mentions`, `wikilink-resolved` are rejected/owned by reconciliation.
4. Add guards for:
   - missing parent/target;
   - ambiguous target;
   - cycle risk for hierarchical links;
   - cross-source edge warning, especially `shared -> internal-hr`.

Stage 3 initial implementation decision: **defer graph writes** and keep the existing dry-run link buckets. This must be explicit in `source_ingest` output.

## 3. Rollback / revert contract

`source_revert` is not meaningful unless executor tags every write.

Required per written page / record:

- `run_id` in `source_sync_state.run_id`;
- stable `external_ref` in page frontmatter under `source_ingest.external_ref`;
- `profile_id` in page frontmatter under `source_ingest.profile_id`;
- generated file commit message includes `run_id`.

Frontmatter may include stable provenance:

```yaml
source_ingest:
  profile_id: fake-source-vehicle-v1
  external_ref: fake-source:vehicle:veh-001
  run_id: <run_id>
```

Mutable sync timestamps/status belong only in `source_sync_state`, not in frontmatter.

## 4. I2 — op-checkpoint resume

Idempotency tests are insufficient. The executor must use DB-backed op checkpoints:

- fingerprint dimensions: `profile_id`, `profile_hash`, `source_id`, connector id/object, and selected run mode;
- completed key: external ref or external id;
- use `loadOpCheckpoint`, `appendCompleted`/`recordCompleted`, and `clearOpCheckpoint`;
- simulate interrupted batch in tests:
  1. process first N records;
  2. stop before completion;
  3. rerun same fingerprint;
  4. assert completed records are skipped and remaining records are processed.

## 5. D2 regression — content_hash invariant

The “second run unchanged” test must assert content stability, not just no thrown errors.

Required test:

1. first executor run writes page;
2. capture `pages.content_hash` and rendered markdown file content;
3. second executor run with identical source data;
4. assert:
   - page status is unchanged/skipped/noop;
   - `pages.content_hash` is exactly unchanged;
   - file content is exactly unchanged;
   - `source_sync_state` may change mutable run metadata without changing page hash.

This protects against the frontmatter sync metadata trap.

## 6. I1 — managed-block edit policy

Manual content preservation has two separate cases:

1. Manual text outside the managed block — must be preserved.
2. Human edits inside the managed block — must be detected and handled by policy.

Stage 3 policy:

- default: `warn_and_overwrite` for managed block internals, because source-ingest owns that block;
- detect internal edits by storing `managed_block_hash` in `source_sync_state` for the previous generated block;
- if existing block hash differs from last generated hash, emit warning:
  - `managed_block_user_edit_overwritten`, or
  - in stricter mode, `managed_block_user_edit_rejected`.

No silent overwrite of inside-block human edits.

## 7. D1 parity / JSONB rule

Any new SQL for `source_sync_state` must work on Postgres and PGlite.

Rules:

- schema changes go lockstep through `migrate.ts`, `schema.sql`, `pglite-schema.ts`, `schema-embedded.ts`;
- JSONB params use `executeRawJsonb` with raw objects, or `$N::text::jsonb` if binding a JSON string;
- never bind `stableJson(...)` / `JSON.stringify(...)` / `canonicalJson(...)` directly into `$N::jsonb`;
- add engine parity coverage for new write SQL, not only mock tests.

## 8. Stage 3 acceptance tests

Minimum tests before Stage 3 is accepted:

1. H1 git-backed guard:
   - target source with `local_path` requires write-through;
   - write-through failure aborts executor;
   - dirty git tree is refused by default.
2. Idempotency/content hash:
   - first run writes;
   - second identical run leaves `content_hash` unchanged.
3. Manual content:
   - outside managed block preserved;
   - inside managed block edit produces explicit warning/policy result.
4. Resume:
   - interrupted run resumes via op-checkpoint and does not reprocess completed records.
5. Rollback tagging:
   - every `source_sync_state` row has `run_id`;
   - every generated page has stable `source_ingest.profile_id` and `external_ref`.
6. Graph substage:
   - initial executor reports graph writes deferred; or, if links are enabled, two-pass resolver tests pass.
7. D1 parity:
   - source_sync_state write/read tested through the engine parity suite.

## 9. Next implementation step

Do not implement record writes until a preflight module exists:

```text
src/core/source-ingest/executor-preflight.ts
```

It should return a typed decision:

```ts
type SourceIngestStorageMode =
  | { mode: 'git-backed'; source_id: string; local_path: string; git_clean: boolean }
  | { mode: 'db-only'; source_id: string; explicitly_allowed: true }
  | { mode: 'blocked'; reason: string };
```

The executor must call this first and fail closed.
