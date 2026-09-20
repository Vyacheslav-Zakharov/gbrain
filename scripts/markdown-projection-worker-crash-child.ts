// Only launched by admitted hosted fixture; never default discovery.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {PostgresEngine} from '../src/core/postgres-engine';
import {drainMarkdownProjectionOnce,type ProjectionWorkerDB} from '../src/core/markdown-projection-worker';
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.MARKDOWN_PROJECTION_DISPOSABLE,'CREATE_AND_DROP_DATABASE');
const url=process.env.MP_CRASH_DATABASE_URL!;
assert(/^mp_accept_[a-f0-9]+$/.test(new URL(url).pathname.slice(1)));
const engine=new PostgresEngine();
await engine.connect({engine:'postgres',database_url:url,poolSize:1});
let backendPid=0;
const db:ProjectionWorkerDB={transaction:fn=>engine.transaction(tx=>fn({executeRaw:async <T=any>(sql:string,params?:unknown[])=>{
 const result=await tx.executeRaw<T>(sql,params);
 if(sql.startsWith('SET TRANSACTION'))backendPid=Number((await tx.executeRaw<any>('SELECT pg_backend_pid() AS pid'))[0].pid);
 return result;
}}))};
try{
 await drainMarkdownProjectionOnce({enabled:true,sourceId:'default',root:process.env.MP_CRASH_ROOT!,inputRoots:[]},db,async point=>{
  if(point==='after_write'){
   assert(backendPid>0);
   await writeFile(process.env.MP_CRASH_MARKER!,JSON.stringify({stage:point,pid:process.pid,backendPid}),{flag:'wx',mode:0o600});
   // SIGKILL must interrupt the actual caller before any DB acknowledgement.
   await new Promise(()=>{setInterval(()=>{},1000);});
  }
 });
 throw Error('crash boundary not reached');
}finally{await engine.disconnect();}
