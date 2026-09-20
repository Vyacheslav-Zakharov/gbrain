// Development-only executable, launched by isolated-supervisor.py. Never Portal.
// No PostgresEngine/shared pool, home config discovery, migrations or enrollment.
import postgres from 'postgres';
import {readFileSync, writeSync,writeFileSync,renameSync} from 'node:fs';
import {admitFixtureFault} from './markdown-projection-fixture-fault';
import {drainMarkdownProjectionOnce, type ProjectionWorkerDB} from '../src/core/markdown-projection-worker';

function fatal(code: string): never {
  // Never print driver messages, SQL, config, URL, password or stack.
  writeSync(2, JSON.stringify({stage:'copy.failed',code})+'\n');
  process.exit(1);
}
process.on('uncaughtException',()=>fatal('unhandled_error'));
process.on('unhandledRejection',()=>fatal('unhandled_error'));
let admitted=false, closing=false;
try {
  const config=JSON.parse(readFileSync(0,'utf8'));
  const c=config.connection;
  if(config.admission!=='HOSTED_DISPOSABLE_ONLY' || !c ||
     !/^mp_accept_[a-f0-9]+$/.test(c.database) ||
     !['127.0.0.1','::1'].includes(c.host) ||
     !Number.isInteger(c.port) || c.port<1 || c.port>65535 ||
     typeof c.username!=='string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.username) ||
     typeof c.password!=='string' || typeof c.expectedServerAddress!=='string' ||
     !Number.isInteger(c.expectedServerPort) ||
     config.worker?.enabled!==true || typeof config.worker.sourceId!=='string' ||
     typeof config.worker.root!=='string' || !Array.isArray(config.worker.inputRoots) ||
     !config.worker.inputRoots.every((p:unknown)=>typeof p==='string') ||
     Object.keys(process.env).some(k=>k.startsWith('PG') || k==='DATABASE_URL')) fatal('admission_failed');
  const fault=admitFixtureFault(config);
  admitted=true;
  const sql=postgres({host:c.host,port:c.port,database:c.database,username:c.username,password:c.password,
    ssl:false,max:1,connect_timeout:5,prepare:false,
    connection:{statement_timeout:5000,lock_timeout:1500,idle_in_transaction_session_timeout:10000,search_path:'public',application_name:fault?`mp-isolated-${fault.id}`:'mp-isolated-healthy'},
    onnotice:()=>{},
    // A disconnected worker may not reconnect or continue a suspended callback.
    onclose:()=>{if(!closing)fatal('connection_closed');}});
  const [identity]=await sql`SELECT current_database() AS db,session_user AS username,
    host(inet_server_addr()) AS address,inet_server_port() AS port`;
  if(identity.db!==c.database || identity.username!==c.username ||
     identity.address!==c.expectedServerAddress || identity.port!==c.expectedServerPort) fatal('admission_failed');
  const [backend]=await sql`SELECT pid,datname,usename,application_name,backend_start::text AS backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()`;
  const db:ProjectionWorkerDB={transaction:async fn=>{
    const result=await sql.begin(async tx=>fn({executeRaw:async <T=any>(text:string,params?:unknown[])=>
      Array.from(await tx.unsafe(text,params as any)) as T[]}));
    return result as Awaited<ReturnType<typeof fn>>;
  }};
  const result=await drainMarkdownProjectionOnce(config.worker,db,fault?async point=>{
    if(point!==fault.seam)return;
    writeFileSync(`${fault.marker}.tmp`,JSON.stringify({id:fault.id,point,pid:process.pid,backend}),{flag:'wx',mode:0o600});
    renameSync(`${fault.marker}.tmp`,fault.marker);
    if(fault.mode==='crash')process.kill(process.pid,'SIGKILL');
    // Backend loss must stop the actual process, not release a late callback.
    await Bun.sleep(6000);
    throw Error('fixture_fault_deadline');
  }:undefined);
  // Transaction and resource closure must finish before completion is emitted.
  closing=true;
  await sql.end({timeout:2});
  writeSync(1,JSON.stringify({stage:'copy.complete',status:result.status})+'\n');
} catch {
  fatal(admitted?'worker_failed':'admission_failed');
}
