import { test, expect } from 'bun:test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { PageFileSyncConflict } from '../src/core/page-file-sync.ts';

// Execute the actual nested scheduler function with offline boundary doubles.
// AST extraction avoids loading CLI configuration/providers or a live database.
const source = readFileSync(new URL('../src/commands/sync.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('sync.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function functionText(name: string): string {
  let found: ts.FunctionDeclaration | undefined;
  function visit(n: ts.Node) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  if (!found) throw new Error(`Missing actual function ${name}`);
  return found.getText(ast);
}
function catchFor(call: string, functionName = 'performSyncInner'): string {
  const scope = ts.createSourceFile('scope.ts', functionText(functionName), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let result: string | undefined;
  function visit(n: ts.Node) {
    if (ts.isTryStatement(n) && n.catchClause && n.tryBlock.statements.some(s => s.getText(scope).includes(call))) {
      // Select the innermost matching try, not an enclosing orchestration try.
      result = n.catchClause.getText(scope);
    }
    ts.forEachChild(n, visit);
  }
  visit(scope);
  if (!result) throw new Error(`Missing catch for ${call}`);
  return result;
}
for (const [call, scope] of [
  ['await engine.updateSlug(', 'performSyncInner'],
  ['await engine.deletePages(slugs,', 'performSyncInner'],
  ['await engine.deletePage(slugs[j],', 'performSyncInner'],
  ['await engine.deletePage(slug, deleteOpts)', 'performSyncInner'],
  ['await engine.deletePages(batch,', 'performFullSync'],
  ['await engine.deletePage(slug, deleteScopedOpts)', 'performFullSync'],
]) {
  test(`actual ${scope} catch preserves safety error at ${call}`, async () => {
    const conflict = new PageFileSyncConflict('pending_recovery');
    let fallback = 0;
    const body = ts.transpile(`async function run() { try { throw conflict; } ${catchFor(call, scope)} }`, { target: ts.ScriptTarget.ES2022 });
    const run = new Function('conflict', 'engine', 'slugs', 'batch', 'failedFiles', 'pagesAffected', 'markCompleted', 'deleteScopedOpts', 'deleteOpts', 'path', 'slug', 'j', 'err',
      `${body}; return run;`)(conflict, { deletePage: async () => { fallback++; } }, ['a'], ['a.md'], [], [], async () => { fallback++; }, {}, {}, 'a.md', 'a', 0, new Error('batch'));
    await expect(run()).rejects.toBe(conflict);
    expect(fallback).toBe(0);
  });
}
test('full-sync deletion safety conflict occurs before bookmark advance', async () => {
  const conflict = new PageFileSyncConflict('pending_recovery');
  let advances = 0;
  const text = functionText('performFullSync').replace("import('./import.ts')", 'offlineImport');
  const code = ts.transpile(text, { target: ts.ScriptTarget.ES2022 });
  const bindings = {
    offlineImport: { runImport: async () => ({ imported: 0, skipped: 0, errors: 0, failures: [], chunksCreated: 0 }) },
    autoConcurrency: () => 1, slog() {}, serr() {}, DEFAULT_SOURCE_ID: 'default',
    loadSyncFailures: () => [], isSkippablePath: () => true, newestCommitMs: () => 0,
    writeSyncAnchor: async (_e: unknown, _s: unknown, field: string) => { if (field === 'last_commit') advances++; },
    writeChunkerVersion: async () => {}, CHUNKER_VERSION: 1,
    applySyncFailureGate: async (o: any) => { await o.advance(); return { advanced: true, acknowledged: 0, autoSkipped: [] }; },
    collectSyncableFiles: () => [], relative: (_r: string, p: string) => p,
    isSyncable: () => true, DELETE_BATCH_SIZE: 500,
  };
  const run = new Function(...Object.keys(bindings), `${code}; return performFullSync;`)(...Object.values(bindings));
  const engine = { setConfig: async () => {}, executeRaw: async () => [{ slug: 'a', source_path: 'a.md' }], deletePages: async () => { throw conflict; } };
  await expect(run(engine, '/offline', 'target', { sourceId: 'alpha', noEmbed: true, skipFailed: true })).rejects.toBe(conflict);
  expect(advances).toBe(0);
});
function load(name: string, bindings: Record<string, unknown>) {
  const code = ts.transpile(functionText(name), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext });
  return new Function(...Object.keys(bindings), `${code}; return ${name};`)(...Object.values(bindings));
}
function scheduler(error?: Error) {
  const completed: string[] = [], failures: unknown[] = [], successes: string[] = [];
  let released = 0;
  const fn = load('importOnePath', {
    join: (...p: string[]) => p.join('/'), syncRepoPath: '/offline', existsSync: () => true,
    markCompleted: async (p: string) => { completed.push(p); }, succeededPaths: successes,
    progressAt: { last: 0 }, progress: { tick() {} }, serr() {}, opts: {}, noEmbed: true,
    // Enclosing sync scope supplies undefined when no local runtime config exists.
    syncRuntimeConfig: undefined,
    syncActivePack: undefined, failedFiles: failures, pagesAffected: [], chunksCreated: 0, filesImported: 0,
    pacer: { acquire: async () => ({ release() { released++; } }), pace: async () => {} },
    observed: async (_: unknown, f: () => Promise<unknown>) => f(),
    importFile: async () => { if (error) throw error; return { status: 'skipped' }; },
    maybeYield: async () => {}, AbortError: class extends Error {},
  });
  return { run: () => fn({}, 'notes/a.md'), completed, failures, successes, released: () => released };
}
for (const code of ['pending_recovery', 'stale_file_baseline', 'unsupported_sync_projection']) {
  test(`actual import scheduler propagates ${code} before ledger/checkpoint`, async () => {
    const conflict = new PageFileSyncConflict(code);
    const s = scheduler(conflict);
    await expect(s.run()).rejects.toBe(conflict);
    expect(s.completed).toEqual([]);
    expect(s.failures).toEqual([]); // never becomes an ageable/acknowledgeable ledger row
    expect(s.successes).toEqual([]);
    expect(s.released()).toBe(1);
  });
}
test('ordinary parse errors remain retryable; unchanged import still completes', async () => {
  const bad = scheduler(new Error('invalid YAML'));
  await bad.run();
  expect(bad.failures).toEqual([{ path: 'notes/a.md', error: 'invalid YAML' }]);
  expect(bad.completed).toEqual([]);
  const good = scheduler();
  await good.run();
  expect(good.completed).toEqual(['notes/a.md']);
});
