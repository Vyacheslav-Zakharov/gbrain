import { afterEach, expect, test, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const cleanup: string[] = [];
afterEach(() => { mock.restore(); for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
 const base = mkdtempSync(join(realpathSync(import.meta.dir), 'operator-test-')); cleanup.push(base);
 const put = (n: string, s: string) => { const p = join(base,n); writeFileSync(p,s,{mode:0o400}); return p; };
 const pin = (n: string) => { const path = join(base,n); mkdirSync(path,{mode:0o700}); const s=lstatSync(path,{bigint:true}); return {path,dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:0o700}; };
 const manifest = {version:1,deploymentId:'operator-example',brainId:'11111111-1111-4111-8111-111111111111',database:'db-example',adapterRole:'adapter-example',generation:'1',topology:'single-host-local',serviceUid:process.getuid!(),roots:[{sourceId:'source-example',mappingGeneration:'1',directory:pin('root'),journal:pin('journal')}],lock:pin('lock'),indexedRoots:[]};
 const secret = 'postgres://enrollment-example:SECRET@example.invalid/db-example';
 const adapter = 'postgres://adapter-example:OTHER@example.invalid/db-example';
 const contract = {version:1,ordinaryRole:'ordinary-example',manifestPath:put('manifest',JSON.stringify(manifest)),credentialPath:put('adapter',adapter),credentialSha256:hash(adapter),sqlAuthority:{roles:{ordinary:'ordinary-example',adapter:'adapter-example',enrollment:'enrollment-example'},catalogPins:{}},expected:{manifestSha256:hash(JSON.stringify(manifest)),deploymentId:manifest.deploymentId,brainId:manifest.brainId,database:manifest.database,adapterRole:manifest.adapterRole,generation:'1'}};
 const bootstrap = {mode:'offline-verification',bootstrapPath:put('bootstrap',JSON.stringify(contract)),bootstrapSha256:hash(JSON.stringify(contract))};
 const reviewed = {hostManifestSha256:contract.expected.manifestSha256,source:'source-example',slug:'page-example',pageId:'1',revision:'opaque-revision',canonicalRoot:manifest.roots[0].directory.path,relativePath:'page-example.md',rawSha256:'a'.repeat(64)};
 const credentialPath = put('enrollment',secret);
 const operator = {version:1,mode:'offline-verification',bootstrap,enrollmentCredentialPath:credentialPath,enrollmentCredentialSha256:hash(secret),reviewedPath:put('reviewed',JSON.stringify(reviewed)),reviewedSha256:hash(JSON.stringify(reviewed))};
 const operatorPath = put('operator',JSON.stringify(operator));
 const anchor = put('anchor',JSON.stringify({operatorPath,operatorSha256:hash(JSON.stringify(operator))}));
 return {base,put,anchor,operator,operatorPath,contract,credentialPath,secret,reviewed};
}

test('independent protected operator pin captures exact reviewed baseline; status loader never reads enrollment secret', async () => {
 const f=fixture(), mod=await api();
 rmSync(f.credentialPath);
 const loaded=mod.loadPageFileOperator({remote:false},f.anchor);
 expect(JSON.stringify(loaded)).not.toContain(f.secret);
 expect(loaded.reviewed).toEqual(f.reviewed);
 expect(() => loaded.revalidate()).not.toThrow();
 await expect(loaded.enrollment({remote:false})).rejects.toThrow('page_file_operator_invalid');
});

test('enrollment resolves only independently pinned separate credential and redacts failures', async () => {
 const f=fixture(), mod=await api();
 const loaded=mod.loadPageFileOperator({remote:false},f.anchor);
 const req=await loaded.enrollment({remote:false});
 expect(req.reviewed).toEqual(f.reviewed);
 expect(await req.authority.resolveCredential(f.credentialPath)).toBe(f.secret);
 await expect(req.authority.resolveCredential('/untrusted')).rejects.toThrow('page_file_operator_invalid');
 chmodSync(f.credentialPath,0o600); writeFileSync(f.credentialPath,f.secret+'drift'); chmodSync(f.credentialPath,0o400);
 await expect(req.authority.resolveCredential(f.credentialPath)).rejects.toThrow('page_file_operator_invalid');
 for(const remote of [true,undefined,null,0]) await expect(loaded.enrollment({remote})).rejects.toThrow('page_file_operator_denied');
});

for(const defect of ['pin','review','symlink','writable','production']) test(`operator refuses ${defect} without repair`,async()=>{
 const f=fixture(),mod=await api();
 if(defect==='pin') {chmodSync(f.operatorPath,0o600);writeFileSync(f.operatorPath,'{}');chmodSync(f.operatorPath,0o400);}
 if(defect==='review') {chmodSync(f.operator.reviewedPath,0o600);writeFileSync(f.operator.reviewedPath,JSON.stringify({...f.reviewed,revision:'new'}));chmodSync(f.operator.reviewedPath,0o400);}
 if(defect==='symlink') {rmSync(f.anchor);symlinkSync(f.operatorPath,f.anchor);}
 if(defect==='writable') chmodSync(f.base,0o777);
 if(defect==='production') {const value=JSON.stringify({...f.operator,mode:'production'});chmodSync(f.operatorPath,0o600);writeFileSync(f.operatorPath,value);chmodSync(f.operatorPath,0o400);chmodSync(f.anchor,0o600);writeFileSync(f.anchor,JSON.stringify({operatorPath:f.operatorPath,operatorSha256:hash(value)}));chmodSync(f.anchor,0o400);}
 expect(()=>mod.loadPageFileOperator({remote:false},f.anchor)).toThrow('page_file_operator_invalid');
});

test('runner requires local capability, exact startup, and reports dirty roots without recovery',async()=>{
 const f=fixture(),mod=await api();
 const bootstrap=await import('../src/core/page-file-bootstrap.ts');
 const original=bootstrap.loadPageFileBootstrap;
 mock.module('../src/core/page-file-bootstrap.ts',()=>({loadPageFileBootstrap:original,loadPageFileStartupBootstrap:()=>({status:'offline-verification',contract:f.contract})}));
 let enrolled:any, reads=0, failure='';
 mock.module('../src/core/page-file-runtime.ts',()=>({
   hasPageFileRuntimeCandidate:async()=>true,
   enrollPageFileRuntime:async(_c:any,s:string,p:string,r:any)=>{expect([s,p]).toEqual([f.reviewed.source,f.reviewed.slug]);enrolled=r;return {status:'enrolled'};},
   resolvePageFileRuntime:async()=>({pages:{get:async()=>{reads++;if(failure)throw new Error(failure);return {raw_markdown:'PRIVATE'};}}}),
 }));
 const operator=mod.loadPageFileOperator({remote:false},f.anchor);
 const ctx:any={remote:false,config:{},engine:{executeRaw:async()=>[{pending_op_id:null}]}};
 for(const remote of [true,undefined,null,0]) await expect(mod.runPageFileOperator({...ctx,remote},operator,'enroll')).rejects.toThrow('page_file_operator_denied');
 expect(enrolled).toBeUndefined();
 expect(await mod.runPageFileOperator(ctx,operator,'enroll')).toEqual({status:'enrolled'});
 expect(enrolled.reviewed).toEqual(f.reviewed);expect(reads).toBe(1);
 expect(await mod.runPageFileOperator(ctx,operator,'verify')).toEqual({status:'verified'});
 failure='page_file_root_sync_required';
 expect(await mod.runPageFileOperator(ctx,operator,'status')).toEqual({status:'page_file_root_sync_required'});
 failure=f.secret;
 await expect(mod.runPageFileOperator(ctx,operator,'verify')).rejects.toThrow('page_file_operator_invalid');
 ctx.engine.executeRaw=async()=>[{pending_op_id:'private-id'}];
 expect(await mod.runPageFileOperator(ctx,operator,'status')).toEqual({status:'pending_recovery'});
 await expect(mod.runPageFileOperator(ctx,{},'enroll')).rejects.toThrow('page_file_operator_invalid');
});

const api = () => import('../src/commands/page-file-operator.ts').catch(() => ({} as any));
test('operator denies every caller not explicitly local before reading authority', async () => {
  const mod = await api();
  expect(typeof mod.loadPageFileOperator).toBe('function');
  for (const remote of [true, undefined, null, 0, 'false']) {
    expect(() => mod.loadPageFileOperator({ remote }, '/missing')).toThrow('page_file_operator_denied');
  }
});
