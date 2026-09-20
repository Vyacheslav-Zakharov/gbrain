// Invoked only inside the already admitted hosted fixture, while DB/root live.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,unlink} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {runIsolatedAsync} from './markdown-projection-isolated-caller';
import {terminateWorker} from './markdown-projection-race-safety';
import {serializePageToMarkdown} from '../src/core/markdown';
export async function isolatedRecovery(engine:any,observer:any,config:any,emit:(x:unknown)=>void){
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.equal(process.env.MARKDOWN_PROJECTION_DISPOSABLE,'CREATE_AND_DROP_DATABASE');
 const root=config.worker.root,source=config.worker.sourceId,slug='worker-lane';
 const row=async()=>(await observer`SELECT * FROM markdown_projection_obligations WHERE source_id=${source} AND page_id=(SELECT id FROM pages WHERE source_id=${source} AND slug=${slug})`)[0];
 const pointer=async()=>Array.from(await observer`SELECT * FROM markdown_projection_current WHERE source_id=${source}`);
 const write=(title:string)=>engine.putPage(slug,{type:'note',title,compiled_truth:title,timeline:'',frontmatter:{}},{sourceId:source});
 const manual=`${root}/manual-original.md`;await writeFile(manual,'manual original — never overwrite\n',{flag:'wx',mode:0o600});
 const originals=new Map<string,Buffer>();
 for(const f of await readdir(root))if(f.endsWith('.md'))originals.set(f,await readFile(`${root}/${f}`));
 const untouched=async()=>{for(const [f,b]of originals)assert.deepEqual(await readFile(`${root}/${f}`),b);};
 for(const scenario of [{mode:'backend-loss',seam:'before_write'},{mode:'backend-loss',seam:'after_write'},{mode:'crash',seam:'after_write'}] as const){
  emit({stage:'worker.isolated.recovery',status:'started',...scenario});
  const id=randomUUID(),marker=`${root}/.fixture-${id}.json`;
  await write(`old-${scenario.mode}-${scenario.seam}`);
  const before=await row(),files=new Set(await readdir(root));
  const running=runIsolatedAsync({...config,fixtureFault:{approval:'ISOLATED_RECOVERY_FIXTURE_ONLY',id,...scenario}}).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  let ready:any,primary:unknown;
  let newer:Promise<any>|undefined;
  try{
   const seamDeadline=Date.now()+4000;
   while(Date.now()<seamDeadline){try{ready=JSON.parse(await readFile(marker,'utf8'));break;}catch(e:any){if(e.code!=='ENOENT')throw e;}await Bun.sleep(10);}
   assert(ready,'bounded durable seam not reached');assert.equal(ready.id,id);assert.equal(ready.point,scenario.seam);
   assert.deepEqual(await row(),before);assert.equal((await pointer()).length,0);
   if(scenario.mode==='backend-loss'){
    // Start a real competing generation writer while the old worker owns the guard.
    newer=write(`new-${scenario.seam}`).then((value:any)=>({value}), (error:any)=>({error}));
    const blockedDeadline=Date.now()+750;
    while(!(await observer`SELECT pid FROM pg_stat_activity WHERE ${ready.backend.pid} = ANY(pg_blocking_pids(pid))`).length){assert(Date.now()<blockedDeadline,'new generation writer not observed blocked');await Bun.sleep(10);}
    await terminateWorker(observer,ready.backend,{datname:config.connection.database,usename:config.connection.username,application_name:`mp-isolated-${id}`});
   }
   const outcome=await running;
   assert(outcome.error,'fault must fail, never complete');
   assert.equal(outcome.error.unsafeFilesystemCleanup,false);
   const receipt=outcome.error.receipt,a=receipt.attempts[0];
   assert.equal(receipt.status,'failed');assert.equal(receipt.attempts.length,1);
   assert.equal(a.pid,ready.pid);assert.equal(a.reaped,true);assert.notEqual(a.exitCode,0);
   if(scenario.mode==='backend-loss')assert(a.errors.includes('connection_closed')||a.errors.includes('unhandled_error'),'preserve actual connection-loss failure evidence');
   else assert.equal(a.exitCode,-9);
   const backendDeadline=Date.now()+3000;
   while((await observer`SELECT pid FROM pg_stat_activity WHERE pid=${ready.backend.pid}`).length){assert(Date.now()<backendDeadline,'backend not absent');await Bun.sleep(10);}
   if(newer){const n=await newer;if(n.error)throw n.error;}
   const pending=await row();assert.equal(pending.status,'pending');assert.equal((await pointer()).length,0);
   if(newer)assert(BigInt(pending.generation)>BigInt(before.generation));else assert.deepEqual(pending,before);
   const added=(await readdir(root)).filter(f=>f.endsWith('.md')&&!files.has(f));
   assert.equal(added.length,scenario.seam==='before_write'?0:1);
   const durable=added.length?await readFile(`${root}/${added[0]}`):undefined;
   await untouched();
   emit({stage:'worker.isolated.failure',status:'passed',...scenario,receipt,identity:ready.backend,pendingGeneration:String(pending.generation),currentAbsent:true});
   // This invocation cannot begin until the failed supervisor's validated reaping above.
   const retry=await runIsolatedAsync(config);assert.equal(retry.copyStatus,'materialized');
   assert.notEqual(retry.attempts[0].pid,a.pid);
   const final=await row(),p:any=(await pointer())[0];
   assert.equal(final.status,'materialized');assert.equal(String(final.materialized_generation),String(pending.generation));assert(p);
   assert.equal(p.current_path,final.current_path);
   const bytes=await readFile(`${root}/${p.current_path}`,'utf8');
   assert.equal(createHash('sha256').update(bytes).digest('hex'),p.current_hash);
   assert.equal(bytes,serializePageToMarkdown(await engine.getPage(slug,{sourceId:source}),['worker-tag']));
   if(scenario.mode==='crash'){assert.equal(p.current_path,added[0]);assert.deepEqual(await readFile(`${root}/${p.current_path}`),durable);}
   await untouched();assert(!(await readdir(root)).some(f=>f.startsWith('.pending-')));
   assert.equal((await runIsolatedAsync(config)).copyStatus,'idle');
   emit({stage:'worker.isolated.recovery',status:'passed',...scenario,failedReceipt:receipt,retryReceipt:retry,reapedBeforeRetry:true,manualFilesUntouched:true,currentPath:p.current_path,currentHash:p.current_hash,generation:String(final.generation)});
  }catch(e){primary=e;}finally{
   // Join even on observer/marker failure; never remove a root under a live child.
   const outcome=await running;
   if(newer){const n=await newer;if(n.error&&!primary)primary=n.error;}
   if(outcome.error?.unsafeFilesystemCleanup)throw Object.assign(new AggregateError([primary,outcome.error],'unverified isolated lifetime'),{unsafeFilesystemCleanup:true});
   if(primary)throw primary;
   await unlink(marker);
  }
 }
 emit({stage:'worker.isolated.acceptance',status:'passed',backendLoss:'passed',processCrash:'passed',newerGeneration:'passed',manualFilesUntouched:true});
}
