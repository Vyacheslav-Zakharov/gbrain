import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as bootstrapApi from '../src/core/page-file-bootstrap.ts';
import * as api from '../src/commands/page-file-operator.ts';

const cleanup: string[] = [];
afterEach(() => { mock.restore(); for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const originalBootstrap = bootstrapApi.loadPageFileBootstrap;
function fixture() {
  const base = mkdtempSync(join(realpathSync(import.meta.dir), 'source-operator-test-')); cleanup.push(base);
  const put = (n: string, s: string) => { const p = join(base,n); writeFileSync(p,s,{mode:0o400}); return p; };
  const pin = (n: string) => { const path = join(base,n); mkdirSync(path,{mode:0o700}); const s=lstatSync(path,{bigint:true}); return {path,dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:0o700}; };
  const manifest = {version:1,deploymentId:'operator-example',brainId:'11111111-1111-4111-8111-111111111111',database:'db-example',adapterRole:'adapter-example',generation:'1',topology:'single-host-local',serviceUid:process.getuid!(),roots:[{sourceId:'source-example',mappingGeneration:'1',directory:pin('root'),journal:pin('journal')}],lock:pin('lock'),indexedRoots:[]};
  const secret = 'postgres://enrollment-example:***@example.invalid/db-example';
  const adapter = 'postgres://adapter-example:***@example.invalid/db-example';
  const contract = {version:1,ordinaryRole:'ordinary-example',manifestPath:put('manifest',JSON.stringify(manifest)),credentialPath:put('adapter',adapter),credentialSha256:hash(adapter),sqlAuthority:{roles:{ordinary:'ordinary-example',adapter:'adapter-example',enrollment:'enrollment-example'},catalogPins:{}},expected:{manifestSha256:hash(JSON.stringify(manifest)),deploymentId:manifest.deploymentId,brainId:manifest.brainId,database:manifest.database,adapterRole:manifest.adapterRole,generation:'1'}};
  const bootstrap = {mode:'offline-verification',bootstrapPath:put('bootstrap',JSON.stringify(contract)),bootstrapSha256:hash(JSON.stringify(contract))};
  const credentialPath = put('enrollment',secret);
  const operator = {version:2,mode:'offline-verification',bootstrap,enrollmentCredentialPath:credentialPath,enrollmentCredentialSha256:hash(secret),sourceIds:['source-example']};
  const operatorPath=put('operator',JSON.stringify(operator));
  const anchor=put('anchor',JSON.stringify({operatorPath,operatorSha256:hash(JSON.stringify(operator))}));
  mock.module('../src/core/page-file-bootstrap.ts',()=>({...bootstrapApi,loadPageFileBootstrap:originalBootstrap,loadPageFileStartupBootstrap:()=>({status:'offline-verification',contract})}));
  return {base,put,manifest,contract,credentialPath,operator,operatorPath,anchor,secret};
}

async function harness(f: ReturnType<typeof fixture>) {
  const { parseMarkdown } = await import('../src/core/markdown.ts');
  const { PageFileDatabase } = await import('../src/core/page-file-db.ts');
  const rows: any[] = [], bindings = new Map<string,any>(), requests: any[] = [], statements: string[] = [];
  const sources = [{id:'source-example',local_path:f.manifest.roots[0]!.directory.path}];
  let sequence=0;
  const add = (slug: string, changes: any = {}) => {
    const raw=`---\ntitle: ${slug}\ntype: note\n---\n\n# ${slug}\n\nPrivate body.\n`;
    const parsed=parseMarkdown(raw,slug+'.md',{validate:true,expectedSlug:slug});
    const row={id:++sequence,source_id:'source-example',slug,source_path:slug+'.md',page_kind:'markdown',deleted_at:null,
      write_revision:'revision-'+sequence,type:parsed.type,title:parsed.title,compiled_truth:parsed.compiled_truth,timeline:parsed.timeline,
      frontmatter:JSON.parse(JSON.stringify(parsed.frontmatter)),...changes};
    writeFileSync(join(sources[0]!.local_path,slug+'.md'),raw); rows.push(row); return row;
  };
  const engine: any = {
    getConfig:async()=>null, getTags:async()=>[], transaction:async(fn:any)=>fn(engine),
    executeRaw:async(sql:string,args:any[]=[])=>{
      statements.push(sql);
      if(sql.includes('/* source-enrollment-inventory */')) return rows.filter(r=>r.source_id===args[0] && Buffer.compare(Buffer.from(r.slug),Buffer.from(args[1]))>0)
        .sort((a,b)=>Buffer.compare(Buffer.from(a.slug),Buffer.from(b.slug))).slice(0,args[2]).map(r=>({...r}));
      if(sql.includes('FROM sources')) return sources.filter(s=>!args.length||s.id===args[0]);
      if(sql.includes('AS "pageId"')) return rows.filter(r=>!r.deleted_at).map(r=>({pageId:String(r.id),sourceId:r.source_id,sourcePath:r.source_path??r.slug+'.md'}));
      if(sql.startsWith('INSERT INTO page_file_bindings')) {
        const [source_id,slug,page_id,binding_key,canonical_root,relative_path,indexed_raw_sha256]=args;
        bindings.set(slug,{source_id,slug,page_id,binding_key,canonical_root,relative_path,indexed_raw_sha256,binding_id:'binding-'+page_id,file_generation:'0',pending_op_id:null});return [];
      }
      if(sql.includes('FROM page_file_bindings')) return sql.includes('canonical_root=$1')
        ? [...bindings.values()].filter(b=>b.canonical_root===args[0]&&b.pending_op_id).slice(0,1)
        : bindings.has(args[1])?[{...bindings.get(args[1])}]:[];
      if(sql.includes('FROM pages')) return rows.filter(r=>r.source_id===args[0]&&r.slug===args[1]&&!r.deleted_at);
      throw new Error('unexpected SQL: '+sql);
    },
  };
  const db=new PageFileDatabase(engine,{brainId:f.manifest.brainId,mappingGeneration:'1',journalDirectory:f.manifest.roots[0]!.journal.path,withLockedBinding:async fn=>fn()});
  let failure='', candidate=true;
  mock.module('../src/core/page-file-runtime.ts',()=>({
    hasPageFileRuntimeCandidate:async()=>candidate,
    enrollPageFileRuntime:async(_ctx:any,source:string,slug:string,request:any)=>{ requests.push(request.reviewed); if(failure)throw new Error(failure);return db.enroll(source,slug,request.reviewed); },
    resolvePageFileRuntime:async()=>({pages:{get:async(source:string,slug:string,validate:any)=>{if(failure)throw new Error(failure);return db.get(source,slug,validate);}}}),
  }));
  const ctx:any={remote:false,config:{},engine};
  return {ctx,add,rows,bindings,requests,statements,sources,db,fail:(s:string)=>{failure=s;},candidate:(v:boolean)=>{candidate=v;}};
}

test('reconcile uses deterministic snapshots, bounded cursor, and verifies changed generations without reenrollment',async()=>{
  const f=fixture(), h=await harness(f), op=api.loadPageFileOperator({remote:false},f.anchor);
  h.add('a');h.add('b');h.add('c');
  const before=h.rows.map(r=>({...r}));
  const files=before.map(r=>readFileSync(join(h.sources[0]!.local_path,r.source_path),'utf8'));
  const first:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example',limit:2});
  expect(first.items.map((x:any)=>[x.slug,x.status])).toEqual([['a','enrolled'],['b','enrolled']]);
  expect(first.nextCursor).toBeString(); expect(first.items).toHaveLength(2);
  expect(h.requests[0]).toEqual({hostManifestSha256:f.contract.expected.manifestSha256,source:'source-example',slug:'a',pageId:'1',revision:'revision-1',canonicalRoot:h.sources[0]!.local_path,relativePath:'a.md',rawSha256:hash(readFileSync(join(h.sources[0]!.local_path,'a.md'),'utf8'))});
  const restart=api.loadPageFileOperator({remote:false},f.anchor);
  const next:any=await api.runPageFileOperator(h.ctx,restart,'reconcile',{source:'source-example',limit:2,cursor:first.nextCursor});
  expect(next.items.map((x:any)=>x.slug)).toEqual(['c']);expect(next.nextCursor).toBeNull();
  h.bindings.get('a').file_generation='7';const existing=structuredClone([...h.bindings]);
  const repeat:any=await api.runPageFileOperator(h.ctx,restart,'reconcile',{source:'source-example',limit:10});
  expect(repeat.items.map((x:any)=>x.status)).toEqual(['verified','verified','verified']);
  expect([...h.bindings]).toEqual(existing);expect(h.requests).toHaveLength(3);expect(h.rows).toEqual(before);
  expect(before.map(r=>readFileSync(join(h.sources[0]!.local_path,r.source_path),'utf8'))).toEqual(files);
  expect(h.statements.filter(sql=>/^\s*(INSERT|UPDATE|DELETE)/.test(sql)).every(sql=>sql.startsWith('INSERT INTO page_file_bindings'))).toBe(true);
  h.add('0-future');
  const future:any=await api.runPageFileOperator(h.ctx,restart,'reconcile',{source:'source-example',limit:10});
  expect(future.items[0]).toMatchObject({slug:'0-future',status:'enrolled'});expect(h.requests).toHaveLength(4);
  expect(JSON.stringify(future)).not.toContain('Private body');expect(JSON.stringify(future)).not.toContain(f.secret);
});

test('inventory is read-only and never reads enrollment credentials or claims projection eligibility',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);
  h.add('preview',{title:'index differs'});rmSync(f.credentialPath);
  const result:any=await api.runPageFileOperator(h.ctx,op,'inventory',{source:'source-example'});
  expect(result.items).toEqual([{source:'source-example',slug:'preview',status:'pending_enrollment',reason:'checked_enrollment_required'}]);
  expect(h.requests).toHaveLength(0);expect(h.bindings.size).toBe(0);
  expect(h.statements.every(sql=>!/^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
});

test('deleted/non-Markdown/missing/divergent pages remain unmodified with fixed reasons',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);
  h.add('deleted',{deleted_at:'2026-01-01'});h.add('nonmd',{page_kind:'binary'});
  h.add('missing');rmSync(join(h.sources[0]!.local_path,'missing.md'));
  h.add('pack-mismatch',{title:'unsupported projection'});
  const before=structuredClone(h.rows);
  const result:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(Object.fromEntries(result.items.map((i:any)=>[i.slug,i.reason]))).toEqual({deleted:'deleted_page',nonmd:'non_markdown',missing:'missing_file','pack-mismatch':'sync_required'});
  expect(h.bindings.size).toBe(0);expect(h.rows).toEqual(before);
});

