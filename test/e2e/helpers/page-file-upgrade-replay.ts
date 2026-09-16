import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { LATEST_VERSION, runMigrations } from '../../../src/core/migrate.ts';

/** Reuse the existing SQL-authority provisioning fixture, logins and frozen pins.
 * No copied DDL/grants and no production provisioning mechanism. The caller has
 * already created a protected page/chunk via its real ordinary/enrollment logins.
 * Receipt records below are preservation sentinels, NOT crash-recovery evidence. */
export async function exerciseAlreadyV142Replay(f: {
  admin: PostgresEngine; source: string; allAccepted: () => Promise<void>;
}) {
  if (process.env.REQUIRE_PAGE_FILE_UPGRADE_REPLAY_POSTGRES !== '1'
    || process.env.GITHUB_ACTIONS !== 'true' || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1') {
    throw new Error('upgrade replay requires explicit disposable hosted acceptance');
  }
  // captureFixturePins leaves pg_catalog first on this disposable max:1
  // migrator pool. initSchema's current_schema() bootstrap would then create
  // pg_catalog.sources. Runtime verifiers retain their catalog-first path.
  const manager = f.admin.connectionManager;
  expect(manager).toBeDefined();
  expect(manager!.isDualPoolActive()).toBe(false);
  const ddl = await manager!.ddl();
  expect(ddl.options.max).toBe(1);
  const [session] = await ddl.unsafe('SELECT pg_backend_pid() AS pid, current_setting(\'search_path\') AS path');
  await ddl.unsafe("SELECT set_config('search_path', 'public', false)");
  try {
    const [context] = await ddl.unsafe('SELECT pg_backend_pid() AS pid, current_schema() AS schema');
    expect(context.pid).toBe(session.pid);
    expect(context.schema).toBe('public');
  expect(LATEST_VERSION).toBe(142); // This is an exact v142 qualification, not an evergreen upgrade test.
  expect(await f.admin.getConfig('version')).toBe('142');
  const [binding] = await f.admin.executeRaw<{ binding_id: string }>(
    "SELECT binding_id FROM page_file_bindings WHERE source_id=$1 AND slug='protected'", [f.source]);
  expect(binding).toBeDefined();
  const prepared = randomUUID();
  for (const state of ['prepared', 'committed', 'aborted'] as const) {
    await f.admin.executeRaw(`INSERT INTO page_file_operations(operation_id,binding_id,request_digest,record,state,revision)
      VALUES($1,$2,$3,$4::text::jsonb,$5,$6)`, [state === 'prepared' ? prepared : randomUUID(), binding.binding_id,
      state, JSON.stringify({ fixture: 'v142-preservation-only', nested: { state, values: [1, null, 'exact'] } }), state, randomUUID()]);
  }
  await f.admin.executeRaw('UPDATE page_file_bindings SET pending_op_id=$1,file_generation=7 WHERE binding_id=$2', [prepared, binding.binding_id]);
  // Full rows, not selected semantic fields: includes UUID revisions, timestamps,
  // chunks, nested JSONB, binding generation/pending operation and all receipts.
  const snapshot = async () => {
    const state: Record<string, unknown> = {};
    for (const table of ['sources', 'pages', 'tags', 'timeline_entries', 'content_chunks', 'page_versions',
      'page_file_bindings', 'page_file_operations', 'page_file_write_authorizations', 'config']) {
      state[table] = await f.admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`);
    }
    return state;
  };
  const baseline = await snapshot();
  await f.allAccepted(); // Actual ordinary, adapter, enrollment logins; original pins.
  const preserved = async () => {
    expect(await f.admin.getConfig('version')).toBe('142');
    expect(await snapshot()).toEqual(baseline);
    await f.allAccepted(); // Never refresh pins after replay to conceal catalog drift.
  };
  // The real release/schema entrypoint on an already-v142 populated database.
  await f.admin.initSchema();
  await preserved();
  expect(await runMigrations(f.admin)).toEqual({ applied: 0, current: 142 });
  await preserved();
  console.log('PG_UPGRADE_REPLAY: already-v142 initSchema and no-pending runner preserve rows revisions receipts and original authority pins');

  // Force the existing migration runner to replay exactly 141/142, without
  // replacing the schema or copying SQL. Rewind ONLY the disposable fixture's
  // version marker; this is not a historical v140 database or live upgrade proof.
  for (let pass = 0; pass < 2; pass++) {
    await f.admin.setConfig('version', '140');
    expect(await runMigrations(f.admin)).toEqual({ applied: 2, current: 142 });
    await preserved();
  }
  console.log('PG_UPGRADE_REPLAY: existing runner replays 141 and 142 twice preserving populated v142 state and original authority pins');
  } finally {
    await ddl.unsafe("SELECT set_config('search_path', $1, false)", [session.path]);
    const [restored] = await ddl.unsafe('SELECT pg_backend_pid() AS pid, current_setting(\'search_path\') AS path');
    expect(restored).toEqual(session);
  }
}
