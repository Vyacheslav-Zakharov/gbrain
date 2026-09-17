import {readFileSync} from 'node:fs';
import {admitRuntimeConfiguration} from '../../../../scripts/markdown-projection-runtime-admission';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {BrainEngine} from '../../engine';
import type {MinionHandler} from '../types';
import {UnrecoverableError} from '../types';
import {runIsolatedAsync,authenticatedProjectionStop} from '../../../../scripts/markdown-projection-isolated-caller';
import {MinionQueue} from '../queue';
export const PROJECTION_JOB = 'markdown-projection-tick';
const validSource = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s);
// Trusted process composition only; never populated from a job, DB config or environment.
export type ProjectionTickDependencies = {
  configPath?: (source: string) => string | undefined;
  run?: typeof runIsolatedAsync;
  admit?: typeof admitRuntimeConfiguration;
};
export function requireProjectionConfiguration(source:string,path:string,admit=admitRuntimeConfiguration):void {
  try {
    if(!admit({admission:'PROTECTED_RUNTIME_V1',action:'drain',configPath:path,sourceId:source}))throw Error();
  } catch {throw new UnrecoverableError('projection_configuration_failed');}
}
function processStart(pid:number):string {
  const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
  const start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
  if(!start || !/^\d+$/.test(start))throw new Error('projection_process_identity_unavailable');
  return start;
}
export function makeMarkdownProjectionHandler(engine: BrainEngine, deps: ProjectionTickDependencies = {}): MinionHandler {
  return async job => {
    const source = job.data.sourceId;
    if (!validSource(source) || Object.keys(job.data).some(k => k !== 'sourceId'))
      throw new UnrecoverableError('projection_payload_refused');
    const path = deps.configPath ? deps.configPath(source) : `/etc/gbrain/markdown-projection/${source}.json`;
    if (!path) return {status: 'not_required'};
    try { requireProjectionConfiguration(source,path,deps.admit); }
    catch(error) {
      await engine.executeRaw(`INSERT INTO public.markdown_projection_source_status(source_id,worker_seen_at,last_error) VALUES ($1,now(),'projection_configuration_failed') ON CONFLICT(source_id) DO UPDATE SET worker_seen_at=now(),last_error='projection_configuration_failed'`,[source]);
      throw error;
    }
    await engine.executeRaw(`INSERT INTO public.markdown_projection_source_status(source_id,worker_seen_at) VALUES ($1,now()) ON CONFLICT(source_id) DO UPDATE SET worker_seen_at=now()`,[source]);
    try {
      const receipt=await runMarkdownProjectionAttempt(engine,source,path,job,deps);
      if(receipt.copyStatus==='not_required')throw new UnrecoverableError('projection_configuration_failed');
      await engine.executeRaw(`UPDATE public.markdown_projection_source_status SET worker_seen_at=now(),last_error=NULL WHERE source_id=$1`,[source]);
      return {status:receipt.copyStatus, reaped:true, durableOutcome:'ledger_consulted'};
    } catch(error) {
      // No raw child/configuration errors are copied into durable source telemetry.
      await engine.executeRaw(`UPDATE public.markdown_projection_source_status SET worker_seen_at=now(),last_error='projection_attempt_failed' WHERE source_id=$1`,[source]);
      throw error;
    }
  };
}
/** Shared CLI/dispatcher admission. Only the private transport writes worker stdin. */
export async function runMarkdownProjectionAttempt(engine: Pick<BrainEngine,'executeRaw'>, source:string,path:string,
  job:{id:number;signal:AbortSignal;isActive:()=>Promise<boolean>},deps:ProjectionTickDependencies={}) {
    if(!validSource(source))throw new Error('projection_source_refused');
    const runId=randomUUID();
    // Linux boot + process start identity is evidence, NEVER a PID-based stop oracle.
    // No job/source FK, expiry, TTL takeover, or queue-maintenance dependency.
    try {
      const reserved=await engine.executeRaw(`INSERT INTO public.markdown_projection_attempts
        (source_id,run_id,job_id,host_id,boot_id,owner_pid,owner_start)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (source_id) WHERE released_at IS NULL DO NOTHING RETURNING run_id`,
        [source,runId,job.id,hostname(),readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),process.pid,processStart(process.pid)]);
      if(reserved.length!==1)throw new Error('reserved');
    } catch {
      throw new UnrecoverableError('projection_reservation_unavailable_operator_required');
    }
    const release=async(proof:unknown)=>{
      if(!authenticatedProjectionStop(proof,runId))throw new UnrecoverableError('projection_reaping_unverified_operator_required');
      // Immutable run identity fences late completion from every future attempt.
      try {
        const released=await engine.executeRaw(`UPDATE public.markdown_projection_attempts SET released_at=now(),state='reaped'
          WHERE source_id=$1 AND run_id=$2 AND released_at IS NULL AND supervisor_pid IS NOT NULL RETURNING run_id`,[source,runId]);
        if(released.length!==1)throw new Error('release refused');
      } catch {throw new UnrecoverableError('projection_release_unverified_operator_required');}
    };
    let receipt;
    try {
      if (job.signal.aborted || !await job.isActive()) throw new Error('inactive');
      receipt = await (deps.run ?? runIsolatedAsync)({admission:'PROTECTED_RUNTIME_V1', action:'drain', configPath:path, sourceId:source},{runId,beforeInput:async pid=>{
        const recorded=await engine.executeRaw(`UPDATE public.markdown_projection_attempts SET supervisor_pid=$3,supervisor_start=$4,state='running'
          WHERE source_id=$1 AND run_id=$2 AND released_at IS NULL AND supervisor_pid IS NULL RETURNING run_id`,[source,runId,pid,processStart(pid)]);
        if(recorded.length!==1)throw new Error('projection_record_refused');
      }});
    } catch (error) {
      await release(error);
      if(error instanceof Error)error.message='projection_child_failed_unknown_consult_ledger';
      throw error; // Preserve authenticated identity and existing queue failure code.
    }
    await release(receipt);
    if (job.signal.aborted || !await job.isActive()) throw new Error('projection_lease_lost_consult_ledger');
    return receipt;
}
/** Trusted host tick; actual MinionWorker default queue contract. */
export async function submitMarkdownProjectionTick(engine: BrainEngine, sourceId: string, slot: string, remote: boolean) {
  if (remote !== false || !validSource(sourceId) || !/^[0-9]{1,16}$/.test(slot)) throw new Error('projection_submit_refused');
  return new MinionQueue(engine).add(PROJECTION_JOB, {sourceId}, {
    queue:'default', idempotency_key:`projection:${sourceId}:${slot}`,
    max_attempts:3, backoff_type:'exponential', backoff_delay:30000, backoff_jitter:0,
    remove_on_complete:false, remove_on_fail:false,
  }, {allowProtectedSubmit:true});
}
/** Ownership remains visible even when all generic telemetry has been removed. */
export async function markdownProjectionJobStatus(engine: BrainEngine, sourceId: string) {
  if (!validSource(sourceId)) throw new Error('projection_source_refused');
  const ownership=await engine.executeRaw(`SELECT source_id,run_id,job_id,host_id,boot_id,owner_pid,owner_start,supervisor_pid,supervisor_start,state,created_at FROM public.markdown_projection_attempts WHERE source_id=$1 AND released_at IS NULL`,[sourceId]);
  const jobs = await engine.executeRaw(`SELECT id,status,attempts_made,delay_until,lock_until,updated_at,error_text,result,progress FROM minion_jobs WHERE name=$1 AND data->>'sourceId'=$2 ORDER BY id DESC LIMIT 20`, [PROJECTION_JOB,sourceId]);
  const telemetry=await engine.executeRaw(`SELECT scheduler_seen_at,worker_seen_at,last_error FROM public.markdown_projection_source_status WHERE source_id=$1`,[sourceId]);
  const obligations=await engine.executeRaw(`SELECT count(*) FILTER(WHERE status='pending')::text AS pending,count(*) FILTER(WHERE status='materialized' AND materialized_generation=generation)::text AS materialized,min(first_pending_at) FILTER(WHERE status='pending') AS first_pending_at,COALESCE(bool_or(status='pending' AND first_pending_at < now()-interval '300 seconds'),false) AS lag_alert FROM public.markdown_projection_obligations WHERE source_id=$1`,[sourceId]);
  return {jobs,ownership,telemetry,obligations,recovery:ownership.length?'operator_blocked_no_automatic_recovery':'none',perPageError:'unavailable', projectionHeartbeat:telemetry[0]?.worker_seen_at??'unavailable', schedulerLiveness:'not_inferred_from_last_seen'};
}
