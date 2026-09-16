import {test,expect} from 'bun:test';
import postgres from 'postgres';

// Offline driver seam: real postgres.js serializers, no database/socket opened.
// The SQL cast supplies ParameterDescription's OID; simulate only catalog rows.
function precisionObserver(initial:BackendIdentity, final:BackendIdentity|null=initial){
 const driver=postgres({max:1});let kills=0;
 const sql=async(strings:TemplateStringsArray,...values:unknown[])=>{
  const text=strings.join('?');
  if(!text.includes('pg_stat_activity'))return [{pid:99}];
  if(!text.includes('pg_terminate_backend'))return [initial];
  const timestampSlot=values.length-1;
  const oid=strings[timestampSlot+1].startsWith('::text')?25:1184;
  const wire=(driver.options.serializers as any)[oid](values[timestampSlot]);
  // Normalize only spelling, never fractional precision. A 1us reused PID differs.
  const instant=(x:string)=>x.replace(' ','T').replace('+00','Z').replace(/(\.\d{3})Z$/,'$1000Z');
  if(!final || final.pid!==values[0] || final.pid===99 || final.datname!==values[1] || final.usename!==values[2] || final.application_name!==values[3] || instant(final.backend_start)!==instant(wire))return [];
  kills++;return [{killed:true}];
 };
 return {sql,get kills(){return kills;},close:()=>driver.end()};
}
test('real driver timestamp serializer preserves guarded microsecond identity',async()=>{
 const o=precisionObserver(identity);
 try{await terminateWorker(o.sql,identity,expected);expect(o.kills).toBe(1);}finally{await o.close();}
});
for(const field of ['missing','backend_start','datname','usename','application_name','pid'] as const)test(`second statement refuses changed ${field} with zero termination`,async()=>{
 const final=field==='missing'?null:{...identity,...(field==='backend_start'?{backend_start:'2026-09-16 00:00:00.123457+00'}:field==='pid'?{pid:43}:{[field]:'wrong'})};
 const o=precisionObserver(identity,final);
 try{await expect(terminateWorker(o.sql,identity,expected)).rejects.toThrow('worker identity changed before termination');expect(o.kills).toBe(0);}finally{await o.close();}
});
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {terminateWorker,cleanupRace,type BackendIdentity} from './markdown-projection-race-safety';
const identity:BackendIdentity={pid:42,datname:'fixture',usename:'fixture_login',application_name:'race-unique',backend_start:'2026-09-16 00:00:00.123456+00'};
const expected={datname:identity.datname,usename:identity.usename,application_name:identity.application_name};
function observer(row:any){let kills=0;const queries:string[]=[];return {get kills(){return kills;},queries,sql:async(strings:TemplateStringsArray,...values:unknown[])=>{const text=strings.join('?');queries.push(text);if(text.includes('pg_terminate_backend')){kills++;return [{killed:true}];}if(text.includes('pg_stat_activity'))return row?[row]:[];return [{pid:99}];}};}
for(const field of ['datname','usename','application_name','backend_start','pid','missing','observer'] as const)test(`refuses ${field} identity with zero kills`,async()=>{
 const row=field==='missing'?undefined:{...identity,...(field==='observer'?{pid:99}:field==='pid'?{pid:43}:{[field]:'wrong'})};
 const o=observer(row);let error;try{await terminateWorker(o.sql,field==='observer'?{...identity,pid:99}:identity,expected);}catch(e){error=e;}
 expect(error).toBeDefined();expect(o.kills).toBe(0);
});
test('matching identity uses independently checked and constrained activity row',async()=>{const o=observer(identity);await terminateWorker(o.sql,identity,expected);expect(o.kills).toBe(1);const kill=o.queries.find(q=>q.includes('pg_terminate_backend'))!;for(const token of ['pg_stat_activity','datname','usename','application_name','backend_start','pg_backend_pid'])expect(kill).toContain(token);});
test('early driver rejection joins late callback write before filesystem cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'race-join-'));const events:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const done=(async()=>{await gate;await Bun.sleep(25);await writeFile(join(root,'late'),'done');events.push('callback-finally');})();
 const running=Promise.reject(Error('driver died')).catch(error=>({error}));
 try{await cleanupRace(release,running,{started:true,done},[async()=>{events.push('disconnect');expect(await readFile(join(root,'late'),'utf8')).toBe('done');}],undefined,500);expect(events).toEqual(['callback-finally','disconnect']);}finally{release();await done;await rm(root,{recursive:true,force:true});}
});
test('all disconnects attempted and primary retained with aggregate secondary errors',async()=>{
 const primary=Error('primary'),a=Error('stale disconnect'),b=Error('fresh disconnect');const seen:string[]=[];let error:any;
 try{await cleanupRace(()=>seen.push('release'),Promise.resolve(),{started:false,done:new Promise(()=>{})},[async()=>{seen.push('stale');throw a;},async()=>{seen.push('fresh');throw b;}],primary,50);}catch(e){error=e;}
 expect(seen).toEqual(['release','stale','fresh']);expect(error.cause).toBe(primary);expect(error.errors).toEqual([primary,a,b]);
});
test('callback deadline refuses return to filesystem cleanup',async()=>{let error:any;let disconnected=false;try{await cleanupRace(()=>{},Promise.resolve(),{started:true,done:new Promise(()=>{})},[async()=>{disconnected=true;}],undefined,10);}catch(e){error=e;}expect(error).toBeDefined();expect(disconnected).toBe(true);expect(error.unsafeFilesystemCleanup).toBe(true);});
