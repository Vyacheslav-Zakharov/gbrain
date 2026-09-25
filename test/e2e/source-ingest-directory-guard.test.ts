import { expect, test, spyOn } from 'bun:test';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { PostgresEngine } from '../../src/core/postgres-engine';
import { FakeSourceConnector } from '../../src/core/source-ingest/connectors/fake';
import { putSourceIngestProfile } from '../../src/core/source-ingest/store';
import { runSourceIngestExecutor } from '../../src/core/source-ingest/executor';
import { prepareDirectorySnapshot } from '../../src/core/source-ingest/directory-identity-guard';
import { importFromContent } from '../../src/core/import-file';
import type { SourceIngestProfile } from '../../src/core/source-ingest/profile-schema';

// Deliberately do NOT import helpers.ts: it loads .env.testing and TRUNCATEs
// unrelated records. Run this file alone in an isolated HOME/GBRAIN_HOME.
// Hosted operator must provision/schema-initialize an ephemeral PG16+pgvector DB.
const databaseUrl = process.env.DATABASE_URL;
function admitDatabase(value: string): URL {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || url.search || url.hash || !url.hostname || !url.username || !url.port
      || !/^gbrain_directory_guard_test(?:_[a-z0-9_]+)?$/.test(url.pathname.slice(1))
      || process.env.GBRAIN_DIRECTORY_GUARD_PG_TEST !== '1') {
    throw new Error('Refusing DB: explicit dedicated gbrain_directory_guard_test URL and GBRAIN_DIRECTORY_GUARD_PG_TEST=1 required');
  }
  for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSERVICE', 'PGOPTIONS', 'DATABASE_DIRECT_URL', 'DIRECT_DATABASE_URL', 'GBRAIN_DATABASE_URL']) {
    if (process.env[name]) throw new Error(`Refusing inherited connection override: ${name}`);
  }
  return url;
}

const policy = {
  fields: { id: 'ID', key: 'Key', name: 'Name', type: 'Type', created: 'Created', parent: 'Parent', site: 'Site' },
  dateFormat: 'MM/DD/YYYY HH:mm:ss' as const, timezone: '+05:00', rootParentValues: ['' as const],
  passportFields: [], anchors: [], typeAllowlist: ['facility', 'equipment'], scope: { sites: ['A'] },
};
// Shared synthetic fixture for every positive/negative phase; no real directory data.
const raw = () => [
  { ID: 'root', Key: 'root', Name: 'Root', Type: 'facility', Created: '06/01/2026 10:00:00', Parent: '', Site: 'A' },
  { ID: 'parent', Key: 'parent', Name: 'Parent', Type: 'equipment', Created: '06/01/2026 10:00:00', Parent: 'root', Site: 'A' },
  { ID: 'child', Key: 'child', Name: 'Child', Type: 'equipment', Created: '06/01/2026 10:00:00', Parent: 'parent', Site: 'A' },
];

