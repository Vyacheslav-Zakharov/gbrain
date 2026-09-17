import {test,expect} from 'bun:test';
import {registerBuiltinHandlers} from '../src/commands/jobs';
import {MinionWorker} from '../src/core/minions/worker';
import {MinionQueue} from '../src/core/minions/queue';
import {PROJECTION_JOB,submitMarkdownProjectionTick,markdownProjectionJobStatus} from '../src/core/minions/handlers/markdown-projection';
import type {ProjectionTickDependencies} from '../src/core/minions/handlers/markdown-projection';
import {runIsolatedAsync} from '../scripts/markdown-projection-isolated-caller';
import {runRuntime} from '../scripts/markdown-projection-runtime';

test('actual runtime and dispatcher share durable source admission, ignore no child bypass',async()=>{
 let runs=0;
 const deps={configPath:()=>'/protected/config',run:async()=>{runs++;throw Error('unknown');}};
 const h=await harness(deps);
 const runtimeDeps={admit:()=>({worker:{sourceId:'source-a'}}),engine:h.engine,run:deps.run};
 await Promise.allSettled([runRuntime({admission:'PROTECTED_RUNTIME_V1',action:'drain',configPath:'/protected/config'},runtimeDeps as any),h.execute()]);
 expect(runs).toBe(1);expect(h.owners.size).toBe(1);
 await expect(runRuntime({admission:'PROTECTED_RUNTIME_V1',action:'drain',configPath:'/protected/config'},runtimeDeps as any)).rejects.toThrow('projection_reservation');
 await expect(runRuntime({admission:'PROTECTED_RUNTIME_V1',action:'drain',supervisionRunId:'forged'},runtimeDeps as any)).rejects.toThrow('admission_failed');
 expect(runs).toBe(1);
});
// Real trusted supervisor and reaper; inert child, no configuration/DB access.
function supervised(fail=false):typeof runIsolatedAsync {
 const supervisor=new URL('../scripts/markdown-projection-isolated-supervisor.py',import.meta.url).pathname;
 const child=fail?'raise SystemExit(1)':`print('{"stage":"copy.complete","status":"idle"}')`;
 const python=`import importlib.util,sys\ns=importlib.util.spec_from_file_location('m',${JSON.stringify(supervisor)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\noriginal=m.run\nm.run=lambda command,config:original([sys.executable,'-c',${JSON.stringify(child)}],config,seconds=.5)\nsys.exit(m.main())`;
 return (config,supervision)=>runIsolatedAsync(config,supervision,['python3','-B','-c',python]);
}
test('actual trusted submission pins payload and options; ordinary submission stays default',async()=>{
 const inserts:{sql:string;params:unknown[]}[]=[];
 const engine:any={getConfig:async()=> '999',transaction:async(fn:any)=>fn(engine),executeRaw:async(sql:string,params:unknown[]=[])=>{
  if(!sql.startsWith('INSERT INTO minion_jobs'))return [];
  inserts.push({sql,params});return [{id:inserts.length,name:params[0],queue:params[1],status:params[2],data:params[4]}];
 }};
 const tick=await submitMarkdownProjectionTick(engine,'source-a','123',false);
 expect(tick.name).toBe(PROJECTION_JOB);
 expect(inserts[0].params.slice(0,9)).toEqual([PROJECTION_JOB,'default','waiting',0,{sourceId:'source-a'},3,'exponential',30000,0]);
 expect(inserts[0].params.slice(15,18)).toEqual([false,false,'projection:source-a:123']);
 expect(inserts[0].sql).toContain('ON CONFLICT (idempotency_key)');
 await new MinionQueue(engine).add('ordinary',{value:1});
 expect(inserts[1].params.slice(0,5)).toEqual(['ordinary','default','waiting',0,{value:1}]);
 for(const remote of [true,undefined,null])await expect(submitMarkdownProjectionTick(engine,'source-a','123',remote as any)).rejects.toThrow('projection_submit_refused');
 await expect(submitMarkdownProjectionTick(engine,'../other','123',false)).rejects.toThrow('projection_submit_refused');
 expect(inserts.length).toBe(2);
});
async function harness(deps: ProjectionTickDependencies, fault?:'reserve'|'record'|'release') {
 const owners=new Map<string,string>(); const failures:any[]=[]; const completed:any[]=[];
 const statements:string[]=[];
 const engine:any={transaction:async(fn:any)=>fn(engine),executeRaw:async(sql:string,p:unknown[]=[])=>{
  statements.push(sql);
  const source=String(p[0]);
  if(sql.startsWith('INSERT INTO public.markdown_projection_attempts')){
   if(fault==='reserve')throw Error('reserve failed');
   if(owners.has(source))return [];owners.set(source,String(p[1]));return [{run_id:p[1]}];
  }
  if(sql.includes('SET supervisor_pid')){
   if(fault==='record')throw Error('record failed');
   return owners.get(source)===p[1]?[{run_id:p[1]}]:[];
  }
  if(sql.includes('SET released_at')){
   if(fault==='release')throw Error('release failed');
   if(owners.get(source)!==p[1])return [];owners.delete(source);return [{run_id:p[1]}];
  }
  if(sql.includes('FROM public.markdown_projection_attempts'))return owners.has(source)?[{source_id:source,run_id:owners.get(source)}]:[];
  if(sql.includes('DELETE FROM minion_jobs'))return sql.includes('count(*)')?[{count:'1'}]:[{id:1}];
  if(sql.includes('WHERE id = $1'))return [{id:1}];
  return [];
 }};
 const worker=new MinionWorker(engine);await registerBuiltinHandlers(worker,engine,{quiet:true,projectionTick:deps});
 const q=(worker as any).queue;
 q.isActive=async()=>true;q.getJob=async()=>({status:'active',lock_token:'token'});
 q.failJob=async(...args:any[])=>{failures.push(args);return true;};
 q.completeJob=async(...args:any[])=>{completed.push(args);return true;};
 const execute=async(data:object={sourceId:'source-a'},name=PROJECTION_JOB)=>{
  const timer=setInterval(()=>{},10000);
  await (worker as any).executeJob({id:1,name,data,attempts_made:0,max_attempts:3,backoff_type:'fixed',backoff_delay:30000,backoff_jitter:0},'token',new AbortController(),timer);
 };
 return {worker,engine,execute,failures,completed,owners,statements,marker:()=>owners.size>0};
}
test('registered disabled projection and ordinary handler unchanged',async()=>{
 const h=await harness({configPath:()=>undefined});await h.execute();expect(h.completed[0][2]).toEqual({status:'not_required'});
 h.worker.register('ordinary',async()=>({ordinary:true}));await h.execute({},'ordinary');expect(h.completed[1][2]).toEqual({ordinary:true});
});
test('enabled registered dispatcher passes only source and protected reference',async()=>{
 let request:any;const h=await harness({configPath:()=>'/protected/config',run:async(c,s)=>{request=c;return supervised()(c,s);}});
 await h.execute();expect(request).toEqual({admission:'PROTECTED_RUNTIME_V1',action:'drain',configPath:'/protected/config',sourceId:'source-a'});expect(h.completed[0][2].status).toBe('idle');expect(h.marker()).toBe(false);
});
test('failed reaped child follows existing failJob/backoff contract, never completion',async()=>{
 const h=await harness({configPath:()=>'/protected/config',run:supervised(true)});
 await h.execute();expect(h.completed).toEqual([]);expect(h.failures[0].slice(2)).toEqual(['projection_child_failed_unknown_consult_ledger','delayed',30000]);expect(h.marker()).toBe(false);
});
test('unverified reaping remains durable and prevents a fresh attempt',async()=>{
 let runs=0;const h=await harness({configPath:()=>'/protected/config',run:async()=>{runs++;throw new Error('SECRET');}});
 await h.execute();await h.execute();expect(runs).toBe(1);expect(h.marker()).toBe(true);expect(h.failures.every(a=>a[3]==='dead')).toBe(true);expect(JSON.stringify(h.failures)).not.toContain('SECRET');
});
test('payload override rejected before launch and protected submission before DB',async()=>{
 const h=await harness({configPath:()=>undefined});await h.execute({sourceId:'source-a',configPath:'/evil'});expect(h.failures[0][2]).toBe('projection_payload_refused');
 await expect(new MinionQueue(h.engine).add(PROJECTION_JOB,{sourceId:'source-a'})).rejects.toThrow('protected job name');
 await expect(submitMarkdownProjectionTick(h.engine,'source-a','1',true)).rejects.toThrow('projection_submit_refused');
 expect(await markdownProjectionJobStatus(h.engine,'source-a')).toMatchObject({perPageError:'unavailable',projectionHeartbeat:'unavailable',schedulerLiveness:'unavailable'});
});
for(const action of ['remove','prune'] as const)test(`retained ownership survives real queue ${action} and fresh dispatcher`,async()=>{
 let runs=0;const h=await harness({configPath:()=>'/protected/config',run:async()=>{runs++;throw Error('unknown stop');}});
 await h.execute();await h.execute();expect(runs).toBe(1);
 const queue=new MinionQueue(h.engine);
 if(action==='remove')await queue.removeJob(1);else await queue.prune();
 expect(h.statements.some(s=>s.includes('DELETE FROM minion_jobs'))).toBe(true);
 await h.execute();expect(runs).toBe(1);expect(h.marker()).toBe(true);
 expect(await markdownProjectionJobStatus(h.engine,'source-a')).toMatchObject({recovery:'operator_blocked_no_automatic_recovery',ownership:[{source_id:'source-a'}]});
});
test('concurrent actual dispatch reserves one source, other source remains independent',async()=>{
 let runs=0;const h=await harness({configPath:()=>'/protected/config',run:async()=>{runs++;await Promise.resolve();throw Error('unknown');}});
 await Promise.all([h.execute(),h.execute(),h.execute({sourceId:'source-b'})]);
 expect(runs).toBe(2);expect(h.owners.size).toBe(2);
});
for(const fault of ['reserve','record','release'] as const)test(`fail closed on ${fault} failure`,async()=>{
 let calls=0;const h=await harness({configPath:()=>'/protected/config',run:async(c,s)=>{calls++;return supervised()(c,s);}},fault);
 await h.execute();await h.execute();expect(h.completed).toEqual([]);
 expect(calls).toBe(fault==='reserve'?0:1);
 expect(h.marker()).toBe(fault!=='reserve');
 expect(h.failures.every(a=>a[3]==='dead')).toBe(true);
});
test('forged reaping flag cannot release durable ownership',async()=>{
 const h=await harness({configPath:()=>'/protected/config',run:async()=>{throw Object.assign(Error('fake'),{unsafeFilesystemCleanup:false});}});
 await h.execute();expect(h.marker()).toBe(true);expect(h.failures[0][2]).toBe('projection_reaping_unverified_operator_required');
});
test('verified supervisor reaping releases and permits subsequent dispatch',async()=>{
 const h=await harness({configPath:()=>'/protected/config',run:supervised()});
 await h.execute();await h.execute();expect(h.completed.length).toBe(2);expect(h.marker()).toBe(false);
});
test('authentic previous-run receipt cannot release a new reservation',async()=>{
 let old:Awaited<ReturnType<typeof runIsolatedAsync>>|undefined;
 const h=await harness({configPath:()=>'/protected/config',run:async(c,s)=>{
  if(old)return old;
  old=await supervised()(c,s);return old;
 }});
 await h.execute();await h.execute();expect(h.completed.length).toBe(1);
 expect(h.marker()).toBe(true);expect(h.failures[0][2]).toBe('projection_reaping_unverified_operator_required');
});
