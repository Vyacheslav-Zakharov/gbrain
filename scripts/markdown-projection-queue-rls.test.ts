import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {MinionQueue} from '../src/core/minions/queue';
const fixture=readFileSync(new URL('./markdown-projection-runtime-hosted.ts',import.meta.url),'utf8');
test('disposable queue RLS has symmetric exact name/source and linked inbox scope',()=>{
 const jobs=fixture.match(/CREATE POLICY mp_runtime_jobs[\s\S]*?;/)?.[0];
 expect(jobs).toBeDefined();
 expect(jobs).toContain('ON public.minion_jobs FOR ALL TO ${role}');
 const predicate="(name='scheduled-fixture-ordinary' AND data='{}'::jsonb) OR (name='markdown-projection-tick' AND data->>'sourceId'='${sourceId}')";
 expect(jobs).toContain(`USING(${predicate})`);expect(jobs).toContain(`WITH CHECK(${predicate})`);
 const inbox=fixture.match(/CREATE POLICY mp_runtime_inbox[\s\S]*?;/)?.[0];
 expect(inbox).toContain('ON public.minion_inbox FOR ALL TO ${role}');
 for(const clause of ['USING','WITH CHECK'])expect(inbox).toContain(`${clause}(EXISTS(SELECT 1 FROM public.minion_jobs j WHERE j.id=minion_inbox.job_id))`);
 for(const table of ['minion_jobs','minion_inbox'])expect(fixture).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
 expect(jobs+String(inbox)).not.toMatch(/TO PUBLIC|USING\(true\)|WITH CHECK\(true\)/i);
 expect(fixture).toContain('LOGIN NOSUPERUSER NOBYPASSRLS');
 expect(fixture).toContain('deniedInbox');
});
test('ordinary caller retains empty JSON and real guard/INSERT RETURNING contract offline',async()=>{
 const calls:{sql:string,params:unknown[]}[]=[];
 const engine:any={getConfig:async(key:string)=>{expect(key).toBe('version');return '140';},transaction:async(fn:any)=>fn(engine),executeRaw:async(sql:string,params:unknown[])=>{calls.push({sql,params});return [{id:1,name:params[0],data:params[4],status:'waiting'}];}};
 const job=await new MinionQueue(engine).add('scheduled-fixture-ordinary',{});
 expect(job.id).toBe(1);expect(calls).toHaveLength(1);expect(calls[0].sql).toContain('INSERT INTO minion_jobs');expect(calls[0].sql).toContain('RETURNING *');
 expect(calls[0].params[0]).toBe('scheduled-fixture-ordinary');expect(calls[0].params[4]).toEqual({});
});
