import { test, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquirePageFileLock } from '../src/core/page-file-lock.ts';
import { withEnv } from './helpers/with-env.ts';

// Identity transport stub, not PostgreSQL acceptance. Callers, runtime host
// validation, flock and filesystem mutations below are real.
mock.module('postgres', () => ({ default: Object.assign(() => ({
  reserve: async () => ({ unsafe: async () => [{ session_user: 'adapter-example', current_user: 'adapter-example', database_name: 'db-example', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }], release() {} }),
  end: async () => {},
}), { BigInt: {} }) }));

for (const writer of ['patterns', 'synthesize', 'summary', 'phantom'] as const) {
  test(`${writer}: actual caller holds enrollment/path gates through entire mutation`, async () => {
    const base = mkdtempSync(join(realpathSync(import.meta.dir), 'cycle-coordination-'));
    const pin = (name: string) => {
      const path = join(base, name); mkdirSync(path, { mode: 0o700 });
      const s = lstatSync(path, { bigint: true });
      return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 as const };
    };
    const manifest = { version: 1, deploymentId: 'deployment-example', brainId: randomUUID(), database: 'db-example', adapterRole: 'adapter-example', generation: '1', topology: 'single-host-local', serviceUid: process.getuid!(), roots: [{ sourceId: 'default', mappingGeneration: 'pin-example', directory: pin('root'), journal: pin('journal') }], lock: pin('lock'), indexedRoots: [] };
    const root = manifest.roots[0].directory.path;
    const paths = writer === 'phantom' ? ['note.md', 'people/note-example.md'] : ['note.md'];
    const file = join(root, 'note.md');
    writeFileSync(file, '# note\n');
    const page = { slug: 'note', type: 'note', title: 'Note', compiled_truth: '# note\n', timeline: '', frontmatter: {} };
    let enrolledSlug: string | undefined, checks = 0, mutations = 0, barrierEnabled = true, metadataFailure = false;
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
    async function assertExcluded() {
      for (const options of [{ rootMode: 'exclusive' as const, paths: [] }, ...paths.map(p => ({ rootMode: 'shared' as const, paths: [p] }))]) {
        const lock = await acquirePageFileLock({ root, lockDirectory: manifest.lock.path, topology: 'single-host-local', timeoutMs: 0, ...options });
        try { expect(lock).toBeNull(); } finally { await lock?.release(); }
      }
    }
    const mutate = async () => { mutations++; await assertExcluded(); };
    const engine: any = {
      kind: 'postgres',
      executeRaw: async (q: string, args: any[] = []) => {
        if (q.includes('to_regclass')) {
          if (metadataFailure) throw new Error('metadata offline');
          return [{ present: true }];
        }
        if (q.includes('FROM public.page_file_bindings')) {
          checks++;
          if (barrierEnabled && checks === 1) { entered(); await barrier; }
          return enrolledSlug === args[1] ? [{ source_id: 'default' }] : [];
        }
        if (q.includes('FROM sources')) return [{ id: 'default', local_path: root }];
        if (q.includes('FROM pages')) return [{ slug: 'people/note-example', connection_count: 1, source_path: null }];
        throw new Error(`Unexpected SQL: ${q}`);
      },
      getPage: async (slug: string) => ({ ...page, slug }),
      getTags: async () => [],
      putPage: mutate, refreshPageBody: mutate,
      migrateFactsToCanonical: async () => { await mutate(); return { migrated: 0 }; },
      rewriteLinks: mutate, softDeletePage: mutate, deleteFactsForPage: mutate,
    };
    const manifestJson = JSON.stringify(manifest);
    const runtime = await import('../src/core/page-file-runtime.ts');
    const lifecycle = await runtime.createPageFileRuntimeCandidate({ mode: 'offline-verification', engine,
      host: { mode: 'offline-verification', manifestJson, expected: { manifestSha256: createHash('sha256').update(manifestJson).digest('hex'), deploymentId: manifest.deploymentId, brainId: manifest.brainId, database: manifest.database, adapterRole: manifest.adapterRole, generation: manifest.generation } },
      authority: { mode: 'offline-verification', credentialReference: 'offline', resolveCredential: async () => 'postgres://fixture.invalid/offline', expected: { role: manifest.adapterRole, database: manifest.database, ordinaryRole: 'ordinary-example' } },
    });
    const patterns = await import('../src/core/cycle/patterns.ts');
    const synthesize = await import('../src/core/cycle/synthesize.ts');
    const phantom = await import('../src/core/cycle/phantom-redirect.ts');
    const invoke = () => writer === 'patterns' ? patterns.reverseWriteRefs(engine, root, [{ slug: 'note', source_id: 'default' }])
      : writer === 'synthesize' ? synthesize.__testing.reverseWriteRefs(engine, root, [{ slug: 'note', source_id: 'default' }])
      : writer === 'summary' ? synthesize.__testing.writeSummaryPage(engine, root, 'note', '2020-01-01', [], [])
      : phantom.tryRedirectPhantom(engine, page as any, 'default', root, false);
    try {
      await withEnv({ GBRAIN_HOME: base, GBRAIN_AUDIT_DIR: join(base, 'audit') }, async () => {
        if (writer === 'phantom') {
          barrierEnabled = false;
          enrolledSlug = 'people/note-example';
          await expect(invoke()).rejects.toThrow('page_file_unsupported_writer');
          expect(existsSync(join(root, paths[1]))).toBe(false);
          expect(mutations).toBe(0);
          enrolledSlug = undefined;
          checks = 0;
          barrierEnabled = true;
        }
        const pending = invoke();
        const settled = pending.then(value => ({ value }), error => ({ error }));
        try {
          await Promise.race([ready, pending.then(() => { throw new Error('missing barrier'); })]);
          expect(readFileSync(file, 'utf8')).toBe('# note\n');
          expect(mutations).toBe(0);
          await assertExcluded();
        } finally { release(); }
        const outcome = await settled;
        if ('error' in outcome) throw outcome.error;
        expect(checks).toBe(paths.length); // No reacquisition in tails.
        expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toBe('# note\n');
        barrierEnabled = false;
        for (const slug of writer === 'phantom' ? ['note', 'people/note-example'] : ['note']) {
          const lock = await acquirePageFileLock({ root, lockDirectory: manifest.lock.path, topology: 'single-host-local', rootMode: 'exclusive', paths: [], timeoutMs: 50 });
          expect(lock).not.toBeNull();
          try { enrolledSlug = slug; } finally { await lock?.release(); }
          const snapshot = paths.map(p => existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
          const beforeMutations = mutations;
          await expect(invoke()).rejects.toThrow('page_file_unsupported_writer');
          expect(mutations).toBe(beforeMutations);
          expect(paths.map(p => existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null)).toEqual(snapshot);
        }
        if (writer === 'phantom') {
          metadataFailure = true;
          const failure = await invoke().then(() => null, error => error);
          expect(failure?.code).toBe('page_file_gate_unavailable');
        }
      });
    } finally { release(); await lifecycle.close(); rmSync(base, { recursive: true, force: true }); }
  }, 15000);
}
