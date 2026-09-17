import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import type {BrainEngine} from '../engine';
import {submitMarkdownProjectionTick,requireProjectionConfiguration,type ProjectionTickDependencies} from './handlers/markdown-projection';

const MANIFEST='/etc/gbrain/markdown-projection/schedule.json';
/** Protected local process configuration, never DB config, environment or job data.
 * Absence is disabled; invalid present configuration fails closed. No enrollment/DDL.
 */
export function readProjectionSchedule(path=MANIFEST): readonly string[] {
 let fd:number;
 try {fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);} catch(e) {
  if((e as NodeJS.ErrnoException).code==='ENOENT')return [];
  throw Error('projection_schedule_admission_failed');
 }
 try {
  for(let p=dirname(path);p!=='/';p=dirname(p)) {
   const s=lstatSync(p);
   if(realpathSync(p)!==p||!s.isDirectory()||(s.uid!==0&&s.uid!==process.getuid?.())||(s.mode&0o022))throw Error();
  }
  const s=fstatSync(fd);
  if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>16384)throw Error();
  const c=JSON.parse(readFileSync(fd,'utf8'));
  if(!c||Array.isArray(c)||Object.keys(c).some(k=>!['version','enabled','sources'].includes(k))||c.version!==1||typeof c.enabled!=='boolean')throw Error();
  if(!c.enabled)return [];
  if(!Array.isArray(c.sources)||c.sources.length>32||!c.sources.length||c.sources.some((x:unknown)=>typeof x!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(x))||new Set(c.sources).size!==c.sources.length)throw Error();
  return Object.freeze([...c.sources]);
 }catch{throw Error('projection_schedule_admission_failed');}finally{closeSync(fd);}
}
/** One finite admitted tick per poll; SQL idempotency handles concurrent producers.
 * Existing delayed jobs own retries: do not enqueue around their backoff or a held run.
 */
export function makeProjectionProducer(engine:BrainEngine,sources:readonly string[],now=Date.now,deps:ProjectionTickDependencies={}) {
 let lastSlot='';
 return async()=>{
  const slot=String(Math.floor(now()/30000));
  if(slot===lastSlot)return;
  for(const source of sources){
   let failure='projection_configuration_failed';
   try {
    requireProjectionConfiguration(source,deps.configPath?.(source)??`/etc/gbrain/markdown-projection/${source}.json`,deps.admit);
    failure='projection_schedule_failed';
    await engine.executeRaw(`INSERT INTO public.markdown_projection_source_status(source_id,scheduler_seen_at) VALUES ($1,now()) ON CONFLICT(source_id) DO UPDATE SET scheduler_seen_at=now()`,[source]);
    const held=await engine.executeRaw(`SELECT run_id FROM public.markdown_projection_attempts WHERE source_id=$1 AND released_at IS NULL`,[source]);
    if(held.length)continue;
    const pending=await engine.executeRaw(`SELECT id FROM minion_jobs WHERE name='markdown-projection-tick' AND data->>'sourceId'=$1 AND status IN ('waiting','active','delayed') LIMIT 1`,[source]);
    if(!pending.length)await submitMarkdownProjectionTick(engine,source,slot,false);
   } catch {
    // Refuse this source, not unrelated sources or the shared worker claim loop.
    // Never expose raw configuration/SQL errors (which may contain credentials).
    try {
     await engine.executeRaw(`INSERT INTO public.markdown_projection_source_status(source_id,scheduler_seen_at,last_error) VALUES ($1,now(),$2) ON CONFLICT(source_id) DO UPDATE SET scheduler_seen_at=now(),last_error=$2`,[source,failure]);
    } catch {
     console.error('[markdown-projection]',source,failure,'projection_schedule_status_unavailable');
    }
   }
  }
  lastSlot=slot;
 };
}
