import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {makeProjectionProducer} from '../src/core/minions/markdown-projection-scheduler';
import {MinionWorker} from '../src/core/minions/worker';
import {registerBuiltinHandlers} from '../src/commands/jobs';
import {markdownProjectionJobStatus} from '../src/core/minions/handlers/markdown-projection';

// Actual registered worker + producer + queue.add; only persistence/claim are offline doubles.
for(const mode of ['invalid','telemetry-failure','disabled'] as const){
 test(`attached producer contains ${mode} without starving ordinary jobs`,async()=>{
  const statements:string[]=[];const queued:string[]=[];const errors=new Map<string,string>();const logs:string[]=[];
  const engine:any={getConfig:async()=> '999',transaction:async(f:any)=>f(engine),executeRaw:async(s:string,p:any[]=[])=>{
   statements.push(s);
   if(s.includes('INSERT INTO public.markdown_projection_source_status')&&p[0]==='bad'){
    if(mode==='telemetry-failure')throw Error('SECRET SQL FAILURE');
    errors.set(p[0],p[1]);
   }
   if(s.includes('FROM public.markdown_projection_source_status'))return [{last_error:errors.get(p[0])}];
   if(s.startsWith('INSERT INTO minion_jobs')){queued.push(p[4].sourceId);return [{id:7}];}return [];
  }};
  let ordinary=0,claims=0;const w=new MinionWorker(engine,{healthCheckInterval:0,pollInterval:1});
  await registerBuiltinHandlers(w,engine,{quiet:true});w.register('ordinary',async()=>{ordinary++;return {};});
  w.setProjectionProducer(makeProjectionProducer(engine,mode==='disabled'?[]:['bad','healthy'],()=>30000,{admit:c=>{
   if(c.sourceId==='bad')throw Error('SECRET malformed authority');
   return {worker:{enabled:true,sourceId:'healthy',root:'/protected',inputRoots:[]},connection:{}};
  }}));
  const q=(w as any).queue;q.promoteDelayed=async()=>0;q.isActive=async()=>true;q.getJob=async()=>({id:1,status:'active',lock_token:'t'});
  q.claim=async()=>{if(++claims===1)return {id:1,name:'ordinary',data:{},status:'active',lock_token:'t'};w.stop();return null;};q.completeJob=async()=>true;
  const prior=console.error;console.error=(...v)=>logs.push(v.join(' '));
  try{await w.start();}finally{w.stop();console.error=prior;}
  expect(ordinary).toBe(1);expect(queued).toEqual(mode==='disabled'?[]:['healthy']);
  if(mode==='invalid')expect((await markdownProjectionJobStatus(engine,'bad')).telemetry[0].last_error).toBe('projection_configuration_failed');
  if(mode==='telemetry-failure')expect(logs.join('\n')).toContain('projection_schedule_status_unavailable');
  expect(logs.join('\n')).not.toContain('SECRET');
  if(mode==='disabled')expect(statements).toEqual([]);
 });
}
test('candidate durable status admits the exact configuration refusal code',()=>{
 const ddl=readFileSync(new URL('../docs/architecture/sql/markdown-projection-worker-candidate.sql',import.meta.url),'utf8');
 expect(ddl.match(/CHECK\(last_error IS NULL OR last_error IN \(([^)]+)\)/)?.[1]).toContain("'projection_configuration_failed'");
});
