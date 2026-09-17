import {test,expect} from 'bun:test';
import {runtimeMarkers,verifyRuntimeMarkers,runtimeCLI} from './markdown-projection-runtime-hosted';
test('hosted inventory requires exactly one of every runtime marker',()=>{
 const rows=runtimeMarkers.map(stage=>({stage,status:'passed'}));
 expect(()=>verifyRuntimeMarkers(rows)).toThrow(); // Legacy single-scenario evidence is insufficient.
 for(const row of rows){expect(()=>verifyRuntimeMarkers(rows.filter(r=>r!==row))).toThrow();expect(()=>verifyRuntimeMarkers([...rows,row])).toThrow();}
});
test('actual CLI default-disabled and missing-config refusal without DB',()=>{
 const idle=runtimeCLI('status');expect((idle as any).parentProof?.reaped).toBe(true);expect((idle as any).parentProof?.members).toEqual([]);expect(idle.exit).toBe(0);expect(JSON.parse(idle.stdout).copyStatus).toBe('not_required');
 const bad=runtimeCLI('drain','/nonexistent/runtime.json');expect(bad.exit).not.toBe(0);
});

test('dual inventory rejects identity collisions and missing independent held/process proof',()=>{
 const rows:any[]=[];
 for(const scenario of ['healthy','unknown-ownership']){
  const identity={scenario,database:`mp_accept_${scenario==='healthy'?'0':'1'}`.padEnd(26,'0'),sourceId:`runtime-${scenario}`,fixtureRoot:`/private/${scenario}`};
  const root=`${identity.fixtureRoot}/output`;
  const inventory=Array.from({length:scenario==='healthy'?14:16},(_,i)=>{
   const runId=`${scenario}-${i}`,argv=['bun','scripts/markdown-projection-runtime.ts','status'];
   const proof={protocol:'disposable-cli-parent-v2',runId,scenario,root,pid:i+1,argv,launched:[i+1],reaped:true,childAccounting:'ECHILD',members:[],sessionMembers:[],exit:0,errors:[]};
   rows.push({...identity,stage:'runtime.process',status:'passed',proof:{...proof,final:true}});
   return {runId,scenario,root,argv,verified:true,proof};
  });
  for(const stage of runtimeMarkers)rows.push({...identity,stage,status:'passed',root:stage==='runtime.cleanup'?'removed':root});
  rows.push({...identity,stage:'runtime.launch-inventory',root,inventory});
  if(scenario==='unknown-ownership')rows.push({...identity,stage:'runtime.held-no-worker',status:'passed',workerAdmissions:0,retained:[{source_id:identity.sourceId,state:'reserved',supervisor_pid:null,supervisor_start:null,released_at:null}]});
 }
 expect(()=>verifyRuntimeMarkers(rows)).not.toThrow();
 for(const stage of [...runtimeMarkers,'runtime.process','runtime.launch-inventory','runtime.held-no-worker']){
  const index=rows.findIndex(r=>r.stage===stage);expect(()=>verifyRuntimeMarkers(rows.filter((_,i)=>i!==index))).toThrow();
  expect(()=>verifyRuntimeMarkers([...rows,rows[index]])).toThrow();
 }
 for(const key of ['database','sourceId','fixtureRoot','root']){const bad=structuredClone(rows),ledgers=bad.filter(r=>r.stage==='runtime.launch-inventory');ledgers[1][key]=ledgers[0][key];expect(()=>verifyRuntimeMarkers(bad)).toThrow();}
});

import {readFileSync} from 'node:fs';
import {PostgresEngine} from '../src/core/postgres-engine';
import {MinionQueue} from '../src/core/minions/queue';
import {LATEST_VERSION} from '../src/core/migrate';
test('scheduled fixture exposes only stored version through real getConfig and queue guard (offline SQL model)',async()=>{
 const fixture=readFileSync(new URL('./markdown-projection-runtime-hosted.ts',import.meta.url),'utf8');
 const policy=/CREATE POLICY mp_runtime_config_version ON public\.config FOR SELECT TO \$\{role\} USING\(key='version'\)/.test(fixture);
 // Model RLS default-deny, not a database execution claim. Real engine method and
 // queue guard execute unchanged; no getConfig/ensureSchema overrides.
 const stored=new Map([['version',String(LATEST_VERSION)],['private-fixture-setting','hidden']]);
 let admitted=false;
 const engine=new PostgresEngine();
 Object.defineProperty(engine,'sql',{get:()=>async(strings:TemplateStringsArray,key:string)=>{
  expect(strings.join('?')).toBe('SELECT value FROM config WHERE key = ?');
  return admitted&&key==='version'?[{value:stored.get(key)}]:[];
 }});
 expect(await engine.getConfig('version')).toBeNull();
 await expect(new MinionQueue(engine).ensureSchema()).rejects.toThrow('schema version 1, need 7');
 admitted=policy;
 expect(await engine.getConfig('version')).toBe(stored.get('version')!);
 expect(await engine.getConfig('private-fixture-setting')).toBeNull();
 await new MinionQueue(engine).ensureSchema();
 stored.set('version','1');
 await expect(new MinionQueue(engine).ensureSchema()).rejects.toThrow('schema version 1, need 7');
});
