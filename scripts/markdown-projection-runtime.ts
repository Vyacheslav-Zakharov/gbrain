import {runIsolated,runIsolatedAsync,authenticatedProjectionDiagnostics} from './markdown-projection-isolated-caller';
import {admitRuntime} from './markdown-projection-runtime-admission';
import {runMarkdownProjectionAttempt} from '../src/core/minions/handlers/markdown-projection';
import type {BrainEngine} from '../src/core/engine';
// Dependencies are trusted in-process test composition, never JSON/CLI options.
export async function runRuntime(request:Record<string,unknown>,deps:{admit?:typeof admitRuntime;engine?:Pick<BrainEngine,'executeRaw'>;run?:typeof runIsolatedAsync}={}) {
 if(Object.keys(request).some(k=>!['admission','action','configPath'].includes(k)))throw Error('admission_failed');
 const config=(deps.admit??admitRuntime)(request);
 if(!config || request.action==='status')return runIsolated(request);
 if(request.action!=='drain'||typeof request.configPath!=='string')throw Error('admission_failed');
 let close=async()=>{};
 let engine=deps.engine;
 try {
  if(!engine){
   const {default:postgres}=await import('postgres');const c=config.connection;
   const sql=postgres({host:c.host,port:c.port,database:c.database,username:c.username,password:c.password,
    ssl:c.tls==='verify-full'?{rejectUnauthorized:true}:false,max:1,prepare:false,connect_timeout:5,onnotice:()=>{},
    connection:{search_path:'pg_catalog,public',statement_timeout:5000,lock_timeout:1500,application_name:'markdown-projection-admission'}});
   close=async()=>{await sql.end({timeout:2});};
   const [id]=await sql`SELECT current_database() AS db,session_user AS username,current_user AS effective,host(inet_server_addr()) AS address,inet_server_port() AS port,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=r.oid) AS owns
    FROM pg_roles r WHERE rolname=session_user`;
   if(!id||id.db!==c.database||id.username!==c.username||id.effective!==c.username||id.address!==c.expectedServerAddress||id.port!==c.expectedServerPort||id.rolsuper||id.rolbypassrls||id.rolcreaterole||id.rolcreatedb||id.owns)throw Error('admission_failed');
   engine={executeRaw:async<T=any>(text:string,params?:unknown[])=>Array.from(await sql.unsafe(text,params as any)) as T[]};
  }
  return await runMarkdownProjectionAttempt(engine,config.worker.sourceId,request.configPath,{id:0,signal:new AbortController().signal,isActive:async()=>true},{run:deps.run});
 }finally{await close();}
}
if(import.meta.main){
 const [action,flag,configPath,...extra]=process.argv.slice(2);
 try{
  if(!['status','drain'].includes(action)||extra.length||(flag!==undefined&&(flag!=='--config'||!configPath)))throw Error();
  console.log(JSON.stringify(await runRuntime({admission:'PROTECTED_RUNTIME_V1',action,...(configPath?{configPath}:{})})));
 }catch(error){console.error(JSON.stringify({status:'failed',code:error instanceof Error&&error.message==='projection_reservation_unavailable_operator_required'?error.message:'runtime_failed',diagnostics:authenticatedProjectionDiagnostics(error),durableOutcome:'unknown_consult_ledger'}));process.exitCode=1;}
}
