// Hosted fixture only: owner provisioning is never imported by the runtime.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile,readdir,chmod,rm,rmdir,realpath,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import type {PostgresEngine} from '../src/core/postgres-engine';
import {makeMarkdownProjectionHandler,runMarkdownProjectionAttempt} from '../src/core/minions/handlers/markdown-projection';
import {MinionQueue} from '../src/core/minions/queue';
import {serializePageToMarkdown} from '../src/core/markdown';
export const runtimeMarkers=['runtime.status-readonly','runtime.healthy','runtime.refusal','runtime.containment','runtime.cleanup'] as const;
export function verifyRuntimeMarkers(rows:any[]){
 const identities:any[]=[];const runs=new Set<string>();
 for(const scenario of ['healthy','unknown-ownership']){
  const scoped=rows.filter(r=>r.scenario===scenario);
  const one=(stage:string)=>{const found=scoped.filter(r=>r.stage===stage);assert.equal(found.length,1,`${scenario}:${stage}`);return found[0];};
  for(const stage of runtimeMarkers)assert.equal(one(stage).status,'passed');
  assert.equal(one('runtime.cleanup').root,'removed');
  const ledger=one('runtime.launch-inventory');identities.push(ledger);
  for(const row of scoped)for(const key of ['database','sourceId','fixtureRoot'])assert.equal(row[key],ledger[key]);
  assert.equal(ledger.inventory.length,scenario==='healthy'?14:16);
  const processes=scoped.filter(r=>r.stage==='runtime.process');assert.equal(processes.length,ledger.inventory.length);
  for(const e of ledger.inventory){
   assert(e.verified&&!runs.has(e.runId));runs.add(e.runId);
   const proof=e.proof;assert.equal(proof.protocol,'disposable-cli-parent-v2');assert.deepEqual(proof.argv,e.argv);assert.equal(proof.runId,e.runId);assert.equal(proof.scenario,scenario);assert.equal(proof.root,ledger.root);
   assert.equal(proof.childAccounting,'ECHILD');assert.equal(proof.reaped,true);assert.deepEqual(proof.members,[]);assert.deepEqual(proof.sessionMembers,[]);assert.deepEqual(proof.errors,[]);assert.deepEqual(proof.launched,[proof.pid]);assert(Number.isSafeInteger(proof.pid)&&proof.pid>0);
   const matching=processes.filter(r=>r.proof.runId===e.runId);assert.equal(matching.length,1);assert.equal(matching[0].proof.final,true);for(const key of Object.keys(proof))assert.deepEqual(matching[0].proof[key],proof[key]);assert.equal(matching[0].proof.exit,proof.exit);assert.deepEqual(matching[0].proof.argv,proof.argv);
  }
  if(scenario==='unknown-ownership'){const held=one('runtime.held-no-worker');assert.equal(held.status,'passed');assert.equal(held.workerAdmissions,0);assert.equal(held.retained.length,1);const a=held.retained[0];assert.equal(a.source_id,ledger.sourceId);assert.equal(a.state,'reserved');assert.equal(a.supervisor_pid,null);assert.equal(a.supervisor_start,null);assert.equal(a.released_at,null);}
 }
 for(const key of ['database','sourceId','fixtureRoot','root'])assert(identities[0][key]&&identities[1][key]&&identities[0][key]!==identities[1][key],`distinct ${key}`);
}
export function runtimeCLI(action:string,path?:string,binding={scenario:'offline',root:process.cwd()},inventory:any[]=[]){
 const argv=[process.execPath,'scripts/markdown-projection-runtime.ts',action,...(path?['--config',path]:[])];
 return supervisedFixtureCLI(argv,binding,inventory);
}
export function supervisedFixtureCLI(argv:string[],binding:{scenario:string;root:string},inventory:any[]=[]){
 const runId=randomUUID();const entry={runId,...binding,argv,verified:false,proof:undefined as any};inventory.push(entry);
 const child=spawnSync('python3',['-B','scripts/markdown-projection-fixture-parent.py','--run-id',runId,'--scenario',binding.scenario,'--root',binding.root,'--',...argv],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',PYTHONDONTWRITEBYTECODE:'1'},timeout:35000,killSignal:'SIGKILL',encoding:'utf8',maxBuffer:2*1024*1024});
 try{
 const proof=JSON.parse(child.stdout);entry.proof=proof;
 assert(!child.error && !child.signal && child.status===0,'runtime CLI lifetime failed; retain evidence');
 assert.equal(proof.protocol,'disposable-cli-parent-v2');assert.equal(proof.final,true);assert.equal(proof.runId,runId);assert.equal(proof.scenario,binding.scenario);assert.equal(proof.root,binding.root);assert.deepEqual(proof.argv,argv);
 assert.equal(proof.reaped,true);assert.equal(proof.childAccounting,'ECHILD');assert(Number.isSafeInteger(proof.pid)&&proof.pid>0);assert.deepEqual(proof.launched,[proof.pid]);assert.deepEqual(proof.errors,[]);
 assert.deepEqual(proof.members,[]);assert.deepEqual(proof.sessionMembers,[]);assert(Number.isSafeInteger(proof.exit));assert.equal(typeof proof.stdout,'string');assert.equal(typeof proof.stderr,'string');
 entry.verified=true;
 return {exit:proof.exit as number,output:proof.stdout+proof.stderr,stdout:proof.stdout as string,parentProof:proof};
 }catch(cause){throw Object.assign(new Error('runtime CLI stop unverified',{cause}),{unsafeFilesystemCleanup:true,entry,primaryError:child.error??child.status});}
}
export async function runtimeHosted(db:ReturnType<typeof postgres>,engine:PostgresEngine,database:string,address:string,base:string,emit:(v:unknown)=>void,scenario:'healthy'|'unknown-ownership',sourceId:string,scheduled=false){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.MARKDOWN_PROJECTION_DISPOSABLE,'CREATE_AND_DROP_DATABASE');
 assert(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sourceId));
 const publish=emit;emit=(v:unknown)=>publish({...v as object,scenario,database,sourceId,fixtureRoot:base});
 assert(/^mp_accept_[0-9a-f]{16}$/.test(database));
 assert.equal(await realpath(base),base);
 for(let p=base;p!=='/';p=dirname(p)){const st=await lstat(p);assert(st.isDirectory()&&!st.isSymbolicLink()&&!(st.mode&0o022));assert(st.uid===0||st.uid===process.getuid?.());}
 const role=`${database}_runtime`,password=`sentinel_${randomBytes(24).toString('hex')}`;
 const root=`${base}/output`,configPath=`${base}/runtime.json`;
 await mkdir(root,{mode:0o700});
 const inventory:any[]=[];
 let created=false,completed=false,failed=false,primaryError:unknown;
 const cleanupErrors:{stage:string,error:unknown}[]=[];
 const cleanup=async(stage:string,fn:()=>Promise<unknown>)=>{try{await fn();}catch(error){cleanupErrors.push({stage,error});}};
 try{
 await db.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '${password}'`);created=true;
 // Dedicated source; no production roles, membership, schema ownership or page DML.
 await db`INSERT INTO sources(id,name) VALUES (${sourceId},'Runtime fixture')`;
 await db`SELECT markdown_projection_set_policy(${sourceId},false)`;
 await db`UPDATE markdown_projection_policy SET root_path=${root} WHERE source_id=${sourceId}`;
 await db`SELECT markdown_projection_set_policy(${sourceId},true)`;
 await db.unsafe(`GRANT USAGE ON SCHEMA public TO ${role};
 GRANT SELECT ON pages,tags,markdown_projection_policy,markdown_projection_obligations,markdown_projection_identity TO ${role};
 GRANT UPDATE(source_id) ON markdown_projection_policy TO ${role};
 GRANT UPDATE(status,current_path,current_hash,materialized_generation,renderer_version) ON markdown_projection_obligations TO ${role};
 CREATE POLICY mp_runtime_pages ON pages FOR SELECT TO ${role} USING(source_id='${sourceId}');
 CREATE POLICY mp_runtime_tags ON tags FOR SELECT TO ${role} USING(EXISTS(SELECT 1 FROM pages WHERE id=page_id AND source_id='${sourceId}'));
 CREATE POLICY mp_runtime_policy ON markdown_projection_policy TO ${role} USING(source_id='${sourceId}') WITH CHECK(source_id='${sourceId}');
 CREATE POLICY mp_runtime_obligations ON markdown_projection_obligations TO ${role} USING(source_id='${sourceId}') WITH CHECK(source_id='${sourceId}');
 CREATE POLICY mp_runtime_identity ON markdown_projection_identity FOR SELECT TO ${role} USING(EXISTS(SELECT 1 FROM pages WHERE id=page_id AND source_id='${sourceId}'));`);
 await db`INSERT INTO public.markdown_projection_attempt_authority(login_name,source_id) VALUES (${role},${sourceId})`;
 await db.unsafe(`GRANT SELECT ON public.markdown_projection_attempts,public.markdown_projection_attempt_authority TO ${role};
 GRANT INSERT(source_id,run_id,job_id,host_id,boot_id,owner_pid,owner_start) ON public.markdown_projection_attempts TO ${role};
 GRANT UPDATE(supervisor_pid,supervisor_start,state,released_at) ON public.markdown_projection_attempts TO ${role};`);
 const [rights]=await db`SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
 EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS membership,
 EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) AS owns,
 has_any_column_privilege(r.oid,'pages','INSERT,UPDATE') AS page_columns,
 has_table_privilege(r.oid,'pages','DELETE,TRUNCATE') AS page_delete
 FROM pg_roles r WHERE rolname=${role}`;
 assert(rights);for(const value of Object.values(rights))assert.equal(value,false);
 const indirect=await db`SELECT p.oid::regprocedure::text AS function,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(${role},p.oid,'EXECUTE') ORDER BY 1`;
 emit({stage:'runtime.rights',rights,executableSecurityDefiners:Array.from(indirect),productionAuthorityApproved:false});
 const config={version:1,enabled:true,connection:{host:'127.0.0.1',port:5432,database,username:role,password,expectedServerAddress:address,expectedServerPort:5432,tls:'local-only'},worker:{sourceId,root,inputRoots:[],inventoryComplete:true}};
 const save=async(c:unknown)=>{await writeFile(configPath,JSON.stringify(c),{mode:0o600});await chmod(configPath,0o600);};
 const invoke=(action:string,path?:string,expected?:string)=>{const r=runtimeCLI(action,path,{scenario,root},inventory);assert(!r.output.includes(password),'credential leak');emit({stage:'runtime.process',status:'passed',proof:r.parentProof});if(expected){assert.equal(r.exit,0,r.output);const receipt=JSON.parse(r.stdout.trim());assert.equal(receipt.status,'passed');assert.equal(receipt.copyStatus,expected);assert(receipt.final&&receipt.attempts.length===1&&receipt.attempts.every((a:any)=>a.reaped&&a.exitCode===0));return receipt;}assert.notEqual(r.exit,0);return r;};
 const snapshot=async()=>{const tables=['pages','tags','markdown_projection_policy','markdown_projection_obligations','markdown_projection_identity','markdown_projection_current'];const rows=[];for(const table of tables)rows.push(Array.from(await db.unsafe(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`)));return JSON.stringify({rows,catalog:Array.from(await db`SELECT oid,relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid`),files:await Promise.all((await readdir(root)).sort().map(async f=>[f,(await readFile(`${root}/${f}`)).toString('base64')]))});};
 const opts={sourceId};
 await engine.putPage('runtime-page',{type:'note',title:'Runtime fixture',compiled_truth:'Protected CLI fixture',timeline:'',frontmatter:{}},opts);
 await save(config);const before=await snapshot(),configBefore=await readFile(configPath,'utf8');
 const status=invoke('status',configPath,'idle');assert.equal(status.projectionStatus.pending,'1');
 assert.equal(await snapshot(),before);assert.equal(await readFile(configPath,'utf8'),configBefore);
 for(const action of ['status','drain']){invoke(action,undefined,'not_required');await save({version:1,enabled:false});invoke(action,configPath,'not_required');assert.equal(await snapshot(),before);}
 await save(config);emit({stage:'runtime.status-readonly',status:'passed',statementAuditProven:false});
 for(const mutate of [(c:any)=>{c.worker.sourceId='missing';},(c:any)=>{c.worker.root=base;},(c:any)=>{c.worker.inventoryComplete=false;},(c:any)=>{c.worker.inputRoots=[root];},(c:any)=>{c.connection.expectedServerAddress='192.0.2.1';},(c:any)=>{c.fixtureFault='forbidden';}]){const bad=structuredClone(config);mutate(bad);await save(bad);invoke('status',configPath);assert.equal(await snapshot(),before);}
 await save(config);await chmod(configPath,0o644);invoke('drain',configPath);assert.equal(await snapshot(),before);await save(config);
 emit({stage:'runtime.refusal',status:'passed'});
 invoke('drain',configPath,'materialized');
 const [current]=await db`SELECT * FROM markdown_projection_current WHERE source_id=${sourceId}`;assert(current);
 const bytes=await readFile(`${root}/${current.current_path}`,'utf8');assert.equal(createHash('sha256').update(bytes).digest('hex'),current.current_hash);
 assert.equal(bytes,serializePageToMarkdown((await engine.getPage('runtime-page',opts))!,[]));
 const [ledger]=await db`SELECT * FROM markdown_projection_obligations WHERE source_id=${sourceId}`;assert.equal(String(ledger.generation),String(ledger.materialized_generation));assert.equal(ledger.status,'materialized');
 invoke('drain',configPath,'idle');emit({stage:'runtime.healthy',status:'passed',ordinaryWriterProven:false,ambiguousCommitProven:false});
 // Healthy cleanup requires both reaped CLI receipts above and no held reservation.
 assert.equal((await db`SELECT * FROM public.markdown_projection_attempts WHERE source_id=${sourceId} AND released_at IS NULL`).length,0);
 if(scenario==='healthy'){
 if(scheduled){
  await db.unsafe(`GRANT SELECT ON config,markdown_projection_source_status TO ${role};
   -- config is brain-global (no source_id); RLS remains enabled. Only the
   -- migration version is needed by the real queue admission guard.
   CREATE POLICY mp_runtime_config_version ON public.config FOR SELECT TO ${role} USING(key='version');
   GRANT INSERT(source_id,scheduler_seen_at,worker_seen_at,last_error),UPDATE(scheduler_seen_at,worker_seen_at,last_error) ON markdown_projection_source_status TO ${role};
   GRANT SELECT,INSERT,UPDATE,DELETE ON minion_jobs,minion_inbox TO ${role};
   GRANT USAGE,SELECT ON SEQUENCE minion_jobs_id_seq,minion_inbox_id_seq TO ${role};`);
  // Disposable login only: ordinary payload is empty, so source alone cannot scope it.
  // SELECT is required by INSERT/UPDATE RETURNING *, claim's self-subquery and inbox joins.
  await db.unsafe(`ALTER TABLE public.minion_jobs ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.minion_jobs FORCE ROW LEVEL SECURITY;
   ALTER TABLE public.minion_inbox ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.minion_inbox FORCE ROW LEVEL SECURITY;
   CREATE POLICY mp_runtime_jobs ON public.minion_jobs FOR ALL TO ${role}
    USING((name='scheduled-fixture-ordinary' AND data='{}'::jsonb) OR (name='markdown-projection-tick' AND data->>'sourceId'='${sourceId}'))
    WITH CHECK((name='scheduled-fixture-ordinary' AND data='{}'::jsonb) OR (name='markdown-projection-tick' AND data->>'sourceId'='${sourceId}'));
   CREATE POLICY mp_runtime_inbox ON public.minion_inbox FOR ALL TO ${role}
    USING(EXISTS(SELECT 1 FROM public.minion_jobs j WHERE j.id=minion_inbox.job_id))
    WITH CHECK(EXISTS(SELECT 1 FROM public.minion_jobs j WHERE j.id=minion_inbox.job_id));`);
  const denied=Array.from(await db`INSERT INTO minion_jobs(name,data) VALUES
   ('markdown-projection-tick',jsonb_build_object('sourceId',${sourceId+'-wrong'}::text)),
   ('scheduled-fixture-wrong',jsonb_build_object('sourceId',${sourceId}::text)) RETURNING *`);
  for(const job of denied)await db`INSERT INTO minion_inbox(job_id,sender,payload) VALUES (${job.id},'admin','{}'::jsonb)`;
  const deniedInbox=Array.from(await db`SELECT * FROM minion_inbox WHERE job_id=ANY(${denied.map(j=>j.id)}) ORDER BY id`);
  await engine.putPage('runtime-page',{type:'note',title:'Scheduled fixture',compiled_truth:'Automatic persisted tick',timeline:'',frontmatter:{}},opts);
  const {scheduledHosted}=await import('./markdown-projection-scheduled-hosted');
  await scheduledHosted(database,role,password,sourceId,configPath,emit,denied.map(j=>Number(j.id)));
  assert.deepEqual(Array.from(await db`SELECT * FROM minion_jobs WHERE id=ANY(${denied.map(j=>j.id)}) ORDER BY id`),denied);
  assert.deepEqual(Array.from(await db`SELECT * FROM minion_inbox WHERE job_id=ANY(${denied.map(j=>j.id)}) ORDER BY id`),deniedInbox);
  emit({stage:'scheduled.queue-rls-owner-readback',status:'passed'});
  const [latest]=await db`SELECT * FROM markdown_projection_current WHERE source_id=${sourceId}`;
  assert.equal(await readFile(`${root}/${latest.current_path}`,'utf8'),serializePageToMarkdown((await engine.getPage('runtime-page',opts))!,[]));
 }
 emit({stage:'runtime.containment',status:'passed',held:0});completed=true;}else{
 // Extend this existing disposable fixture; independent physical nonowner logins.
 const {default:connect}=await import('postgres');
 const clients=[0,1].map(()=>connect({host:'127.0.0.1',port:5432,database,username:role,password,max:1,prepare:false,connect_timeout:5}));
 try{
  const adapters=clients.map(sql=>({executeRaw:async<T=any>(text:string,p?:unknown[])=>Array.from(await sql.unsafe(text,p as any)) as T[]}));
  const queue=new MinionQueue(engine);const job=await queue.add('ordinary-containment-fixture',{});
  let launches=0;
  const context={id:job.id,signal:new AbortController().signal,isActive:async()=>true};
  const fault={run:async()=>{launches++;throw Error('fixture unknown stop');}};
  await Promise.allSettled(adapters.map(a=>runMarkdownProjectionAttempt(a,sourceId,configPath,context,fault)));
  assert.equal(launches,1);
  const held=Array.from(await db`SELECT * FROM public.markdown_projection_attempts WHERE source_id=${sourceId} AND released_at IS NULL`);assert.equal(held.length,1);
  // A newly queued waiting job is not terminal: these calls must not delete it.
  // Neither telemetry operation is authority to release source ownership.
  assert.equal(await queue.removeJob(job.id),false);assert.equal(await queue.prune(),0);
  assert.deepEqual(Array.from(await db`SELECT * FROM public.markdown_projection_attempts WHERE source_id=${sourceId} AND released_at IS NULL`),held);
  if(scheduled){
  // Real terminal deletion: cancellation/removal never confer projection ownership.
  await queue.cancelJob(job.id);assert.equal(await queue.removeJob(job.id),true);
  assert.equal(await queue.getJob(job.id),null);
  const {markdownProjectionJobStatus}=await import('../src/core/minions/handlers/markdown-projection');
  const retainedStatus=await markdownProjectionJobStatus(engine,sourceId);
  assert.equal(retainedStatus.ownership.length,1);
  assert.equal(retainedStatus.recovery,'operator_blocked_no_automatic_recovery');
  assert.deepEqual(Array.from(await db`SELECT * FROM public.markdown_projection_attempts WHERE source_id=${sourceId} AND released_at IS NULL`),held);
  emit({stage:'scheduled.terminal-deleted-held',jobId:job.id,jobs:Array.from(await db`SELECT * FROM minion_jobs WHERE id=${job.id}`),attempts:held,status:retainedStatus});
  }
  const refusal=invoke('drain',configPath);assert.equal(JSON.parse(refusal.output.trim()).code,'projection_reservation_unavailable_operator_required'); // reserve-before-input refusal
  assert.deepEqual(Array.from(await db`SELECT * FROM public.markdown_projection_attempts WHERE source_id=${sourceId} AND released_at IS NULL`),held);
  await assert.rejects(()=>makeMarkdownProjectionHandler(adapters[1] as any,{configPath:()=>configPath,...fault})({...context,data:{sourceId}} as any));
  assert.equal(launches,1);
  const status=invoke('status',configPath,'idle');assert.equal(status.projectionStatus.containment,'operator_blocked_no_automatic_recovery');
  emit({stage:'runtime.containment',status:'passed',ownership:held,realCrashInjectionProven:false,persistReleaseFaultsProven:false});
 }finally{await Promise.all(clients.map(c=>c.end({timeout:2})));}
 // Fixture-only permission: the injected run throws before any supervisor/input.
 // The product reservation stays held; never turn this into recovery authority.
 const retained=Array.from(await db`SELECT * FROM public.markdown_projection_attempts WHERE source_id=${sourceId} AND released_at IS NULL`);
 assert.equal(retained.length,1);assert.equal(retained[0].state,'reserved');
 assert.equal(retained[0].supervisor_pid,null);assert.equal(retained[0].supervisor_start,null);
 assert(inventory.length===16&&inventory.every(e=>e.verified));
 emit({stage:'runtime.held-no-worker',status:'passed',retained,workerAdmissions:0,proof:'fixture-pre-input-throw-and-reserved-db-state'});
 completed=true;
 }
 }catch(error){failed=true;primaryError=error;}finally{
 // Independent attempts: one failure must not hide others or retain the secret.
 if(created){
 await cleanup('role.objects',async()=>{await db.unsafe(`DROP OWNED BY ${role}`);});
 await cleanup('role.login',async()=>{await db.unsafe(`DROP ROLE ${role}`);});
 await cleanup('role.absence',async()=>{assert.equal((await db`SELECT oid FROM pg_roles WHERE rolname=${role}`).length,0);});
 }
 const absent=async(path:string)=>{try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw new Error('runtime cleanup absence unproven');};
 await cleanup('config',async()=>{await rm(configPath,{force:true});await absent(configPath);});
 // Only the completed scenario proves all child lifecycles safe. Otherwise retain evidence.
 if(completed)await cleanup('root',async()=>{assert(inventory.length>0&&inventory.every(e=>e.verified));assert.equal(new Set(inventory.map(e=>e.runId)).size,inventory.length);await rm(root,{recursive:true,force:true});await absent(root);});
 // Never recursively remove the scenario base: unexpected contents are evidence.
 if(completed&&!cleanupErrors.length)await cleanup('base',async()=>{await rmdir(base);await absent(base);});
 emit({stage:'runtime.launch-inventory',scenario,root,inventory:inventory.map(e=>({...e,proof:e.proof?{protocol:e.proof.protocol,runId:e.proof.runId,scenario:e.proof.scenario,root:e.proof.root,pid:e.proof.pid,argv:e.proof.argv,launched:e.proof.launched,reaped:e.proof.reaped,childAccounting:e.proof.childAccounting,members:e.proof.members,sessionMembers:e.proof.sessionMembers,exit:e.proof.exit,errors:e.proof.errors}:undefined}))});
 await cleanup('receipt',async()=>{emit({stage:'runtime.cleanup',status:cleanupErrors.length?'failed':'passed',root:completed&&!cleanupErrors.some(e=>e.stage==='root')?'removed':'retained',failures:cleanupErrors.map(e=>({stage:e.stage}))});});
 }
 if(cleanupErrors.length)throw Object.assign(new AggregateError([...(failed?[primaryError]:[]),...cleanupErrors.map(e=>e.error)],'runtime hosted cleanup failed',failed?{cause:primaryError}:undefined),{primaryError,cleanupErrors});
 if(failed)throw primaryError;
}
