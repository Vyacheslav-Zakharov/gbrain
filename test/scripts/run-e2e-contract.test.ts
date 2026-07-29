import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const RUN_E2E = readFileSync(resolve(ROOT, 'scripts/run-e2e.sh'), 'utf8');
const CI_LOCAL = readFileSync(resolve(ROOT, 'scripts/ci-local.sh'), 'utf8');

describe('E2E harness control-state contract', () => {
  test('preserves only the explicit gbrain controls required by the suite', () => {
    const allowlistArm = RUN_E2E.match(/GBRAIN_HOME\|GBRAIN_TEST_DB[^)]*\) ;;/)?.[0] ?? '';
    expect(allowlistArm).toContain('GBRAIN_PGBOUNCER_URL');
    expect(allowlistArm).toContain('GBRAIN_PGBOUNCER_DIRECT_URL');
    expect(allowlistArm).not.toContain('GBRAIN_SOURCE');
  });

  test('keeps the normal hang detector at 180s and scopes 300s to contended ci-local shards', () => {
    expect(RUN_E2E).toContain('E2E_FILE_TIMEOUT_SECONDS="${E2E_FILE_TIMEOUT_SECONDS:-180}"');
    expect(RUN_E2E).toContain('TIMEOUT_CMD="timeout $E2E_FILE_TIMEOUT_SECONDS"');
    const contendedOverrides = CI_LOCAL.match(/E2E_FILE_TIMEOUT_SECONDS=300/g) ?? [];
    expect(contendedOverrides).toHaveLength(2);
  });
});
