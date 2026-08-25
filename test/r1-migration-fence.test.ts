import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertSchemaMutationAllowed,
  resolveMigrationFence,
} from '../src/core/migration-fence.ts';
import { tryRunPendingMigrations } from '../src/core/migrate.ts';

describe('R1 automatic migration fence', () => {
  test('fails closed from env or marker file and permits only the fixed bypass token', () => {
    expect(resolveMigrationFence({ GBRAIN_MIGRATION_FENCE: '1' }, () => false)).toMatchObject({ active: true, source: 'env' });
    expect(resolveMigrationFence({}, () => true)).toMatchObject({ active: true, source: 'file' });
    expect(resolveMigrationFence({}, () => false)).toMatchObject({ active: false });
    expect(() => assertSchemaMutationAllowed({ GBRAIN_MIGRATION_FENCE: '1' }, () => false)).toThrow('MIGRATION_FENCE_ACTIVE');
    expect(() => assertSchemaMutationAllowed({ GBRAIN_MIGRATION_FENCE: '1', GBRAIN_MIGRATION_FENCE_BYPASS: 'avers-r1-approved-runner' }, () => false)).not.toThrow();
  });

  test('ordinary CLI migration helper returns fenced before probing or initSchema', async () => {
    let probes = 0;
    let mutations = 0;
    const result = await tryRunPendingMigrations({} as any, {
      _hooks: {
        isMigrationFenced: () => ({ active: true, source: 'env' as const, markerPath: null }),
        hasPending: async () => { probes++; return true; },
        initSchema: async () => { mutations++; },
      },
    });
    expect(result).toEqual({ status: 'fenced', source: 'env' });
    expect(probes).toBe(0);
    expect(mutations).toBe(0);
  });

  test('postinstall and both engine initSchema paths are structurally fenced', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.postinstall).toBe('bash scripts/postinstall-migrate.sh');
    const postinstall = readFileSync(new URL('../scripts/postinstall-migrate.sh', import.meta.url), 'utf8');
    expect(postinstall).toContain('GBRAIN_MIGRATION_FENCE');
    expect(postinstall).toContain('MIGRATION_FENCE.json');
    for (const rel of ['../src/core/postgres-engine.ts', '../src/core/pglite-engine.ts']) {
      expect(readFileSync(new URL(rel, import.meta.url), 'utf8')).toContain('assertSchemaMutationAllowed');
    }
    expect(readFileSync(new URL('../src/core/db.ts', import.meta.url), 'utf8')).toContain('assertSchemaMutationAllowed');
    expect(readFileSync(new URL('../src/core/migrate.ts', import.meta.url), 'utf8')).toContain('assertSchemaMutationAllowed');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain("throw new Error(`MIGRATION_FENCE_ACTIVE");
    expect(cli).toContain("if (message.startsWith('MIGRATION_FENCE_ACTIVE')) throw err");
  });
});
