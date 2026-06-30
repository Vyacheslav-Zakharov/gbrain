# Source Ingest — Phase 0 Repository Inventory

Date: 2026-06-30  
Repo: `/home/avers/work/gbrain`  
Scope: Stage 0 inventory for Third-Party Source Ingest before implementation.

## 0. Status

This document is an inventory and reuse decision record, not an implementation patch.

**Phase 0 outcome:** proceed to Stage 1 only after the reuse decisions and gaps below are accepted.

**Repository state at inventory time:** `git status --short` returned clean output.

## 1. Hard constraints confirmed against code

| Constraint | Code evidence | Phase 0 conclusion |
|---|---|---|
| Contract-first operations | `src/core/operations.ts`; CLI dispatch in `src/cli.ts`; MCP dispatch in `src/mcp/dispatch.ts`; tool schema in `src/mcp/tool-defs.ts` | Add read-side and write-side source-ingest surfaces as operations, not ad-hoc commands only. |
| Remote vs local trust boundary | `OperationContext.remote` defaults true in `src/mcp/dispatch.ts`; CLI local path sets context through `src/cli.ts`; `submit_job` rejects protected jobs unless `ctx.remote === false` | Real ingest writes must run in local/trusted minion or CLI context. Remote MCP may call discovery/dry-run/status only. |
| `put_page` is canonical page write path | `operations.ts:772+` calls import/write path and handles provenance stamping; remote callers are server-stamped | Source ingest should render Markdown then write through the same DB/import path, not direct DB page inserts. |
| `content_hash` trap exists | `src/core/import-file.ts:504-550` excludes only selected ephemeral keys (`captured_at`, `ingested_at`, quarantine/content flags/embed skip) from hash | Mutable source sync metadata must not be added to page frontmatter unless explicitly excluded; preferred design remains `source_sync_state` table. |
| Cross-source edge support exists but needs explicit source ids | `BrainEngine.LinkBatchInput` has `from_source_id`, `to_source_id`, `origin_source_id`; `add_link` op exposes `from_source_id`/`to_source_id` and rejects reserved managed link sources | Batch link builder should use engine batch APIs with explicit source-qualified endpoints and custom `link_source` such as `source-ingest`. |
| Cycle has phase taxonomy/locking | `src/core/cycle.ts` has `ALL_PHASES`, `PHASE_SCOPE`, DB cycle locks and per-source cycle support | Add `source_refresh` as a source-scoped phase that enqueues jobs only; no connector I/O inline. |
| Minions are durable job substrate | `src/commands/jobs.ts`, `src/core/minions/*`, `src/core/minions/handlers/embed-backfill.ts` | Implement ingest executor as minion handler modeled on `embed-backfill`, not a foreground-only loop. |
| Schema parity is an iron rule | `src/core/migrate.ts`, `src/schema.sql`, `src/core/pglite-schema.ts`, `src/core/schema-embedded.ts`, `src/core/postgres-engine.ts`, `src/core/pglite-engine.ts`, `test/e2e/engine-parity.test.ts`, `test/schema-bootstrap-coverage.test.ts` | Any new tables/methods require migration + schema blob + embedded schema + both engines + parity/bootstrap tests. |
| Git-backed vs DB-only source distinction exists | `src/core/write-through.ts` skips when no repo configured or wrong source repo; `src/commands/sync.ts` works over sources with `local_path` and git delta semantics | Ingest profile must record target source storage mode expectation; batch executor must either write-through and optionally commit, or mark source DB-only and avoid sync assumptions. |
| Progress/reporting substrate exists | `src/core/progress.ts` and `job.updateProgress` use stable phase names and stderr/DB progress | Use `job.updateProgress` for minion progress and `createProgress` only for foreground CLI diagnostics. |
| Connector/integration registry partially exists | `src/commands/integrations.ts` has recipe discovery, secret status, health checks, SSRF-gated HTTP checks; `src/core/sources-ops.ts` has SSRF gate for git remote sources | Reuse as reference/secret model, but source-ingest connector registry itself is still new. |

