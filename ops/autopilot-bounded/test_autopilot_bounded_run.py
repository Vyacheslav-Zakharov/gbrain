from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


RUNNER_PATH = Path(__file__).with_name("autopilot-bounded-run.py")
SPEC = importlib.util.spec_from_file_location("autopilot_bounded_run", RUNNER_PATH)
assert SPEC is not None and SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def snapshot(
    *,
    take_ids: tuple[int, ...] = (),
    concept_ids: tuple[int, ...] = (),
    review_events: dict[int, tuple] | None = None,
) -> dict:
    return {
        "takes": {("internal-it", "pending"): len(take_ids)} if take_ids else {},
        "concepts": {("internal-it", "pending"): len(concept_ids)} if concept_ids else {},
        "take_rows": {row_id: ("internal-it", "pending") for row_id in take_ids},
        "concept_rows": {row_id: ("internal-it", "pending") for row_id in concept_ids},
        "review_events": review_events or {},
        "canonical_take_rows": {},
        "canonical_concept_rows": {},
        "jobs": {},
    }


class ProposalOnlyConfigurationTests(unittest.TestCase):
    def test_recurring_runner_is_strictly_proposal_only(self) -> None:
        self.assertEqual(RUNNER.PHASES, ("propose_takes",))
        self.assertEqual(RUNNER.SOURCES, ("internal-it",))
        self.assertEqual(RUNNER.MAX_PROVIDER_PAGES, 5)
        self.assertEqual(RUNNER.PILOT_MAX_ATTEMPTS, 3)
        self.assertEqual(RUNNER.MAX_PENDING_TAKES, 10)
        self.assertEqual(RUNNER.PILOT_AGGREGATE_COST_CAP_USD, 0.30)
        self.assertEqual(RUNNER.MAX_NEW_CONCEPTS, 0)
        self.assertEqual(RUNNER.CONFIGURED_COST_ENVELOPE_USD, 0.10)
        self.assertEqual(
            RUNNER.NONTERMINAL_JOB_STATES,
            ("waiting", "active", "delayed", "waiting-children", "paused"),
        )
        self.assertEqual(RUNNER.PILOT_START_DATE, "2026-08-19")
        runner_source = RUNNER_PATH.read_text(encoding="utf-8")
        self.assertIn(
            'child_env["GBRAIN_PROPOSE_TAKES_PAGE_LIMIT"] = str(MAX_PROVIDER_PAGES)',
            runner_source,
        )
        self.assertIn(
            'child_env["GBRAIN_PROPOSE_TAKES_MAX_NEW_TAKES"] = str(MAX_NEW_TAKES)',
            runner_source,
        )
        self.assertIn(
            'child_env["GBRAIN_PROPOSE_TAKES_WRITE_ATTEMPTS"] = "1"',
            runner_source,
        )

    def test_successful_cycle_returns_to_durable_hold(self) -> None:
        receipt = {"status": "ok", "run_id": "pilot-run", "stop_reasons": []}
        hold = RUNNER.hold_payload_for_receipt(receipt, Path("/private/receipt.json"))

        self.assertEqual(hold["status"], "hold")
        self.assertEqual(hold["reason"], "pilot_cycle_complete")
        self.assertEqual(hold["run_id"], "pilot-run")
        self.assertEqual(hold["receipt"], "/private/receipt.json")

    def test_runner_exception_preserves_in_progress_attempt_identity(self) -> None:
        existing = {
            "status": "hold",
            "reason": "pilot_cycle_in_progress",
            "run_id": "run-1",
            "source_id": "internal-it",
            "pilot_attempt": 1,
            "receipt": "/private/run-1/receipt.json",
        }

        hold = RUNNER.exception_hold_payload(existing, RuntimeError("secret message is not retained"))

        self.assertEqual(hold["reason"], "runner_exception")
        self.assertEqual(hold["previous_reason"], "pilot_cycle_in_progress")
        self.assertEqual(hold["run_id"], "run-1")
        self.assertEqual(hold["pilot_attempt"], 1)
        self.assertEqual(hold["receipt"], "/private/run-1/receipt.json")
        self.assertNotIn("secret message", json.dumps(hold))

        safe_hold = RUNNER.exception_hold_payload(existing, RuntimeError("pilot_venv_site_packages_missing"))
        self.assertEqual(safe_hold["error_code"], "pilot_venv_site_packages_missing")

    def test_pilot_attempt_count_uses_dedicated_immutable_ledgers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            for attempt, day in enumerate(("2026-08-19", "2026-08-20", "2026-08-21"), 1):
                marker = state / f"pilot-attempted-{day}.json"
                marker.write_text(json.dumps({
                    "status": "attempted",
                    "pilot_attempt": attempt,
                    "utc_day": day,
                    "source_id": "internal-it",
                    "run_id": f"run-{attempt}",
                    "reserved_budget_usd": "0.10",
                    "receipt": f"/private/run-{attempt}/receipt.json",
                }))
                marker.chmod(0o600)
            (state / "attempted-2026-08-18.json").write_text("{}")

            self.assertEqual(RUNNER.count_pilot_attempts(state), 3)
            capacity = RUNNER.pilot_capacity(state)
            self.assertEqual(capacity["attempts"], 3)
            self.assertEqual(capacity["reserved_budget_usd"], "0.30")
            self.assertFalse(capacity["next_attempt_allowed"])

    def test_attempt_marker_is_immutable_and_hold_precedes_provider_capable_work(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            hold = state / "HOLD.json"
            marker = RUNNER.begin_pilot_attempt(
                state=state,
                hold_path=hold,
                utc_day="2026-08-19",
                run_id="run-1",
                source="internal-it",
                attempt_number=1,
                receipt_path=state / "run-1" / "receipt.json",
            )
            original = marker.read_bytes()

            self.assertTrue(hold.is_file())
            self.assertEqual(json.loads(hold.read_text())["reason"], "pilot_cycle_in_progress")
            self.assertEqual(json.loads(marker.read_text())["status"], "attempted")
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                RUNNER.begin_pilot_attempt(
                    state=state,
                    hold_path=hold,
                    utc_day="2026-08-19",
                    run_id="run-duplicate",
                    source="internal-it",
                    attempt_number=1,
                    receipt_path=state / "run-duplicate" / "receipt.json",
                )
            self.assertEqual(marker.read_bytes(), original)

    def test_marker_before_explicit_pilot_cutoff_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            day = "2026-08-18"
            marker = state / f"pilot-attempted-{day}.json"
            marker.write_text(json.dumps({
                "status": "attempted",
                "pilot_attempt": 1,
                "utc_day": day,
                "source_id": "internal-it",
                "run_id": "pre-pilot",
                "reserved_budget_usd": "0.10",
                "receipt": "/private/pre-pilot/receipt.json",
            }))
            marker.chmod(0o600)

            with self.assertRaises(ValueError):
                RUNNER.pilot_capacity(state)

    def test_runtime_hash_manifest_is_strict_and_mode_600(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True)
            deployed = {name: root / name for name in ("runner", "wrapper", "service", "timer")}
            source_paths = {name: f"ops/autopilot-bounded/{name}" for name in deployed}
            for name, path in deployed.items():
                path.write_text(name)
                source = repo / source_paths[name]
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text(name)
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "runtime"], check=True)
            commit = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                check=True, text=True, capture_output=True,
            ).stdout.strip()
            manifest = root / "runtime.sha256"
            manifest.write_text("".join(
                f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path}\n"
                for path in deployed.values()
            ))
            manifest.chmod(0o600)

            verify = lambda: RUNNER.verify_runtime_hash_manifest(
                manifest, deployed, source_paths, repo, commit,
            )
            self.assertEqual(verify(), [])
            deployed["runner"].write_text("drift")
            self.assertIn("runtime_hash_mismatch:runner", verify())
            forged = hashlib.sha256(deployed["runner"].read_bytes()).hexdigest()
            lines = manifest.read_text().splitlines()
            manifest.write_text("\n".join(
                f"{forged}  {deployed['runner']}" if line.endswith(f"  {deployed['runner']}") else line
                for line in lines
            ) + "\n")
            self.assertIn("runtime_source_hash_mismatch:runner", verify())
            manifest.chmod(0o644)
            self.assertIn("runtime_manifest_permissions", verify())

    def test_systemd_unit_does_not_bypass_runner_hold_and_attempt_evidence(self) -> None:
        service = RUNNER_PATH.with_name("gbrain-autopilot.service").read_text()
        runner_source = RUNNER_PATH.read_text()
        runner_body = runner_source[runner_source.index("def run() -> int:"):]
        self.assertNotIn("ExecStartPre=", service)
        self.assertIn("UMask=0077", service)
        self.assertIn("ExecStart=/usr/bin/python3 %h/.gbrain/autopilot-bounded-run.py", service)
        self.assertNotIn("\nimport psycopg", runner_source[:runner_source.index("def load_runtime_dependencies")])
        self.assertLess(runner_body.index("begin_pilot_attempt("), runner_body.index("load_runtime_dependencies()"))
        self.assertEqual(RUNNER.EXTERNAL_RUNTIME_SOURCE_FILES["gateway"], "src/core/ai/gateway.ts")
        self.assertIs(RUNNER.EXTERNAL_RUNTIME_FILES["gateway"], RUNNER.INSTALLED_GATEWAY)

    def test_runtime_dependency_loader_is_bounded_and_redacts_shell_failure(self) -> None:
        original_files = RUNNER.GOVERNED_ENV_FILES
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            good = root / "good.sh"
            good.write_text("export PILOT_ENV_PROBE=loaded\n")
            try:
                RUNNER.GOVERNED_ENV_FILES = (good,)
                RUNNER.load_governed_environment()
                self.assertEqual(os.environ["PILOT_ENV_PROBE"], "loaded")

                bad = root / "bad.sh"
                bad.write_text("echo private-sentinel >&2\nfalse\n")
                RUNNER.GOVERNED_ENV_FILES = (bad,)
                with self.assertRaisesRegex(RuntimeError, "^governed_environment_load_failed$") as raised:
                    RUNNER.load_governed_environment()
                self.assertNotIn("private-sentinel", str(raised.exception))
            finally:
                RUNNER.GOVERNED_ENV_FILES = original_files
                os.environ.pop("PILOT_ENV_PROBE", None)

    def test_pinned_dependency_loader_fails_closed_without_matching_venv(self) -> None:
        original_venv = RUNNER.VENV
        with tempfile.TemporaryDirectory() as directory:
            try:
                RUNNER.VENV = Path(directory) / "missing-venv"
                with self.assertRaisesRegex(RuntimeError, "^pilot_venv_site_packages_missing$"):
                    RUNNER.load_pinned_psycopg()
            finally:
                RUNNER.VENV = original_venv

    def test_runner_rejects_producer_receipt_above_page_cap(self) -> None:
        report = {"status": "clean", "phases": []}
        within = {"status": "ok", "details": {"selected_pages": 5, "pages_scanned": 5}}
        above = {"status": "ok", "details": {"selected_pages": 6, "pages_scanned": 6}}

        self.assertTrue(RUNNER.phase_result_acceptable(report, "propose_takes", within))
        self.assertFalse(RUNNER.phase_result_acceptable(report, "propose_takes", above))


