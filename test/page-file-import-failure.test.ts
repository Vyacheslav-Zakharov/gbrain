import { test, expect } from 'bun:test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PageFileSyncConflict } from '../src/core/page-file-sync.ts';
import { withLegacyPageFileRootMutation } from '../src/core/page-file-root-gate.ts';

// Execute the complete production runImport (including its nested worker loop).
// External config/provider/DB boundaries are offline doubles, not module mocks.
const source = readFileSync(new URL('../src/commands/import.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('import.ts', source, ts.ScriptTarget.Latest, true);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runImport')!;
function harness(options: { error?: unknown; workers?: number; completed?: string[]; files?: string[]; rootError?: unknown; enrolled?: boolean; slow?: boolean } = {}) {
  const events: string[] = [];
  const snapshots: string[][] = [];
  let calls = 0;
  const importFile = async (_e: unknown, _p: string, rel: string) => {
    calls++;
    if (options.slow && rel === 'b.md') {
      await new Promise(r => setTimeout(r, 20)); events.push('settled');
      return { status: 'imported', slug: 'b', chunks: 1 };
    }
    if (options.error) throw options.error;
    return { status: 'skipped', error: 'unchanged' };
  };
  class Worker {
    async connect() {}
    async disconnect() { events.push('disconnect'); }
  }
  const boundaries: Record<string, unknown> = {
    '../core/schema-pack/load-active.ts': { loadActivePack: async () => ({ manifest: { page_types: [] } }) },
    '../core/config.ts': { loadConfig: () => ({ database_url: 'offline' }) },
    '../core/sync-concurrency.ts': { parseWorkers: () => options.workers ?? 1 },
    '../core/postgres-engine.ts': { PostgresEngine: Worker },
    '../core/db.ts': { resolvePoolSize: () => 1 },
  };
  const bindings = {
    offlineImport: async (name: string) => { if (!(name in boundaries)) throw new Error(`Unstubbed import ${name}`); return boundaries[name]; },
    join, relative, console: { log() {}, error() {} },
    collectSyncableFiles: () => options.files ?? ['/offline/a.md'], sortNewestFirst() {},
    gbrainPath: () => '/offline-checkpoint', loadCheckpoint: () => ({ completedPaths: options.completed ?? [] }),
    resumeFilter: (files: string[], dir: string, completed: Set<string>) => files.filter(f => !completed.has(relative(dir, f))),
    saveCheckpoint: (_p: string, cp: any) => snapshots.push(cp.completedPaths),
    clearCheckpoint: () => events.push('clear'), existsSync: () => false,
    createProgress: () => ({ start() {}, tick() {}, finish() { events.push('finish'); } }),
    cliOptsToProgressOptions() {}, getCliOptions() {}, isImageFilePath: () => false,
    importFile, importImageFile: importFile, loadConfig: () => ({ database_url: 'offline' }),
    withLegacyPageFileRootMutation: async (e: any, r: string, f: () => unknown) => { if (options.rootError) throw options.rootError; return withLegacyPageFileRootMutation(e, r, f); },
    PageFileSyncConflict,
  };
  const text = node.getText(ast).replace(/^export /, '').replace(/import\(/g, 'offlineImport(');
  const code = ts.transpile(text, { target: ts.ScriptTarget.ES2022 });
  const run = new Function(...Object.keys(bindings), `${code}; return runImport;`)(...Object.values(bindings));
  const engine = { kind: 'postgres', logIngest: async () => events.push('ingest'), executeRaw: async (sql: string) => sql.includes('to_regclass') ? [{ present: true }] : sql.includes('page_file_bindings') && options.enrolled ? [{ canonical_root: '/offline', relative_path: 'a.md' }] : [], setConfig: async () => events.push('bookmark') };
  return { run: () => run(engine, ['/offline', '--no-embed', '--workers', String(options.workers ?? 1)], { sourceId: 'alpha', managedBookmark: true }), events, snapshots, calls: () => calls };
}

for (const files of [['/offline/a.md'], []]) {
  test(`enrolled root refuses before path-only resume or missing-file enumeration (${files.length} files)`, async () => {
    const h = harness({ enrolled: true, completed: ['a.md'], files });
    await expect(h.run()).rejects.toMatchObject({ acknowledgeable: false });
    expect(h.calls()).toBe(0);
    expect(h.events).not.toContain('clear');
    expect(h.events).not.toContain('ingest');
    expect(h.snapshots).toEqual([]);
  });
}

test('ordinary malformed files retain retryable failure results', async () => {
  const h = harness({ error: new Error('invalid YAML') });
  expect((await h.run()).failures).toEqual([{ path: 'a.md', error: 'invalid YAML' }]);
  expect(h.events).not.toContain('clear');
});

test('parallel refusal waits for in-flight work before disconnect, without claiming more files', async () => {
  const error = new PageFileSyncConflict('stale_file_baseline');
  const h = harness({ error, workers: 2, slow: true, files: ['/offline/a.md', '/offline/b.md', '/offline/c.md'] });
  await expect(h.run()).rejects.toBe(error);
  expect(h.events.indexOf('settled')).toBeGreaterThanOrEqual(0);
  expect(h.events.indexOf('disconnect')).toBeGreaterThan(h.events.indexOf('settled'));
  expect(h.calls()).toBe(2);
  expect(h.events).not.toContain('clear');
});

test('runImport propagates a non-acknowledgeable failure unchanged, before success reporting', async () => {
  const error = new PageFileSyncConflict('pending_recovery');
  const h = harness({ error });
  await expect(h.run()).rejects.toBe(error);
  expect(h.events).not.toContain('ingest');
  expect(h.events).not.toContain('clear');
  expect(h.snapshots).toEqual([]);
});
