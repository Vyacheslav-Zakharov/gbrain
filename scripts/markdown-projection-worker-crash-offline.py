#!/usr/bin/env python3
"""Process/FS-only supervisor tests, NOT database-death proof."""
import importlib.util
from pathlib import Path
import sys
import tempfile
spec=importlib.util.spec_from_file_location('crash',Path(__file__).with_name('markdown-projection-worker-crash-supervisor.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
    marker=str(Path(root,'receipt.json'))
    program="import json,os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(json.dumps({'stage':'after_write','pid':os.getpid()})); os.fork(); time.sleep(60)"
    m.crash(marker,[sys.executable,'-c',program,marker],1)
    Path(marker).unlink()
    try:
        m.crash(marker,[sys.executable,'-c','import time;time.sleep(60)'],.1)
    except TimeoutError:
        pass
    else:
        raise AssertionError('missing milestone accepted')
    try:
        m.crash(marker,[sys.executable,'-c','raise SystemExit(0)'],1)
    except RuntimeError as error:
        assert 'before crash boundary' in str(error)
    else:
        raise AssertionError('early clean exit accepted')
print('PASS SIGKILL milestone, fork reaping, missing milestone deadline, early exit refusal; NO DB proof')