class PostflightSettleTests(unittest.TestCase):
    def test_settles_after_partial_phase_when_new_take_exists(self) -> None:
        self.assertTrue(
            RUNNER.has_new_review_targets(
                snapshot(),
                snapshot(take_ids=(991,)),
            )
        )

    def test_does_not_delay_failure_with_no_new_review_target(self) -> None:
        self.assertFalse(RUNNER.has_new_review_targets(snapshot(), snapshot()))

    def test_settles_when_new_concept_exists(self) -> None:
        self.assertTrue(
            RUNNER.has_new_review_targets(
                snapshot(),
                snapshot(concept_ids=(44,)),
            )
        )

    def test_postflight_snapshot_resamples_after_new_target_even_on_failed_phase_path(self) -> None:
        snapshots = iter([
            snapshot(take_ids=(991,)),
            snapshot(take_ids=(991,)),
        ])
        sleeps: list[int] = []

        post = RUNNER.settled_postflight_snapshot(
            object(),
            snapshot(),
            snapshot_fn=lambda _conn: next(snapshots),
            sleep_fn=sleeps.append,
        )

        self.assertEqual(sleeps, [RUNNER.POSTFLIGHT_SETTLE_SECONDS])
        self.assertEqual(set(post["take_rows"]), {991})
        with self.assertRaises(StopIteration):
            next(snapshots)

    def test_failed_phase_with_late_exact_assignment_keeps_only_phase_failure(self) -> None:
        pre = snapshot()
        snapshots = iter([
            snapshot(take_ids=(991,)),
            snapshot(
                take_ids=(991,),
                review_events={
                    1094: (
                        "take_proposal",
                        991,
                        "round_opened",
                        "system:assignment-sync",
                        "internal-it",
                        True,
                    ),
                },
            ),
        ])
        post = RUNNER.settled_postflight_snapshot(
            object(),
            pre,
            snapshot_fn=lambda _conn: next(snapshots),
            sleep_fn=lambda _seconds: None,
        )
        review = RUNNER.evaluate_postflight(pre, post, "internal-it", run_failed=True)

        self.assertEqual(review["stop_reasons"], ["phase_failure"])
        self.assertEqual(review["deltas"]["review_event_changes"], 0)
        self.assertEqual(review["deltas"]["allowed_assignment_event_ids"], [1094])
        self.assertTrue(review["auto_accept_publish_verified"])


if __name__ == "__main__":
    unittest.main()
