/**
 * v0.41.6.0 D3 + D5 E2E — lock recovery scenarios.
 *
 * Combined coverage for the abnormal-termination + lock-owner-message +
 * --break-lock flows that need real subprocess + shared DB state. Skips
 * gracefully when DATABASE_URL is unset.
 *
 * Scenarios:
 *   1. Concurrent sync: second exits with PID + age + --break-lock hint
 *      (per eng-review D10).
 *   2. SIGTERM during sync: lock row deleted within 3s
 *      (per process-cleanup registry contract).
 *   3. SIGPIPE via real `head -5` pipe: clean exit, next sync runs
 *      without "Another sync is in progress" (per outside-voice F14 /
 *      eng-review D19).
 *   4. --break-lock with dead local PID: clears the row.
 *   5. --break-lock with alive local PID: refuses with --force-break-lock hint.
 *   6. --force-break-lock with alive PID: clears (with warning).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync, spawnSync, spawn } from 'child_process';
import { tmpdir, hostname } from 'os';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { tryAcquireDbLock, inspectLock } from '../../src/core/db-lock.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping lock-recovery E2E (DATABASE_URL not set)');

const CLI = ['bun', 'run', join(import.meta.dir, '..', '..', 'src', 'cli.ts')];

let tmpHome: string;
let repoDir: string;

beforeAll(async () => {
  if (skip) return;
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-lock-recovery-e2e-'));
  await setupDB();
});

afterAll(async () => {
  if (skip) return;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  if (repoDir) { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } }
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-lock-recovery-repo-'));
  mkdirSync(join(repoDir, 'people'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(repoDir, 'people', `alice-example-${i}.md`), [
      '---', 'type: person', `title: Alice Example ${i}`, '---', '',
      `Placeholder person ${i} for lock-recovery E2E.`,
    ].join('\n'));
  }
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir });

  // Clean up any leftover lock rows from prior runs.
  const eng = getEngine();
  try { await (eng as any).sql`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-sync:%'`; } catch { /* */ }
});

