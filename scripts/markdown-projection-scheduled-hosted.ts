// Called only by the existing owner-provisioned disposable runtime fixture.
import assert from 'node:assert/strict';
import {dirname} from 'node:path';
import {PostgresEngine} from '../src/core/postgres-engine';
import {LATEST_VERSION} from '../src/core/migrate';
import {MinionQueue} from '../src/core/minions/queue';
import {makeProjectionProducer} from '../src/core/minions/markdown-projection-scheduler';
import {markdownProjectionJobStatus} from '../src/core/minions/handlers/markdown-projection';
import {supervisedFixtureCLI} from './markdown-projection-runtime-hosted';
export async function scheduledHosted(database:string,role:string,password:string,source:string,configPath:string,emit:(v:unknown)=>void,deniedIds:number[]){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert(/^mp_accept_[0-9a-f]{16}$/.test(database));
 const url=new URL(`postgres://127.0.0.1:5432/${database}`);url.username=role;url.password=password;
 const engine=new PostgresEngine();await engine.connect({engine:'postgres',database_url:url.href,poolSize:2});
 const snapshot=async(stage:string)=>{
  emit({stage:`scheduled.jobs.${stage}`,rows:await engine.executeRaw(`SELECT * FROM minion_jobs ORDER BY id`)});
  emit({stage:`scheduled.attempts.${stage}`,rows:await engine.executeRaw(`SELECT * FROM markdown_projection_attempts WHERE source_id=$1 ORDER BY created_at`,[source])});
  emit({stage:`scheduled.status.${stage}`,value:await markdownProjectionJobStatus(engine,source)});
 };
 try{
  const version=await engine.getConfig('version');
  assert.equal(version,String(LATEST_VERSION),'runtime must see the stored migrated schema version');
  const visible=await engine.executeRaw(`SELECT key,value FROM public.config ORDER BY key`);
  assert.deepEqual(visible,[{key:'version',value:version}],'runtime config visibility is version-only');
  emit({stage:'scheduled.schema-version',status:'passed',version,latestVersion:LATEST_VERSION,visible});
  const queue=new MinionQueue(engine);
  assert.equal(deniedIds.length,2);
  const denied=(fn:()=>Promise<unknown>)=>assert.rejects(Promise.resolve().then(fn),(e:any)=>e.code==='42501'&&/row-level security/.test(e.message));
  // Application authorization and database source isolation are separate gates.
  await assert.rejects(Promise.resolve().then(()=>queue.add('markdown-projection-tick',{sourceId:source})),/protected job name 'markdown-projection-tick' requires CLI or operation-local submitter/);
  // Trusted local fixture submission must reach SQL; RLS still rejects its source.
  await denied(()=>queue.add('markdown-projection-tick',{sourceId:source+'-wrong'},undefined,{allowProtectedSubmit:true}));
  // Actual physical login, SQLSTATE checks, and seeded invisible rows, not mocks.
  for(const [name,data] of [
   ['scheduled-fixture-wrong',{sourceId:source}],
   ['scheduled-fixture-ordinary',{sourceId:source+'-wrong'}],
  ] as const)await denied(()=>queue.add(name,data));
  const probe=await queue.add('scheduled-fixture-ordinary',{});
  for(const [name,data] of [
   ['markdown-projection-tick',{sourceId:source+'-wrong'}],
   ['scheduled-fixture-wrong',{sourceId:source}],
  ] as const)await denied(()=>engine.executeRaw(`UPDATE minion_jobs SET name=$1,data=$2::text::jsonb WHERE id=$3 RETURNING *`,[name,JSON.stringify(data),probe.id]));
  assert.deepEqual((await queue.getJob(probe.id))?.data,{});
  const message=await queue.sendMessage(probe.id,{fixture:true},'admin');assert(message);
  for(const id of deniedIds){
   assert.equal(await queue.getJob(id),null);
   assert.deepEqual(await engine.executeRaw(`SELECT * FROM minion_inbox WHERE job_id=$1`,[id]),[]);
   assert.deepEqual(await engine.executeRaw(`UPDATE minion_jobs SET status='cancelled' WHERE id=$1 RETURNING *`,[id]),[]);
   assert.deepEqual(await engine.executeRaw(`UPDATE minion_inbox SET read_at=now() WHERE job_id=$1 RETURNING *`,[id]),[]);
   await denied(()=>engine.executeRaw(`INSERT INTO minion_inbox(job_id,sender,payload) VALUES ($1,'admin','{}'::jsonb) RETURNING *`,[id]));
   await denied(()=>engine.executeRaw(`UPDATE minion_inbox SET job_id=$1 WHERE id=$2 RETURNING *`,[id,message.id]));
  }
  assert.equal((await queue.claim('fixture-rls',30000,'default',['scheduled-fixture-ordinary']))?.id,probe.id);
  assert.deepEqual((await queue.readInbox(probe.id,'fixture-rls')).map(m=>m.id),[message.id]);
  assert.equal((await queue.completeJob(probe.id,'fixture-rls'))?.status,'completed');
  assert.equal(await queue.removeJob(probe.id),true);
  assert.deepEqual(await engine.executeRaw(`SELECT * FROM minion_inbox WHERE job_id=$1`,[probe.id]),[]);
  emit({stage:'scheduled.queue-rls',status:'passed'});
  // Real registered worker with attached invalid producer: no projection enqueue,
  // durable exact error, and an unrelated ordinary job still completes.
  const refusedOrdinary=await new MinionQueue(engine).add('scheduled-fixture-ordinary',{});
  const refused=supervisedFixtureCLI([process.execPath,'scripts/markdown-projection-scheduled-child.ts',configPath,'config-refused','0',String(refusedOrdinary.id)],{scenario:'scheduled-config-refused',root:dirname(configPath)});
  assert(!refused.output.includes(password));assert.equal(refused.exit,0);
  assert.equal((await new MinionQueue(engine).getJob(refusedOrdinary.id))?.status,'completed');
  assert.equal((await engine.executeRaw(`SELECT id FROM minion_jobs WHERE name='markdown-projection-tick' AND data->>'sourceId'=$1`,[source])).length,0);
  assert.equal((await markdownProjectionJobStatus(engine,source)).telemetry[0].last_error,'projection_configuration_failed');
  await snapshot('configuration-refused');
  emit({stage:'scheduled.configuration-contained',status:'passed',proof:refused.parentProof});
  const started=Date.now();const slotTime=()=>started;
  const deps={configPath:()=>configPath};
  await Promise.all([makeProjectionProducer(engine,[source],slotTime,deps)(),makeProjectionProducer(engine,[source],slotTime,deps)()]);
  const rows=await engine.executeRaw<any>(`SELECT * FROM minion_jobs WHERE name='markdown-projection-tick' AND data->>'sourceId'=$1`,[source]);
  assert.equal(rows.length,1);const id=rows[0].id;assert.equal(rows[0].status,'waiting');
  assert.equal(rows[0].backoff_delay,30000);
  // Fixture-only shorter real timer; production queue policy remains 30s exponential.
  await engine.executeRaw(`UPDATE minion_jobs SET backoff_delay=1000 WHERE id=$1`,[id]);
  const ordinary=await new MinionQueue(engine).add('scheduled-fixture-ordinary',{});
  await snapshot('waiting');
  const launch=(mode:string)=>{
   const result=supervisedFixtureCLI([process.execPath,'scripts/markdown-projection-scheduled-child.ts',configPath,mode,String(id),String(ordinary.id)],{scenario:`scheduled-${mode}`,root:dirname(configPath)});
   assert(!result.output.includes(password));emit({stage:`scheduled.process.${mode}`,proof:result.parentProof});
   for(const line of result.stdout.split('\n')){let row;try{row=JSON.parse(line);}catch{continue;}if(row?.stage?.startsWith('scheduled.'))emit(row);}
   return result;
  };
  const dead=launch('die-delayed');assert.equal(dead.exit,-9);await snapshot('delayed');
  const delayed=await new MinionQueue(engine).getJob(id);assert.equal(delayed?.status,'delayed');assert.equal(delayed?.attempts_made,1);
  assert.equal((await markdownProjectionJobStatus(engine,source)).ownership.length,0);
  await makeProjectionProducer(engine,[source],()=>started+30000,deps)();
  assert.equal((await engine.executeRaw(`SELECT id FROM minion_jobs WHERE name='markdown-projection-tick' AND data->>'sourceId'=$1`,[source])).length,1);
  const restarted=launch('complete');assert.equal(restarted.exit,0);assert.notEqual(dead.parentProof.pid,restarted.parentProof.pid);
  assert.equal((await new MinionQueue(engine).getJob(id))?.status,'completed');
  assert.equal((await new MinionQueue(engine).getJob(ordinary.id))?.status,'completed');
  const status=await markdownProjectionJobStatus(engine,source);assert.equal(status.ownership.length,0);assert.equal(status.obligations[0].pending,'0');
  assert(Date.now()-started<=60000);await snapshot('completed');
  emit({stage:'scheduled.complete',status:'passed',jobId:id,ordinaryId:ordinary.id,fixtureBackoffMs:1000,performanceMeasurements:'pending-not-functionality-acceptance'});
 }finally{await engine.disconnect();}
}