## 2. Substrate → reuse → gap → files

| Substrate / capability | Reuse decision | Gap to implement for Source Ingest | Files to touch/read |
|---|---|---|---|
| Operation registry / contract surface | Reuse `Operation` registry in `src/core/operations.ts`; generated CLI/MCP path already exists through `cli.ts`, `dispatch.ts`, `tool-defs.ts` | Add first-class ops: `source_discover`, `source_profile_draft`, `source_validate_profile`, `source_dry_run`, `source_sync_status` as read-scope/MCP-visible; `source_ingest`, `source_refresh`, `source_revert` as write/admin with localOnly/trust gates where needed. Avoid `CLI_ONLY` for read-side. | `src/core/operations.ts`; `src/cli.ts`; `src/mcp/dispatch.ts`; `src/mcp/tool-defs.ts`; tests around operations exposure |
| Source scoping and source existence | Reuse `resolveSourceId`, `assertSourceExists` logic and `sourceScopeOpts` patterns | Add approval-time freeze for `approved_source_id`; executor must re-validate against operator allowlist and ignore fresh LLM-proposed `source_id`. Need profile validator rule and execution guard. | `src/core/source-resolver.ts`; `src/core/operations.ts`; `src/core/sources-ops.ts`; future `source-ingest/profile-validator.ts` |
| Page renderer/write path | Reuse `put_page` → `importFromContent` → `serializePageToMarkdown` → `writePageThrough` path | Build source-record renderer that outputs stable frontmatter + managed body block + link proposals. Do not direct-insert pages. Need strict managed-block merger before update mode is safe. | `src/core/operations.ts`; `src/core/import-file.ts`; `src/core/markdown.ts`; `src/core/write-through.ts`; new `src/core/source-ingest/renderer.ts`; new `src/core/source-ingest/managed-block.ts` |
| Content hash/idempotency | Reuse `importFromContent` short-circuit and `findDuplicatePage(hash|frontmatterId)` | Add `content_fingerprint` / `last_source_hash` in DB state, not frontmatter. Ensure stable source identity marker only in frontmatter. Add tests: unchanged source record rerun returns unchanged and does not re-chunk/re-embed. | `src/core/import-file.ts`; `src/core/engine.ts`; `src/core/postgres-engine.ts`; `src/core/pglite-engine.ts`; new tests |
| Sync state | New table is justified | Create `source_sync_state` for connector/object/external_id → slug/profile/source/hash/freshness/run status. Mutable sync data must not be in page frontmatter. | `src/core/migrate.ts`; `src/schema.sql`; `src/core/pglite-schema.ts`; `src/core/schema-embedded.ts`; `src/core/engine.ts`; both engines; tests |
| Ingest profiles | New table/versioning is justified | Create `source_ingest_profiles` and `source_ingest_profile_versions` or equivalent. Store machine profile in DB JSONB with approved frozen fields and version hash. GBrain `source` page may hold summary/pointer only. | same schema files; new `src/core/source-ingest/profile-schema.ts`; profile ops/tests |
| Run history / run items | Partially reuse `minion_jobs.result`, `op_checkpoints`, and job progress | Avoid unbounded `source_ingest_run_items` unless TTL/GC is implemented. Minimum durable state: run_id in `source_sync_state`, capped errors in job result, per-item status checkpoint for retry. If separate table is added, add purge/TTL. | `src/core/minions/*`; `src/core/op-checkpoint.ts`; `src/core/migrate.ts`; `src/core/cycle.ts` purge phase if separate table |
| Durable executor | Reuse Minions queue/worker and `embed-backfill` handler shape | Add handler `ingest-third-party` or `source-ingest` with per-profile/source lock, budget/pacer, keyset/cursor resume, `job.updateProgress`, abort signal support, and local/trusted submit gate. | `src/commands/jobs.ts`; `src/core/minions/handlers/embed-backfill.ts`; `src/core/minions/protected-names.ts`; `src/core/minions/queue.ts`; new handler file |
| Protected job submission | Reuse `PROTECTED_JOB_NAMES` and `submit_job` remote guard | Add source ingest write/refresh protected names if they can mutate many pages or spend LLM/API budget. Remote MCP must not submit protected write jobs. | `src/core/minions/protected-names.ts`; `src/core/operations.ts`; `src/commands/jobs.ts` |
| Resume/idempotency | Reuse `op-checkpoint.ts` append-only paths and 7-day GC model | Define source-ingest fingerprint from profile version + connector id + source object + approved source id + selection hash. Record completed external IDs/statuses. Decide whether failed/skipped live in checkpoint child rows or run item table. | `src/core/op-checkpoint.ts`; `src/core/migrate.ts`; new ingest executor tests |
| Rate limiting / pacing | Reuse `db-pacer.ts` / `pace-mode.ts` patterns where applicable | Add connector pacing and DB pacing hooks. Avoid per-record unbounded writes. | `src/core/db-pacer.ts`; `src/core/pace-mode.ts`; handler implementation |
| Link creation/reconciliation | Reuse `addLinksBatch` / `removeLink` primitives and source-qualified link rows | Implement two-pass link build: pages first, then links. Use non-reserved `link_source` such as `source-ingest`. Store rule-level coverage, buckets, and sample edges for review. Need reconciliation by profile/rule without deleting unrelated manual links. | `src/core/engine.ts`; `src/core/postgres-engine.ts`; `src/core/pglite-engine.ts`; `src/core/operations.ts` add_link docs; new `source-ingest/link-builder.ts` |
| Timeline entries | Reuse `addTimelineEntriesBatch` / `add_timeline_entry` semantics | Imported lifecycle events should be source-qualified and idempotent. Need decision whether generated timeline uses separate source/provenance and how to avoid duplicate events across refresh. | engine timeline methods; `operations.ts:2163+`; new renderer/linker tests |
| Discovery profiler | New component | Implement connector-agnostic profiler: field stats, null ratio, cardinality, sample values, ID candidates, updated_at candidates, parent/FK candidates, data quality warnings. | new `src/core/source-ingest/discovery.ts`; fixtures/tests |
| Agent mapping draft | New LLM component | Build draft op from discovery + active schema graph. Must never auto-approve or select active source at execute time. Add eval suite before trusting. | new `src/core/source-ingest/mapping-draft.ts`; `evals/source-ingest-mapping/`; schema graph APIs |
| Mapping validator | New component, but use schema pack/type/link helpers | Validate target type, link types, slug template stable fields, source allowlist, PII/security classification, freshness policy, update policy, connector capability. | new `src/core/source-ingest/profile-validator.ts`; schema-pack helpers; source resolver |
| Profile JSON Schema / DSL | New component | Define typed JSON Schema and avoid free-text JSONPath predicates. Need structured DSL for field paths, filters, link lookups, freshness, update policy. | new `src/core/source-ingest/profile-schema.ts`; `docs/source-ingest-workflow.md`; tests |
| Connector registry | Partially reuse integration recipes and secret/health-check patterns | Actual connector interface is new: `listObjects`, `discover`, `sample`, `fetchAll`, `fetchChangedSince`, `fetchById`. Secrets must stay in env/secret store, never in profile JSONB or pages. | `src/commands/integrations.ts`; `src/core/url-safety.ts`; new `src/core/source-ingest/connectors/*` |
| Fake connector | New but required for Stage 1 | Deterministic fake equipment/deal/person fixtures for tests, dry-run, evals. | new `src/core/source-ingest/connectors/fake.ts`; `test/fixtures/source-ingest/*` |
| Freshness / refresh scheduler | Reuse `cycle.ts` phase framework and Minions queue | Add `source_refresh` phase to `ALL_PHASES`/`PHASE_SCOPE` that only selects stale profiles/pages and enqueues jobs. No connector I/O inline. Read-side computed freshness from `source_sync_state`. | `src/core/cycle.ts`; `src/commands/jobs.ts`; `src/core/operations.ts`; new status ops/tests |
| Budget / cost control | Reuse `BudgetTracker` pattern and protected job names | LLM mapping draft and connector refresh need caps. Refresh phase must enqueue bounded jobs and respect daily/source caps. | `src/core/budget/*`; `src/core/cycle/budget-meter.ts`; handler |
| Conflict resolver | Reuse `findDuplicatePage`, `(source_id, slug)` PK, soft-delete/restore | Add external_id collision, slug collision, deleted/archived source-record handling, and manual page conflict states. No default soft-delete for disappeared source records; mark historical/status/timeline. | `src/core/import-file.ts`; engine duplicate methods; new `source-ingest/conflicts.ts` |
| Managed block merge | New first-class tested module | Strict grammar for `<!-- gbrain-source-sync:start ... -->` / end markers. Decide policy for edits inside block: likely warn/overwrite with diff, not promise preservation. Must round-trip DB→MD→sync→DB. | new `src/core/source-ingest/managed-block.ts`; tests; `src/core/markdown.ts`; `src/core/import-file.ts` |
| Dry run report | New report over existing renderer/link validator | Must produce counts, managed-block before/after diff, stratified sample, routing/sensitivity banner, rule-level link coverage and exception buckets. No writes. | new `source-ingest/dry-run.ts`; read op in `operations.ts`; admin UI/API later |
| Revert / rollback | Partially reuse soft-delete/restore and run_id tagging | Add `source_revert --run <id>` or op. Needs durable run_id association in `source_sync_state` and/or page provenance. Must define rollback for updated pages vs created pages. | `src/core/operations.ts`; `src/core/source-ingest/revert.ts`; `delete_page`/`restore_page` ops; tests |
| Git-backed vs DB-only write-through | Reuse `writePageThrough` behavior and source `local_path` | Profile/executor must explicitly know if target source is DB-only or git-backed. For git-backed, ensure files are written and maybe committed; for DB-only, avoid later sync deleting perceived DB-only pages. | `src/core/write-through.ts`; `src/commands/sync.ts`; `src/core/sources-ops.ts`; source-ingest executor |
| Admin UI | Reuse `admin/` Vite app and jobs dashboard patterns | No source-ingest UI exists. Need new pages: Source Catalog, Discovery Result, Mapping Editor, Dry Run Preview, Batch Job Monitor, Source Sync Dashboard. | `admin/src/App.tsx`; `admin/src/api.ts`; `admin/src/pages/JobsWatch.tsx`; new admin pages/routes |
| Tests and checks | Reuse Bun tests, e2e helpers, parity/bootstrap tests, static checks | Add tests for schema parity, bootstrap coverage, content_hash idempotency, localOnly/write trust, rule-level link review, partial-write recovery, managed-block roundtrip, fake connector discovery/dry-run. | `test/e2e/engine-parity.test.ts`; `test/schema-bootstrap-coverage.test.ts`; `test/operations-link-read-redaction.test.ts`; new `test/source-ingest*.test.ts` |
| Error contract | Reuse `OperationError` JSON shape in dispatch | New ops must throw `OperationError{code,message,suggestion,docs}` where possible, not bare `Error`, especially for profile validation, source routing, connector auth, and stale/refresh states. | `src/core/operations.ts`; `src/mcp/dispatch.ts`; new source-ingest modules |

