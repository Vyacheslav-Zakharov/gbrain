import { test, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquirePageFileLock } from '../src/core/page-file-lock.ts';
import { upsertFactRow } from '../src/core/facts-fence.ts';
import { withEnv } from './helpers/with-env.ts';

// Offline identity transport only; no PostgreSQL or live credentials.
mock.module('postgres', () => ({ default: Object.assign(() => ({
  reserve: async () => ({ unsafe: async () => [{ session_user: 'adapter-example', current_user: 'adapter-example', database_name: 'db-example', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }], release() {} }),
  end: async () => {},
}), { BigInt: {} }) }));

for (const writer of ['revert', 'import'] as const) {
 test(`${writer}: enrollment excluded at absence check and mutation tail`, async () => {
    const base = mkdtempSync(join(realpathSync(import.meta.dir), 'ingest-coordination-'));
    const pin = (name: string) => {
      const path = join(base, name); mkdirSync(path, { mode: 0o700 });
      const s = lstatSync(path, { bigint: true });
      return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 as const };
    };
    const manifest = { version: 1, deploymentId: 'deployment-example', brainId: randomUUID(), database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local', serviceUid: process.getuid!(), roots: [{ sourceId: 'default', mappingGeneration: 'pin-example', directory: pin('root'), journal: pin('journal') }], lock: pin('lock'), indexedRoots: [] };
    const root = manifest.roots[0].directory.path;
    const path = join(root, 'note.md');
    const before = upsertFactRow('# Note\n', { claim: 'Existing fact', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', validFrom: '2020-01-01', source: 'test' }).body;
    writeFileSync(path, before);

    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
    let checks = 0, writes = 0, enrolled = false;
    async function assertExcluded() {
      for (const options of [{ rootMode: 'exclusive' as const, paths: [] }, { rootMode: 'shared' as const, paths: ['note.md'] }]) {
        const lock = await acquirePageFileLock({ root, lockDirectory: manifest.lock.path, topology: 'single-host-local', timeoutMs: 20, ...options });
        try { expect(lock).toBeNull(); } finally { await lock?.release(); }
      }
    }
    const engine: any = {
      kind: 'postgres',
      executeRaw: async (q: string) => {
        if (q.includes('to_regclass')) return [{ present: true }];
        if (q.includes('FROM public.page_file_bindings')) {
          if (++checks === 1) { entered(); await barrier; }
          return enrolled ? [{ source_id: 'default' }] : [];
        }
        if (q.includes('FROM page_file_bindings')) return [];
        if (q.includes('FROM sources')) return [{ id: 'default', local_path: root }];
        if (q.includes('FROM pages')) return [{ source_path: null }];
        if (q.includes('FROM source_ingest_run_items')) return [{ connector_id: 'example', source_object: 'note', external_id: '1', slug: 'note', approved_source_id: 'default', profile_id: 'example', action: 'created', last_result: 'success' }];
        return [];
      },
      getPage: async () => writer === 'revert' ? { updated_at: new Date() } : null,
      getVersions: async () => [], getConfig: async () => null,
      getTags: async () => [], getChunks: async () => [],
      softDeletePage: async () => { await assertExcluded(); writes++; throw new Error('tail_barrier_stop'); },
      transaction: async (fn: any) => fn(engine),
      putPage: async () => { await assertExcluded(); writes++; throw new Error('tail_barrier_stop'); },
    };
    const manifestJson = JSON.stringify(manifest);
    const runtime = await import('../src/core/page-file-runtime.ts');
    const lifecycle = await runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine,
      host: { mode: 'offline-verification', manifestJson, expected: { manifestSha256: createHash('sha256').update(manifestJson).digest('hex'), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } },
      authority: { mode: 'offline-verification', credentialReference: 'offline', resolveCredential: async () => 'postgres://fixture.invalid/offline', expected: { role: manifest.adapterRole, database: manifest.database, ordinaryRole: 'ordinary-example' } },
    });

    try {
      await withEnv({ GBRAIN_HOME: base }, async () => {
        const { buildSourceRevertReport } = await import('../src/core/source-ingest/revert.ts');
        const { importFromFile } = await import('../src/core/import-file.ts');
        const pending = writer === 'revert' ? buildSourceRevertReport(engine, 'run-example', { apply: true }) : importFromFile(engine, path, 'note.md', { noEmbed: true, inferFrontmatter: false });
        const settled = pending.then(value => ({ value }), error => ({ error }));
        try {
          await Promise.race([ready, pending.then(() => { throw new Error('missing barrier'); })]);
          expect(readFileSync(path, 'utf8')).toBe(before);
          await assertExcluded();
        } finally { release(); }
        const outcome = await settled;
        expect(writes).toBe(1);
        expect(readFileSync(path, 'utf8')).toBe(before);
        if ('error' in outcome) expect(outcome.error.message).toBe('tail_barrier_stop');
        else expect(JSON.stringify(outcome.value)).toContain('tail_barrier_stop');
        const lock = await acquirePageFileLock({ root, lockDirectory: manifest.lock.path, topology: 'single-host-local', rootMode: 'exclusive', paths: [], timeoutMs: 100 });
        try { expect(lock).not.toBeNull(); enrolled = true; } finally { await lock?.release(); }
        // Enrollment wins the initial lookup -> gate race: import must reject
        // as a conflict, never return an acknowledgeable malformed-file result.
        if (writer === 'import') {
          const { PageFileSyncConflict } = await import('../src/core/page-file-sync.ts');
          await expect(importFromFile(engine, path, 'note.md', { noEmbed: true })).rejects.toBeInstanceOf(PageFileSyncConflict);
        } else {
          const report = await buildSourceRevertReport(engine, 'run-example', { apply: true });
          expect(report.pages[0].revert_action).toBe('blocked');
          expect(report.pages[0].reason).toBe('page_file_unsupported_writer');
        }
        expect(writes).toBe(1);
        expect(readFileSync(path, 'utf8')).toBe(before);
      });
    } finally { release(); await lifecycle.close(); rmSync(base, { recursive: true, force: true }); }
 }, 15000);
}
