// Dedicated process and connection. Never imports Portal engine or fixture hooks.
import {readFileSync,writeSync} from 'node:fs';
import {admitRuntime} from './markdown-projection-runtime-admission';
import {drainMarkdownProjectionOnce,type ProjectionWorkerDB} from '../src/core/markdown-projection-worker';
const fatal=(code:string):never=>{writeSync(2,JSON.stringify({stage:'copy.failed',code})+'\n');process.exit(1);};
process.on('uncaughtException',()=>fatal('unhandled_error'));
process.on('unhandledRejection',()=>fatal('unhandled_error'));
let admitted=false,closing=false;
try{
 const request=JSON.parse(readFileSync(0,'utf8'));
 const config=admitRuntime(request);
 if(!config){writeSync(1,JSON.stringify({stage:'copy.complete',status:'not_required'})+'\n');process.exit(0);}
 const c=config.connection;
 const {default:postgres}=await import('postgres');
 admitted=true;
 const sql=postgres({host:c.host,port:c.port,database:c.database,username:c.username,password:c.password,
 ssl:c.tls==='verify-full'?{rejectUnauthorized:true}:false,max:1,prepare:false,connect_timeout:5,onnotice:()=>{},
 connection:{search_path:'pg_catalog,public',statement_timeout:5000,lock_timeout:1500,idle_in_transaction_session_timeout:10000,application_name:'markdown-projection-runtime'},
 onclose:()=>{if(!closing)fatal('connection_closed');}});
 const [id]=await sql`SELECT current_database() AS db,session_user AS username,current_user AS effective,
 host(inet_server_addr()) AS address,inet_server_port() AS port,
 r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb
 FROM pg_roles r WHERE r.rolname=session_user`;
 if(!id||id.db!==c.database||id.username!==c.username||id.effective!==c.username||id.address!==c.expectedServerAddress||id.port!==c.expectedServerPort||id.rolsuper||id.rolbypassrls||id.rolcreaterole||id.rolcreatedb)fatal('admission_failed');
 // An owner or page writer is not a copy-worker identity. Grants stay external.
 const [rights]=await sql`SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns,
 has_table_privilege(current_user,'public.pages','INSERT,UPDATE,DELETE,TRUNCATE') AS writes_pages`;
 if(rights.owns||rights.writes_pages)fatal('admission_failed');
 let result:{status:string;projectionStatus?:Record<string,string>};
 if(request.action==='status'){
  const rows=await sql.begin('READ ONLY',async tx=>{
   const [policy]=await tx`SELECT enabled,alive,root_path FROM public.markdown_projection_policy WHERE source_id=${config.worker.sourceId}`;
   if(!policy||policy.root_path!==config.worker.root)throw Error('policy');
   const [counts]=await tx`SELECT count(*)::text AS total,
    count(*) FILTER(WHERE status='pending')::text AS pending,
    count(*) FILTER(WHERE status='blocked_policy')::text AS blocked,
    count(*) FILTER(WHERE status='materialized')::text AS materialized,
    COALESCE(min(first_pending_at) FILTER(WHERE status='pending')::text,'') AS firstPendingAt,
    COALESCE(max(generation)::text,'') AS desiredGeneration,
    COALESCE(max(materialized_generation)::text,'') AS materializedGeneration
    FROM public.markdown_projection_obligations WHERE source_id=${config.worker.sourceId}`;
   const [containment]=await tx`SELECT count(*)::text AS held FROM public.markdown_projection_attempts WHERE source_id=${config.worker.sourceId} AND released_at IS NULL`;
   return {...counts,enabled:String(policy.enabled&&policy.alive),lastError:'unavailable',heartbeat:'unavailable',containment:containment.held==='0'?'clear':'operator_blocked_no_automatic_recovery'};
  });
  result={status:'idle',projectionStatus:rows as Record<string,string>};
 }else{
  // A user-supplied run ID alone is not authority: only the recorded live parent
  // supervisor may deliver this private stdin request. Never reserve/spawn here.
  const parentStat=readFileSync(`/proc/${process.ppid}/stat`,'utf8');
  const parentStart=parentStat.slice(parentStat.lastIndexOf(')')+2).split(' ')[19];
  const [attempt]=await sql`SELECT run_id FROM public.markdown_projection_attempts WHERE source_id=${config.worker.sourceId} AND run_id=${request.supervisionRunId} AND supervisor_pid=${process.ppid} AND supervisor_start=${parentStart} AND released_at IS NULL AND state='running'`;
  if(!attempt)fatal('admission_failed');
  const db:ProjectionWorkerDB={transaction:async fn=>await sql.begin(async tx=>fn({executeRaw:async <T=any>(text:string,params?:unknown[])=>Array.from(await tx.unsafe(text,params as any)) as T[]})) as Awaited<ReturnType<typeof fn>>};
  // Each fresh invocation rereads policy and durable obligations, including after uncertain COMMIT.
  result=await drainMarkdownProjectionOnce(config.worker,db);
 }
 closing=true;await sql.end({timeout:2});
 writeSync(1,JSON.stringify({stage:'copy.complete',...result})+'\n');
}catch{fatal(admitted?'worker_failed':'admission_failed');}
