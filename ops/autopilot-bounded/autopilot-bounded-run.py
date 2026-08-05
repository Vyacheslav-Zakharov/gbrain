#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

STATE = Path.home() / ".gbrain" / "state" / "autopilot-bounded"
HOLD = STATE / "HOLD.json"
LOCK = STATE / "run.lock"
EXPECTED_SOURCE_COMMIT = STATE / "expected-source-commit"
GBRAIN = Path.home() / ".bun" / "bin" / "gbrain"
INSTALLED_CYCLE = Path.home() / ".bun" / "install" / "global" / "node_modules" / "gbrain" / "src" / "core" / "cycle.ts"
INSTALLED_SYNTH = Path.home() / ".bun" / "install" / "global" / "node_modules" / "gbrain" / "src" / "core" / "cycle" / "synthesize-concepts.ts"
INSTALLED_PROPOSE = Path.home() / ".bun" / "install" / "global" / "node_modules" / "gbrain" / "src" / "core" / "cycle" / "propose-takes.ts"
SOURCES = (
    "internal-it",
    "internal-production",
    "internal-sales-marketing",
    "internal-hr",
    "internal-safety",
    "shared",
)
PHASES = ("synthesize_concepts", "propose_takes")
MAX_PENDING_TAKES = 20
MAX_PENDING_CONCEPTS = 10
MAX_NEW_TAKES = 10
MAX_NEW_CONCEPTS = 5
PHASE_TIMEOUT_SECONDS = 20 * 60
TOTAL_WALL_SECONDS = 45 * 60
POSTFLIGHT_SETTLE_SECONDS = 75
GUARD_MANIFEST = Path.home() / ".gbrain" / "update-guard" / "gbrain-customizations" / "0.42.53.0" / "manifest.json"
REQUIRED_RUNTIME_FILES = {
    "src/core/cycle.ts": INSTALLED_CYCLE,
    "src/core/cycle/synthesize-concepts.ts": INSTALLED_SYNTH,
    "src/core/cycle/propose-takes.ts": INSTALLED_PROPOSE,
}


