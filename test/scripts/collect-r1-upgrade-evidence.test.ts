import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dir, '../..');
const script = join(repoRoot, 'scripts/collect-r1-upgrade-evidence.sh');

describe('collect-r1-upgrade-evidence', () => {
  test('collects every fixture, redacts secrets, and finalizes a manifest despite one failure', () => {
    const out = mkdtempSync(join(tmpdir(), 'gbrain-r1-evidence-'));
    const result = spawnSync('bash', [script, '--output', out, '--test-mode'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        R1_TEST_SECRET: 'super-secret-value',
        R1_TEST_DATABASE_URL: 'postgresql://user:password@example.invalid/db',
      },
    });

    expect(result.status).toBe(1); // synthetic failing collector is retained, not swallowed
    expect(result.stderr).toContain('evidence complete with collector failures');

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
      schema_version: number;
      complete: boolean;
      collectors: Array<{ name: string; status: string; exit_code: number }>;
      files: Array<{ path: string; sha256: string; bytes: number }>;
    };
    expect(manifest.schema_version).toBe(1);
    expect(manifest.complete).toBe(false);
    expect(manifest.collectors.map((x) => x.name)).toEqual([
      'test_safe',
      'test_failure',
      'test_secret',
      'test_database_url',
    ]);
    expect(manifest.collectors.find((x) => x.name === 'test_failure')).toMatchObject({
      status: 'failed',
      exit_code: 7,
    });

    const combined = readdirSync(out)
      .filter((name) => name.endsWith('.txt') || name.endsWith('.json'))
      .map((name) => readFileSync(join(out, name), 'utf8'))
      .join('\n');
    expect(combined).not.toContain('super-secret-value');
    expect(combined).not.toContain('user:password@');
    expect(combined).toContain('<redacted>');
    expect(manifest.files.length).toBeGreaterThanOrEqual(4);
    expect(manifest.files.every((x) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(true);
  });
});
