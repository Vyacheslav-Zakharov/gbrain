# Bounded proposal-only Autopilot

This is the production recommissioning mode for the Avers GBrain installation.
It intentionally does **not** run the continuous `gbrain autopilot` loop.

## Contract

- systemd timer: daily at `03:15` local time with up to 10 minutes randomized delay;
- one UTC-day attempt ledger prevents duplicate manual or timer starts;
- one source per run, selected from the hard-coded allowlist;
- phases: `synthesize_concepts`, then `propose_takes`;
- no `extract_atoms`, auto-drain, grading, acceptance, publication, or Minion fan-out;
- per-phase timeout: 20 minutes; internal phase wall-time: 45 minutes; systemd timeout: 50 minutes, preserving a 5-minute postflight/HOLD margin;
- preflight refuses nonterminal jobs, pending Takes >20, pending Concepts >10, config drift, missing/mismatched mode-600 `~/.gbrain/state/autopilot-bounded/expected-source-commit`, or SHA-256 mismatch between the installed cycle files and the exact update-guard manifest;
- after successful phases, postflight waits 75 seconds (longer than the 60-second assignment synchronizer interval) before the final snapshot, so delayed review-round writes cannot race past the receipt;
- postflight creates `HOLD.json` on phase failure, any cross-source proposal/canonical fingerprint change, any review event other than (a) the exact one-to-one `system:propose_takes` supersede event paired with an allowed source-local transition or (b) the exact one-to-one `system:assignment-sync` `round_opened` event with validated state/detail shape for each new source-local pending proposal, any disallowed proposal mutation/deletion, any canonical Take/Concept full-row SHA-256 change, >10 gross new Take proposal IDs, or >5 gross new Concept proposal IDs; the only accepted `warn` is `propose_takes` under top-level `partial`, with exact `budget_exhausted=true`, 1–10 reported inserted proposals, exactly one warning matching the producer's complete budget-exhaustion format, and a postflight-equal count of actual new source-local pending Take IDs, because this is the expected hard-cap stop after bounded positive progress;
- configured phase envelope is `$0.35/run` (`$0.25` Concepts + `$0.10` Takes); both proposal phases use strict canonical-model-priced pre-dispatch worst-case reservations, while combined actual invoice attribution remains incomplete and must not be claimed as exact provider spend;
- all generated review objects must remain `pending` and canonical Concepts are not published.

## Required DB configuration

```text
autopilot.auto_drain.enabled=false
cycle.propose_takes.budget_usd=0.10
cycle.synthesize_concepts.budget_usd=0.25
cycle.conversation_facts_backfill.enabled=false
cycle.enrich_thin.enabled=false
```

## Installed paths

```text
~/.gbrain/autopilot-bounded-run.py
~/.gbrain/autopilot-bounded-run.sh
~/.gbrain/autopilot-venv/  # dedicated Python venv; require psycopg[binary]==3.3.4
~/.config/systemd/user/gbrain-autopilot.service
~/.config/systemd/user/gbrain-autopilot.timer
~/.gbrain/state/autopilot-bounded/
```

The installed files must be byte-identical to this directory's Git-backed copies. Provision the runner dependency in an isolated venv before any canary:

```bash
python3 -m venv ~/.gbrain/autopilot-venv
~/.gbrain/autopilot-venv/bin/pip install 'psycopg[binary]==3.3.4'
~/.gbrain/autopilot-venv/bin/python -c 'import psycopg; assert psycopg.__version__ == "3.3.4"'
```

## Enable

Only after exact-SHA runtime deployment, source-scope dry-run, config read-back, and one successful manual canary. Pin the deployed commit only after the update-guard manifest has been refreshed and read back:

```bash
install -m 600 /dev/null ~/.gbrain/state/autopilot-bounded/expected-source-commit
printf '%s\n' "$DEPLOYED_COMMIT" > ~/.gbrain/state/autopilot-bounded/expected-source-commit
test "$(cat ~/.gbrain/state/autopilot-bounded/expected-source-commit)" = \
  "$(jq -r .source_commit ~/.gbrain/update-guard/gbrain-customizations/0.42.53.0/manifest.json)"
systemctl --user daemon-reload
systemctl --user enable --now gbrain-autopilot.timer
```

The oneshot service is normally inactive between runs. The timer—not continuous service activity—is the steady-state liveness signal.

## HOLD recovery

Do not delete `HOLD.json` blindly. Read the referenced run receipt, reconcile queue/source deltas, fix the producer/configuration issue, run the source-scope smoke, and only then archive the hold file and run one controlled canary. A held or failed attempt still consumes that UTC day's attempt ledger unless the operator explicitly archives it as part of the audited recovery.

## Verification

```bash
systemctl --user status gbrain-autopilot.timer --no-pager
systemctl --user list-timers gbrain-autopilot.timer --no-pager
python3 -m py_compile ~/.gbrain/autopilot-bounded-run.py
systemd-analyze --user verify ~/.config/systemd/user/gbrain-autopilot.service ~/.config/systemd/user/gbrain-autopilot.timer
stat -c '%a %n' ~/.gbrain/autopilot-bounded-run.sh  # require executable mode (700 or 755)
sha256sum ~/.gbrain/autopilot-bounded-run.{sh,py}
```

Inspect the newest `~/.gbrain/state/autopilot-bounded/<run-id>/receipt.json` and require:

```text
status=ok
deltas.cross_source_proposals=0
deltas.cross_source_canonical=0
deltas.proposal_invariant_violations=0
deltas.review_event_changes=0
deltas.canonical_take_row_changes=0
deltas.canonical_concept_row_changes=0
deltas.nonterminal_jobs=0
len(deltas.gross_new_take_ids)<=10
len(deltas.gross_new_concept_ids)<=5
auto_accept_publish_verified=true
auto_drain=false
```