(databaseUrl ? test : test.skip)('PostgreSQL native directory guard: publication, hidden identity, HOLD and pre-write refusals', async () => {
  const url = admitDatabase(databaseUrl!); // before client creation or any writes
  const sourceId = `guard-pg-${randomUUID()}`;
  const profileId = `${sourceId}-profile`;
  const key = `source_ingest.directory_guard.${sourceId}.${profileId}`;
  const pinKey = `${key}.first_bootstrap`;
  const repo = mkdtempSync(join(tmpdir(), 'directory-guard-pg-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const engine = new PostgresEngine();
  let ownedSource = false;
  let rows = raw();
  let fullReads = 0;
  const fetch = spyOn(FakeSourceConnector.prototype, 'fetchAll').mockImplementation(async function* () {
    fullReads++;
    yield { records: rows.map(data => ({ external_id: data.ID, data })), cursor: null };
  });
  const sample = spyOn(FakeSourceConnector.prototype, 'sample').mockImplementation(async () => { throw Error('sample forbidden'); });
  const changed = spyOn(FakeSourceConnector.prototype, 'fetchChangedSince').mockImplementation(async function* () { throw Error('incremental forbidden'); });
  try {
    await engine.connect({ database_url: databaseUrl!, poolSize: 1 });
    const [identity] = await engine.executeRaw<{ db: string; usr: string; version: string }>(
      'SELECT current_database() AS db, session_user AS usr, current_setting(\'server_version_num\') AS version');
    expect(identity.db).toBe(url.pathname.slice(1));
    expect(identity.usr).toBe(decodeURIComponent(url.username));
    expect(Number(identity.version)).toBeGreaterThanOrEqual(160000);
    expect(Number(identity.version)).toBeLessThan(170000);
    // Schema initialization belongs to the hosted fixture, not this scoped test.
    git('init', '-q'); git('config', 'user.name', 'Synthetic Test');
    git('config', 'user.email', 'test@example.test');
    writeFileSync(join(repo, 'README.md'), 'Synthetic PostgreSQL qualification\n');
    git('add', '.'); git('commit', '-qm', 'synthetic seed');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES ($1,$1,$2)', [sourceId, repo]);
    ownedSource = true;
    await importFromContent(engine, 'facilities/root', '---\ntype: facility\ntitle: Root\n---\nSynthetic root facility', { sourceId, noEmbed: true, remote: false });
    const facility = await engine.getPage('facilities/root', { sourceId });
    const review = () => {
      const result = prepareDirectorySnapshot({
        upstreamBinding: { connectorInstanceId: 'fake-source', objectName: 'directory', alias: 'source', sourceTableId: null, resolvedCatalogId: null },
        sourceId, profileId, policy, records: rows, complete: true, mode: 'preview',
      });
      if (result.status === 'stopped') throw Error(result.diagnostics.join(','));
      return result;
    };
    const originalHash = review().snapshotHash;
    const profile: SourceIngestProfile = {
      profile_id: profileId, status: 'reviewed', source_connector: 'fake-source', source_object: 'directory',
      target: { approved_source_id: sourceId, gbrain_type: 'equipment', slug_template: 'equipment/{{ ID }}' },
      identity: { external_id_field: 'ID', display_name_field: 'Name', require_explicit_resolution: true,
        explicit_create_ids: ['parent', 'child'], nonwriting_bindings: { root: { source_id: sourceId, slug: 'facilities/root', type: 'facility', approved: true } } },
      directory_guard: { source_alias: 'source', policy, approved_bootstrap_hash: originalHash, baseline_promotion: 'hold' },
      links: [
        { id: 'parent', type: 'part_of', when: [{ field: 'Parent', op: 'neq', value: 'root' }, { field: 'Parent', op: 'exists' }], target: { lookup: 'external_id', value_field: 'Parent', profile_id: profileId, source_id: sourceId, type: 'equipment' } },
        { id: 'facility', type: 'located_at', when: [{ field: 'Parent', op: 'eq', value: 'root' }], target: { lookup: 'external_id', value_field: 'Parent', profile_id: profileId, source_id: sourceId, type: 'facility' } },
      ],
      update_policy: { mode: 'managed_block', preserve_manual_sections: true, include_external_id_in_content: false },
      security: { classification: 'internal', pii: false },
    };
    const save = () => putSourceIngestProfile(engine, profile);
    const run = () => runSourceIngestExecutor(engine, { profile_id: profileId, changed_since: true, run_id: `guard-${randomUUID()}` });
    const snapshot = async () => ({
      pages: await engine.executeRaw('SELECT slug,content_hash,frontmatter FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]),
      versions: await engine.executeRaw('SELECT v.* FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 ORDER BY v.id', [sourceId]),
      graph: await engine.executeRaw('SELECT l.* FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 ORDER BY l.id', [sourceId]),
      head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'),
      baseline: await engine.getConfig(key), pin: await engine.getConfig(pinKey),
    });
    await save();
    const first = await run();
    expect(first.ok).toBe(true); expect(first.counts.written).toBe(2);
    expect(first.results.map(r => r.external_id)).toEqual(['parent', 'child']);
    expect(await engine.getPage('equipment/root', { sourceId })).toBeNull();
    expect(await engine.getPage('facilities/root', { sourceId })).toEqual(facility);
    expect(await engine.getConfig(key)).toBeNull();
    expect(await engine.getConfig(pinKey)).not.toBeNull();
    const published = await snapshot();
    expect(published.graph).toHaveLength(2);
    expect(published.status).toBe('');
    const hidden = await engine.getPage('equipment/parent', { sourceId });
    expect(hidden?.frontmatter.external_ref).toBeUndefined();
    const second = await run();
    expect(second.ok).toBe(true); expect(second.counts.unchanged).toBe(2);
    expect(await snapshot()).toEqual(published);

    // Re-approval of changed bytes cannot replace the immutable first-write pin.
    rows = raw().map(r => r.ID === 'parent' ? { ...r, Created: '06/02/2026 10:00:00' } : r);
    profile.directory_guard!.approved_bootstrap_hash = review().snapshotHash;
    await save();
    await expect(run()).rejects.toThrow('bootstrap_pin');
    expect(await snapshot()).toEqual(published);
    rows = raw(); profile.directory_guard!.approved_bootstrap_hash = originalHash;
    profile.directory_guard!.baseline_promotion = 'full'; await save();
    expect((await run()).ok).toBe(true);
    const accepted = await engine.getConfig(key); expect(accepted).not.toBeNull();

    // An allowed name update under HOLD writes pages but not the accepted baseline.
    profile.directory_guard!.baseline_promotion = 'hold'; await save();
    rows = raw().map(r => r.ID === 'child' ? { ...r, Name: 'Updated child' } : r);
    const hold = await run(); expect(hold.ok).toBe(true); expect(hold.counts.written).toBe(1);
    expect(await engine.getConfig(key)).toBe(accepted);
    const held = await snapshot();
    expect(held.pages).not.toEqual(published.pages);
    expect((await run()).counts.unchanged).toBe(2);
    expect(await snapshot()).toEqual(held);

    rows = raw().map(r => r.ID === 'child' ? { ...r, Created: '06/02/2026 10:00:00' } : r);
    await expect(run()).rejects.toThrow();
    expect(await snapshot()).toEqual(held);
    // SQL would erase every row; raw duplicate must still STOP before SQL selection.
    profile.transform = { sources: [{ alias: 'source', object: 'directory' }], sql: 'SELECT * FROM source WHERE false', primary_key_field: 'ID' };
    await save(); rows = [...raw(), raw()[2]];
    await expect(run()).rejects.toThrow('duplicate_id');
    expect(await snapshot()).toEqual(held);
    expect(fullReads).toBeGreaterThan(5);
  } finally {
    fetch.mockRestore(); sample.mockRestore(); changed.mockRestore();
    const errors: unknown[] = [];
    if (ownedSource) {
      // Exact owned predicates only; no TRUNCATE, global reset or wildcard deletes.
      for (const [sql, params] of [
        ['DELETE FROM source_ingest_run_items WHERE profile_id=$1 AND approved_source_id=$2', [profileId, sourceId]],
        ['DELETE FROM source_sync_state WHERE profile_id=$1 AND approved_source_id=$2', [profileId, sourceId]],
        ['DELETE FROM source_ingest_profiles WHERE profile_id=$1 AND approved_source_id=$2', [profileId, sourceId]],
        ['DELETE FROM config WHERE key IN ($1,$2)', [key, pinKey]],
        ['DELETE FROM pages WHERE source_id=$1', [sourceId]],
        ['DELETE FROM sources WHERE id=$1', [sourceId]],
      ] as Array<[string, string[]]>) {
        try { await engine.executeRaw(sql, params); } catch (e) { errors.push(e); }
      }
      try {
        expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toEqual([]);
        expect(await engine.executeRaw('SELECT profile_id FROM source_ingest_profiles WHERE profile_id=$1', [profileId])).toEqual([]);
        expect(await engine.getConfig(key)).toBeNull(); expect(await engine.getConfig(pinKey)).toBeNull();
      } catch (e) { errors.push(e); }
    }
    try { await engine.disconnect(); } catch (e) { errors.push(e); }
    rmSync(repo, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Exact-owned fixture cleanup failed');
  }
}, 120_000);
