#!/usr/bin/env python3
"""Assemble the guarded G5 ACL S2 SQL from reviewed fragments."""
from __future__ import annotations

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PARTS = [
    "G5-ROLE-OWNERSHIP-TRANSFER-FRAGMENT-NOEXEC.sql.txt",
    "G5-RUNTIME-ACL-RLS-COMMAND-FRAGMENT-NOEXEC.sql.txt",
    "G5-RUNTIME-ROUTINE-TYPE-ACL-FRAGMENT-NOEXEC.sql.txt",
    "G5-RUNTIME-ACL-EXACT-POSTCONDITIONS-NOEXEC.sql.txt",
]
OUTPUT = ROOT / "G5-ACL-S2-ASSEMBLED-NOEXEC.sql.txt"
COMPONENT_MANIFEST = ROOT / "G5-ACL-S2-COMPONENT-SHA256SUMS"
GUARD = [
    r"\set ON_ERROR_STOP on",
    r"\echo 'NOEXEC ASSEMBLED S2: deliberate exception follows'",
    "DO $g5_noexec$ BEGIN RAISE EXCEPTION 'NOEXEC assembled S2: strip only after exact review, hosted proof and literal ACL GO'; END $g5_noexec$;",
    "",
]


def body(name: str) -> str:
    text = (ROOT / name).read_text(encoding="utf-8")
    lines = text.splitlines()
    if lines[0] != r"\set ON_ERROR_STOP on" or not lines[1].startswith(r"\echo 'NOEXEC"):
        raise SystemExit(f"unexpected guard prefix: {name}")
    if not lines[2].startswith("DO $g5_noexec$ BEGIN RAISE EXCEPTION 'NOEXEC") or not lines[2].endswith("END $g5_noexec$;"):
        raise SystemExit(f"missing deliberate guard exception: {name}")
    lines = lines[4:]
    if name == PARTS[0]:
        if lines[-1] != "COMMIT;":
            raise SystemExit("ownership fragment must end COMMIT")
        lines = lines[:-1]
    return "\n".join(lines).rstrip() + "\n"


expected = {}
for line in COMPONENT_MANIFEST.read_text(encoding="utf-8").splitlines():
    digest, name = line.split("  ", 1)
    expected[name] = digest
if set(expected) != set(PARTS):
    raise SystemExit("component manifest set mismatch")
for name in PARTS:
    actual = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    if actual != expected[name]:
        raise SystemExit(f"component hash mismatch: {name}")

chunks = ["\n".join(GUARD)]
for name in PARTS:
    data = (ROOT / name).read_bytes()
    chunks.append(f"-- BEGIN {name} sha256={hashlib.sha256(data).hexdigest()}\n")
    chunks.append(body(name))
    chunks.append(f"-- END {name}\n")
chunks.append("COMMIT;\n")
chunks.append("-- A fresh administrator connection must execute the separately bound exact verifier after commit.\n")
OUTPUT.write_text("".join(chunks), encoding="utf-8")
print(f"{hashlib.sha256(OUTPUT.read_bytes()).hexdigest()}  {OUTPUT.name}")
