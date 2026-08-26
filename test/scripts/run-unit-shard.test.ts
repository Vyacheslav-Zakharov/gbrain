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
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(): string[] {
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '', GBRAIN_TEST_RUN_ID: 'test-run' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
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

function batchingSandbox(fileCount = 5): { root: string; callsPath: string; markerPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-unit-batching-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(SHARD_SH, join(root, 'scripts', 'run-unit-shard.sh'));
  chmodSync(join(root, 'scripts', 'run-unit-shard.sh'), 0o755);
  for (let i = 1; i <= fileCount; i++) {
    writeFileSync(join(root, 'test', `${i}.test.ts`), '// fixture\n');
  }
  return { root, callsPath: join(root, 'bun-calls.txt'), markerPath: join(root, 'failed-once') };
}

describe('run-unit-shard.sh recycled process batches', () => {
  it('keeps direct-run receipts isolated by run id', () => {
    const sb = batchingSandbox(1);
    try {
      writeFileSync(join(sb.root, 'bin', 'bun'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(join(sb.root, 'bin', 'bun'), 0o755);
      for (const runId of ['run-a', 'run-b']) {
        const result = spawnSync('bash', [join(sb.root, 'scripts', 'run-unit-shard.sh')], {
          cwd: sb.root,
          encoding: 'utf-8',
          env: { ...process.env, PATH: `${join(sb.root, 'bin')}:${process.env.PATH ?? ''}`, SHARD: '', GBRAIN_TEST_RUN_ID: runId },
        });
        expect(result.status).toBe(0);
      }
      expect(readFileSync(join(sb.root, '.context/test-batches/run-a/unsharded.jsonl'), 'utf-8')).toContain('"complete":true');
      expect(readFileSync(join(sb.root, '.context/test-batches/run-b/unsharded.jsonl'), 'utf-8')).toContain('"complete":true');
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  });

  it('runs five files as three fresh Bun batches and writes a completion receipt', () => {
    const sb = batchingSandbox();
    try {
      writeFileSync(join(sb.root, 'bin', 'bun'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${sb.callsPath}"\n`);
      chmodSync(join(sb.root, 'bin', 'bun'), 0o755);
      const result = spawnSync('bash', [join(sb.root, 'scripts', 'run-unit-shard.sh'), '--batch-size', '2'], {
        cwd: sb.root, encoding: 'utf-8',
        env: { ...process.env, PATH: `${join(sb.root, 'bin')}:${process.env.PATH ?? ''}`, SHARD: '', GBRAIN_TEST_RUN_ID: 'test-run' },
      });
      expect(result.status).toBe(0);
      const calls = readFileSync(sb.callsPath, 'utf-8').trim().split('\n');
      expect(calls).toHaveLength(3);
      expect(calls.map(line => line.match(/test\/[1-5]\.test\.ts/g)?.length ?? 0)).toEqual([2, 2, 1]);
      const receipt = readFileSync(join(sb.root, '.context/test-batches/test-run/unsharded.jsonl'), 'utf-8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(receipt.filter(row => row.kind === 'batch')).toHaveLength(3);
      expect(receipt.at(-1)).toMatchObject({ kind: 'complete', complete: true, rc: 0, files_total: 5, batches_total: 3 });
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  });

  it('continues later batches after the first failure and returns the first non-zero rc', () => {
    const sb = batchingSandbox(4);
    try {
      writeFileSync(join(sb.root, 'bin', 'bun'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${sb.callsPath}"\nif [ ! -f "${sb.markerPath}" ]; then touch "${sb.markerPath}"; exit 7; fi\n`);
      chmodSync(join(sb.root, 'bin', 'bun'), 0o755);
      const result = spawnSync('bash', [join(sb.root, 'scripts', 'run-unit-shard.sh'), '--batch-size', '2'], {
        cwd: sb.root, encoding: 'utf-8',
        env: { ...process.env, PATH: `${join(sb.root, 'bin')}:${process.env.PATH ?? ''}`, SHARD: '', GBRAIN_TEST_RUN_ID: 'test-run' },
      });
      expect(result.status).toBe(7);
      expect(readFileSync(sb.callsPath, 'utf-8').trim().split('\n')).toHaveLength(2);
      const receipt = readFileSync(join(sb.root, '.context/test-batches/test-run/unsharded.jsonl'), 'utf-8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(receipt.filter(row => row.kind === 'batch').map(row => row.rc)).toEqual([7, 0]);
      expect(receipt.at(-1)).toMatchObject({ kind: 'complete', complete: true, rc: 7, files_total: 4, batches_total: 2 });
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  });

  it('isolates migration files in snapshot-free cold batches', () => {
    const sb = batchingSandbox(1);
    try {
      writeFileSync(join(sb.root, 'test', 'migrate.test.ts'), '// cold fixture\n');
      const snapshotOptOut = ['delete', 'process.env.GBRAIN_PGLITE_SNAPSHOT;'].join(' ');
      writeFileSync(join(sb.root, 'test', 'custom.test.ts'), `${snapshotOptOut}\n`);
      writeFileSync(join(sb.root, 'bin', 'bun'), `#!/usr/bin/env bash\nprintf 'snapshot=%s args=%s\\n' "\${GBRAIN_PGLITE_SNAPSHOT-}" "$*" >> "${sb.callsPath}"\n`);
      chmodSync(join(sb.root, 'bin', 'bun'), 0o755);
      const result = spawnSync('bash', [join(sb.root, 'scripts', 'run-unit-shard.sh'), '--batch-size', '5'], {
        cwd: sb.root,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${join(sb.root, 'bin')}:${process.env.PATH ?? ''}`,
          SHARD: '', GBRAIN_TEST_RUN_ID: 'test-run',
          GBRAIN_PGLITE_SNAPSHOT: '/tmp/fixture.tar',
        },
      });
      expect(result.status).toBe(0);
      const calls = readFileSync(sb.callsPath, 'utf-8').trim().split('\n');
      expect(calls.find(line => line.includes('test/1.test.ts'))).toStartWith('snapshot=/tmp/fixture.tar');
      expect(calls.find(line => line.includes('test/migrate.test.ts'))).toStartWith('snapshot= args=');
      expect(calls.find(line => line.includes('test/custom.test.ts'))).toStartWith('snapshot= args=');
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  });

  it('strips ambient production database and brain-home variables at the shard boundary', () => {
    const sb = batchingSandbox(1);
    try {
      writeFileSync(join(sb.root, 'bin', 'bun'), `#!/usr/bin/env bash\nprintf '%s|%s\\n' "\${DATABASE_URL-}" "\${GBRAIN_HOME-}" > "${sb.callsPath}"\n`);
      chmodSync(join(sb.root, 'bin', 'bun'), 0o755);
      const result = spawnSync('bash', [join(sb.root, 'scripts', 'run-unit-shard.sh')], {
        cwd: sb.root,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${join(sb.root, 'bin')}:${process.env.PATH ?? ''}`,
          SHARD: '', GBRAIN_TEST_RUN_ID: 'test-run',
          DATABASE_URL: 'postgresql://production.invalid/live',
          GBRAIN_HOME: '/production/brain',
        },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(sb.callsPath, 'utf-8').trim()).toBe('|');
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  });

  it('escalates a TERM-resistant batch to KILL and records the timeout failure', () => {
    const sb = batchingSandbox(1);
    try {
      writeFileSync(
        join(sb.root, 'bin', 'bun'),
        `#!/usr/bin/env bash\ntrap '' TERM\nprintf '%s\\n' "$*" >> "${sb.callsPath}"\nwhile true; do sleep 1; done\n`,
      );
      chmodSync(join(sb.root, 'bin', 'bun'), 0o755);
      const started = Date.now();
      const result = spawnSync('bash', [join(sb.root, 'scripts', 'run-unit-shard.sh'), '--batch-size', '1'], {
        cwd: sb.root,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${join(sb.root, 'bin')}:${process.env.PATH ?? ''}`,
          SHARD: '', GBRAIN_TEST_RUN_ID: 'test-run',
          GBRAIN_TEST_BATCH_TIMEOUT: '1',
          GBRAIN_TEST_BATCH_KILL_AFTER: '1',
        },
      });
      expect(Date.now() - started).toBeLessThan(8000);
      expect(result.status).toBe(137);
      const receipt = readFileSync(join(sb.root, '.context/test-batches/test-run/unsharded.jsonl'), 'utf-8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(receipt[0]).toMatchObject({ kind: 'batch', rc: 137 });
      expect(receipt.at(-1)).toMatchObject({ kind: 'complete', complete: true, rc: 137 });
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  });

  it('rejects invalid batch and timeout controls before launching Bun', () => {
    const sb = batchingSandbox(1);
    try {
      writeFileSync(join(sb.root, 'bin', 'bun'), `#!/usr/bin/env bash\necho called >> "${sb.callsPath}"\n`);
      chmodSync(join(sb.root, 'bin', 'bun'), 0o755);
      for (const [args, env, message] of [
        [['--batch-size', '0'], {}, 'invalid batch size'],
        [[], { GBRAIN_TEST_BATCH_TIMEOUT: '0' }, 'invalid batch timeout'],
        [[], { GBRAIN_TEST_BATCH_KILL_AFTER: '0' }, 'invalid batch kill-after'],
      ] as const) {
        const result = spawnSync('bash', [join(sb.root, 'scripts', 'run-unit-shard.sh'), ...args], {
          cwd: sb.root,
          encoding: 'utf-8',
          env: { ...process.env, PATH: `${join(sb.root, 'bin')}:${process.env.PATH ?? ''}`, SHARD: '', GBRAIN_TEST_RUN_ID: 'test-run', ...env },
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(message);
      }
      expect(() => readFileSync(sb.callsPath, 'utf-8')).toThrow();
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  });
});
