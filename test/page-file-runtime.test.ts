import { beforeAll, afterAll, test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { pageFileSyncHost } from '../src/core/page-file-sync.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { loadConfigFileOnly } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';
import { acquirePageFileLock } from '../src/core/page-file-lock.ts';
import { resolvePageFileRuntime, resolvePageFileRootHost } from '../src/core/page-file-runtime.ts';
test('missing local configuration leaves root coordination unavailable', async () => {
 await expect(resolvePageFileRootHost({engine:{kind:'pglite'},config:null}, '/unused')).resolves.toBeUndefined();
});
let engine: PGLiteEngine; let dir: string; let root: string; let config: any;
const page = { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} };
const ctx = (extra = {}) => ({ engine, config, remote: true, sourceId: 'default', dryRun: false,
 logger: { info() {}, warn() {}, error() {}, debug() {} }, ...extra } as OperationContext);
const call = (name: string, p: any, c = ctx()) => operationsByName[name].handler(c,p) as Promise<any>;
beforeAll(async () => {
 dir = await mkdtemp(join(tmpdir(),'page-runtime-')); root = join(dir,'source');
 await mkdir(root); await mkdir(join(dir,'journal'));
 engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
 config = { engine:'pglite', page_file_runtime: { mode:'isolated-integration', topology:'single-host-local', brainId:'offline-runtime', lockDirectory:join(dir,'locks'), journalDirectory:join(dir,'journal') } };
 await mkdir(join(dir,'.gbrain'));
 await writeFile(join(dir,'.gbrain','config.json'),JSON.stringify(config));
 await withEnv({GBRAIN_HOME:dir},async () => { config = loadConfigFileOnly(); });
 await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[root]);
 await engine.putPage('example',page); await writeFile(join(root,'example.md'),'Before');
 // Explicit trusted local enrollment, never a side effect of the request handler.
 await new PageFileDatabase(engine,{brainId:'offline-runtime',journalDirectory:join(dir,'journal'),...pageFileSyncHost({root,paths:['example.md'],lockDirectory:join(dir,'locks'),topology:'single-host-local'})}).enroll('default','example');
});
afterAll(async () => { await engine?.disconnect(); if(dir) await rm(dir,{recursive:true,force:true}); });
test('production operation registry selects native file runtime from trusted server config', async () => {
 const p = {source_id:'default',slug:'example'};
 const snap = await call('get_page_checked',p);
 expect(snap.persistence).toBe('file_and_database');
 expect(snap.file.raw_markdown).toBe('Before');
 const applied = await call('put_page_checked',{...p,expected_revision:snap.revision,page:{...page,compiled_truth:'After'},operation_id:randomUUID(),file_baseline:snap.file.baseline,raw_markdown:'After',lockDirectory:'/caller-must-not-control'});
 expect(applied.status).toBe('committed');
 expect(await readFile(join(root,'example.md'),'utf8')).toBe('After');
 expect((await engine.getPage('example'))!.compiled_truth).toBe('After');
 expect((await call('get_page_checked',p)).file.raw_markdown).toBe('After');
});
test('runtime keeps production prerequisites closed and ignores request configuration', async () => {
 const p = {source_id:'default',slug:'example',page_file_runtime:config.page_file_runtime};
 await expect(call('get_page_checked',p,ctx({config:{engine:'pglite'}}))).rejects.toMatchObject({code:'ineligible_page'});
 await expect(call('get_page_checked',p,ctx({config:{...config,page_file_runtime:{...config.page_file_runtime,mode:'production'}}}))).rejects.toMatchObject({code:'file_runtime_prerequisites_pending'});
 await expect(call('get_page_checked',p,ctx({config:{...config,page_file_runtime:{...config.page_file_runtime,topology:'multi-host'}}}))).rejects.toMatchObject({code:'unsupported_file_runtime'});
 await expect(call('get_page_checked',p,ctx({auth:{allowedSources:[]}}))).rejects.toMatchObject({code:'permission_denied'});
 expect(await readFile(join(root,'example.md'),'utf8')).toBe('After');
});
test('production handler actually respects the native root gate', async () => {
 const lock = await acquirePageFileLock({root,lockDirectory:config.page_file_runtime.lockDirectory,topology:'single-host-local',rootMode:'exclusive'});
 expect(lock).not.toBeNull();
 try { await expect(call('get_page_checked',{source_id:'default',slug:'example'})).rejects.toMatchObject({code:'file_lock_unavailable'}); }
 finally { await lock?.release(); }
});
test('runtime sync captures before preparation and rejects after production checked publish', async () => {
 const p = {source_id:'default',slug:'example'};
 const runtime = (await resolvePageFileRuntime(ctx(),'default','example'))!;
 const original = await runtime.sync.capture('default','example');
 const snap = await call('get_page_checked',p);
 await call('put_page_checked',{...p,expected_revision:snap.revision,page:{...page,compiled_truth:'Newest'},operation_id:randomUUID(),file_baseline:snap.file.baseline,raw_markdown:'Newest'});
 await expect(runtime.sync.commit(original)).rejects.toMatchObject({code:'stale_file_baseline',acknowledgeable:false});
 expect(await readFile(join(root,'example.md'),'utf8')).toBe('Newest');
 expect((await engine.getPage('example'))!.compiled_truth).toBe('Newest');
});
