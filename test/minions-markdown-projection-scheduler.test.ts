import {test,expect} from 'bun:test';
import {makeProjectionProducer,readProjectionSchedule} from '../src/core/minions/markdown-projection-scheduler';
import {MinionWorker} from '../src/core/minions/worker';
import {registerBuiltinHandlers,runJobs} from '../src/commands/jobs';
import {MinionQueue} from '../src/core/minions/queue';

// Offline SQL-boundary double: tests actual producer, queue.add, registered dispatch
// and worker.start. PostgreSQL persistence/leases remain a separate hosted proof.
function store(){
 const jobs:any[]=[];const held=new Set<string>();const telemetry=new Map();
 const engine:any={getConfig:async()=> '999',transaction:async(fn:any)=>fn(engine),executeRaw:async(s:string,p:any[]=[])=>{
  if(s.includes('INSERT INTO public.markdown_projection_source_status')){telemetry.set(p[0],{scheduler_seen_at:'retained'});return [];}
  if(s.includes('FROM public.markdown_projection_source_status'))return telemetry.has(p[0])?[telemetry.get(p[0])]:[];
  if(s.includes('FROM public.markdown_projection_attempts'))return held.has(p[0])?[{run_id:'held',source_id:p[0]}]:[];
  if(s.startsWith('SELECT * FROM minion_jobs WHERE idempotency_key'))return jobs.filter(j=>j.idempotency_key===p[0]);
  if(s.startsWith('INSERT INTO minion_jobs')){const old=jobs.find(j=>j.idempotency_key===p[17]&&p[17]);if(old)return [old];const j={id:jobs.length+1,name:p[0],queue:p[1],status:p[2],data:p[4],max_attempts:p[5],attempts_made:0,idempotency_key:p[17]};jobs.push(j);return [j];}
  if(s.includes("status IN ('waiting','active','delayed')"))return jobs.filter(j=>j.name==='markdown-projection-tick'&&j.data.sourceId===p[0]&&['waiting','active','delayed'].includes(j.status));
  if(s.includes('FROM minion_jobs WHERE name=$1'))return jobs.filter(j=>j.name===p[0]&&j.data.sourceId===p[1]);
  return [];
 }};return {engine,jobs,held,telemetry};
}
test('two producers same slot deduplicate through actual queue; restart preserves delayed and held source',async()=>{
 const h=store();const a=makeProjectionProducer(h.engine,['source-a','source-b'],()=>30000,{admit:()=>({worker:{enabled:true,sourceId:'source-a',root:'/protected',inputRoots:[]},connection:{}})});
 await Promise.all([a(),makeProjectionProducer(h.engine,['source-a','source-b'],()=>30000,{admit:()=>({worker:{enabled:true,sourceId:'source-a',root:'/protected',inputRoots:[]},connection:{}})})()]);
 expect(h.jobs.length).toBe(2);expect(h.jobs.every(j=>j.queue==='default')).toBe(true);
 h.jobs[0].status='delayed';h.jobs[0].error_text='retained';h.held.add('source-b');h.jobs.splice(1);
 await makeProjectionProducer(h.engine,['source-a','source-b'],()=>90000,{admit:()=>({worker:{enabled:true,sourceId:'source-a',root:'/protected',inputRoots:[]},connection:{}})})();
 expect(h.jobs.length).toBe(1);expect(h.jobs[0].error_text).toBe('retained');expect(h.telemetry.size).toBe(2);
});
test('actual worker startup consumes admitted producer and ordinary jobs; fresh worker reads retained job',async()=>{
 const h=store();await new MinionQueue(h.engine).add('ordinary',{});
 await makeProjectionProducer(h.engine,['source-a'],()=>30000,{admit:()=>({worker:{enabled:true,sourceId:'source-a',root:'/protected',inputRoots:[]},connection:{}})})();
 const run=async()=>{
  const w=new MinionWorker(h.engine,{pollInterval:1,healthCheckInterval:0,stalledInterval:100000});
  await registerBuiltinHandlers(w,h.engine,{quiet:true,projectionTick:{configPath:()=>undefined}});
  w.register('ordinary',async()=>({ordinary:true}));w.setProjectionProducer(makeProjectionProducer(h.engine,['source-a'],()=>30000,{admit:()=>({worker:{enabled:true,sourceId:'source-a',root:'/protected',inputRoots:[]},connection:{}})}));
  const q=(w as any).queue;q.promoteDelayed=async()=>0;
  q.claim=async()=>{const j=h.jobs.find(j=>j.status==='waiting');if(j){j.status='active';j.lock_token='t';return j;}w.stop();return null;};
  q.isActive=async()=>true;q.getJob=async(id:number)=>h.jobs.find(j=>j.id===id);
  q.completeJob=async(id:number,_t:string,result:any)=>{Object.assign(h.jobs.find(j=>j.id===id),{status:'completed',result});return true;};
  q.failJob=async()=>{throw Error('unexpected failure');};
  await w.start();
 };
 await run();await run();expect(h.jobs.length).toBe(2);expect(h.jobs.every(j=>j.status==='completed')).toBe(true);
 expect(h.jobs[0].result).toEqual({ordinary:true});expect(h.jobs[1].result).toEqual({status:'not_required'});
});
test('status CLI reads retained source ownership without reset and wrong queue refuses producer',async()=>{
 const h=store();h.held.add('source-a');let output='';const previous=console.log;console.log=(v)=>{output=String(v);};
 try{await runJobs(h.engine,['projection-status','source-a']);}finally{console.log=previous;}
 expect(JSON.parse(output).recovery).toBe('operator_blocked_no_automatic_recovery');expect(h.held.size).toBe(1);
 expect(()=>new MinionWorker(h.engine,{queue:'other'}).setProjectionProducer(async()=>{})).toThrow('default_queue');
 expect(readProjectionSchedule('/nonexistent/projection-schedule.json')).toEqual([]);
});