## 3. Proposed replacement for plan §8 (reuse map)

The backend architecture should be described as thin adapters over existing GBrain primitives plus a small set of genuinely new modules.

### Reused primitives

| Need | Existing primitive | Decision |
|---|---|---|
| Operation surface | `src/core/operations.ts` + CLI/MCP dispatch | All source-ingest capabilities start as ops. Read ops are MCP-visible; write ops are local/trusted where needed. |
| Page write/render | `put_page`, `importFromContent`, `serializePageToMarkdown`, `writePageThrough` | Renderer produces Markdown/frontmatter; canonical GBrain path writes it. |
| Durable jobs | Minions queue/worker; `embed-backfill` handler pattern | Batch ingest is a minion handler, not a bespoke loop. |
| Resume | `op-checkpoint.ts` | Use checkpoint keys by profile version and external IDs. |
| Progress | `job.updateProgress` + `src/core/progress.ts` | DB progress for jobs; stderr/json progress for CLI. |
| Refresh scheduling | `cycle.ts` phases + Minions | `source_refresh` phase enqueues jobs only. |
| Source isolation | `source-resolver.ts`, `sourceScopeOpts`, source-qualified engine opts | Freeze `approved_source_id`; source-qualified all writes/links. |
| Links/timeline | `addLinksBatch`, `addTimelineEntriesBatch` | Two-pass batch pages then graph. |
| Duplicate/conflict base | `findDuplicatePage`, `(source_id, slug)` identity, soft-delete/restore | Extend for external_id conflicts and run_id rollback. |
| Integration health/secrets pattern | `integrations.ts`, `url-safety.ts`, `sources-ops.ts` SSRF patterns | Reuse patterns, but connector registry is new. |

