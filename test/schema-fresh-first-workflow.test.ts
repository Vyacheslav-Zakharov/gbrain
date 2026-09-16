import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('hosted SQL authority requires a fresh catalog before every other PostgreSQL suite', () => {
  const workflow = read('.github/workflows/page-cas-mvp.yml');
  const parsed = Bun.YAML.parse(workflow) as { jobs: { 'postgres-cas': { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> } } };
  const steps = parsed.jobs['postgres-cas'].steps;
  const fresh = steps.filter(step => step.env?.REQUIRE_PAGE_FILE_FRESH_CATALOG_POSTGRES === '1');
  expect(fresh).toHaveLength(1);
  const lane = fresh[0];
  expect(lane.run).toContain('test/e2e/page-file-sql-authority.test.ts');
  for (const flag of ['REQUIRE_PAGE_FILE_SQL_AUTHORITY_POSTGRES', 'REQUIRE_PAGE_FILE_UPGRADE_REPLAY_POSTGRES',
    'REQUIRE_PAGE_FILE_CONNECTED_POSTGRES', 'REQUIRE_PAGE_FILE_PILOT_POSTGRES', 'PAGE_FILE_CAS_DISPOSABLE']) {
    expect(lane.env?.[flag]).toBe('1');
  }
  const earlier = steps.slice(0, steps.indexOf(lane));
  expect(earlier.some(step => step.env?.DATABASE_URL || step.run?.includes('test/e2e/'))).toBe(false);
  expect(earlier.some(step => step.name === 'Prepare disposable protected bootstrap directory (hosted runner only)')).toBe(true);
  expect(workflow).toContain('test/schema-function-byte-parity.test.ts test/schema-fresh-first-workflow.test.ts');
  expect(workflow).toContain("assert sql_log.count('PG_SQL_AUTHORITY_FRESH: empty public catalog verified before first initSchema') == 1");
});

test('fresh precondition is before initialization; replay still checks original authority pins', () => {
  const fixture = read('test/e2e/page-file-sql-authority.test.ts');
  const beforeInit = fixture.split('    await admin.initSchema();')[0];
  expect(beforeInit).toContain("process.env.REQUIRE_PAGE_FILE_FRESH_CATALOG_POSTGRES === '1'");
  expect(beforeInit).toContain("expect(relations.count).toBe(0)");
  expect(beforeInit).toContain("WHERE n.nspname='public'");
  expect(beforeInit).toContain("expect(functions.count).toBe(0)");
  expect(beforeInit).toContain('PG_SQL_AUTHORITY_FRESH: empty public catalog verified before first initSchema');
  const replay = read('test/e2e/helpers/page-file-upgrade-replay.ts');
  expect(replay).toContain('await f.admin.initSchema();\n  await preserved();');
  expect(replay).toContain('await f.allAccepted(); // Never refresh pins after replay to conceal catalog drift.');
  expect(replay).toContain('expect(await snapshot()).toEqual(baseline)');
  expect(replay).toContain('expect(await runMigrations(f.admin)).toEqual({ applied: 0, current: 142 })');
  expect(replay).toContain('expect(await runMigrations(f.admin)).toEqual({ applied: 2, current: 142 })');
  expect(replay).not.toContain('captureFixturePins()');
});
