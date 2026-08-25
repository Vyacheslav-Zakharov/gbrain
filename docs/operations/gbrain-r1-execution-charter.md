# GBrain R1 execution charter

Status: authorized for clone/candidate work only
Date: 2026-08-25

## Immutable inputs

- Plan: `/home/avers/.hermes/plans/2026-08-25_081500-gbrain-governed-upgrade-plan-v2.md`
- Owner decisions: `/home/avers/.hermes/cache/documents/doc_d6cc210e50b7_hermes-upgrade-owner-decisions.md`
- Independent plan review: `/home/avers/.hermes/cache/documents/doc_6be96972cd52_hermes-governed-upgrade-plan-review.md`
- Live source SHA: `92d76f26f248ccffdd8c97dc490f7f4184ad35cd`
- Upstream review target: `492b5528238dfea0ed9e3ee491805d83af86f6a6`
- Hosted ZeroEntropy shutdown: `2026-09-04`

## Current authorization

Authorized now:

- Lane A: R1.0 emergency runbook/additive-column spike and R1.1 baseline capture.
- Lane B: read-only R2.1 fork/path/value inventory.

Not authorized:

- production DB/config/guard/service mutation;
- production provider switch;
- R1.2 provider binding;
- R1.3+ production-affecting deployment;
- Autopilot recommission or HOLD clearance.

## Binding owner decisions

1. Work starts immediately; brief search degradation during a later approved production window is acceptable, but no gate may be compressed.
2. Full DB restore is the default rollback posture while estimated full re-embed cost remains approximately USD 1. If estimate materially exceeds USD 1, and especially if it exceeds USD 5, stop and re-confirm.
3. If the R1 candidate is not frozen by `2026-08-28` EOD, invoke emergency Decision 8 immediately.
4. The rehearsed additive-column bridge is the primary emergency semantic mode; FTS-only is the floor.
5. G3/G5/G9 artifacts go to fresh Claude Code sessions by file transfer only. Final audit uses a different model. Owner remains sole production approver.

## Additional verified execution constraints

- Autopilot must remain `HOLD`; timer presence is not authorization to clear HOLD.
- `takes.embedding` currently has 69 rows and 0 populated embeddings. Until an explicit re-disposition is reviewed, no writer may populate it.
- Do not allocate R1 migration `142` by assumption. Prefer a fork-namespaced operation marker that does not advance the scalar upstream watermark.
- Do not invoke ordinary GBrain CLI commands for read-only baseline collection: the exact fork auto-runs pending migrations during normal connections. Use direct read-only PostgreSQL and filesystem inspection.
- Production artifacts and review handoffs use files, never chat paste.
- No production dump may be created before encryption, named access, retention, and destruction policy are bound.

## Checkpoint status

- G0 owner decisions 3, 6, 7, 8: satisfied.
- Plan review: GO after v2 verification.
- G0.5: open until provider-down FTS proof and additive-column clone spike pass.
- G1: open until the scripted baseline evidence bundle is frozen and reviewed.