### New modules justified

| New module | Why existing substrate is insufficient |
|---|---|
| `source-ingest/discovery.ts` | No existing connector-agnostic field/stat profiler. |
| `source-ingest/profile-schema.ts` | Need machine-validated profile DSL and JSON Schema. |
| `source-ingest/profile-validator.ts` | Need rules for GBrain type/link/source/privacy/freshness approval. |
| `source-ingest/mapping-draft.ts` | LLM draft from discovery + schema graph is new and must be eval-gated. |
| `source-ingest/managed-block.ts` | No current source-sync managed-block grammar/merge module. |
| `source-ingest/renderer.ts` | Need external record → GBrain Markdown/frontmatter + link proposals. |
| `source-ingest/dry-run.ts` | Need dry-run reports, link rule coverage, sensitivity banner. |
| `source-ingest/connectors/*` | Third-party connector contract and fake/real connectors are new. |
| `source-ingest/executor.ts` / minion handler | Batch-specific orchestration, status, rollback, checkpointing. |

## 4. Stage 1 implementation gates

Do not start broad implementation until these are explicit in the Stage 1 design:

1. **DB schema minimal set:** likely `source_ingest_profiles`, `source_ingest_profile_versions`, `source_sync_state`; defer or TTL-bound run item table.
2. **Engine parity plan:** every schema/table/method change mirrored in Postgres and PGLite; no `JSON.stringify` into `::jsonb` — use `executeRawJsonb` pattern if needed.
3. **Operation matrix:** read ops MCP-visible; write ops local/trusted/protected as appropriate.
4. **Managed-block policy:** what happens when user edits inside generated block.
5. **Git-backed/DB-only target policy:** especially for pilot target `shared`.
6. **Source routing freeze:** approval stores `approved_source_id`; execute re-validates it.
7. **Fake connector fixtures:** deterministic data covering vehicle, group node exclusion, parent/location refs, missing parent, duplicate names, PII-like fields.
8. **Test matrix:** content hash idempotency, schema parity/bootstrap, localOnly/protected job guard, dry-run no-write, batch rerun unchanged, partial failure/resume, managed-block roundtrip.