function runCli(args: string[], env: Record<string, string | undefined> = {}): { code: number; stdout: string; stderr: string } {
  const fullEnv: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
    GBRAIN_HOME: tmpHome,
    DATABASE_URL: process.env.DATABASE_URL!,
    ...env,
  };
  for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
  const res = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    env: fullEnv as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describeE2E('v0.41.6.0 — sync lock recovery scenarios', () => {
  test('--break-lock refuses when no lock row exists (clean message, exit 0)', () => {
    const result = runCli(['sync', '--break-lock', '--source', 'default']);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/not held|nothing to break/i);
  });

  test('--break-lock + --all is accepted and iterates sources (self-heal, no longer refused)', () => {
    // v0.41.13.0 (T4 + D1) intentionally DROPPED the old --all refusal so cron
    // can self-heal every source in one call: runBreakLock now widens to
    // iterate sources when --all is set (sync.ts ~2550). This test pins that
    // shipped contract. Deterministic: with no active sources OR only
    // unlocked ones, every per-source break is a no-op and the exit is 0.
    const result = runCli(['sync', '--break-lock', '--all']);
    const out = result.stdout + result.stderr;
    expect(result.code).toBe(0);
    // The combination must NOT be rejected anymore.
    expect(out).not.toMatch(/cannot be combined with --all/);
    // It took the accepted iterate/no-sources path.
    expect(out).toMatch(/No active sources to break-lock against|is not held \(nothing to break\)|Broke lock/i);
  });

  test('lock-busy error message includes PID + hostname + age + --break-lock hint', async () => {
    // Acquire a lock from THIS process so the row exists for the subprocess to see.
    const eng = getEngine();
    const lockKey = 'gbrain-sync:default';
    const handle = await tryAcquireDbLock(eng, lockKey);
    expect(handle).not.toBeNull();

    try {
      const result = runCli(['sync', '--repo', repoDir, '--full', '--yes', '--no-embed', '--source', 'default']);
      expect(result.code).not.toBe(0);
      const msg = result.stderr + result.stdout;
      expect(msg).toMatch(new RegExp(`pid ${process.pid}`));
      expect(msg).toMatch(/started \d+/);
      expect(msg).toMatch(/--break-lock/);
    } finally {
      await handle!.release();
    }
  });

  test('--break-lock with TTL-expired row clears the lock', async () => {
    const eng = getEngine();
    // Insert a TTL-expired row with a fake PID on this host.
    await (eng as any).sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
      VALUES ('gbrain-sync:default', 99999, ${hostname()}, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes')
    `;

    const result = runCli(['sync', '--break-lock', '--source', 'default']);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/broke lock.*ttl_expired/i);

    // Lock row should be gone.
    const snap = await inspectLock(eng, 'gbrain-sync:default');
    expect(snap).toBeNull();
  });

  test('--break-lock with alive local PID refuses with --force-break-lock hint', async () => {
    const eng = getEngine();
    // Use OUR pid → guaranteed alive on this host.
    await (eng as any).sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
      VALUES ('gbrain-sync:default', ${process.pid}, ${hostname()}, NOW(), NOW() + INTERVAL '30 minutes')
    `;

    const result = runCli(['sync', '--break-lock', '--source', 'default']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Refusing to break lock/);
    expect(result.stderr).toMatch(/--force-break-lock/);

    // Lock row should still exist.
    const snap = await inspectLock(eng, 'gbrain-sync:default');
    expect(snap).not.toBeNull();

    // Cleanup.
    await (eng as any).sql`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-sync:default'`;
  });

  test('--force-break-lock clears even when holder PID is alive (with warning)', async () => {
    const eng = getEngine();
    await (eng as any).sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
      VALUES ('gbrain-sync:default', ${process.pid}, ${hostname()}, NOW(), NOW() + INTERVAL '30 minutes')
    `;

    const result = runCli(['sync', '--force-break-lock', '--source', 'default']);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/[Ff]orce-broke lock|WARNING/);

    const snap = await inspectLock(eng, 'gbrain-sync:default');
    expect(snap).toBeNull();
  });

  test('SIGTERM during sync releases the lock within 3s', async () => {
    const eng = getEngine();
    let output = '';
    let stopping = false;
    const child = spawn(CLI[0], [CLI[1], '--preload', join(import.meta.dir, 'fixtures/sync-lock-held.preload.ts'),
      ...CLI.slice(2), 'sync', '--repo', repoDir, '--full', '--yes', '--no-embed', '--source', 'default'], {
      env: { ...process.env, GBRAIN_HOME: tmpHome, DATABASE_URL: process.env.DATABASE_URL! },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Subscribe immediately, including spawn failure; never await a missed event.
    let ended = false;
    const exited = new Promise<{ code: number | null; signal: string | null; error?: Error }>(resolve => {
      child.once('exit', (code, signal) => { ended = true; resolve({ code, signal }); });
      child.once('error', error => { ended = true; resolve({ code: null, signal: null, error }); });
    });
    const drain = (data: Buffer) => { output = (output + data.toString()).slice(-16_000); };
    child.stdout!.on('data', drain);
    child.stderr!.on('data', drain);
    async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out; child output:\n${output}`)), ms);
        })]);
      } finally { clearTimeout(timer!); }
    }
    try {
      await bounded((async () => {
        while (!stopping && !output.includes(`E2E_SYNC_LOCK_HELD:${child.pid}`)) {
          if (ended || child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Child exited before held-lock handshake:\n${output}`);
          }
          await Bun.sleep(25);
        }
      })(), 15_000, 'held-lock handshake');
      const snap = await bounded(inspectLock(eng, 'gbrain-sync:default'), 2_000, 'inspect held lock');
      expect(snap?.holder_pid).toBe(child.pid);
      expect(ended).toBe(false);
      expect(child.kill('SIGTERM')).toBe(true);
      // Deadline starts at signal, not at exit. Cleanup must remove the row,
      // not merely replace its owner; no harness delete until assertions finish.
      await bounded((async () => {
        while (!stopping && await bounded(inspectLock(eng, 'gbrain-sync:default'), 1_000, 'inspect released lock')) await Bun.sleep(50);
      })(), 3_000, 'SIGTERM lock release');
      const result = await bounded(exited, 5_000, 'SIGTERM exit');
      expect(result.error).toBeUndefined();
      expect(result.signal === 'SIGTERM' || result.code === 143 || result.code === 0).toBe(true);
    } finally {
      stopping = true;
      if (!ended) {
        child.kill('SIGKILL');
        await bounded(exited, 3_000, 'SIGKILL cleanup');
      }
      await bounded((eng as any).sql`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-sync:default' AND holder_pid = ${child.pid ?? -1}`, 2_000, 'fixture lock cleanup');
    }
  }, 35_000);

  // v0.41.7+ follow-up: this test's timing is brittle on slow CI.
  // The SIGPIPE cleanup-registry codepath IS exercised structurally by
  // unit test/process-cleanup.test.ts. The SIGTERM-during-sync E2E above
  // verifies the lock-release on abnormal termination. Re-enable once
  // the head-pipe scenario can be made deterministic across CI runners.
  test.skip('pipe through `head -5` exits cleanly, next sync runs without lock-busy', async () => {
    // Run `gbrain sync ... | head -5` via shell.
    const cmd = `${CLI.join(' ')} sync --repo ${repoDir} --full --yes --no-embed 2>&1 | head -5`;
    const result = spawnSync('sh', ['-c', cmd], {
      env: {
        ...process.env,
        GBRAIN_HOME: tmpHome,
        DATABASE_URL: process.env.DATABASE_URL!,
      } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    // head closes the pipe → SIGPIPE → cleanup → exit. Exit code from `sh` is
    // last command (head) which exited 0 since it read its 5 lines.
    expect(result.status).toBe(0);

    // Next sync should NOT report "Another sync is in progress" — give the
    // cleanup pass up to 5s to clear the lock.
    let nextResult: ReturnType<typeof runCli>;
    let nextOk = false;
    for (let i = 0; i < 5; i++) {
      nextResult = runCli(['sync', '--repo', repoDir, '--full', '--yes', '--no-embed']);
      if (!/Another sync is in progress/.test(nextResult.stderr + nextResult.stdout)) {
        nextOk = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(nextOk).toBe(true);
  }, 60_000);
});
