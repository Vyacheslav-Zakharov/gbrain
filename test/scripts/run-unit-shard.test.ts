/**
 * Regression test (b): scripts/run-unit-shard.sh exclusion symmetry.
 *
 * Pins the contract that the local fast-loop unit-shard script:
 *   1. EXCLUDES *.slow.test.ts (those run via scripts/run-slow-tests.sh).
 *   2. EXCLUDES *.serial.test.ts (those run via scripts/run-serial-tests.sh
 *      after the parallel pass).
 *   3. Includes plain *.test.ts files (the fast-loop unit set).
 *
 * Without this guard, a future refactor that drops one of the `-not -name`
 * clauses from the find expression would cause slow OR serial files to
 * run inside the parallel pass — silently undoing the quarantine and
 * re-introducing the contention flakes that motivated v0.26.4.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(shard = ''): string[] {
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: shard },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function dryRunBatches(batchSize: number | undefined, shard = ''): { headers: string[]; files: string[] } {
  const args = [SHARD_SH, '--dry-run-batches'];
  if (batchSize !== undefined) args.push(`--batch-size=${batchSize}`);
  const out = execFileSync('bash', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: shard },
  });
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  return {
    headers: lines.filter(line => line.startsWith('# batch ')),
    files: lines.filter(line => !line.startsWith('# batch ')),
  };
}

describe('run-unit-shard.sh exclusion symmetry', () => {
  it('lists at least one plain *.test.ts file', () => {
    const files = dryRunList();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => /\.test\.ts$/.test(f) && !/\.(slow|serial)\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.slow.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.slow\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes every *.serial.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes the test/e2e/ subtree', () => {
    const files = dryRunList();
    const leaks = files.filter(f => f.startsWith('test/e2e/'));
    expect(leaks).toEqual([]);
  });
});

describe('run-unit-shard.sh process-isolated batching', () => {
  it('defaults to one test file per Bun process', () => {
    const shard = '1/4';
    const expected = dryRunList(shard);
    const { headers, files } = dryRunBatches(undefined, shard);

    expect(files).toEqual(expected);
    expect(headers.length).toBe(expected.length);
    expect(headers.every(header => header.endsWith('(1 files)'))).toBe(true);
  });

  it('preserves deterministic shard selection and caps every batch', () => {
    const shard = '1/4';
    const batchSize = 17;
    const expected = dryRunList(shard);
    const { headers, files } = dryRunBatches(batchSize, shard);

    expect(files).toEqual(expected);
    expect(headers.length).toBe(Math.ceil(expected.length / batchSize));
    for (const header of headers) {
      const match = header.match(/\((\d+) files\)$/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(0);
      expect(Number(match![1])).toBeLessThanOrEqual(batchSize);
    }
  });

  it('rejects zero and non-numeric batch sizes', () => {
    for (const value of ['0', 'abc']) {
      const result = spawnSync('bash', [SHARD_SH, `--batch-size=${value}`, '--dry-run-batches'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('invalid batch size');
    }
  });

  it('propagates a failing Bun batch exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-fake-bun-'));
    const fakeBun = join(dir, 'bun');
    writeFileSync(fakeBun, '#!/usr/bin/env bash\nexit 42\n');
    chmodSync(fakeBun, 0o755);
    try {
      const result = spawnSync('bash', [SHARD_SH, '--batch-size=1'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          // Select exactly the first sorted file without adding a test-only
          // file-list override to the production runner.
          SHARD: '1/100000',
        },
      });
      expect(result.status).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast and does not start later batches after a Bun failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-fake-bun-fast-'));
    const fakeBun = join(dir, 'bun');
    const calls = join(dir, 'calls.log');
    writeFileSync(fakeBun, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 42\n`);
    chmodSync(fakeBun, 0o755);
    try {
      expect(dryRunList('1/500').length).toBeGreaterThan(1);
      const result = spawnSync('bash', [SHARD_SH, '--batch-size=1'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          SHARD: '1/500',
        },
      });
      expect(result.status).toBe(42);
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