def row_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def snapshot(conn: psycopg.Connection) -> dict:
    with conn.cursor() as cur:
        cur.execute("SELECT status, count(*)::int AS count FROM minion_jobs WHERE status IN ('waiting','active','delayed') GROUP BY status ORDER BY status")
        jobs = {r["status"]: r["count"] for r in cur.fetchall()}
        cur.execute("SELECT source_id, status, count(*)::int AS count FROM take_proposals GROUP BY source_id,status ORDER BY source_id,status")
        takes = {(r["source_id"], r["status"]): r["count"] for r in cur.fetchall()}
        cur.execute("SELECT source_id, status, count(*)::int AS count FROM concept_proposals GROUP BY source_id,status ORDER BY source_id,status")
        concepts = {(r["source_id"], r["status"]): r["count"] for r in cur.fetchall()}
        cur.execute("SELECT id,source_id,status,acted_at,acted_by,(to_jsonb(tp)-'status'-'acted_at'-'acted_by')::text AS payload_json,to_jsonb(tp)::text AS row_json FROM take_proposals tp ORDER BY id")
        take_rows = {
            r["id"]: (r["source_id"], r["status"], str(r["acted_at"] or ""), r["acted_by"] or "", row_sha256(r["payload_json"]), row_sha256(r["row_json"]))
            for r in cur.fetchall()
        }
        cur.execute("SELECT id,source_id,status,to_jsonb(cp)::text AS row_json FROM concept_proposals cp ORDER BY id")
        concept_rows = {r["id"]: (r["source_id"], r["status"], row_sha256(r["row_json"])) for r in cur.fetchall()}
        cur.execute("SELECT t.id,p.source_id,to_jsonb(t)::text AS row_json FROM takes t JOIN pages p ON p.id=t.page_id ORDER BY t.id")
        canonical_take_rows = {r["id"]: (r["source_id"], row_sha256(r["row_json"])) for r in cur.fetchall()}
        cur.execute("SELECT id,source_id,to_jsonb(p)::text AS row_json FROM pages p WHERE type='concept' ORDER BY id")
        canonical_concept_rows = {r["id"]: (r["source_id"], row_sha256(r["row_json"])) for r in cur.fetchall()}
        cur.execute("""
            SELECT id,target_type,target_id,action,actor,details->>'source_id' AS details_source_id,
                   CASE WHEN previous_state IS NULL
                         AND jsonb_typeof(new_state)='object'
                         AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(new_state) k)
                             = ARRAY['escalation_reason','policy_kind','status']::text[]
                         AND COALESCE(new_state->>'status','') <> ''
                         AND COALESCE(new_state->>'policy_kind','') <> ''
                         AND jsonb_typeof(details)='object'
                         AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(details) k)
                             = ARRAY['deadline_hours','due_at','reviewers','round_id','source_id']::text[]
                         AND COALESCE(details->>'round_id','') ~ '^[1-9][0-9]*$'
                         AND COALESCE(details->>'due_at','') <> ''
                         AND COALESCE(details->>'deadline_hours','') ~ '^[1-9][0-9]*$'
                         AND jsonb_typeof(details->'reviewers')='array'
                         AND jsonb_array_length(details->'reviewers') > 0
                        THEN true ELSE false END AS assignment_contract_ok,
                   to_jsonb(e)::text AS row_json
            FROM ai_review_events e ORDER BY id
        """)
        review_events = {
            r["id"]: (
                r["target_type"], r["target_id"], r["action"], r["actor"],
                r["details_source_id"] or "", r["assignment_contract_ok"], row_sha256(r["row_json"]),
            )
            for r in cur.fetchall()
        }
        cur.execute("SELECT p.source_id, count(*)::int AS count FROM takes t JOIN pages p ON p.id=t.page_id GROUP BY p.source_id ORDER BY p.source_id")
        canonical_takes = {r["source_id"]: r["count"] for r in cur.fetchall()}
        cur.execute("SELECT source_id, count(*)::int AS count FROM pages WHERE deleted_at IS NULL AND type='concept' GROUP BY source_id ORDER BY source_id")
        canonical_concepts = {r["source_id"]: r["count"] for r in cur.fetchall()}
        cur.execute("SELECT key,value FROM config WHERE key IN ('autopilot.auto_drain.enabled','cycle.propose_takes.budget_usd','cycle.synthesize_concepts.budget_usd','cycle.conversation_facts_backfill.enabled','cycle.enrich_thin.enabled') ORDER BY key")
        config = {r["key"]: r["value"] for r in cur.fetchall()}
    return {
        "jobs": jobs, "takes": takes, "concepts": concepts,
        "take_rows": take_rows, "concept_rows": concept_rows,
        "canonical_take_rows": canonical_take_rows,
        "canonical_concept_rows": canonical_concept_rows,
        "review_events": review_events,
        "canonical_takes": canonical_takes, "canonical_concepts": canonical_concepts,
        "config": config,
    }


def serializable_snapshot(value: dict) -> dict:
    return {
        "jobs": value["jobs"],
        "takes": [{"source_id": k[0], "status": k[1], "count": v} for k, v in sorted(value["takes"].items())],
        "concepts": [{"source_id": k[0], "status": k[1], "count": v} for k, v in sorted(value["concepts"].items())],
        "take_rows": [{"id": row_id, "fingerprint": list(fp)} for row_id, fp in sorted(value["take_rows"].items())],
        "concept_rows": [{"id": row_id, "fingerprint": list(fp)} for row_id, fp in sorted(value["concept_rows"].items())],
        "canonical_take_rows": [{"id": row_id, "fingerprint": list(fp)} for row_id, fp in sorted(value["canonical_take_rows"].items())],
        "canonical_concept_rows": [{"id": row_id, "fingerprint": list(fp)} for row_id, fp in sorted(value["canonical_concept_rows"].items())],
        "review_events": [{"id": row_id, "fingerprint": list(fp)} for row_id, fp in sorted(value["review_events"].items())],
        "canonical_takes": value["canonical_takes"],
        "canonical_concepts": value["canonical_concepts"],
        "config": value["config"],
    }