test('unsafe inventory never weakens the complete collision proof for other pages',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);
  h.add('a');h.add('unsafe',{source_path:'../escape.md'});
  const result:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(result.items.map((i:any)=>i.reason)).toEqual(['invalid_binding','invalid_binding']);expect(h.requests).toHaveLength(0);
});

function rewrite(path:string, value:unknown) {
  chmodSync(path,0o600);writeFileSync(path,JSON.stringify(value));chmodSync(path,0o400);
}
function productionFixture(version:1|2) {
  const f=fixture();
  const approval={version,mode:'production-pilot',bootstrapSha256:f.operator.bootstrap.bootstrapSha256,
    ...(version===2?{sources:['source-example']}:{source:'source-example',slug:'a'})};
  const bootstrap={...f.operator.bootstrap,mode:'production-pilot',approvalPath:f.put('approval',JSON.stringify(approval)),approvalSha256:hash(JSON.stringify(approval))};
  const contract={...f.operator,mode:'production-pilot',bootstrap};
  rewrite(f.operatorPath,contract);rewrite(f.anchor,{operatorPath:f.operatorPath,operatorSha256:hash(JSON.stringify(contract))});
  mock.module('../src/core/page-file-bootstrap.ts',()=>({...bootstrapApi,loadPageFileBootstrap:originalBootstrap,loadPageFileStartupBootstrap:()=>originalBootstrap(bootstrap as any)}));
  return {...f,productionContract:contract};
}

