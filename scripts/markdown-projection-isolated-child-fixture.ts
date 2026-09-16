// OFFLINE ONLY: actual executable, simulated driver transport; no DB connections.
import {mock} from 'bun:test';
const mode=process.argv[2];
mock.module('postgres',()=>({default:(options:any)=>{
 const sql:any=async()=>[{db:'mp_accept_abcd',username:'fixture',address:'127.0.0.1',port:5432}];
 sql.begin=async(fn:any)=>{
  if(mode==='loss'){
   setTimeout(()=>options.onclose(),10);
   // If fail-stop is broken, this forbidden continuation must be observable.
   setTimeout(()=>{console.log('LATE_CALLBACK_WRITE');process.exit(9);},150);
   return new Promise(()=>{});
  }
  if(mode==='unhandled'){
   setTimeout(()=>{throw Error('postgres://fixture:SECRET@127.0.0.1/db');},10);
   return new Promise(()=>{});
  }
  return fn({unsafe:async(text:string)=>text.startsWith('SELECT * FROM public.markdown_projection_policy')?
   [{alive:true,enabled:true,root_path:'/unused',source_incarnation:'fixture',policy_generation:1}]:[]});
 };
 sql.end=async()=>options.onclose();
 return sql;
}}));
await import('./markdown-projection-isolated-worker');