def evaluate_postflight(
    pre: dict,
    post: dict,
    source: str,
    run_failed: bool,
    expected_budget_take_count: int | None = None,
) -> dict:
    pending_take_delta = post["takes"].get((source, "pending"), 0) - pre["takes"].get((source, "pending"), 0)
    pending_concept_delta = post["concepts"].get((source, "pending"), 0) - pre["concepts"].get((source, "pending"), 0)
    take_status_deltas = {
        key: post["takes"].get(key, 0) - pre["takes"].get(key, 0)
        for key in set(pre["takes"]) | set(post["takes"])
        if post["takes"].get(key, 0) != pre["takes"].get(key, 0)
    }
    concept_status_deltas = {
        key: post["concepts"].get(key, 0) - pre["concepts"].get(key, 0)
        for key in set(pre["concepts"]) | set(post["concepts"])
        if post["concepts"].get(key, 0) != pre["concepts"].get(key, 0)
    }
    pre_take_ids, post_take_ids = set(pre["take_rows"]), set(post["take_rows"])
    pre_concept_ids, post_concept_ids = set(pre["concept_rows"]), set(post["concept_rows"])
    new_take_ids, new_concept_ids = post_take_ids - pre_take_ids, post_concept_ids - pre_concept_ids
    deleted_take_ids, deleted_concept_ids = pre_take_ids - post_take_ids, pre_concept_ids - post_concept_ids
    changed_take_ids = {i for i in pre_take_ids & post_take_ids if pre["take_rows"][i] != post["take_rows"][i]}
    changed_concept_ids = {i for i in pre_concept_ids & post_concept_ids if pre["concept_rows"][i] != post["concept_rows"][i]}
    invalid_new_takes = {i for i in new_take_ids if post["take_rows"][i][0] != source or post["take_rows"][i][1] != "pending"}
    invalid_new_concepts = {i for i in new_concept_ids if post["concept_rows"][i][0] != source or post["concept_rows"][i][1] != "pending"}
    allowed_take_supersedes = set()
    for row_id in changed_take_ids:
        before, after = pre["take_rows"][row_id], post["take_rows"][row_id]
        if (
            before[0] == source == after[0]
            and before[1] == "pending" and after[1] == "superseded"
            and after[2] and after[3] == "system:propose_takes"
            and before[4] == after[4]
        ):
            allowed_take_supersedes.add(row_id)
    proposal_invariant_violations = (
        len(invalid_new_takes) + len(invalid_new_concepts) + len(deleted_take_ids) + len(deleted_concept_ids)
        + len(changed_take_ids - allowed_take_supersedes) + len(changed_concept_ids)
    )
    pre_event_ids, post_event_ids = set(pre["review_events"]), set(post["review_events"])
    new_event_ids = post_event_ids - pre_event_ids
    deleted_event_ids = pre_event_ids - post_event_ids
    changed_existing_event_ids = {i for i in pre_event_ids & post_event_ids if pre["review_events"][i] != post["review_events"][i]}
    allowed_supersede_event_ids = {
        i for i in new_event_ids
        if post["review_events"][i][0] == "take_proposal"
        and post["review_events"][i][1] in allowed_take_supersedes
        and post["review_events"][i][2] == "supersede"
        and post["review_events"][i][3] == "system:propose_takes"
    }
    allowed_assignment_event_ids = {
        i for i in new_event_ids
        if (
            (post["review_events"][i][0], post["review_events"][i][1])
            in ({("take_proposal", row_id) for row_id in new_take_ids}
                | {("concept_proposal", row_id) for row_id in new_concept_ids})
        )
        and post["review_events"][i][2] == "round_opened"
        and post["review_events"][i][3] == "system:assignment-sync"
        and post["review_events"][i][4] == source
        and post["review_events"][i][5] is True
    }
    expected_supersede_targets = Counter(allowed_take_supersedes)
    actual_supersede_targets = Counter(post["review_events"][i][1] for i in allowed_supersede_event_ids)
    supersede_event_mismatch = sum((expected_supersede_targets - actual_supersede_targets).values()) + sum((actual_supersede_targets - expected_supersede_targets).values())
    expected_assignment_targets = Counter(
        [("take_proposal", row_id) for row_id in new_take_ids]
        + [("concept_proposal", row_id) for row_id in new_concept_ids]
    )
    actual_assignment_targets = Counter(
        (post["review_events"][i][0], post["review_events"][i][1])
        for i in allowed_assignment_event_ids
    )
    assignment_event_mismatch = sum((expected_assignment_targets - actual_assignment_targets).values()) + sum((actual_assignment_targets - expected_assignment_targets).values())
    allowed_new_event_ids = allowed_supersede_event_ids | allowed_assignment_event_ids
    review_event_violations = len(deleted_event_ids) + len(changed_existing_event_ids) + len(new_event_ids - allowed_new_event_ids) + supersede_event_mismatch + assignment_event_mismatch
    changed_canonical_take_ids = {i for i in set(pre["canonical_take_rows"]) | set(post["canonical_take_rows"]) if pre["canonical_take_rows"].get(i) != post["canonical_take_rows"].get(i)}
    changed_canonical_concept_ids = {i for i in set(pre["canonical_concept_rows"]) | set(post["canonical_concept_rows"]) if pre["canonical_concept_rows"].get(i) != post["canonical_concept_rows"].get(i)}
    canonical_changes = len(changed_canonical_take_ids) + len(changed_canonical_concept_ids)
    cross_source_proposal_changes = sum(
        1 for i in new_take_ids | deleted_take_ids | changed_take_ids if (post["take_rows"].get(i) or pre["take_rows"].get(i))[0] != source
    ) + sum(
        1 for i in new_concept_ids | deleted_concept_ids | changed_concept_ids if (post["concept_rows"].get(i) or pre["concept_rows"].get(i))[0] != source
    )
    cross_source_canonical_changes = sum(
        1 for i in changed_canonical_take_ids if (post["canonical_take_rows"].get(i) or pre["canonical_take_rows"].get(i))[0] != source
    ) + sum(
        1 for i in changed_canonical_concept_ids if (post["canonical_concept_rows"].get(i) or pre["canonical_concept_rows"].get(i))[0] != source
    )
    post_nonterminal = sum(post["jobs"].values())
    stop_reasons = []
    if run_failed: stop_reasons.append("phase_failure")
    if expected_budget_take_count is not None and (
        expected_budget_take_count != len(new_take_ids) or invalid_new_takes
    ):
        stop_reasons.append("budget_progress_mismatch")
    if len(new_take_ids) > MAX_NEW_TAKES: stop_reasons.append("take_review_capacity_exceeded")
    if len(new_concept_ids) > MAX_NEW_CONCEPTS: stop_reasons.append("concept_review_capacity_exceeded")
    if cross_source_proposal_changes or cross_source_canonical_changes: stop_reasons.append("cross_source_write")
    if proposal_invariant_violations: stop_reasons.append("proposal_invariant_violation")
    if review_event_violations: stop_reasons.append("automatic_owner_decision")
    if canonical_changes: stop_reasons.append("canonical_publication")
    if post_nonterminal: stop_reasons.append("nonterminal_jobs_after")
    deltas = {
        "pending_takes_net": pending_take_delta,
        "pending_concepts_net": pending_concept_delta,
        "gross_new_take_ids": sorted(new_take_ids),
        "gross_new_concept_ids": sorted(new_concept_ids),
        "reported_budget_exhausted_take_count": expected_budget_take_count,
        "allowed_take_supersede_ids": sorted(allowed_take_supersedes),
        "allowed_assignment_event_ids": sorted(allowed_assignment_event_ids),
        "take_proposal_statuses": [{"source_id": k[0], "status": k[1], "delta": v} for k, v in sorted(take_status_deltas.items())],
        "concept_proposal_statuses": [{"source_id": k[0], "status": k[1], "delta": v} for k, v in sorted(concept_status_deltas.items())],
        "proposal_invariant_violations": proposal_invariant_violations,
        "review_event_changes": review_event_violations,
        "canonical_take_row_changes": len(changed_canonical_take_ids),
        "canonical_concept_row_changes": len(changed_canonical_concept_ids),
        "cross_source_proposals": cross_source_proposal_changes,
        "cross_source_canonical": cross_source_canonical_changes,
        "nonterminal_jobs": post_nonterminal,
    }
    return {
        "stop_reasons": stop_reasons,
        "auto_accept_publish_verified": not (
            proposal_invariant_violations or review_event_violations or canonical_changes
            or cross_source_proposal_changes or cross_source_canonical_changes
        ),
        "deltas": deltas,
    }