## 5. Gaps / risks found in code inventory

| Risk | Evidence | Required decision |
|---|---|---|
| MCP tool listing currently builds from all operations | `buildToolDefs(operations)` in MCP transport/tool defs; localOnly handling must be verified at transport/registration level before relying on hiding | For source-ingest, do not rely only on hidden tools. Put trust checks inside handlers and queue submission as defense-in-depth. |
| `submit_job` is admin-scope and remote-callable for non-protected names | `operations.ts:2830+` only rejects protected job names remotely | Add source-ingest mutating job names to protected set or make write op localOnly and submit internally. |
| Existing `put_page` itself is remote write-capable | It stamps remote provenance but still writes | Batch graph/value guarantees require local/trusted executor; do not expose bulk ingest as remote `put_page` loop. |
| Managed-block semantics are not present for source sync | Search found generic managed blocks for skillpack/takes fences, but no `gbrain-source-sync` parser | Build a dedicated tested module; do not reuse unrelated skill/takes fences blindly. |
| Run item table can grow unbounded | Minion jobs already store result/progress; op checkpoints have GC | Prefer capped job result + `source_sync_state` + checkpoints unless product requires item history; if table added, implement TTL/purge from day one. |
| DB-only vs git-backed writes can diverge | `writePageThrough` explicitly skips missing/wrong repos; sync is source/local_path oriented | Pilot must decide target `shared` storage mode before writing. |
| Cycle phase ordering is pinned by tests/comments | `ALL_PHASES` notes test assertion on order | Adding `source_refresh` requires updating phase tests and scope docs deliberately. |

