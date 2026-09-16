#!/usr/bin/env python3
"""Offline runner contracts: fake every `bun test`; only real LPT CLI executes.

Run: python3 scripts/test-shard-isolation.test.py
No dependencies, database, test modules, or product code are loaded.
"""
import collections
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TARGET = 'test/source-ingest-executor.test.ts'
REAL_BUN = shutil.which('bun')
FAKE = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
if args[:2] == ['run', 'scripts/sharding.ts']:
    if 'SELECTED' in os.environ:
        sys.stdin.read()
        print(os.environ['SELECTED'], end='')
        sys.exit(0)
    sys.exit(subprocess.call([os.environ['REAL_BUN'], *args]))
assert args[:2] == ['test', '--timeout=60000'], args
assert len(args) > 2, 'unfiltered bun test forbidden'
with open(os.environ['ARGV_LOG'], 'a') as f:
    f.write(json.dumps({'argv': args, 'pid': os.getpid()}) + '\n')
isolated = args[2:] == ['test/source-ingest-executor.test.ts']
sys.exit(int(os.environ.get('FAIL_ISOLATED' if isolated else 'FAIL_ORDINARY', '0')))
'''


class ShardIsolation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp = Path(self.temp.name)
        fake = self.tmp / 'bun'
        fake.write_text(FAKE)
        fake.chmod(0o755)
        self.log = self.tmp / 'argv.jsonl'
        self.env = {**os.environ, 'PATH': f'{self.tmp}:{os.environ["PATH"]}',
                    'REAL_BUN': REAL_BUN or '', 'ARGV_LOG': str(self.log)}
        for key in ('SELECTED', 'FAIL_ISOLATED', 'FAIL_ORDINARY', 'DATABASE_URL'):
            self.env.pop(key, None)

    def run_shard(self, index=1, total=10, dry=False, root=ROOT, **env):
        self.log.unlink(missing_ok=True)
        command = ['bash', str(root / 'scripts/test-shard.sh')]
        if dry:
            command.append('--dry-run-list')
        result = subprocess.run([*command, str(index), str(total)], cwd=root,
                                env={**self.env, **env}, text=True,
                                capture_output=True, timeout=15)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def test_all_ten_shards_preserve_inventory_and_isolate_only_owner(self):
        self.assertTrue(REAL_BUN, 'Bun required for pure LPT selection only')
        selected_all, invoked_all, owners, singleton_shards = [], [], [], []
        for index in range(1, 11):
            dry, calls = self.run_shard(index, dry=True)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertEqual(calls, [], 'dry-run must not execute tests')
            selected = dry.stdout.splitlines()
            result, calls = self.run_shard(index)
            self.assertEqual(result.returncode, 0, result.stderr)
            invoked = [file for call in calls for file in call['argv'][2:]]
            self.assertEqual(collections.Counter(selected), collections.Counter(invoked))
            ordinary = [file for file in selected if file != TARGET]
            expected = ([ordinary] if ordinary else []) + ([[TARGET]] if TARGET in selected else [])
            self.assertEqual([call['argv'][2:] for call in calls], expected,
                             f'shard {index}: target must run alone after ordinary batch')
            self.assertEqual(len({call['pid'] for call in calls}), len(calls))
            if TARGET in selected:
                owners.append(index)
            singleton_shards.extend(index for call in calls if call['argv'][2:] == [TARGET])
            selected_all.extend(selected)
            invoked_all.extend(invoked)
        tracked = subprocess.check_output(['git', 'ls-files', 'test'], cwd=ROOT, text=True).splitlines()
        dedicated = {'test/eval-longmemeval-e2e.slow.test.ts', 'test/entity-resolve-perf.slow.test.ts'}
        all_unit = [p for p in tracked if p.endswith('.test.ts') and not p.startswith('test/e2e/')]
        serial = [p for p in all_unit if p.endswith('.serial.test.ts')]
        eligible = [p for p in all_unit if p not in serial and p not in dedicated]
        self.assertEqual(collections.Counter(invoked_all), collections.Counter(eligible))
        self.assertEqual(collections.Counter(selected_all + serial + list(dedicated)), collections.Counter(all_unit))
        self.assertEqual(len(owners), 1)
        self.assertEqual(singleton_shards, owners)
        print(json.dumps({'matrix_files': len(invoked_all), 'owner': owners[0],
                          'singleton_invocations': len(singleton_shards),
                          'complete_non_e2e_files': len(all_unit)}))

    def test_failures_in_either_batch_still_attempt_both(self):
        selected = 'test/ordinary.test.ts\n' + TARGET + '\n'
        for ordinary, isolated in [('17', '0'), ('0', '23'), ('17', '23')]:
            with self.subTest(ordinary=ordinary, isolated=isolated):
                result, calls = self.run_shard(SELECTED=selected,
                    FAIL_ORDINARY=ordinary, FAIL_ISOLATED=isolated)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([c['argv'][2:] for c in calls],
                                 [['test/ordinary.test.ts'], [TARGET]])

    def test_empty_and_single_batch_selections_never_run_unfiltered(self):
        for selected in ['', TARGET + '\n', 'test/ordinary.test.ts\n',
                         'test/nested/source-ingest-executor.test.ts\n',
                         'test/a space.test.ts\n']:
            with self.subTest(selected=selected):
                result, calls = self.run_shard(SELECTED=selected)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = [selected.splitlines()] if selected else []
                self.assertEqual([c['argv'][2:] for c in calls], expected)
                dry, dry_calls = self.run_shard(dry=True, SELECTED=selected)
                self.assertEqual(dry.returncode, 0, dry.stderr)
                self.assertEqual(dry.stdout, selected)
                self.assertEqual(dry_calls, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