def parse_report(stdout: str) -> dict | None:
    decoder = json.JSONDecoder()
    for index, char in enumerate(stdout):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(stdout[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "phases" in value:
            return value
    return None


def phase_result(report: dict | None, phase: str) -> dict | None:
    if not report:
        return None
    for item in report.get("phases", []):
        if item.get("phase") == phase:
            return item
    return None


def phase_result_acceptable(report: dict | None, phase: str, result: dict | None) -> bool:
    if not report or not result or report.get("status") not in {"clean", "partial"}:
        return False
    status = result.get("status")
    if status in {"ok", "skipped"}:
        return True
    details = result.get("details")
    if (
        phase != "propose_takes"
        or report.get("status") != "partial"
        or status != "warn"
        or not isinstance(details, dict)
    ):
        return False
    inserted = details.get("proposals_inserted")
    warnings = details.get("warnings")
    return (
        details.get("budget_exhausted") is True
        and isinstance(inserted, int) and not isinstance(inserted, bool)
        and 0 < inserted <= MAX_NEW_TAKES
        and isinstance(warnings, list) and len(warnings) == 1
        and isinstance(warnings[0], str)
        and re.fullmatch(
            r"budget exhausted at page [1-9]\d*/[1-9]\d* \(reserved \$\d+\.\d{4} / cap \$\d+\.\d{2}\)",
            warnings[0],
        ) is not None
    )


def run() -> int:
    STATE.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    lock_handle = LOCK.open("a+")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"status": "refused", "reason": "overlap_lock"}))
        return 2

    now = dt.datetime.now(dt.timezone.utc)
    day = now.date().isoformat()
    attempted = STATE / f"attempted-{day}.json"
    if HOLD.exists():
        print(json.dumps({"status": "refused", "reason": "durable_hold", "hold": str(HOLD)}))
        return 2
    if attempted.exists():
        print(json.dumps({"status": "skipped", "reason": "daily_cap", "ledger": str(attempted)}))
        return 0

    override = os.environ.get("GBRAIN_AUTOPILOT_SOURCE")
    source = override or SOURCES[now.toordinal() % len(SOURCES)]
    if source not in SOURCES:
        print(json.dumps({"status": "refused", "reason": "source_not_allowlisted"}))
        return 2

    try:
        guard_manifest = json.loads(GUARD_MANIFEST.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "refused", "reason": "guard_manifest_unreadable", "error_type": type(exc).__name__}))
        return 2
    guard_files = guard_manifest.get("files") if isinstance(guard_manifest, dict) else None
    hash_mismatches = []
    for relative_path, runtime_path in REQUIRED_RUNTIME_FILES.items():
        expected = guard_files.get(relative_path, {}).get("sha256") if isinstance(guard_files, dict) else None
        try:
            actual = hashlib.sha256(runtime_path.read_bytes()).hexdigest()
        except OSError:
            actual = None
        if not expected or actual != expected:
            hash_mismatches.append({"path": relative_path, "expected": expected, "actual": actual})
    if hash_mismatches:
        print(json.dumps({"status": "refused", "reason": "runtime_guard_hash_mismatch", "files": hash_mismatches}))
        return 2
    guard_source_commit = guard_manifest.get("source_commit")
    try:
        expected_source_commit = EXPECTED_SOURCE_COMMIT.read_text().strip()
        pin_stat = EXPECTED_SOURCE_COMMIT.stat()
        pin_permissions_valid = (pin_stat.st_mode & 0o777) == 0o600 and pin_stat.st_uid == os.getuid()
    except OSError:
        expected_source_commit = ""
        pin_permissions_valid = False
    if not pin_permissions_valid or not isinstance(guard_source_commit, str) or len(guard_source_commit) != 40 or guard_source_commit != expected_source_commit:
        print(json.dumps({"status": "refused", "reason": "guard_source_commit_mismatch"}))
        return 2

    started = dt.datetime.now(dt.timezone.utc)
    run_id = started.strftime("%Y%m%dT%H%M%SZ") + f"-{source}"
    run_dir = STATE / run_id
    run_dir.mkdir(mode=0o700)
    atomic_json(attempted, {"run_id": run_id, "source_id": source, "started_at": started.isoformat(), "status": "started"})

    with psycopg.connect("", row_factory=dict_row) as conn:
        pre = snapshot(conn)
        atomic_json(run_dir / "pre.json", serializable_snapshot(pre))
        nonterminal = sum(pre["jobs"].values())
        pending_takes = sum(v for (s, status), v in pre["takes"].items() if status == "pending")
        pending_concepts = sum(v for (s, status), v in pre["concepts"].items() if status == "pending")
        config = pre["config"]
        gates = {
            "nonterminal_jobs": nonterminal,
            "pending_takes": pending_takes,
            "pending_concepts": pending_concepts,
            "auto_drain": config.get("autopilot.auto_drain.enabled"),
            "propose_budget_usd": config.get("cycle.propose_takes.budget_usd"),
            "concept_budget_usd": config.get("cycle.synthesize_concepts.budget_usd"),
            "conversation_backfill": config.get("cycle.conversation_facts_backfill.enabled"),
            "enrich_thin": config.get("cycle.enrich_thin.enabled"),
            "runtime_guard_source_commit": guard_source_commit,
            "runtime_guard_hash_parity": True,
        }
        failures = []
        if nonterminal != 0:
            failures.append("nonterminal_jobs")
        if pending_takes > MAX_PENDING_TAKES:
            failures.append("pending_takes_capacity")
        if pending_concepts > MAX_PENDING_CONCEPTS:
            failures.append("pending_concepts_capacity")
        if config.get("autopilot.auto_drain.enabled") != "false":
            failures.append("auto_drain_not_false")
        if config.get("cycle.propose_takes.budget_usd") != "0.10":
            failures.append("propose_budget_mismatch")
        if config.get("cycle.synthesize_concepts.budget_usd") != "0.25":
            failures.append("concept_budget_mismatch")
        if config.get("cycle.conversation_facts_backfill.enabled") != "false":
            failures.append("conversation_backfill_not_false")
        if config.get("cycle.enrich_thin.enabled") != "false":
            failures.append("enrich_thin_not_false")
        if failures:
            receipt = {"status": "refused", "run_id": run_id, "source_id": source, "gates": gates, "failures": failures}
            atomic_json(run_dir / "receipt.json", receipt)
            atomic_json(HOLD, receipt)
            atomic_json(attempted, {**receipt, "ended_at": dt.datetime.now(dt.timezone.utc).isoformat()})
            print(json.dumps(receipt, ensure_ascii=False))
            return 2

        phase_receipts = []
        deadline = time.monotonic() + TOTAL_WALL_SECONDS
        run_failed = False
        expected_budget_take_count = None
        for phase in PHASES:
            remaining = int(deadline - time.monotonic())
            if remaining <= 0:
                phase_receipts.append({"phase": phase, "exit_code": 124, "error": "total_walltime_exhausted"})
                run_failed = True
                break
            timeout = min(PHASE_TIMEOUT_SECONDS, remaining)
            command = [str(GBRAIN), "dream", "--json", "--source", source, "--phase", phase]
            try:
                proc = subprocess.run(command, text=True, capture_output=True, timeout=timeout, check=False)
                rc = proc.returncode
            except subprocess.TimeoutExpired as exc:
                proc = None
                rc = 124
                stdout = exc.stdout if isinstance(exc.stdout, str) else ""
                stderr = exc.stderr if isinstance(exc.stderr, str) else ""
            else:
                stdout = proc.stdout
                stderr = proc.stderr
            (run_dir / f"{phase}.stdout").write_text(stdout)
            (run_dir / f"{phase}.stderr").write_text(stderr)
            os.chmod(run_dir / f"{phase}.stdout", 0o600)
            os.chmod(run_dir / f"{phase}.stderr", 0o600)
            report = parse_report(stdout)
            result = phase_result(report, phase)
            phase_receipts.append({
                "phase": phase,
                "exit_code": rc,
                "cycle_status": report.get("status") if report else None,
                "phase_status": result.get("status") if result else None,
                "summary": result.get("summary") if result else None,
                "details": result.get("details") if result else None,
            })
            accepted = rc == 0 and phase_result_acceptable(report, phase, result)
            if accepted and phase == "propose_takes" and result.get("status") == "warn":
                expected_budget_take_count = result["details"]["proposals_inserted"]
            if not accepted:
                run_failed = True
                break

        if not run_failed:
            time.sleep(POSTFLIGHT_SETTLE_SECONDS)
        post = snapshot(conn)
        atomic_json(run_dir / "post.json", serializable_snapshot(post))

        assessment = evaluate_postflight(
            pre,
            post,
            source,
            run_failed,
            expected_budget_take_count=expected_budget_take_count,
        )
        stop_reasons = assessment["stop_reasons"]

        receipt = {
            "status": "hold" if stop_reasons else "ok",
            "run_id": run_id,
            "source_id": source,
            "started_at": started.isoformat(),
            "ended_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "gates": gates,
            "phases": phase_receipts,
            "deltas": assessment["deltas"],
            "stop_reasons": stop_reasons,
            "auto_accept_publish_verified": assessment["auto_accept_publish_verified"],
            "auto_drain": False,
            "daily_run_cap": 1,
            "review_capacity": {"gross_new_takes": MAX_NEW_TAKES, "gross_new_concepts": MAX_NEW_CONCEPTS},
            "walltime_cap_minutes": 45,
            "configured_cost_envelope_usd": 0.35,
            "actual_spend_usd": None,
            "actual_spend_note": "propose_takes tracker is not exposed; do not treat configured envelope as invoice attribution",
        }
        atomic_json(run_dir / "receipt.json", receipt)
        atomic_json(attempted, receipt)
        if stop_reasons:
            atomic_json(HOLD, receipt)
        print(json.dumps(receipt, ensure_ascii=False))
        return 2 if stop_reasons else 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except SystemExit:
        raise
    except Exception as exc:
        receipt = {
            "status": "hold",
            "reason": "runner_exception",
            "error_type": type(exc).__name__,
            "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        atomic_json(HOLD, receipt)
        print(json.dumps(receipt, ensure_ascii=False))
        raise SystemExit(2)