## 6. Recommended Stage 1 file plan

### Add

- `src/core/source-ingest/profile-schema.ts`
- `src/core/source-ingest/profile-validator.ts`
- `src/core/source-ingest/connectors/types.ts`
- `src/core/source-ingest/connectors/fake.ts`
- `src/core/source-ingest/discovery.ts`
- `src/core/source-ingest/managed-block.ts`
- `src/core/source-ingest/renderer.ts`
- `src/core/minions/handlers/source-ingest.ts` or `ingest-third-party.ts`
- `test/source-ingest-profile-validator.test.ts`
- `test/source-ingest-managed-block.test.ts`
- `test/source-ingest-fake-connector.test.ts`
- `test/source-ingest-idempotency.test.ts`
- `evals/source-ingest-mapping/` fixtures and expectations

### Modify

- `src/core/operations.ts` — op contracts.
- `src/core/engine.ts` — typed DB methods if raw SQL is not kept module-local.
- `src/core/postgres-engine.ts` and `src/core/pglite-engine.ts` — parity methods.
- `src/core/migrate.ts` — new migrations.
- `src/schema.sql`, `src/core/pglite-schema.ts`, `src/core/schema-embedded.ts` — schema fan-out.
- `src/commands/jobs.ts` — register source-ingest handler.
- `src/core/minions/protected-names.ts` — protect mutating/costly job names.
- `src/core/cycle.ts` — later, add `source_refresh` phase after Stage 3 is stable.
- `test/e2e/engine-parity.test.ts` and `test/schema-bootstrap-coverage.test.ts` — extend coverage.
- `admin/src/App.tsx`, `admin/src/api.ts`, new admin pages — Stage 5, not Stage 1.

## 7. Minimal Stage 1 acceptance criteria

Stage 1 should be accepted only when all are true:

- [ ] Fake connector discovery returns deterministic schema, samples, counts, ID/update/parent candidates.
- [ ] Profile JSON Schema validates a worked vehicle profile and rejects invalid type/link/source/freshness shapes.
- [ ] Approved profile stores frozen `approved_source_id` and version/hash.
- [ ] New schema applies from migrations and fresh bootstrap in PGLite.
- [ ] Postgres/PGLite parity tests cover new methods or storage semantics.
- [ ] Read-side ops are visible over MCP and return structured errors.
- [ ] Write-side bulk ingest is not remote-callable except through trusted local execution path.
- [ ] No mutable sync metadata is written to page frontmatter.
- [ ] Managed-block module has unit tests before executor uses it.

## 8. Phase 0 conclusion

The repository has strong reusable substrate for source ingest: operations, source scoping, minion jobs, write-through rendering, cycle scheduling, checkpoints, progress, and schema parity tests. The implementation should therefore be a contract-first extension over existing primitives.

The genuinely new work is concentrated in:

1. connector/discovery/profile DSL;
2. agent mapping draft and evals;
3. managed-block merge;
4. source sync state schema;
5. dry-run report and rule-level link review;
6. local/trusted batch executor with resume/revert;
7. admin UI.

**Recommendation:** Stage 0 is complete as inventory. Next step is Stage 1 design/implementation plan for schema + contracts + fake connector, with user review before code changes beyond this document.
