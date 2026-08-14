from __future__ import annotations

import importlib.util
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
