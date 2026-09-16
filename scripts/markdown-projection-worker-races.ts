// Hosted-only caller schedules; no SQL adapter mocks or additional privileges.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PostgresEngine} from '../src/core/postgres-engine';
import {drainMarkdownProjectionOnce,type ProjectionWorkerDB,type ProjectionWorkerConfig} from '../src/core/markdown-projection-worker';
import {serializePageToMarkdown} from '../src/core/markdown';
import {terminateWorker,cleanupRace,raceStage,type BackendIdentity} from './markdown-projection-race-safety';

export async function workerRaces(engine:PostgresEngine, observer:any, url:string, config:ProjectionWorkerConfig, emit:(x:unknown)=>void) {
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 const opts={sourceId:config.sourceId};
 const slug='worker-lane';
 const row=async()=> (await observer`SELECT * FROM markdown_projection_obligations WHERE source_id=${config.sourceId} AND page_id=(SELECT id FROM pages WHERE source_id=${config.sourceId} AND slug=${slug})`)[0];
 const current=async()=>Array.from(await observer`SELECT * FROM markdown_projection_current WHERE source_id=${config.sourceId}`);
 const absent=async(pid:number)=>{
  const end=Date.now()+3000;
  while(Date.now()<end){if(!(await observer`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`).length)return;await Bun.sleep(20);}
  assert.fail(`backend still present: ${pid}`);
 };
 const write=async(title:string)=>engine.putPage(slug,{type:'note',title,compiled_truth:title,timeline:'',frontmatter:{}},opts);
 const bytes=async(path:string)=>readFile(`${config.root}/${path}`,'utf8');
 const verify=async()=>{
  const r=await row();assert.equal(r.status,'materialized');
  assert.equal(String(r.materialized_generation),String(r.generation));
  const b=await bytes(r.current_path);
  assert.equal(b,serializePageToMarkdown((await engine.getPage(slug,opts))!,['worker-tag']));
  assert.equal(createHash('sha256').update(b).digest('hex'),r.current_hash);
  return r;
 };
 for(const seam of ['before_write','after_write'] as const){
  await write(`old-${seam}`);
  const old=await row();
  const stale=new PostgresEngine(), fresh=new PostgresEngine();
  let release!:()=>void, reached!:()=>void;
  const gate=new Promise<void>(r=>release=r), ready=new Promise<void>(r=>reached=r);
  let pid=0, freshPid=0, staleAckRejected=false;
  let callbackFinished!:()=>void;
  const callbackDone=new Promise<void>(r=>callbackFinished=r);
  const callback={started:false,done:callbackDone};
  const target=new URL(url), applicationName=`mp-race-${crypto.randomUUID()}`;
  const expected={datname:decodeURIComponent(target.pathname.slice(1)),usename:decodeURIComponent(target.username),application_name:applicationName};
  let identity:BackendIdentity|undefined, primary:unknown;
  // Observe PID inside the real transaction, AFTER its SET TRANSACTION.
  // Track callback completion separately: driver rejection may precede JS unwind.
  const observed=(e:PostgresEngine,set:(p:number)=>void):ProjectionWorkerDB=>({transaction:fn=>e.transaction(async tx=>{
   if(e===stale)callback.started=true;
   try{return await fn({executeRaw:async <T=any>(sql:string,params?:unknown[])=>{
    let result:T[];
    try{result=await tx.executeRaw<T>(sql,params);}catch(error){
     if(e===stale&&sql.startsWith('UPDATE public.markdown_projection_obligations'))staleAckRejected=true;
     throw error;
    }
    if(sql.startsWith('SET TRANSACTION')){
     if(e===stale){
      await tx.executeRaw("SELECT set_config('application_name',$1,true)",[applicationName]);
      identity=(await tx.executeRaw<BackendIdentity>('SELECT pid, datname, usename, application_name, backend_start::text AS backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()'))[0];
      set(Number(identity.pid));
     }else set(Number((await tx.executeRaw<any>('SELECT pg_backend_pid() AS pid'))[0].pid));
    }
    return result;
   }});}finally{if(e===stale)callbackFinished();}
  })});
  const stage=<T>(name:string,operation:()=>T|PromiseLike<T>)=>raceStage(`worker.${name}`,operation,receipt=>emit({...receipt,seam}));
  let running:Promise<any>|undefined;
  try{
   await stale.connect({engine:'postgres',database_url:url,poolSize:1});
   await fresh.connect({engine:'postgres',database_url:url,poolSize:1});
   running=drainMarkdownProjectionOnce(config,observed(stale,p=>pid=p),async p=>{if(p===seam){reached();await gate;}}).then(value=>({value}),error=>({error}));
   await stage('ready',()=>ready);
   const observerPid=Number((await observer`SELECT pg_backend_pid() AS pid`)[0].pid);
   emit({stage:'worker.termination',seam,status:'started'});
   assert(identity);await terminateWorker(observer,identity,expected);
   emit({stage:'worker.termination',seam,status:'passed'});
   await absent(pid);
   await write(`new-${seam}`);
   const pending=await row();assert.equal(pending.status,'pending');assert(BigInt(pending.generation)>BigInt(old.generation));
   assert.equal((await current()).length,0,'new write cannot retain a current pointer');
   emit({stage:'worker.fresh.publication',seam,status:'started'});
   assert.equal((await drainMarkdownProjectionOnce(config,observed(fresh,p=>freshPid=p))).status,'materialized');
   emit({stage:'worker.fresh.publication',seam,status:'passed'});
   assert(freshPid>0);assert.notEqual(freshPid,pid);assert.notEqual(freshPid,observerPid);
   const latest=await verify(), pointer=await current(), latestBytes=await bytes(latest.current_path);
   await stage('gate.release',release);
   const driver=running;
   const outcome=await stage('driver.settlement',()=>driver);
   await stage('callback.completion',()=>callbackDone);
   assert(outcome.error,'terminated transaction acknowledged');assert(staleAckRejected,'lost session must reject actual ACK SQL');
   assert.deepEqual(await current(),pointer);assert.deepEqual(await row(),latest);
   assert.equal(await bytes(latest.current_path),latestBytes);
   const payloads=await readdir(config.root);assert(!payloads.some(p=>p.startsWith('.pending-')));
   // Old worker really installed immutable bytes, not a synthetic death success.
   const oldBodies=await Promise.all(payloads.filter(p=>p.endsWith('.md')).map(bytes));
   assert(oldBodies.some(b=>b.includes(`old-${seam}`)));
   assert.equal((await drainMarkdownProjectionOnce(config,fresh)).status,'idle');
   emit({stage:'worker.backend-race',seam,status:'passed',terminatedPid:pid,currentPid:freshPid,observerPid,backendAbsent:true,staleRejected:true});
  }catch(error){primary=error;}finally{
   await cleanupRace(release,running,callback,[()=>stale.disconnect(),()=>fresh.disconnect()],primary);
  }
 }
 await write('crash-durable-before-ack');
 const before=await row(), beforeFiles=new Set(await readdir(config.root));
 const marker=`${config.root}/crash-receipt.json`;
 const child=Bun.spawn(['python3','scripts/markdown-projection-worker-crash-supervisor.py',marker,process.execPath,'scripts/markdown-projection-worker-crash-child.ts'],{
  env:{...process.env,MP_CRASH_DATABASE_URL:url,MP_CRASH_ROOT:config.root,MP_CRASH_MARKER:marker},stdout:'pipe',stderr:'pipe'});
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 assert.equal(exit,0,`${out}\n${err}`);
 const receipt=JSON.parse(await readFile(marker,'utf8'));assert.equal(receipt.stage,'after_write');assert(receipt.backendPid>0);
 assert.notEqual(receipt.backendPid,Number((await observer`SELECT pg_backend_pid() AS pid`)[0].pid));
 await absent(receipt.backendPid);
 assert.deepEqual(await row(),before);assert.equal((await current()).length,0);
 const added=(await readdir(config.root)).filter(p=>p.endsWith('.md')&&!beforeFiles.has(p));assert.equal(added.length,1);
 const durableBytes=await bytes(added[0]);
 const retry=await drainMarkdownProjectionOnce(config,engine);assert.equal(retry.status,'materialized');assert('path' in retry);assert.equal(retry.path,added[0]);
 assert.equal(await bytes(added[0]),durableBytes);await verify();
 assert.equal((await drainMarkdownProjectionOnce(config,engine)).status,'idle');
 emit({stage:'worker.process-crash',status:'passed',receipt,supervisor:out,backendAbsent:true,idempotentPath:retry.path});
}
