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

for (const writer of ['fence', 'forget'] as const) {
  test(`${writer}: registered host excludes enrollment throughout the writer`, async () => {
    const base = mkdtempSync(join(realpathSync(import.meta.dir), 'facts-coordination-'));
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
    let enrolled = false, gateChecks = 0, barrierEnabled = true;
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
    const engine: any = {
      kind: 'postgres',
      executeRaw: async (q: string) => {
        if (q.includes('to_regclass')) return [{ present: true }];
        if (q.includes('FROM public.page_file_bindings')) {
          gateChecks++;
          if (barrierEnabled) { entered(); await barrier; }
          return enrolled ? [{ source_id: 'default' }] : [];
        }
        if (q.includes('FROM sources')) return [{ id: 'default', local_path: root }];
        if (q.includes('FROM pages')) return [{ source_path: null }];
        if (q.includes('FROM facts')) return [{ id: '1', source_id: 'default', entity_slug: 'note', row_num: 1, source_markdown_slug: 'note', expired_at: null }];
        if (q.startsWith('UPDATE facts')) { await assertExcluded(); return []; }
        throw new Error(`Unexpected SQL: ${q}`);
      },
      insertFacts: async () => { await assertExcluded(); return { inserted: 1, ids: [1] }; },
    };
    async function assertExcluded() {
      for (const options of [{ rootMode: 'exclusive' as const, paths: [] }, { rootMode: 'shared' as const, paths: ['note.md'] }]) {
        const lock = await acquirePageFileLock({ root, lockDirectory: manifest.lock.path, topology: 'single-host-local', timeoutMs: 20, ...options });
        try { expect(lock).toBeNull(); } finally { await lock?.release(); }
      }
    }
    const manifestJson = JSON.stringify(manifest);
    const runtime = await import('../src/core/page-file-runtime.ts');
    const lifecycle = await runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine,
      host: { mode: 'offline-verification', manifestJson, expected: { manifestSha256: createHash('sha256').update(manifestJson).digest('hex'), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } },
      authority: { mode: 'offline-verification', credentialReference: 'offline', resolveCredential: async () => 'postgres://fixture.invalid/offline', expected: { role: manifest.adapterRole, database: manifest.database, ordinaryRole: 'ordinary-example' } },
    });
    const { writeFactsToFence } = await import('../src/core/facts/fence-write.ts');
    const { forgetFactInFence } = await import('../src/core/facts/forget.ts');
    const invoke = () => writer === 'fence' ? writeFactsToFence(engine, { sourceId: 'default', slug: 'note', localPath: root }, [{ fact: 'Added fact', kind: 'fact', notability: 'medium', source: 'test', visibility: 'world', embedding: null, sessionId: null }]) : forgetFactInFence(engine, 1);
    try {
      await withEnv({ GBRAIN_HOME: base }, async () => {
        const pending = invoke();
        // Attach a rejection handler even if a lock assertion fails first.
        const settled = pending.then(value => ({ value }), error => ({ error }));
        try {
          await Promise.race([ready, pending.then(() => { throw new Error('missing barrier'); })]);
          expect(readFileSync(path, 'utf8')).toBe(before);
          await assertExcluded();
        } finally { release(); }
        const outcome = await settled;
        if ('error' in outcome) throw outcome.error;
        expect(readFileSync(path, 'utf8')).not.toBe(before);
        expect(gateChecks).toBe(1); // No nested host/gate reacquisition.
        const lock = await acquirePageFileLock({ root, lockDirectory: manifest.lock.path, topology: 'single-host-local', rootMode: 'exclusive', paths: [], timeoutMs: 100 });
        expect(lock).not.toBeNull();
        try { enrolled = true; } finally { await lock?.release(); }
        barrierEnabled = false;
        const after = readFileSync(path, 'utf8');
        await expect(invoke()).rejects.toThrow('page_file_unsupported_writer');
        expect(readFileSync(path, 'utf8')).toBe(after);
      });
    } finally { release(); await lifecycle.close(); rmSync(base, { recursive: true, force: true }); }
  }, 15000);
}
