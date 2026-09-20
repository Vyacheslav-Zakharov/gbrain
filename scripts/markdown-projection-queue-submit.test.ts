import {test,expect} from 'bun:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MinionQueue} from '../src/core/minions/queue';

const fixture=readFileSync(new URL('./markdown-projection-scheduled-hosted.ts',import.meta.url),'utf8');
const start=fixture.indexOf('  const denied=');
const end=fixture.indexOf('  const probe=',start);
assert(start>=0&&end>start);
const transpiler=new Bun.Transpiler({loader:'ts'});
const runNegativeFixture=new Function('queue','assert','source',transpiler.transformSync(`return (async()=>{${fixture.slice(start,end)}})()`));

for(const synchronous of [true,false])test(`actual fixture reaches SQL through trusted fourth arg; transport sync=${synchronous}`,async()=>{
 const calls:{sql:string,params:unknown[]}[]=[];
 const refusal=Object.assign(new Error('fixture simulated row-level security refusal'),{code:'42501'});
 const engine:any={getConfig:async()=> '140',transaction:async(fn:any)=>fn(engine),executeRaw:(sql:string,params:unknown[])=>{
  calls.push({sql,params});
  if(synchronous)throw refusal;
  return Promise.reject(refusal);
 }};
 await runNegativeFixture(new MinionQueue(engine),assert,'fixture-source');
 expect(calls).toHaveLength(3);
 expect(calls.map(c=>[c.params[0],c.params[4]])).toEqual([
  ['markdown-projection-tick',{sourceId:'fixture-source-wrong'}],
  ['scheduled-fixture-wrong',{sourceId:'fixture-source'}],
  ['scheduled-fixture-ordinary',{sourceId:'fixture-source-wrong'}],
 ]);
 for(const call of calls){expect(call.sql).toContain('INSERT INTO minion_jobs');expect(call.sql).toContain('RETURNING *');}
});

test('real protected submit guard rejects before schema or SQL, including trust hidden in opts',async()=>{
 let accesses=0;
 const engine:any={getConfig:()=>{accesses++;throw Error('unexpected schema access');},executeRaw:()=>{accesses++;throw Error('unexpected SQL');}};
 const queue=new MinionQueue(engine);
 for(const name of ['markdown-projection-tick',' markdown-projection-tick ']){
  await assert.rejects(Promise.resolve().then(()=>queue.add(name,{sourceId:'fixture-source'})),/protected job name/);
  await assert.rejects(Promise.resolve().then(()=>queue.add(name,{}, {allowProtectedSubmit:true} as any)),/protected job name/);
 }
 expect(accesses).toBe(0);
});

test('fixture denial assertion normalizes synchronous throws and async rejections without accepting guard errors',async()=>{
 const declaration=fixture.slice(start,fixture.indexOf('\n',start));
 const run=new Function('assert','operation',transpiler.transformSync(`return (async()=>{${declaration};await denied(operation);})()`));
 const error=Object.assign(new Error('fixture simulated row-level security refusal'),{code:'42501'});
 await run(assert,()=>{throw error;});
 await run(assert,()=>Promise.reject(error));
 await assert.rejects(run(assert,()=>Promise.reject(new Error('protected job name'))),{code:'ERR_ASSERTION'});
});
