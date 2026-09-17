import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {readProjectionSchedule} from '../src/core/minions/markdown-projection-scheduler';
import {makeProjectionProducer} from '../src/core/minions/markdown-projection-scheduler';
import {registerBuiltinHandlers} from '../src/commands/jobs';
import {MinionWorker} from '../src/core/minions/worker';
import {markdownProjectionJobStatus} from '../src/core/minions/handlers/markdown-projection';
import {runIsolatedAsync} from '../scripts/markdown-projection-isolated-caller';

test('real protected manifests: disabled no writes, malformed/mismatch/inaccessible refusal and deletion after enqueue',async()=>{
 const dir=mkdtempSync(join(homedir(),'admission-'));const path=join(dir,'source.json');const root=join(dir,'output');mkdirSync(root,{mode:0o700});
 const config={version:1,enabled:true,connection:{host:'127.0.0.1',port:5432,database:'offline',username:'offline',password:'SECRET',expectedServerAddress:'127.0.0.1',expectedServerPort:5432,tls:'local-only'},worker:{sourceId:'source-a',root,inputRoots:[],inventoryComplete:true}};
 let queued=0,writes=0;const engine:any={getConfig:async()=> '999',transaction:async(f:any)=>f(engine),executeRaw:async(s:string,p:any[])=>{writes++;if(s.includes('INSERT INTO public.markdown_projection_attempts')||s.includes('SET supervisor_pid')||s.includes('SET released_at'))return [{run_id:p[1]}];if(s.includes('INSERT INTO minion_jobs')){queued++;return [{id:1,data:p[4]}];}return [];}};
 const deps={configPath:()=>path};const put=(value:unknown)=>{writeFileSync(path,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});chmodSync(path,0o600);};
 try{
  await makeProjectionProducer(engine,readProjectionSchedule(join(dir,'absent')))();expect(writes).toBe(0);
  for(const bad of ['{SECRET',{version:1,enabled:false},{...config,worker:{...config.worker,sourceId:'other'}}]){
   put(bad);await expect(makeProjectionProducer(engine,['source-a'],()=>30000,deps)()).rejects.toThrow('projection_configuration_failed');expect(queued).toBe(0);
  }
  put(config);chmodSync(path,0o644);await expect(makeProjectionProducer(engine,['source-a'],()=>30000,deps)()).rejects.toThrow('projection_configuration_failed');expect(queued).toBe(0);
  put(config);await makeProjectionProducer(engine,['source-a'],()=>30000,deps)();expect(queued).toBe(1);
  const supervisor=new URL('../scripts/markdown-projection-isolated-supervisor.py',import.meta.url).pathname;
  const python=`import importlib.util,sys\ns=importlib.util.spec_from_file_location('m',${JSON.stringify(supervisor)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\noriginal=m.run\nm.run=lambda command,config:original([sys.executable,'-c',"print('{\\\"stage\\\":\\\"copy.complete\\\",\\\"status\\\":\\\"idle\\\"}')"],config,seconds=.5)\nsys.exit(m.main())`;
  const run:typeof runIsolatedAsync=(c,s)=>runIsolatedAsync(c,s,['python3','-B','-c',python]);
  const worker=new MinionWorker(engine);await registerBuiltinHandlers(worker,engine,{quiet:true,projectionTick:{...deps,run}});
  const handler=(worker as any).handlers.get('markdown-projection-tick');
  expect((await handler({id:1,data:{sourceId:'source-a'},signal:new AbortController().signal,isActive:async()=>true})).status).toBe('idle');
  rmSync(path);
  await expect(handler({data:{sourceId:'source-a'}})).rejects.toThrow('projection_configuration_failed');expect(queued).toBe(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('enabled missing fixed manifest refuses producer and actual worker retains failure, ordinary unchanged',async()=>{
 const source='offline-missing-scheduled-authority';let inserts=0;let error='';const jobs:any[]=[];
 const engine:any={getConfig:async()=> '999',transaction:async(f:any)=>f(engine),executeRaw:async(s:string,p:any[]=[])=>{
 if(s.includes('INSERT INTO minion_jobs')){inserts++;return [{id:1}];}
 if(s.includes("last_error='projection_configuration_failed'"))error='projection_configuration_failed';
 if(s.includes('FROM public.markdown_projection_source_status'))return [{last_error:error}];return [];
 }};
 await expect(makeProjectionProducer(engine,[source],()=>30000)()).rejects.toThrow('projection_configuration_failed');expect(inserts).toBe(0);
 const worker=new MinionWorker(engine,{healthCheckInterval:0,pollInterval:1});await registerBuiltinHandlers(worker,engine,{quiet:true});
 worker.register('ordinary',async()=>({ordinary:true}));
 jobs.push({id:1,name:'markdown-projection-tick',data:{sourceId:source},status:'waiting',attempts_made:0,max_attempts:3},{id:2,name:'ordinary',data:{},status:'waiting'});
 const q=(worker as any).queue;q.promoteDelayed=async()=>0;q.isActive=async()=>true;q.getJob=async(id:number)=>jobs.find(j=>j.id===id);
 q.claim=async()=>{const j=jobs.find(j=>j.status==='waiting');if(!j){worker.stop();return null;}j.status='active';j.lock_token='t';return j;};
 q.completeJob=async(id:number,_:string,result:any)=>{Object.assign(jobs.find(j=>j.id===id),{status:'completed',result});return true;};
 q.failJob=async(id:number,_:string,error_text:string,status:string)=>{Object.assign(jobs.find(j=>j.id===id),{status,error_text});return true;};
 await worker.start();expect(jobs[0].status).toBe('dead');expect(jobs[0].error_text).toBe('projection_configuration_failed');expect(jobs[0].result).toBeUndefined();expect(jobs[1].result).toEqual({ordinary:true});
 expect((await markdownProjectionJobStatus(engine,source)).telemetry[0].last_error).toBe('projection_configuration_failed');
});
