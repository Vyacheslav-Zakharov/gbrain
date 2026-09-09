/**
 * E2E Upgrade Tests — Tier 1 (no API keys required, needs network)
 *
 * Tests the check-update command against the real GitHub API.
 * Skips gracefully if network is unavailable.
 *
 * Run: bun test test/e2e/upgrade.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isValidVersionString } from '../../src/core/semver.ts';
import { VERSION } from '../../src/version.ts';
import { isMinorOrMajorBump } from '../../src/commands/check-update.ts';

// Check if we can reach GitHub
async function hasNetwork(): Promise<boolean> {
  try {
    const res = await fetch('https://api.github.com', { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const skip = !(await hasNetwork());
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E upgrade tests (network unavailable)');
}

// This contract does not depend on the live-network skip above. The fetch
// replacement is confined to a child, never the shared Bun module registry.
test('handles a deterministic GitHub 404 as no releases', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-update-404-'));
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  try {
    proc = Bun.spawn(['bun', 'run', 'test/e2e/fixtures/check-update-404.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, GBRAIN_HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => proc!.kill('SIGKILL'), 10_000);
    let stdout: string, stderr: string, exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
    } finally { clearTimeout(timer); }
    if (exitCode !== 0) throw new Error(`404 fixture exited ${exitCode}: ${stderr}`);
    const output = JSON.parse(stdout);
    expect(output).toMatchObject({ current_version: VERSION, current_source: 'package-json',
      latest_version: '', update_available: false, release_url: '', changelog_diff: '',
      published_at: '', error: 'no_releases' });
    expect(typeof output.upgrade_command).toBe('string');
    expect(output.upgrade_command.length).toBeGreaterThan(0);
  } finally {
    if (proc && proc.exitCode === null) proc.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);

describeE2E('E2E: Check-Update', () => {
  test('check-update --json returns valid JSON with current version', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--json'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.current_version).toBe(VERSION);
    expect(output.current_source).toBe('package-json');
    expect(typeof output.update_available).toBe('boolean');
    expect(output.upgrade_command.length).toBeGreaterThan(0);
    for (const key of ['latest_version', 'release_url', 'changelog_diff', 'published_at']) {
      expect(typeof output[key]).toBe('string');
    }
    if (output.error !== undefined) {
      expect(output.error).toBe('no_releases');
      expect(output.update_available).toBe(false);
      expect(output.latest_version).toBe('');
      expect(output.release_url).toBe('');
      expect(output.published_at).toBe('');
      expect(output.changelog_diff).toBe('');
    } else {
      expect(isValidVersionString(output.latest_version)).toBe(true);
      expect(output.update_available).toBe(isMinorOrMajorBump(VERSION, output.latest_version));
      expect(new URL(output.release_url).hostname).toBe('github.com');
      expect(Number.isFinite(Date.parse(output.published_at))).toBe(true);
      if (!output.update_available) expect(output.changelog_diff).toBe('');
    }
  });

  test('check-update without --json prints human-readable output', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('GBrain');
  });

  test('check-update --help prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--help'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('check-update');
    expect(stdout).toContain('--json');
  });

  test('version comparison wiring works end-to-end', () => {
    // Smoke test that the exported function works correctly
    expect(isMinorOrMajorBump('0.4.0', '0.5.0')).toBe(true);
    expect(isMinorOrMajorBump('0.4.0', '0.4.1')).toBe(false);
    expect(isMinorOrMajorBump('0.4.0', '1.0.0')).toBe(true);
    expect(isMinorOrMajorBump('0.4.0', '0.4.0')).toBe(false);
  });
});