test('real protected v2 admission admits source sweeps while real v1 admission cannot widen',async()=>{
  const legacy=productionFixture(1);
  expect(()=>api.loadPageFileOperator({remote:false},legacy.anchor)).toThrow('page_file_operator_invalid');
  const f=productionFixture(2),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);
  h.add('a');h.add('future-without-page-approval');
  const result:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(result.items.map((i:any)=>i.status)).toEqual(['enrolled','enrolled']);
  chmodSync(f.productionContract.bootstrap.approvalPath,0o600);
  await expect(api.runPageFileOperator(h.ctx,op,'inventory',{source:'source-example'})).rejects.toThrow('page_file_operator_invalid');
});

test('operator refuses manifest replacement between bootstrap validation and policy capture',()=>{
  const f=fixture();
  mock.module('../src/core/page-file-bootstrap.ts',()=>({...bootstrapApi,loadPageFileBootstrap:(anchor:any)=>{
    const loaded=originalBootstrap(anchor);
    rewrite(f.contract.manifestPath,{...f.manifest,generation:'changed'});
    return loaded;
  }}));
  expect(()=>api.loadPageFileOperator({remote:false},f.anchor)).toThrow('page_file_operator_invalid');
});

test('duplicate/unknown/empty source policy fails at protected loader',()=>{
  for(const sourceIds of [['source-example','source-example'],['foreign'],[]]) {
    const f=fixture(),contract={...f.operator,sourceIds};
    rewrite(f.operatorPath,contract);rewrite(f.anchor,{operatorPath:f.operatorPath,operatorSha256:hash(JSON.stringify(contract))});
    expect(()=>api.loadPageFileOperator({remote:false},f.anchor)).toThrow('page_file_operator_invalid');
  }
});

