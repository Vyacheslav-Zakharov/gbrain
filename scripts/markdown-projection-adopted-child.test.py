"""Real Linux subprocess tests; outer subreaper independently cleans each case."""
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest

SUPERVISOR = str(Path(__file__).with_name('markdown-projection-isolated-supervisor.py'))
CHILD = '''import os,signal,time
mode = MODE
if mode in ('escape', 'double', 'resistant', 'fork-on-term'):
 pid = os.fork()
 if pid == 0:
  os.setsid()
  if mode == 'double' and os.fork(): os._exit(0)
  if mode == 'resistant': signal.signal(signal.SIGTERM, signal.SIG_IGN)
  if mode == 'fork-on-term':
   def fork_again(sig, frame):
    if os.fork() == 0:
     os.setsid()
     signal.signal(signal.SIGTERM, signal.SIG_IGN)
     time.sleep(20)
    os._exit(0)
   signal.signal(signal.SIGTERM, fork_again)
  time.sleep(20)
  os._exit(0)
 time.sleep(.08)
print('{"stage":"copy.complete","status":"idle"}', flush=True)
if mode in ('hang', 'inventory-fault', 'wait-fault'): time.sleep(20)
'''


def cleanup_test_children():
    end = time.monotonic() + 3
    while time.monotonic() < end:
        for pid in Path(f'/proc/self/task/{os.getpid()}/children').read_text().split():
            try: os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError: pass
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if not pid: time.sleep(.01)
        except ChildProcessError:
            return
    raise AssertionError('test harness child residue')


class AdoptedChildren(unittest.TestCase):
    def case(self, mode):
        assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
        code = '''import importlib.util,os,sys,json,time
spec=importlib.util.spec_from_file_location('supervisor',sys.argv[1])
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
mode=sys.argv[2]
if mode in ('inventory-fault','wait-fault'):
 original=s.reaper.cleanup_owned
 def faulty(proc):
  if mode=='inventory-fault':
   def broken(): raise OSError('injected inventory failure')
   s.reaper.owned_children=broken
  else:
   def broken(*args): raise OSError('injected wait failure')
   s.reaper.os.waitpid=broken
  return original(proc)
 s.reaper.cleanup_owned=faulty
start=time.monotonic()
result=s.run([sys.executable,'-B','-c',sys.argv[3]],{},seconds=.25,attempts=2 if mode.endswith('fault') else 1)
print(json.dumps(result),flush=True)
assert time.monotonic()-start<6
if mode.endswith('fault'):
 assert result['status']=='failed' and len(result['attempts'])==1
 assert result['attempts'][0]['reaped'] is False
 assert 'lifetime_deadline' in result['attempts'][0]['errors']
 assert 'reaping_failed' in result['attempts'][0]['errors']
else:
 assert result['attempts'][0]['reaped'] is True
 assert result['status']==('failed' if mode=='hang' else 'passed')
 try: os.waitpid(-1,os.WNOHANG)
 except ChildProcessError: pass
 else: raise AssertionError('receipt returned with kernel-owned child remaining')
'''
        proc = subprocess.Popen([sys.executable, '-B', '-c', code, SUPERVISOR, mode,
                                 CHILD.replace('MODE', repr(mode))], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            output, _ = proc.communicate(timeout=8)
        finally:
            if proc.poll() is None: proc.kill()
            proc.wait(timeout=1)
            cleanup_test_children()
        self.assertEqual(proc.returncode, 0, output.decode())

    def test_escaped_session(self): self.case('escape')
    def test_double_fork(self): self.case('double')
    def test_term_resistant(self): self.case('resistant')
    def test_fork_during_termination(self): self.case('fork-on-term')
    def test_ordinary_success(self): self.case('ordinary')
    def test_marker_then_hang(self): self.case('hang')
    def test_inventory_failure(self): self.case('inventory-fault')
    def test_waitpid_failure(self): self.case('wait-fault')


if __name__ == '__main__': unittest.main()
