import { beforeAll, afterAll, test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { PageFileJournal, rawDigest } from '../src/core/page-file-journal.ts';
import { pageFileSyncHost } from '../src/core/page-file-sync.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
let engine: PGLiteEngine; let dir: string; let root: string; let config: any;
const page = { type:'concept',title:'Example',compiled_truth:'Before',timeline:'',frontmatter:{} };
const ctx = (extra = {}) => ({engine,config,remote:false,sourceId:'default',dryRun:false,logger:{info(){},warn(){},error(){},debug(){}},...extra} as OperationContext);
const call = (p:any,c=ctx()) => operationsByName.recover_page_file_checked.handler(c,p) as Promise<any>;
beforeAll(async () => {
 dir=await mkdtemp(join(tmpdir(),'runtime-recovery-')); root=join(dir,'source'); await mkdir(root); await mkdir(join(dir,'journal'));
 engine=new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
 config={engine:'pglite',page_file_runtime:{mode:'isolated-integration',topology:'single-host-local',brainId:'recovery',lockDirectory:join(dir,'locks'),journalDirectory:join(dir,'journal')}};
 await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[root]);
}, 30000);
afterAll(async()=>{await engine?.disconnect(); if(dir)await rm(dir,{recursive:true,force:true});});
async function prepared(slug:string, after=false) {
 await engine.putPage(slug,{...page,title:slug[0].toUpperCase()+slug.slice(1)}); await writeFile(join(root,slug+'.md'),'Before');
 const db=new PageFileDatabase(engine,{brainId:'recovery',journalDirectory:join(dir,'journal'),...pageFileSyncHost({root,paths:[slug+'.md'],lockDirectory:join(dir,'locks'),topology:'single-host-local'})});
 await db.enroll('default',slug); const snap=await db.get('default',slug,()=>{});
 const p={source_id:'default',slug,expected_revision:snap.revision,file_baseline:snap.file.baseline,page:{...snap.page,compiled_truth:'After'},raw_markdown:'After',operation_id:randomUUID()};
 const record={operationId:p.operation_id,requestDigest:rawDigest(Buffer.from(JSON.stringify(['default',slug,p.expected_revision,p.file_baseline,p.page,p.raw_markdown]))),target:join(root,slug+'.md'),bindingId:p.file_baseline.binding_id,expectedRevision:p.expected_revision,beforeDigest:p.file_baseline.raw_sha256,afterDigest:rawDigest(Buffer.from('After'))};
 await new PageFileJournal(join(dir,'journal')).prepare(record,Buffer.from('Before'),Buffer.from('After'));
 await engine.transaction(async tx=>{
 await tx.executeRaw("INSERT INTO page_file_operations(operation_id,binding_id,request_digest,record,state) VALUES($1,$2,$3,$4::text::jsonb,'prepared')",[p.operation_id,record.bindingId,record.requestDigest,JSON.stringify(record)]);
 await tx.executeRaw('UPDATE page_file_bindings SET pending_op_id=$2 WHERE binding_id=$1',[record.bindingId,p.operation_id]);
 });
 if(after)await writeFile(record.target,'After'); return p;
}
test('registered trusted recovery resumes exact prepared before-image and returns durable retry receipt',async()=>{
 const p=await prepared('resume');
 expect(operationsByName.recover_page_file_checked).toBeDefined();
 const result=await call({...p,action:'resume-exact'}); expect(result.status).toBe('committed');
 expect(await readFile(join(root,'resume.md'),'utf8')).toBe('After'); expect((await engine.getPage('resume'))!.compiled_truth).toBe('After');
 expect(await call({...p,action:'resume-exact'})).toEqual(result);
 const [b]=await engine.executeRaw<any>('SELECT * FROM page_file_bindings WHERE binding_id=$1',[p.file_baseline.binding_id]); expect(b.pending_op_id).toBeNull();
 const [op]=await engine.executeRaw<any>('SELECT * FROM page_file_operations WHERE operation_id=$1',[p.operation_id]); expect(op.revision).toBe(result.revision);
});
test('authorization, exact identity and unexpected bytes fail closed',async()=>{
 const p=await prepared('denied');
 for(const remote of [true,undefined]) await expect(call({...p,action:'abort'},ctx({remote}))).rejects.toMatchObject({code:'permission_denied'});
 await expect(call({...p,action:'abort'},ctx({viaSubagent:true,subagentId:7}))).rejects.toMatchObject({code:'permission_denied'});
 await expect(call({...p,action:'resume-exact',raw_markdown:'Substituted',page:{...p.page,compiled_truth:'Substituted'}})).rejects.toThrow('operation_id_reused');
 await expect(call({...p,action:'resume-exact',file_baseline:{...p.file_baseline,generation:'99'}})).rejects.toThrow('operation_id_reused');
 await writeFile(join(root,'denied.md'),'Third version');
 expect((await call({...p,action:'resume-exact'})).status).toBe('conflict');
 expect((await call({...p,action:'abort'})).status).toBe('conflict');
 expect(await readFile(join(root,'denied.md'),'utf8')).toBe('Third version');
 expect((await engine.getPage('denied'))!.compiled_truth).toBe('Before');
});
test('prepared after-image resumes projection but never aborts by rolling file back',async()=>{
 const p=await prepared('installed',true);
 expect((await call({...p,action:'abort'})).status).toBe('conflict');
 const result=await call({...p,action:'resume-exact'}); expect(result.status).toBe('committed');
 expect((await engine.getPage('installed'))!.compiled_truth).toBe('After');
 expect(await call({...p,action:'resume-exact'})).toEqual(result);
});
test('abort persists terminal receipt and ordinary retry cannot resurrect it',async()=>{
 const p=await prepared('abort'); const result=await call({...p,action:'abort'}); expect(result.status).toBe('aborted');
 expect(await call({...p,action:'abort'})).toEqual(result);
 expect((await engine.getPage('abort'))!.compiled_truth).toBe('Before'); expect(await readFile(join(root,'abort.md'),'utf8')).toBe('Before');
 const [op]=await engine.executeRaw<any>('SELECT * FROM page_file_operations WHERE operation_id=$1',[p.operation_id]); expect(op.state).toBe('aborted'); expect(op.revision).toBe(p.expected_revision);
 expect((await operationsByName.put_page_checked.handler(ctx(),p) as any).status).toBe('conflict');
 const [b]=await engine.executeRaw<any>('SELECT * FROM page_file_bindings WHERE binding_id=$1',[p.file_baseline.binding_id]); expect(b.pending_op_id).toBeNull();
});