test('duplicate file ownership is not silently resolved',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);
  h.add('a');h.add('b',{source_path:'a.md'});
  const result:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(result.items.map((i:any)=>i.reason)).toEqual(['path_collision','path_collision']);expect(h.requests).toHaveLength(0);
});

test('root pending intent preserves existing generations and prevents new enrollment',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);
  h.add('a');await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  h.bindings.get('a').pending_op_id='unresolved-intent';h.bindings.get('a').file_generation='9';h.add('b');
  const before=structuredClone([...h.bindings]);
  const result:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(result.items.map((i:any)=>i.reason)).toEqual(['pending_recovery','pending_recovery']);
  expect([...h.bindings]).toEqual(before);expect(h.requests).toHaveLength(1);
});

test('dirty marker stays byte-identical and no page enrollment is attempted',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);h.add('a');
  const marker=join(f.manifest.lock.path,hash(h.sources[0]!.local_path+'\0ROOT')+'.dirty');writeFileSync(marker,'dirty evidence');
  const result:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(result.items[0].reason).toBe('page_file_root_sync_required');expect(readFileSync(marker,'utf8')).toBe('dirty evidence');expect(h.requests).toHaveLength(0);
});

test('stale observation and remap fail closed with no business mutations',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);const row=h.add('a');
  const query=h.ctx.engine.executeRaw;
  h.ctx.engine.executeRaw=async(sql:string,args:any[])=>{const r=await query(sql,args);if(sql.includes('/* source-enrollment-inventory */'))row.write_revision='changed-after-preview';return r;};
  const stale:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(stale.items[0].reason).toBe('page_file_enrollment_stale');expect(h.bindings.size).toBe(0);
  h.sources[0]!.local_path=join(f.base,'unapproved-root');
  const remap:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(remap.items[0].reason).toBe('binding_changed');expect(h.bindings.size).toBe(0);
});

