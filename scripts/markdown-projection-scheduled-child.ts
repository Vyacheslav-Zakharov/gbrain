// Disposable hosted child only; invoked by the existing exclusive-child supervisor.
import assert from 'node:assert/strict';
import {readFileSync,writeSync} from 'node:fs';
import {PostgresEngine} from '../src/core/postgres-engine';
import {MinionWorker} from '../src/core/minions/worker';
import {MinionQueue} from '../src/core/minions/queue';
import {registerBuiltinHandlers} from '../src/commands/jobs';
import {runIsolatedAsync} from './markdown-projection-isolated-caller';
const [path,mode,idText,ordinaryText]=process.argv.slice(2);
assert(['die-delayed','complete'].includes(mode));
const c=JSON.parse(readFileSync(path,'utf8'));
assert(/^mp_accept_[0-9a-f]{16}$/.test(c.connection.database));
assert.equal(c.connection.host,'127.0.0.1');
const url=new URL(`postgres://127.0.0.1:5432/${c.connection.database}`);
url.username=c.connection.username;url.password=c.connection.password;
const engine=new PostgresEngine();
await engine.connect({engine:'postgres',database_url:url.href,poolSize:2});
const worker=new MinionWorker(engine,{pollInterval:10,healthCheckInterval:0});
const queue=new MinionQueue(engine);
const emit=(v:unknown)=>writeSync(1,JSON.stringify(v)+'\n');
await registerBuiltinHandlers(worker,engine,{quiet:true,projectionTick:{configPath:s=>s===c.worker.sourceId?path:undefined,run:async(config,supervision)=>{
 try{const receipt=await runIsolatedAsync(mode==='die-delayed'?{...config,configPath:'/nonexistent/scheduled-failure.json'}:config,supervision);emit({stage:'scheduled.isolated-receipt',receipt});return receipt;}
 catch(error){emit({stage:'scheduled.isolated-failure',receipt:(error as any).receipt});throw error;}
}}});
worker.register('scheduled-fixture-ordinary',async()=>({ordinary:true}));
const running=worker.start();
try{
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){
  const job=await queue.getJob(Number(idText));
  if(mode==='die-delayed'&&job?.status==='delayed'){
   emit({stage:'scheduled.child-delayed',pid:process.pid,job});
   // Real process death after authenticated subprocess cleanup, never unknown-stop takeover.
   process.kill(process.pid,'SIGKILL');await new Promise(()=>{});
  }
  if(mode==='complete'&&job?.status==='completed'&&(await queue.getJob(Number(ordinaryText)))?.status==='completed'){
   emit({stage:'scheduled.child-completed',pid:process.pid,job});break;
  }
  await new Promise(r=>setTimeout(r,20));
 }
 if(mode==='complete')assert.equal((await queue.getJob(Number(idText)))?.status,'completed');
 else throw Error('delayed state not reached');
}finally{worker.stop();await running;await engine.disconnect();}
