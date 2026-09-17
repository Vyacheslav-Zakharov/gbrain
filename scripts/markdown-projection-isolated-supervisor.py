#!/usr/bin/env python3
"""Development-only bounded one-shot caller. JSON config on stdin, never argv.
Success requires completion AND zero exit AND kernel child/group/session closure.
Linux dedicated single-thread/exclusive-child supervisor; not OS-wide containment.
No database, Portal engine or shared pool exists in this supervisor.
"""
import ctypes
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location('reaper', Path(__file__).with_name('markdown-projection-engine-supervisor.py'))
reaper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reaper)


def run(command, config, seconds=20, attempts=1):
    if not math.isfinite(seconds) or not 0 < seconds <= 60 or not 1 <= attempts <= 3:
        raise ValueError('invalid bounded lifetime/attempts')
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('cannot enable subreaper')
    reaper.admit_owned_supervisor()
    receipts = []
    run_id = config.get('supervisionRunId') or str(uuid.uuid4())
    def final(status, **extra):
        return {'protocol': 'markdown-projection-reaping-v1', 'final': True,
                'runId': run_id, 'status': status, 'attempts': receipts, **extra}
    # Do not forward arbitrary child output: it can contain credentials or SQL data.
    # Retain only structured stage/code diagnostics from the private protocol.
    env = {'PATH': os.defpath, 'LANG': 'C.UTF-8'}
    for number in range(attempts):
        receipt = {'attempt': number + 1, 'runId': run_id, 'reaped': False, 'errors': []}
        receipts.append(receipt)
        with tempfile.TemporaryFile() as payload, tempfile.TemporaryFile() as output:
            payload.write(json.dumps(config).encode()); payload.seek(0)
            deadline = time.monotonic() + seconds
            proc = subprocess.Popen(command, stdin=payload, stdout=output, stderr=output,
                                    env=env, start_new_session=True)
            receipt['pid'] = proc.pid
            try:
                while proc.poll() is None:
                    if time.monotonic() >= deadline:
                        receipt['errors'].append('lifetime_deadline')
                        break
                    if output.tell() > 65536:
                        receipt['errors'].append('output_limit')
                        break
                    time.sleep(.01)
            except BaseException:
                receipt['errors'].append('supervisor_interrupted')
            finally:
                # Always join/reap, including a child that emitted success then hung.
                try:
                    import contextlib
                    with contextlib.redirect_stdout(sys.stderr):
                        reaper.cleanup_owned(proc)
                    receipt['reaped'] = True
                except BaseException:
                    receipt['errors'].append('reaping_failed')
            receipt['exitCode'] = proc.returncode
            output.seek(0)
            lines = output.read(65537).decode('utf8', errors='replace').splitlines()
            completed = []
            projection_status = None
            for line in lines:
                try:
                    event = json.loads(line)
                except ValueError:
                    if line: receipt['errors'].append('child_unstructured_error_redacted')
                    continue
                if not isinstance(event, dict):
                    receipt['errors'].append('child_protocol_error'); continue
                if event.get('stage') == 'copy.complete' and event.get('status') in ('idle', 'not_required', 'materialized'):
                    completed.append(event['status'])
                    if 'projectionStatus' in event:
                        data = event['projectionStatus']
                        if not isinstance(data, dict) or len(data) > 12 or not all(isinstance(k, str) and isinstance(v, str) and len(v) < 256 for k, v in data.items()):
                            receipt['errors'].append('child_protocol_error')
                        else:
                            projection_status = data
                elif event.get('stage') == 'copy.failed':
                    code = event.get('code')
                    allowed = {'connection_closed', 'unhandled_error', 'worker_failed', 'admission_failed'}
                    receipt['errors'].append(code if code in allowed else 'worker_failed')
                else:
                    receipt['errors'].append('child_protocol_error')
            if proc.returncode != 0: receipt['errors'].append('child_exit_failure')
            if len(completed) != 1: receipt['errors'].append('missing_unique_completion')
            if not receipt['errors'] and receipt['reaped']:
                return final('passed', copyStatus=completed[0], **({'projectionStatus': projection_status} if projection_status is not None else {}))
            # Never launch another child if prior lifetime/reaping is unproven.
            if not receipt['reaped']: break
    return final('failed')


def main():
    def interrupted(sig, frame):
        raise RuntimeError('supervisor_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    config = json.load(sys.stdin)
    # Explicit executable from the trusted caller, never ambient PATH discovery.
    if len(sys.argv) != 3 or sys.argv[1] != '--bun':
        raise RuntimeError('bun_required')
    bun = sys.argv[2]
    if not Path(bun).is_absolute() or not Path(bun).is_file() or not os.access(bun, os.X_OK):
        raise RuntimeError('bun_required')
    worker = 'markdown-projection-runtime-worker.ts' if config.get('admission') == 'PROTECTED_RUNTIME_V1' else 'markdown-projection-isolated-worker.ts'
    result = run([bun, str(Path(__file__).with_name(worker))], config)
    print(json.dumps(result), flush=True)
    return 0 if result['status'] == 'passed' else 1

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({'status': 'failed', 'error': 'supervisor_failure_redacted'}), flush=True)
        sys.exit(1)