test('bounds, source isolation, malformed cursors and forged capabilities are rejected before inventory',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);
  for(const options of [{source:'other'},{source:'source-example',limit:0},{source:'source-example',limit:101},
    {source:'source-example',limit:1.5},{source:'source-example',cursor:'!'},{source:'source-example',cursor:'a'.repeat(16385)},
    {source:'source-example',unexpected:true}]) {
    await expect(api.runPageFileOperator(h.ctx,op,'reconcile',options)).rejects.toThrow('page_file_operator_invalid');
  }
  for(const remote of [true,undefined,null,0]) await expect(api.runPageFileOperator({...h.ctx,remote},op,'inventory',{source:'source-example'})).rejects.toThrow('page_file_operator_denied');
  await expect(api.runPageFileOperator(h.ctx,{} as any,'inventory',{source:'source-example'})).rejects.toThrow('page_file_operator_invalid');
  expect(h.statements).toHaveLength(0);
  h.candidate(false);await expect(api.runPageFileOperator(h.ctx,op,'inventory',{source:'source-example'})).rejects.toThrow('page_file_operator_invalid');
});

test('cursor is bound to policy/source and duplicate/foreign inventory rows are rejected',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);h.add('a');h.add('b');
  const first:any=await api.runPageFileOperator(h.ctx,op,'inventory',{source:'source-example',limit:1});
  const cursor=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());
  for(const mutation of [{source:'foreign'},{policy:'0'.repeat(64)}]) {
    await expect(api.runPageFileOperator(h.ctx,op,'inventory',{source:'source-example',cursor:Buffer.from(JSON.stringify({...cursor,...mutation})).toString('base64url')})).rejects.toThrow('page_file_operator_invalid');
  }
  const query=h.ctx.engine.executeRaw;
  for(const mutation of ['duplicate','foreign']) {
    h.ctx.engine.executeRaw=async(sql:string,args:any[])=>sql.includes('/* source-enrollment-inventory */')
      ? mutation==='duplicate'?[h.rows[0],h.rows[0]]:[{...h.rows[0],source_id:'foreign'}]:query(sql,args);
    await expect(api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'})).rejects.toThrow('page_file_operator_invalid');
  }
  expect(h.requests).toHaveLength(0);
});

test('collision inventory truncation is explicit and unknown errors are redacted',async()=>{
  const f=fixture(),h=await harness(f),op=api.loadPageFileOperator({remote:false},f.anchor);h.add('a');
  const query=h.ctx.engine.executeRaw;
  h.ctx.engine.executeRaw=async(sql:string,args:any[])=>sql.includes('AS "pageId"')?Array(10001).fill({}):query(sql,args);
  const blocked:any=await api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'});
  expect(blocked.items[0].reason).toBe('page_file_inventory_limit');expect(h.requests).toHaveLength(0);
  h.ctx.engine.executeRaw=query;h.fail(f.secret);
  await expect(api.runPageFileOperator(h.ctx,op,'reconcile',{source:'source-example'})).rejects.toThrow('page_file_operator_invalid');
  expect(h.bindings.size).toBe(0);
});

test('source command help documents bounded local sweep and restart semantics',()=>{
  const child=spawnSync(process.execPath,['src/commands/page-file-operator.ts','--help'],{cwd:join(import.meta.dir,'..'),encoding:'utf8',timeout:5000});
  expect(child.status).toBe(0);expect(child.stdout).toContain('inventory|reconcile');expect(child.stdout).toContain('[limit] [cursor]');
});

test('protected source policy loads without a manual per-page review or enrollment secret', () => {
  const f=fixture(); rmSync(f.credentialPath);
  const op=api.loadPageFileOperator({remote:false},f.anchor);
  expect(op.reviewed).toBeUndefined();
  expect(JSON.stringify(op)).not.toContain(f.secret);
  expect(()=>op.verifyStartup()).not.toThrow();
});
