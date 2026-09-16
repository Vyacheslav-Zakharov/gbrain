#!/usr/bin/env python3
"""Replay the actual hosted offline step in a fresh worktree, without a DB.
Usage: python3 -B scripts/markdown-projection-preengine-clean-offline.py WORKFLOW EVIDENCE [REF]
Keeps the worktree and all before/after statuses, including on failure.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

workflow, evidence = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
ref = sys.argv[3] if len(sys.argv) > 3 else 'HEAD'
source = Path(__file__).resolve().parent.parent
evidence.mkdir(parents=True, exist_ok=False)
root = evidence / 'source'
subprocess.run(['git', 'worktree', 'add', '--detach', str(root), ref], cwd=source, check=True)
# Real directory retains the repository's existing node_modules/ ignore semantics.
(root / 'node_modules').mkdir()
for entry in (source / 'node_modules').iterdir():
    (root / 'node_modules' / entry.name).symlink_to(entry.resolve())
text = workflow.read_text().split('      - name: Bounded offline worker regressions and typecheck\n', 1)[1].split('      - name:', 1)[0]
commands = [line.strip() for line in text.splitlines() if line.strip().startswith(('env -i ', 'timeout '))]
assert commands and all(' > "$EVIDENCE/' in command for command in commands)
env = dict(os.environ, EVIDENCE=str(evidence), RUNNER_TEMP=str(evidence), HOME=str(evidence / 'home'))
for key in ('DATABASE_URL', 'PYTHONDONTWRITEBYTECODE'):
    env.pop(key, None)
def status():
    return subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=root, text=True)
assert status() == '', 'fixture must start clean'
rows = []
for command in commands:
    before = status()
    result = subprocess.run(['bash', '-c', command], cwd=root, env=env, capture_output=True, text=True, timeout=135)
    row = dict(command=command, before=before, after=status(), exit=result.returncode, stderr=result.stderr)
    rows.append(row)
    (evidence / 'sequence.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(json.dumps(row), flush=True)
assert all(row['exit'] == 0 for row in rows), 'offline command failed; inspect sequence.json'
assert all(row['before'] == row['after'] == '' for row in rows), 'offline sequence mutated tracked/untracked source; inspect sequence.json'
print('PASS full hosted pre-engine offline sequence preserves clean source')
