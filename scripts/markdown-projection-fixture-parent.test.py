#!/usr/bin/env python3
"""Actual dedicated parent boundary, no database or Bun worker required."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

PARENT = str(Path(__file__).with_name('markdown-projection-fixture-parent.py'))

class ParentTest(unittest.TestCase):
    def invoke(self, code):
        command = [sys.executable, '-B', '-c', code]
        child = subprocess.run([sys.executable, '-B', PARENT, '--run-id', 'fixture-test', '--scenario', 'offline', '--root', '/nonexistent/fixture-test', '--', *command], capture_output=True, text=True, timeout=12)
        self.assertEqual(child.returncode, 0, child.stderr)
        receipt = json.loads(child.stdout)
        self.assertEqual(receipt['argv'], command)
        self.assertEqual(receipt['runId'], 'fixture-test')
        self.assertEqual(receipt['childAccounting'], 'ECHILD')
        self.assertEqual(receipt['members'], [])
        self.assertEqual(receipt['sessionMembers'], [])
        self.assertTrue(receipt['reaped'])
        self.assertEqual(receipt['launched'], [receipt['pid']])
        return receipt

    def test_nonzero_preserved(self):
        self.assertEqual(self.invoke('print("primary");raise SystemExit(7)')['exit'], 7)

    def test_escaped_closed_pipe_adopted_child(self):
        r = self.invoke('import os,time\np=os.fork()\nif p==0:\n os.setsid();os.close(1);os.close(2);time.sleep(60)\nelse:\n print(p,flush=True)\n')
        self.assertEqual(r['exit'], 0)
        self.assertFalse(Path('/proc', r['stdout'].strip()).exists())

if __name__ == '__main__':
    unittest.main()
