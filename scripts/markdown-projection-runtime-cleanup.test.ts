import {test,expect,spyOn} from 'bun:test';
import * as childProcess from 'node:child_process';
import * as postgresModule from 'postgres';
import {mkdtemp,writeFile,access,mkdir,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runtimeHosted} from './markdown-projection-runtime-hosted';
import {serializePageToMarkdown} from '../src/core/markdown';

// Adapted from the independent review's actual-caller executable repro.
// Offline transport only: no database, container, or runtime subprocess.
for(const mode of ['healthy-success','held-success','nonempty-base','primary','combined','cleanup-only','unknown-ownership','unproven-stop','proof-missing','proof-mismatch','proof-residue','proof-run-id','proof-accounting','proof-inventory','no-worker-proof'] as const)test(`runtimeHosted cleanup: ${mode}`,async()=>{
 const cleanMode=mode==='healthy-success'||mode==='held-success'||mode==='nonempty-base';
 const sourceId=`fixture-${mode}`;
 const base=await mkdtemp(`${process.cwd()}/.runtime-cleanup-test-`);
 const config=`${base}/runtime.json`,root=`${base}/output`;
 await writeFile(config,'offline sentinel',{mode:0o600});
 if(mode==='nonempty-base')await writeFile(`${base}/unknown-evidence`,'retain me');
 const env={GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,MARKDOWN_PROJECTION_DISPOSABLE:process.env.MARKDOWN_PROJECTION_DISPOSABLE};
 process.env.GITHUB_ACTIONS='true';process.env.MARKDOWN_PROJECTION_DISPOSABLE='CREATE_AND_DROP_DATABASE';
 const primary=new Error('PRIMARY_SEED_FAILURE'),owned=new Error('DROP_OWNED_FAILURE'),role=new Error('DROP_ROLE_FAILURE');
 const calls:string[]=[],events:any[]=[];
 const page:any={slug:'runtime-page',type:'note',title:'Runtime fixture',compiled_truth:'Protected CLI fixture',timeline:'',frontmatter:{}};
 const bytes=serializePageToMarkdown(page,[]);
 let invocation=0;
 const queueCalls:string[]=[],owners:any[]=[];
 let connections=0,closed=0;
 const connect=spyOn(postgresModule,'default').mockImplementation(((options:any)=>{
  expect(options.database).toBe('mp_accept_0123456789abcdef');
  expect(options.username).toBe('mp_accept_0123456789abcdef_runtime');
  connections++;
  return {unsafe:async(sql:string,p:unknown[])=>{
   expect(sql).toContain('INSERT INTO public.markdown_projection_attempts');
   expect(p[0]).toBe(sourceId);expect(p[2]).toBe(1);
   if(owners.length)return [];
   owners.push({source_id:p[0],run_id:p[1],job_id:p[2],released_at:null,state:mode==='no-worker-proof'?'running':'reserved',supervisor_pid:null,supervisor_start:null});
   return [{run_id:p[1]}];
  },end:async(options:any)=>{expect(options).toEqual({timeout:2});closed++;}} as any;
 }) as typeof postgresModule.default);
 const engine:any={putPage:async()=>{},getPage:async()=>page,
  getConfig:async(key:string)=>{expect(key).toBe('version');queueCalls.push('schema');return '7';},
  transaction:async(fn:any)=>{queueCalls.push('transaction');return fn({executeRaw:async(sql:string,p:unknown[])=>{
   expect(sql).toStartWith('INSERT INTO minion_jobs');expect(sql).toContain('RETURNING *');
   expect(p.slice(0,5)).toEqual(['ordinary-containment-fixture','default','waiting',0,{}]);
   queueCalls.push('insert');return [{id:1,name:p[0],queue:p[1],status:p[2],data:p[4]}];
  }});},
  executeRaw:async(sql:string,p:unknown[])=>{
   if(sql.startsWith('DELETE FROM minion_jobs WHERE id')){
    expect(p).toEqual([1]);expect(sql).toContain("status IN ('completed', 'dead', 'cancelled', 'failed')");
    queueCalls.push('remove');return []; // Newly submitted waiting job is not removable.
   }
   expect(sql).toContain('WITH pruned AS');expect(sql).toContain('DELETE FROM minion_jobs');
   expect(p[0]).toEqual(['completed','dead','cancelled']);expect(typeof p[1]).toBe('string');
   queueCalls.push('prune');return [{count:'0'}];
  }
 };
 const spawn=spyOn(childProcess,'spawnSync').mockImplementation(((_exe:any,args:string[])=>{
  invocation++;
  if(mode==='unproven-stop')return {error:new Error('timeout'),signal:'SIGKILL',status:null,stdout:'',stderr:''};
  if(mode==='proof-missing')return {status:0,signal:null,stdout:'{}',stderr:''};
  const argv=args.slice(args.indexOf('--')+1);const runId=args[3],scenario=args[5],boundRoot=args[7];
  const action=argv[2],path=argv[4];
  const expected=invocation===1?'idle':invocation<=5?'not_required':invocation===13?'materialized':'idle';
  const refused=(invocation>=6&&invocation<=12)||invocation===15;
  if(invocation===13)require('node:fs').writeFileSync(`${root}/page.md`,bytes);
  const stdout=refused?'':JSON.stringify({status:'passed',copyStatus:expected,projectionStatus:{pending:'1',containment:owners.length?'operator_blocked_no_automatic_recovery':'none'},final:true,attempts:[{reaped:true,exitCode:0}]});
  return {status:0,signal:null,stdout:JSON.stringify({protocol:'disposable-cli-parent-v2',final:true,runId:mode==='proof-run-id'?'foreign':runId,scenario,root:boundRoot,childAccounting:mode==='proof-accounting'?'poll-empty':'ECHILD',launched:mode==='proof-inventory'?[]:[123],errors:[],argv:mode==='proof-mismatch'?['wrong']:argv,pid:123,tracked:{123:{start:'1',group:123,session:123}},reaped:true,members:mode==='proof-residue'?[123]:[],sessionMembers:[],exit:refused?1:0,stdout,stderr:invocation===15?JSON.stringify({code:'projection_reservation_unavailable_operator_required'}):''}),stderr:''};
 }) as any);
 const db:any=async(parts:TemplateStringsArray)=>{
  const sql=parts.join('?');calls.push(sql);
  if(sql.includes('INSERT INTO sources')&&(mode==='primary'||mode==='combined'))throw primary;
  if(sql.includes('FROM pg_roles WHERE'))return [];
  if(sql.includes('FROM pg_roles r'))return [{rolsuper:false}];
  if(sql.includes('FROM public.markdown_projection_attempts'))return owners.map(row=>({...row}));
  if(sql.includes('SELECT * FROM markdown_projection_current'))return [{current_path:'page.md',current_hash:createHash('sha256').update(bytes).digest('hex')}];
  if(sql.includes('SELECT * FROM markdown_projection_obligations'))return [{generation:1,materialized_generation:1,status:'materialized'}];
  return [];
 };
 db.unsafe=async(sql:string)=>{calls.push(sql.replace(/PASSWORD '[^']*'/,'PASSWORD [REDACTED]'));if(sql.startsWith('DROP OWNED')&&!cleanMode)throw owned;if(sql.startsWith('DROP ROLE')&&mode==='combined'){await rm(config);await mkdir(config);await writeFile(`${config}/block`,'fixture');throw role;}return [];};
 let caught:any;
 try{
  try{await runtimeHosted(db,engine,'mp_accept_0123456789abcdef','192.0.2.1',base,v=>events.push(v),mode==='cleanup-only'||mode==='healthy-success'||mode==='nonempty-base'?'healthy':'unknown-ownership',sourceId);}catch(e){caught=e;}
  if(cleanMode){
   expect(invocation).toBe(mode==='held-success'?16:14);
   expect(await access(root).then(()=>true,()=>false)).toBe(false);
   expect(await access(config).then(()=>true,()=>false)).toBe(false);
   if(mode==='nonempty-base'){
    expect(caught).toBeInstanceOf(AggregateError);expect(caught.cleanupErrors.map((e:any)=>e.stage)).toEqual(['base']);
    expect(await readFile(`${base}/unknown-evidence`,'utf8')).toBe('retain me');
   }else{expect(caught).toBeUndefined();expect(await access(base).then(()=>true,()=>false)).toBe(false);}
   return;
  }
  expect(await access(base).then(()=>true,()=>false)).toBe(true);
  if(mode==='unknown-ownership'||mode==='no-worker-proof'){
   expect(queueCalls).toEqual(['schema','transaction','insert','remove','prune']);
   expect(connections).toBe(2);expect(closed).toBe(2);expect(owners).toHaveLength(1);
   expect(events.some(e=>e.stage==='runtime.containment'&&e.status==='passed')).toBe(true);
   expect(events.some(e=>e.stage==='runtime.held-no-worker')).toBe(mode!=='no-worker-proof');
  }else{expect(queueCalls).toEqual([]);expect(connections).toBe(0);}
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught.cleanupErrors.some((e:any)=>e.stage==='role.objects'&&e.error===owned)).toBe(true);
  expect(calls.some(s=>s.startsWith('DROP ROLE'))).toBe(true);
  expect(events.at(-1).status).toBe('failed');
  if(mode==='primary'||mode==='combined'){expect(caught.primaryError).toBe(primary);expect(caught.cause).toBe(primary);}
  if(mode==='combined'){expect(caught.cleanupErrors.map((e:any)=>e.stage)).toEqual(['role.objects','role.login','config']);}
  else expect(await access(config).then(()=>true,()=>false)).toBe(false);
  if(mode==='cleanup-only'||mode==='unknown-ownership'){
   expect(caught.primaryError).toBeUndefined();expect(caught.cause).toBeUndefined();
   expect(caught.errors).toEqual([owned]);
   expect(events.at(-1).root).toBe('removed');
   expect(invocation).toBe(mode==='cleanup-only'?14:16);
   expect(owners).toHaveLength(mode==='cleanup-only'?0:1);
  }
  expect(events.every(e=>e.sourceId===sourceId)).toBe(true);
  if(mode==='no-worker-proof'){expect(caught.primaryError).toBeDefined();expect(events.at(-1).root).toBe('retained');}
  expect(JSON.stringify(events)).not.toContain('sentinel_');
  expect(String(caught)).not.toContain('sentinel_');
  if(mode==='cleanup-only'){expect(events.filter(e=>e.stage==='runtime.process')).toHaveLength(14);expect(caught.primaryError).toBeUndefined();expect(await access(root).then(()=>true,()=>false)).toBe(false);}
  else expect(await access(root).then(()=>true,()=>false)).toBe(mode!=='unknown-ownership');
 // Independent offline evidence: spawnSync and postgres were replaced above,
 // never delegated, and the injected fault is a local throw (no child exists).
 // This test-owned directory may be removed even when the caller retains it;
 // a real unknown-ownership root must NOT use this teardown permission.
 }finally{connect.mockRestore();spawn.mockRestore();for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(base,{recursive:true,force:true});}
});
