import assert from 'node:assert/strict';
export type BackendIdentity = {pid:number; datname:string; usename:string; application_name:string; backend_start:string};
export async function terminateWorker(observer:any, identity:BackendIdentity, expected:{datname:string;usename:string;application_name:string}) {
 const observerPid=Number((await observer`SELECT pg_backend_pid() AS pid`)[0].pid);
 assert(identity && Number.isSafeInteger(identity.pid) && identity.pid>0);assert.notEqual(identity.pid,observerPid);
 for(const key of ['datname','usename','application_name'] as const){assert(expected[key]);assert.equal(identity[key],expected[key]);}
 assert(typeof identity.backend_start==='string' && identity.backend_start.length>0);
 const rows=await observer`SELECT pid, datname, usename, application_name, backend_start::text AS backend_start FROM pg_stat_activity WHERE pid=${identity.pid}`;
 assert.equal(rows.length,1,'worker identity absent');
 for(const key of ['pid','datname','usename','application_name','backend_start'] as const)assert.equal(rows[0][key],identity[key],`worker identity mismatch: ${key}`);
 // Recheck every ownership field in the terminating statement, not just the earlier read.
 const killed=await observer`SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=${identity.pid} AND pid<>pg_backend_pid() AND datname=${expected.datname} AND usename=${expected.usename} AND application_name=${expected.application_name} AND backend_start=${identity.backend_start}::timestamptz`;
 assert.equal(killed.length,1,'worker identity changed before termination');assert.equal(killed[0].killed,true);
}
async function bounded(promise:Promise<unknown>,timeoutMs:number,label:string){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} deadline`)),timeoutMs);})]);}finally{clearTimeout(timer);}
}
export async function cleanupRace(release:()=>void, running:Promise<unknown>|undefined, callback:{started:boolean;done:Promise<void>}, disconnects:Array<()=>Promise<void>>, primary:unknown, timeoutMs=4000) {
 const errors:unknown[]=[];let unsafeFilesystemCleanup=false;
 const attempt=async(fn:()=>Promise<unknown>)=>{try{await fn();}catch(error){errors.push(error);}};
 release();
 // Driver settlement is NOT callback completion. Join actual finally first.
 if(running)try{await bounded(running,timeoutMs,'worker driver');}catch(error){unsafeFilesystemCleanup=true;errors.push(error);}
 if(callback.started)try{await bounded(callback.done,timeoutMs,'worker callback');}catch(error){unsafeFilesystemCleanup=true;errors.push(error);}
 for(const disconnect of disconnects)await attempt(()=>bounded(Promise.resolve().then(disconnect),timeoutMs,'worker disconnect'));
 if(errors.length){const error=new AggregateError(primary===undefined?errors:[primary,...errors],'worker race cleanup failed',{cause:primary});Object.assign(error,{unsafeFilesystemCleanup});throw error;}
 if(primary!==undefined)throw primary;
}
