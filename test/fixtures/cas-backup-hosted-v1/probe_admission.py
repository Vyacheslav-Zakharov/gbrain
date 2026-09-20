#!/usr/bin/env python3
"""Offline blocking proof, NOT hosted backup/restore qualification.

Invokes the exact frozen CLI in dry-preflight mode, without monkeypatches,
authorization/fence fabrication, exporter execution or production source reads.
Synthetic manifest paths exist only below this explicitly test-only directory.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

BASE = pathlib.Path(__file__).resolve().parent
PIN = 'e95c15c162d3f95932eb95373f5cf246791dff8776957ca3aad02bfe42cad374'
PG_ARGV = ['/usr/lib/postgresql/16/bin/pg_dump', '--format=custom',
           '--no-password', '--host=/var/run/postgresql', '--port=5432',
           '--username=postgres', '--dbname=gbrain']
CATEGORIES = ['runtime', 'config', 'dependencies', 'canonical_roots',
              'git_state', 'archive_objects', 'roles_acl']


def main():
    assert hashlib.sha256((BASE / 'capture.py').read_bytes()).hexdigest() == PIN
    cases = []
    # No processes are launched by the executor: --execute is never supplied.
    # TemporaryDirectory cleanup covers only this probe's own manifest bytes.
    with tempfile.TemporaryDirectory(prefix='admission-only-', dir=BASE) as temp:
        root = pathlib.Path(temp)
        roots = [dict(category=c, path=str(root / c), dev=0, ino=0, uid=0)
                 for c in CATEGORIES]
        manifest = dict(schema='cas-local-capture-v1', mode='production',
                        identity={'host': 'synthetic-hosted-only',
                                  'database': 'gbrain', 'cluster': 'synthetic-disposable'},
                        roots=roots, allowed_roots=[r['path'] for r in roots],
                        output=str(root / 'output'), recipient=str(root / 'recipient'),
                        timeout_seconds=10, max_bytes=1048576, db={'argv': PG_ARGV})

        def probe(name, expected):
            path = root / 'manifest.json'
            raw = json.dumps(manifest).encode()
            path.write_bytes(raw)
            command = [sys.executable, '-B', str(BASE / 'capture.py'), str(path),
                       '--manifest-sha256', hashlib.sha256(raw).hexdigest(),
                       '--fixture-dir', str(root)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=5,
                                    env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent',
                                         'LC_ALL': 'C'})
            assert result.returncode == 2, (name, result.returncode)
            assert result.stderr.strip() == 'Refusal: ' + expected, (name, result.stderr)
            assert result.stdout == '', (name, result.stdout)
            assert not (root / 'output').exists()
            cases.append(dict(case=name, exit_code=result.returncode,
                              stderr=result.stderr.strip(), output_created=False))

        probe('production-grammar-synthetic-identity', 'target identity')
        manifest['mode'] = 'fixture'
        probe('fixture-mode-fixed-real-exporter', 'fixture escaped')
        manifest['db']['argv'] = [str(root / 'pg_dump')] + PG_ARGV[1:]
        probe('fixture-mode-contained-real-exporter-grammar', 'noncanonical simulated DB argv')
        manifest['mode'] = 'hosted'
        probe('no-third-hosted-mode', 'mode')
    print(json.dumps(dict(status='BLOCKED_FROZEN_SYNTHETIC_TARGET_ADMISSION',
                          executor_sha256=PIN, cases=cases,
                          export_executed=False, hosted_qualified=False,
                          authority_receipts_created=False, row8_closed=False), indent=2))


if __name__ == '__main__':
    main()
