#!/usr/bin/env python3
"""Kill only after durable worker milestone; reuse bounded group reaping."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
spec = importlib.util.spec_from_file_location('relay_supervisor', Path(__file__).with_name('markdown-projection-engine-supervisor.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def crash(marker, command, seconds=8):
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('cannot enable subreaper')
    assert not Path(marker).exists(), 'stale milestone'
    proc = subprocess.Popen(command, start_new_session=True)
    primary, errors = None, []
    try:
        end = time.monotonic() + seconds
        while True:
            if proc.poll() is not None:
                raise RuntimeError('child exited before crash boundary')
            try:
                receipt = json.loads(Path(marker).read_text())
                break
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            if time.monotonic() >= end:
                raise TimeoutError('crash milestone deadline')
            time.sleep(.02)
        assert receipt['stage'] == 'after_write'
        assert receipt['pid'] == proc.pid
        os.killpg(proc.pid, signal.SIGKILL)
        assert proc.wait(timeout=2) == -signal.SIGKILL
    except BaseException as error:
        primary = error
    finally:
        try:
            m.cleanup_group(proc)
        except BaseException as error:
            errors.append(str(error))
        m.finish(primary, errors)
    print(json.dumps({'stage': 'worker.crash.reaped', 'pid': proc.pid, 'signal': 'SIGKILL', 'members': m.members(proc.pid)}), flush=True)


if __name__ == '__main__':
    crash(sys.argv[1], sys.argv[2:])
