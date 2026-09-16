#!/usr/bin/env python3
"""Offline actual subprocess tests: no database client is instantiated."""
import importlib.util
from pathlib import Path
import sys
import unittest

PATH = Path(__file__).with_name('markdown-projection-isolated-supervisor.py')

class Tests(unittest.TestCase):
    def test_success_requires_reaped_zero_exit(self):
        self.assertTrue(PATH.exists(), 'isolated supervisor missing')
        spec = importlib.util.spec_from_file_location('isolated', PATH)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        result = m.run([sys.executable, '-c', 'print(\'{"stage":"copy.complete","status":"idle"}\')'], {}, seconds=.5)
        self.assertEqual(result['status'], 'passed')
        self.assertTrue(result['attempts'][0]['reaped'])

    def load(self):
        spec = importlib.util.spec_from_file_location('isolated', PATH)
        m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        return m

    def test_exit_failure_retained_and_secrets_redacted(self):
        m = self.load()
        r = m.run([sys.executable, '-c', 'print("postgres://user:SECRET@host/db");raise SystemExit(7)'], {}, seconds=.5)
        self.assertEqual(r['status'], 'failed')
        self.assertEqual(r['attempts'][0]['exitCode'], 7)
        self.assertNotIn('SECRET', str(r))

    def test_success_marker_then_hang_killed_before_retry(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            pidfile = str(Path(d) / 'pid')
            code = '''import os,sys,time,signal
from pathlib import Path
p=Path(sys.argv[1])
if p.exists():
 old=int(p.read_text())
 try: os.kill(old,0)
 except ProcessLookupError: pass
 else: raise SystemExit(8)
 print('{"stage":"copy.complete","status":"idle"}',flush=True)
else:
 p.write_text(str(os.getpid()))
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 print('{"stage":"copy.complete","status":"idle"}',flush=True)
 while True: time.sleep(.1)
'''
            r = self.load().run([sys.executable,'-c',code,pidfile], {}, seconds=.15, attempts=2)
            self.assertEqual(r['status'], 'passed')
            self.assertEqual(len(r['attempts']), 2)
            self.assertIn('lifetime_deadline',r['attempts'][0]['errors'])
            self.assertEqual(r['attempts'][0]['exitCode'], -9)
            self.assertTrue(all(a['reaped'] for a in r['attempts']))

    def test_simulated_connection_loss_closes_admission(self):
        code = 'print(\'{"stage":"copy.failed","code":"connection_closed"}\');raise SystemExit(1)'
        r = self.load().run([sys.executable,'-c',code], {}, seconds=.5)
        self.assertEqual(r['status'], 'failed')
        self.assertIn('connection_closed',r['attempts'][0]['errors'])
        self.assertTrue(r['attempts'][0]['reaped'])

    def test_actual_executable_simulated_driver_success_loss_and_unhandled(self):
        import shutil
        config = {'admission':'HOSTED_DISPOSABLE_ONLY', 'connection':{
            'host':'127.0.0.1','port':5432,'database':'mp_accept_abcd','username':'fixture',
            'password':'SECRET','expectedServerAddress':'127.0.0.1','expectedServerPort':5432},
            'worker':{'enabled':True,'sourceId':'default','root':'/unused','inputRoots':[]}}
        fixture=PATH.with_name('markdown-projection-isolated-child-fixture.ts')
        for mode, expected in [('idle','passed'),('loss','failed'),('unhandled','failed')]:
            with self.subTest(mode=mode):
                r=self.load().run([shutil.which('bun'),str(fixture),mode],config,seconds=3)
                self.assertEqual(r['status'],expected)
                self.assertTrue(r['attempts'][0]['reaped'])
                if mode!='idle':
                    code='connection_closed' if mode=='loss' else 'unhandled_error'
                    self.assertIn(code,r['attempts'][0]['errors'])
                    self.assertEqual(r['attempts'][0]['exitCode'],1)
                    self.assertNotIn('child_unstructured_error_redacted',r['attempts'][0]['errors'])
                self.assertNotIn('SECRET',str(r))

    def test_actual_worker_rejects_unadmitted_config_without_db(self):
        import shutil
        worker = PATH.with_name('markdown-projection-isolated-worker.ts')
        self.assertTrue(worker.exists(), 'actual executable missing')
        r = self.load().run([shutil.which('bun'),str(worker)], {'password':'SECRET'}, seconds=3)
        self.assertEqual(r['status'], 'failed')
        self.assertIn('admission_failed',r['attempts'][0]['errors'])
        self.assertNotIn('SECRET',str(r))

if __name__ == '__main__':
    unittest.main()
