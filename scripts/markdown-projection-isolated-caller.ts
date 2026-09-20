// Shared by the hosted caller and offline OS/filesystem regression. No database.
import {execFileSync,execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {accessSync,constants,realpathSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
type Attempt = {attempt:number;runId:string;pid:number;reaped:true;exitCode:number;errors:string[]};
type Receipt = {protocol:string;final:true;runId:string;status:'passed'|'failed';attempts:Attempt[];copyStatus?:string};
// Process-local capability: a boolean/property or copied JSON is not stop authority.
const verifiedStops = new WeakMap<object, string>();
export function authenticatedProjectionStop(value: unknown, runId: string): boolean {
 return typeof value === 'object' && value !== null && verifiedStops.get(value) === runId;
}
export function authenticatedProjectionDiagnostics(value:unknown){
 if(typeof value!=='object'||value===null||!verifiedStops.has(value))return undefined;
 const receipt=(value as any).receipt;
 if(!receipt||receipt.status!=='failed')return undefined;
 return {status:'failed',attempts:receipt.attempts.map((a:Attempt)=>({attempt:a.attempt,exitCode:a.exitCode,errors:a.errors.filter(e=>codes.has(e))}))};
}
export type ProjectionSupervision = {runId: string; beforeInput: (pid: number) => Promise<void>};
const record=(value:unknown):value is Record<string,unknown> => typeof value==='object' && value!==null && !Array.isArray(value);
const codes=new Set(['lifetime_deadline','output_limit','supervisor_interrupted','child_unstructured_error_redacted','child_protocol_error','connection_closed','unhandled_error','worker_failed','admission_failed','child_exit_failure','missing_unique_completion']);
// Total over JSON values: narrow each container before touching its members.
// A matching envelope alone is NOT proof. Every attempt and the final outcome
// must agree with the private supervisor protocol and the observed CLI exit.
function validReceipt(value:unknown,runId:string,primary:unknown):value is Receipt {
 if(record(value) && 'projectionStatus' in value && (!record(value.projectionStatus) || Object.keys(value.projectionStatus).length>12 || !Object.values(value.projectionStatus).every(v=>typeof v==='string' && v.length<256)))return false;
 if(!record(value) || value.protocol!=='markdown-projection-reaping-v1' || value.runId!==runId || value.final!==true ||
    (value.status!=='passed' && value.status!=='failed') || !Array.isArray(value.attempts) || value.attempts.length<1 || value.attempts.length>3)return false;
 const pids=new Set<number>();
 for(let i=0;i<value.attempts.length;i++){
  const a:unknown=value.attempts[i];
  if(!record(a) || a.attempt!==i+1 || a.runId!==runId || typeof a.pid!=='number' || !Number.isSafeInteger(a.pid) || a.pid<=0 || pids.has(a.pid) ||
     a.reaped!==true || typeof a.exitCode!=='number' || !Number.isSafeInteger(a.exitCode) || a.exitCode< -64 || a.exitCode>255 ||
     !Array.isArray(a.errors) || !a.errors.every((e:unknown)=>typeof e==='string' && codes.has(e)))return false;
  pids.add(a.pid);
  if((a.exitCode!==0)!==a.errors.includes('child_exit_failure'))return false;
  if(i<value.attempts.length-1 && a.errors.length===0)return false; // supervisor stops on first success
 }
 const last=value.attempts[value.attempts.length-1] as Attempt;
 if(value.status==='passed')return primary===undefined && last.exitCode===0 && last.errors.length===0 &&
  (value.copyStatus==='idle' || value.copyStatus==='not_required' || value.copyStatus==='materialized');
 // Timeout/signal/spawn failures cannot be authorized by even plausible stdout.
 return record(primary) && primary.status===1 && primary.signal==null && last.errors.length>0 && !('copyStatus' in value);
}
export function runIsolated(config:object, command=['python3','-B',new URL('./markdown-projection-isolated-supervisor.py',import.meta.url).pathname], bunExecutable=process.execPath):Receipt {
 // The trusted running Bun, never a PATH lookup or config/credential field.
 try {
  if(!isAbsolute(bunExecutable) || !statSync(bunExecutable).isFile() || realpathSync(bunExecutable)!==realpathSync(process.execPath))throw new Error();
  accessSync(bunExecutable,constants.X_OK);
 }catch{throw new Error('trusted current Bun executable required');}
 const runId=randomUUID(); let output='',primary:unknown;
 try {output=execFileSync(command[0],[...command.slice(1),'--bun',bunExecutable],{input:JSON.stringify({...config,supervisionRunId:runId}),encoding:'utf8',timeout:27000,maxBuffer:65536});}
 catch(e){primary=e;output=String((e as any)?.stdout??'');}
 return finishIsolated(output,runId,primary);
}
function finishIsolated(output:string,runId:string,primary:unknown):Receipt {
 let receipt:unknown,validationError:unknown,verified=false;
 try{
  receipt=JSON.parse(output.trim()) as unknown;
  if(!validReceipt(receipt,runId,primary))throw new Error('invalid or inconsistent reaping receipt');
  // Admission happens only after full validation and result construction.
  const result:Receipt={...receipt,attempts:receipt.attempts.map(a=>({...a,errors:[...a.errors]}))};
  verified=true;
  if(result.status==='passed'){verifiedStops.set(result,runId);return result;}
 }catch(e){validationError=e;verified=false;}
 const failure = Object.assign(new Error('isolated worker failed',{cause:primary??validationError}),{
  unsafeFilesystemCleanup:!verified,receipt,primaryError:primary,validationError,
  cleanupErrors:verified?[]:['process stop unverified'],
 });
 if(verified)verifiedStops.set(failure,runId);
 throw failure;
}
// Async transport uses the identical executable, supervisor and receipt validator.
export async function runIsolatedAsync(config:object, supervision?:ProjectionSupervision, command=['python3','-B',new URL('./markdown-projection-isolated-supervisor.py',import.meta.url).pathname]):Promise<Receipt> {
 const runId=supervision?.runId ?? randomUUID();
 return new Promise((resolve,reject)=>{
  const child=execFile(command[0],[...command.slice(1),'--bun',process.execPath],
   {encoding:'utf8',timeout:27000,maxBuffer:65536},(error,stdout)=>{
    try{
     const primary=error?Object.assign(error,{status:typeof error.code==='number'?error.code:undefined}):undefined;
     resolve(finishIsolated(stdout,runId,primary));
    }catch(e){reject(e);}
   });
  void (async()=>{
   try {
    if(supervision){
     if(!child.pid)throw new Error('supervisor identity unavailable');
     await supervision.beforeInput(child.pid);
    }
    child.stdin!.end(JSON.stringify({...config,supervisionRunId:runId}));
   } catch(error) {
    // No worker input is delivered. Never infer reaping from kill success.
    child.stdin?.destroy();child.kill('SIGKILL');reject(error);
   }
  })();
 });
}
export async function removeHostedHome(home:string,failure:unknown){
 if((failure as any)?.unsafeFilesystemCleanup)throw new Error('filesystem cleanup refused: process stop unverified');
 await rm(home,{recursive:true,force:true});
}
export function hostedWorkerMode(value:string|undefined){
 if(value!=='isolated' && value!=='legacy')throw new Error('explicit MARKDOWN_PROJECTION_WORKER_MODE isolated|legacy required');
 return value;
}
