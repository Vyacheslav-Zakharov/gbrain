import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations, MIGRATIONS } from '../src/core/migrate.ts';
import { purgeStaleSourceIngestRunItems } from '../src/core/source-ingest/ledger.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

async function hasTable(engine: PGLiteEngine, table: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [table],
  );
  return rows[0]?.exists === true;
}

async function hasIndex(engine: PGLiteEngine, index: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = $1
     ) AS exists`,
    [index],
  );
  return rows[0]?.exists === true;
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('source-ingest round3 P0 hardening', () => {
  test('v120-stamped brain missing source_ingest_run_items upgrades without crash and recreates ledger', async () => {
    await engine.executeRaw(`DROP TABLE IF EXISTS source_ingest_run_items`);
    await engine.setConfig('version', '120');

    const result = await runMigrations(engine);

    expect(result.applied).toBe(MIGRATIONS.filter(m => m.version > 120).length);
    expect(result.current).toBe(LATEST_VERSION);
    expect(await hasTable(engine, 'source_ingest_run_items')).toBe(true);
    expect(await hasIndex(engine, 'source_ingest_run_items_run_idx')).toBe(true);
    expect(await hasIndex(engine, 'source_ingest_run_items_external_idx')).toBe(true);
    const version = await engine.getConfig('version');
    expect(Number(version)).toBe(LATEST_VERSION);
  }, 30000);

  test('v123 source-ingest RLS migration is guarded against missing tables', () => {
    const v123 = MIGRATIONS.find(m => m.version === 123);
    expect(v123?.sql).toContain("to_regclass('public.source_ingest_run_items') IS NOT NULL");
    expect(v123?.sql).toContain("to_regclass('public.source_connector_configs') IS NOT NULL");
    expect(v123?.sql).toContain("to_regclass('public.source_connector_secrets') IS NOT NULL");
    expect(v123?.sql).toContain("to_regclass('public.source_connector_secret_audit') IS NOT NULL");
  });

  test('source-ingest run ledger GC prunes stale rows and keeps recent rows', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('shared', 'shared', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await engine.executeRaw(`
      INSERT INTO source_ingest_profiles
        (profile_id, connector_id, source_object, status, approved_source_id, target_type, profile_json, profile_hash)
      VALUES
        ('fake-source-vehicle-v1', 'fake-source', 'vehicle', 'reviewed', 'shared', 'equipment', '{}'::jsonb, 'hash')
      ON CONFLICT (profile_id) DO NOTHING
    `);
    await engine.executeRaw(`
      INSERT INTO source_ingest_run_items
        (run_id, connector_id, source_object, external_id, slug, approved_source_id, profile_id, profile_version,
         action, last_result, created_at)
      VALUES
        ('old-run', 'fake-source', 'vehicle', 'old', 'old-slug', 'shared', 'fake-source-vehicle-v1', 1,
         'created', 'success', now() - interval '8 days'),
        ('new-run', 'fake-source', 'vehicle', 'new', 'new-slug', 'shared', 'fake-source-vehicle-v1', 1,
         'created', 'success', now())
    `);

    const purged = await purgeStaleSourceIngestRunItems(engine, 7);
    const remaining = await engine.executeRaw<{ run_id: string }>(`SELECT run_id FROM source_ingest_run_items ORDER BY run_id`);

    expect(purged).toBe(1);
    expect(remaining.map(r => r.run_id)).toEqual(['new-run']);
  }, 30000);
});
