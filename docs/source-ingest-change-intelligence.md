# Source Ingest Change Intelligence v1

Status: definition and UI contract implemented; runtime planner/apply pipeline is not active yet.

## Purpose

Convert source-record changes into governed GBrain knowledge changes without treating every update as a blind Markdown overwrite.

```text
source snapshot
→ deterministic field diff
→ current-state projection
→ append-only business events
→ graph projection
→ optional agent proposals
→ approval gate
→ atomic apply
```

## Invariants

1. Source detection, snapshots, diffs, effective dates, idempotency and writes are deterministic.
2. Agent output is a proposal (`ChangePlan`), never a direct Markdown edit.
3. Current state and history are separate projections.
4. Manual page content stays outside source-managed blocks.
5. Related pages are graph-derived by default; cascaded prose edits require review.
6. Every applied change cites connector/object/external-id/source timestamp/run id.

## Article-view contract

`article_json.change_intelligence` and the compiled profile carry:

- `enabled`, `mode`, `snapshot_strategy`;
- `effective_at_field`;
- `current_state_fields`;
- `timeline_fields`;
- `relationship_rules`;
- related-page policy;
- agent semantic fields, allowed proposal actions and confidence threshold;
- deterministic, agent and cascade approval policies.

The v1 UI is under **Article view → Изменения**. It supplies editable fields and conservative presets for people/employees, deals, equipment/vehicles, companies, positions and departments/org units.

## Runtime model (next stage)

### Snapshot ledger

Persist the normalized selected source record before applying an update:

```text
source_record_snapshots
- connector_id
- source_object
- external_id
- source_updated_at
- record_hash
- record_json
- observed_at
- run_id
```

### Change events

```text
source_change_events
- event_id
- connector_id / source_object / external_id
- field
- old_value / new_value
- event_kind
- effective_at
- detected_at
- source_snapshot_before / after
- idempotency_key
```

### Change plan

```json
{
  "current_updates": [],
  "timeline_events": [],
  "graph_mutations": [],
  "agent_proposals": [],
  "related_page_impacts": [],
  "approval": {"required": true, "reasons": []},
  "evidence": []
}
```

### Apply semantics

- Current fields update only a source-managed current-state block.
- Timeline events are append-only and deduplicated by an idempotency key.
- Graph is the current relationship projection; historical relationship periods remain in snapshots/events until temporal edges are first-class.
- Neighboring pages are not blindly rewritten. `graph_projection` is the safe default.
- Agent proposals are applied only according to the frozen approval policy.

## Recommended defaults

- Deterministic current-state and Timeline events: automatic after reviewed mapping.
- Agent semantic proposals: always review initially.
- Neighboring-page/cascade edits: always review.
- Confidence threshold: 0.85.
- Effective date: explicit business-effective field, otherwise source `updated_at`, otherwise detection time with warning.

## Required runtime preview

Before approval/apply, show per source record:

```text
Current state
- position_id: old → new

Timeline
+ effective date — position changed old → new

Graph
- close current holds_position edge to old
+ open current holds_position edge to new

Related pages
- graph projection only; no prose rewrite

Agent proposals
- summary/timeline/related-page proposals with confidence and evidence
```

## Non-goals for v1 UI

- It does not execute an LLM.
- It does not mutate Timeline or graph during the current executor run.
- It does not enable temporal graph edges.
- It does not silently activate change tracking merely because a preset was selected; the Article View must still be saved, previewed and approved.
