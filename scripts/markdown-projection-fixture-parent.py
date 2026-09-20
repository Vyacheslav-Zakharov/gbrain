#!/usr/bin/env python3
"""Dedicated exclusive-child disposable CLI parent; not product recovery authority."""
import argparse
import contextlib
import ctypes
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location('reaper', Path(__file__).with_name('markdown-projection-engine-supervisor.py'))
reaper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reaper)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--scenario', required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not Path(args.root).is_absolute():
        raise ValueError('explicit command/root required')
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('cannot enable child subreaper')
    reaper.admit_owned_supervisor()
    def interrupted(sig, frame):
        raise RuntimeError('supervisor_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    proof = dict(protocol='disposable-cli-parent-v2', final=True, runId=args.run_id,
                 scenario=args.scenario, root=args.root, argv=command, launched=[],
                 reaped=False, errors=[])
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
        child = None
        try:
            child = subprocess.Popen(command, start_new_session=True, stdout=output, stderr=error)
            proof.update(pid=child.pid, launched=[child.pid])
            deadline = time.monotonic() + 28
            while child.poll() is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError('lifetime_deadline')
                if output.tell() + error.tell() > 524288:
                    raise RuntimeError('output_limit')
                time.sleep(.01)
        except BaseException as exc:
            proof['errors'].append(type(exc).__name__)
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            if child is not None:
                try:
                    with contextlib.redirect_stdout(sys.stderr):
                        reaper.cleanup_owned(child)
                    proof.update(reaped=True, childAccounting='ECHILD', members=[], sessionMembers=[])
                except BaseException:
                    proof['errors'].append('reaping_failed')
                proof['exit'] = child.returncode
        output.seek(0); error.seek(0)
        proof.update(stdout=output.read(524289).decode(errors='replace'), stderr=error.read(524289).decode(errors='replace'))
    print(json.dumps(proof), flush=True)
    return 0 if proof['reaped'] and not proof['errors'] else 1


if __name__ == '__main__':
    sys.exit(main())
