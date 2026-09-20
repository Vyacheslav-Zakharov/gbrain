"""Offline reviewer fault regressions: inert children only, never PostgreSQL."""
import ast
import io
import json
import pathlib
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import Mock, patch
import qualify as q


class FakeChild:
    def __init__(self, cleanup=None):
        self.stdout = Mock(); self.stderr = Mock()
        self.cleanup = cleanup; self.waits = []; self.actions = []
    def __enter__(self): return self
    def __exit__(self, *args):
        self.wait()  # Faithful Popen context's hidden unbounded wait sentinel.
    def poll(self): return None
    def terminate(self): self.actions.append('TERM')
    def kill(self): self.actions.append('KILL')
    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.cleanup is not None: raise self.cleanup
        if timeout is None: raise AssertionError('unbounded wait sentinel')
        return 0


class GlobalsLifecycleTests(unittest.TestCase):
    def invoke(self):
        return q.pg('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-v',
                    'VERBOSITY=verbose', '--file=/synthetic/globals.sql')

    def faults(self, child, primary, constructor=False):
        sel = Mock()
        sel.__enter__ = Mock(return_value=sel)
        sel.__exit__ = Mock(return_value=False)
        sel.register.side_effect = primary
        return (patch.object(q.subprocess, 'Popen', return_value=child),
                patch.object(q.selectors, 'DefaultSelector',
                             **({'side_effect': primary} if constructor else {'return_value': sel})),
                patch.object(q.os, 'set_blocking'))

    def test_reviewer_constructor_timeout_category(self):
        child = FakeChild(OSError('SENTINEL cleanup'))
        primary = subprocess.TimeoutExpired([], 60)
        a,b,c = self.faults(child, primary, constructor=True)
        with a,b,c, self.assertRaises(q.capture.Refusal) as got:
            self.invoke()
        diagnostic = q.failure_diagnostic(got.exception, 'restore-data')
        self.assertEqual(diagnostic['failurecategory'], 'psql-timeout')
        self.assertNotIn('SENTINEL', json.dumps(diagnostic))

    def test_registration_timeout_exact_primary_and_traceback(self):
        child = FakeChild(OSError('SENTINEL cleanup'))
        primary = subprocess.TimeoutExpired([], 60)
        a,b,c = self.faults(child, primary)
        with a,b,c:
            try: q.bounded_globals_run(['inert'])
            except BaseException as got:
                self.assertIs(got, primary)
                self.assertTrue(any(t.tb_frame.f_code.co_name == '_execute_mock_call'
                                    for t in self.tracebacks(got.__traceback__)))
            else: self.fail('primary lost')
        self.assertTrue(child.waits)
        self.assertTrue(all(x is not None and 0 < x <= 1 for x in child.waits))
        self.assertIn('KILL', child.actions)

    @staticmethod
    def tracebacks(tb):
        while tb is not None:
            yield tb
            tb = tb.tb_next

    def test_registration_timeout_category_over_cleanup_oserror(self):
        child = FakeChild(OSError('SENTINEL cleanup'))
        a,b,c = self.faults(child, subprocess.TimeoutExpired([], 60))
        with a,b,c, self.assertRaises(q.capture.Refusal) as got: self.invoke()
        self.assertEqual(got.exception.safe_psql_category, 'psql-timeout')
        self.assertEqual(got.exception.safe_globals_diagnostic['sqlstate'], 'unknown')

    def test_no_unbounded_wait_or_context_exit(self):
        child = FakeChild()
        primary = subprocess.TimeoutExpired([], 60)
        a,b,c = self.faults(child, primary)
        with a,b,c:
            try: q.bounded_globals_run(['inert'])
            except BaseException as got: self.assertIs(got, primary)
            else: self.fail('primary lost')
        self.assertNotIn(None, child.waits)
        tree = ast.parse(pathlib.Path(q.__file__).read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'bounded_globals_run')
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'wait':
                self.assertTrue(any(k.arg == 'timeout' for k in n.keywords))
            if isinstance(n, ast.With):
                self.assertNotIn('Popen', ast.dump(n.items[0].context_expr))

    def test_pipe_close_error_preserves_primary(self):
        child = FakeChild()
        child.stdout.close.side_effect = OSError('SENTINEL pipe close')
        primary = subprocess.TimeoutExpired([], 60)
        a,b,c = self.faults(child, primary)
        with a,b,c:
            try: q.bounded_globals_run(['inert'])
            except BaseException as got: self.assertIs(got, primary)
            else: self.fail('primary lost')
        child.stderr.close.assert_called_once()

    def real_child(self, script, accelerated=False):
        real_popen = subprocess.Popen; clock = time.monotonic
        children = []; actions = []
        def launch(*args, **kwargs):
            p = real_popen(*args, **kwargs); children.append(p)
            if accelerated: self.assertEqual(p.stdout.read(1), b'R')
            for name in ('terminate', 'kill'):
                original = getattr(p, name)
                def call(original=original, name=name):
                    actions.append(name); return original()
                setattr(p, name, call)
            return p
        start = clock()
        try:
            with patch.object(q.subprocess, 'Popen', side_effect=launch), patch.object(q.time, 'monotonic', side_effect=lambda: clock() * (600 if accelerated else 1)):
                with self.assertRaises(subprocess.SubprocessError) as got:
                    q.bounded_globals_run([sys.executable, '-c', script])
            self.assertLess(clock() - start, 4)
            self.assertIsNotNone(children[0].returncode)
            return got.exception, children[0].returncode, actions
        finally:
            for p in children:
                if p.poll() is None: p.kill()
                p.wait(timeout=1)
                for pipe in (p.stdout,p.stderr):
                    if pipe is not None: pipe.close()

    def test_terminate_resistant_child_killed_and_reaped(self):
        exc, rc, actions = self.real_child('import os,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);os.write(1,b"R");time.sleep(10)', True)
        self.assertIsInstance(exc, subprocess.TimeoutExpired)
        self.assertEqual(rc, -signal.SIGKILL)
        self.assertEqual(actions, ['terminate', 'kill'])

    def test_stdout_cap(self):
        exc, _, _ = self.real_child('import os;os.write(1,b"S"*100000)')
        self.assertNotIsInstance(exc, subprocess.CalledProcessError)
        self.assertEqual(str(exc), 'output limit')

    def test_stderr_cap(self):
        exc, _, _ = self.real_child('import os;os.write(2,b"S"*100000)')
        self.assertNotIsInstance(exc, subprocess.CalledProcessError)
        self.assertEqual(str(exc), 'output limit')

    def test_aggregate_cap(self):
        exc, _, _ = self.real_child('import os;os.write(1,b"S"*40000);os.write(2,b"S"*40000)')
        self.assertEqual(str(exc), 'output limit')


if __name__ == '__main__': unittest.main(verbosity=2)
