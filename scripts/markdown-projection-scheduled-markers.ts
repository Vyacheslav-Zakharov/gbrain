import assert from 'node:assert/strict';
export const scheduledStages=['scheduled.queue-rls','scheduled.queue-rls-owner-readback','scheduled.complete','scheduled.process.die-delayed','scheduled.process.complete','scheduled.child-delayed','scheduled.child-completed','scheduled.isolated-failure','scheduled.isolated-receipt',...['waiting','delayed','completed'].flatMap(s=>['jobs','attempts','status'].map(k=>`scheduled.${k}.${s}`)),'scheduled.terminal-deleted-held'];
export function verifyScheduledMarkers(rows:any[]){
 const one=(stage:string)=>{const found=rows.filter(r=>r.stage===stage);assert.equal(found.length,1,stage);return found[0];};
 scheduledStages.forEach(one);
 for(const stage of ['scheduled.queue-rls','scheduled.queue-rls-owner-readback'])assert.equal(one(stage).status,'passed');
 const final=one('scheduled.complete');assert.equal(final.status,'passed');
 for(const stage of scheduledStages){const r=one(stage);if(stage==='scheduled.terminal-deleted-held')continue;for(const key of ['database','sourceId','fixtureRoot','scenario'])assert(r[key]&&r[key]===final[key]);}
 const dead=one('scheduled.process.die-delayed').proof,fresh=one('scheduled.process.complete').proof;
 for(const p of [dead,fresh]){assert.equal(p.protocol,'disposable-cli-parent-v2');assert.equal(p.final,true);assert.equal(p.reaped,true);assert.equal(p.childAccounting,'ECHILD');assert.deepEqual(p.errors,[]);assert.deepEqual(p.members,[]);assert.deepEqual(p.sessionMembers,[]);assert(Number.isSafeInteger(p.pid)&&p.pid>0);assert.deepEqual(p.launched,[p.pid]);assert(p.runId);}
 assert.equal(dead.exit,-9);assert.equal(fresh.exit,0);assert.notEqual(dead.pid,fresh.pid);assert.notEqual(dead.runId,fresh.runId);
 assert.equal(one('scheduled.child-delayed').pid,dead.pid);assert.equal(one('scheduled.child-completed').pid,fresh.pid);
 for(const [phase,status] of [['waiting','waiting'],['delayed','delayed'],['completed','completed']]){
  const jobs=one(`scheduled.jobs.${phase}`).rows.filter((j:any)=>j.id===final.jobId);assert.equal(jobs.length,1);assert.equal(jobs[0].status,status);
  assert.equal(one(`scheduled.status.${phase}`).value.ownership.length,0);
 }
 const jobId=(value:unknown)=>{assert((typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)||(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)));return String(value);};
 const baseline=one('scheduled.attempts.waiting').rows;
 assert(baseline.every((a:any)=>jobId(a.job_id)==='0'&&a.released_at&&a.state==='reaped'));
 const priorRuns=new Set(baseline.map((a:any)=>a.run_id));assert.equal(priorRuns.size,baseline.length);
 for(const phase of ['delayed','completed']){
  const all=one(`scheduled.attempts.${phase}`).rows;
  assert.equal(new Set(all.map((a:any)=>a.run_id)).size,all.length);
  assert.deepEqual(all.filter((a:any)=>priorRuns.has(a.run_id)),baseline,'pre-scheduler attempts must remain unchanged');
 }
 assert(Number.isSafeInteger(final.jobId)&&final.jobId>0);
 const attempts=one('scheduled.attempts.completed').rows.filter((a:any)=>!priorRuns.has(a.run_id));
 assert.equal(attempts.length,2);assert(attempts.every((a:any)=>a.released_at&&a.state==='reaped'&&jobId(a.job_id)===String(final.jobId)));assert.notEqual(attempts[0].run_id,attempts[1].run_id);
 for(const [stage,status] of [['scheduled.isolated-failure','failed'],['scheduled.isolated-receipt','passed']]){const r=one(stage).receipt;assert.equal(r.protocol,'markdown-projection-reaping-v1');assert.equal(r.final,true);assert.equal(r.status,status);assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].reaped,true);assert.equal(r.attempts[0].runId,r.runId);assert(attempts.some((a:any)=>a.run_id===r.runId));if(status==='passed')assert.equal(r.attempts[0].exitCode,0);else assert.notEqual(r.attempts[0].exitCode,0);}
 assert.equal(one('scheduled.status.completed').value.obligations[0].pending,'0');
 const held=one('scheduled.terminal-deleted-held');assert.equal(held.scenario,'unknown-ownership');assert.notEqual(held.database,final.database);assert.deepEqual(held.jobs,[]);assert.equal(held.attempts.length,1);assert(Number.isSafeInteger(held.jobId)&&held.jobId>0);assert.equal(jobId(held.attempts[0].job_id),String(held.jobId));assert.equal(held.attempts[0].released_at,null);assert.equal(held.status.ownership.length,1);assert.equal(held.status.ownership[0].run_id,held.attempts[0].run_id);assert.equal(held.status.recovery,'operator_blocked_no_automatic_recovery');
}
