#!/usr/bin/env python3
"""Offline process-only proof: no sockets/namespaces/database/container."""
import importlib.util
from pathlib import Path
import subprocess
import sys
spec=importlib.util.spec_from_file_location('supervisor',Path(__file__).with_name('markdown-projection-engine-supervisor.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
primary=ValueError('primary')
try:
    m.finish(primary,['secondary'])
except ValueError as e:
    assert e is primary
else:
    raise AssertionError('primary lost')
try:
    m.finish(None,['cleanup failed'])
except RuntimeError:
    pass
else:
    raise AssertionError('cleanup failure swallowed')
# Forking relay surrogate; intentionally ignore TERM to exercise escalation.
relay=[sys.executable,'-c','import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); os.fork(); time.sleep(60)']
try:
    m.supervise(relay,lambda:True,[sys.executable,'-c','import time; time.sleep(.1); raise SystemExit(7)'],2)
except subprocess.CalledProcessError as e:
    assert e.returncode == 7
else:
    raise AssertionError('command failure lost')
try:
    m.supervise(relay,lambda:True,[sys.executable,'-c','import time; time.sleep(60)'],.1)
except TimeoutError:
    pass
else:
    raise AssertionError('deadline lost')
print('PASS primary/secondary, cleanup-only failure, fork/group reaping and timeout')
