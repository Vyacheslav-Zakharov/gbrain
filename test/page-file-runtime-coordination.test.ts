import { beforeAll, afterAll, test, expect, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { acquirePageFileLock } from '../src/core/page-file-lock.ts';
import * as runtime from '../src/core/page-file-runtime.ts';
import { withEnv } from './helpers/with-env.ts';
let engine: PGLiteEngine, dir: string, root: string, config: any;
const page = {type:'concept',title:'Example',compiled_truth:'Before',timeline:'',frontmatter:{}};
const ctx = () => ({engine,config,remote:true,sourceId:'default',dryRun:false,logger:{info(){},warn(){},error(){},debug(){}}} as OperationContext);
beforeAll(async () => {
 dir=await mkdtemp(join(tmpdir(),'runtime-coordination-')); root=join(dir,'source');
 await mkdir(root); await mkdir(join(dir,'journal'));
 engine=new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
 config={engine:'pglite',page_file_runtime:{mode:'isolated-integration',topology:'single-host-local',brainId:'offline',lockDirectory:join(dir,'locks'),journalDirectory:join(dir,'journal')}};
 await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[root]);
 await engine.putPage('example',page); await writeFile(join(root,'example.md'),'Before');
},30000);
test('actual legacy handler holds gate across DB commit and file tail against enrollment',async()=>{
 await engine.putPage('writer-first',page); await writeFile(join(root,'writer-first.md'),'Before');
 let entered!:()=>void, release!:()=>void;
 const ready=new Promise<void>(r=>entered=r), barrier=new Promise<void>(r=>release=r);
 const getTags=engine.getTags.bind(engine);
 const spy=spyOn(engine,'getTags').mockImplementation(async(slug,opts)=>{
  if(slug==='writer-first'){entered(); await barrier;}
  return getTags(slug,opts);
 });
 const writer=offline(async()=>operationsByName.put_page.handler(ctx(),{source_id:'default',slug:'writer-first',content:'After'}));
 try {
  await ready;
  expect((await engine.getPage('writer-first'))!.compiled_truth).toBe('After');
  expect(await readFile(join(root,'writer-first.md'),'utf8')).toBe('Before');
  await expect(runtime.enrollPageFileRuntime({...ctx(),remote:false},'default','writer-first')).rejects.toThrow('page_file_gate_busy');
  expect(await engine.executeRaw("SELECT slug FROM page_file_bindings WHERE slug='writer-first'")).toHaveLength(0);
 } finally {release(); spy.mockRestore(); await writer;}
 expect(await readFile(join(root,'writer-first.md'),'utf8')).toContain('After');
});
test('explicit runtime enrollment owns exclusive root through commit; registry cannot mutate',async()=>{
 expect(typeof runtime.enrollPageFileRuntime).toBe('function');
 let entered!:()=>void, release!:()=>void;
 const ready=new Promise<void>(r=>entered=r), barrier=new Promise<void>(r=>release=r);
 const transaction=engine.transaction.bind(engine);
 const spy=spyOn(engine,'transaction').mockImplementation(async <T>(fn: (tx: import('../src/core/engine.ts').BrainEngine) => Promise<T>): Promise<T> => {
  const result=await transaction(fn); entered(); await barrier; return result;
 });
 const enrollment=runtime.enrollPageFileRuntime({...ctx(),remote:false},'default','example');
 try {
  await ready;
  await expect(offline(async()=>operationsByName.put_page.handler(ctx(),{source_id:'default',slug:'unrelated',content:'Other'}))).rejects.toThrow('page_file_gate_busy');
  expect(await engine.getPage('unrelated')).toBeNull();
 } finally {release(); spy.mockRestore(); await enrollment;}
 expect((await operationsByName.get_page_checked.handler(ctx(),{source_id:'default',slug:'example'}) as any).file.raw_markdown).toBe('Before');
 const enrolledResult:any=await offline(async()=>operationsByName.put_page.handler(ctx(),{source_id:'default',slug:'example',content:'Accepted ordinary update'}));
 expect(enrolledResult.write_through.written).toBe(true);
 expect((await engine.getPage('example'))!.compiled_truth).toBe('Accepted ordinary update');
 expect(await readFile(join(root,'example.md'),'utf8')).toContain('Accepted ordinary update');
 const result:any=await offline(async()=>operationsByName.put_page.handler(ctx(),{source_id:'default',slug:'unrelated',content:'Other'}));
 expect(result.write_through.written).toBe(true);
 expect((await engine.getPage('unrelated'))!.compiled_truth).toBe('Other');
 expect(await readFile(join(root,'unrelated.md'),'utf8')).toContain('Other');
});
afterAll(async()=>{await engine?.disconnect(); if(dir) await rm(dir,{recursive:true,force:true});});
const offline = <T>(fn:()=>Promise<T>) => withEnv({GBRAIN_HOME:dir,OPENAI_API_KEY:undefined,ANTHROPIC_API_KEY:undefined,GEMINI_API_KEY:undefined,GOOGLE_API_KEY:undefined,VOYAGE_API_KEY:undefined},fn);
test('registered legacy put refuses the enrollment root barrier before DB mutation',async()=>{
 const lock=await acquirePageFileLock({root,...config.page_file_runtime,rootMode:'exclusive',paths:[]});
 expect(lock).not.toBeNull();
 const beforePage=await engine.getPage('example');
 const beforeFile=await readFile(join(root,'example.md'),'utf8');
 try {
  await expect(offline(async()=>operationsByName.put_page.handler(ctx(),{source_id:'default',slug:'example',content:'After',lockDirectory:join(dir,'attacker')}))).rejects.toThrow('file_lock_unavailable');
  expect(await engine.getPage('example')).toEqual(beforePage);
  expect(await readFile(join(root,'example.md'),'utf8')).toBe(beforeFile);
 } finally {await lock?.release();}
});
