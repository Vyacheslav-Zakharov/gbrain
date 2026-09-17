import {test,expect} from 'bun:test';
import {scheduledStages,verifyScheduledMarkers} from './markdown-projection-scheduled-markers';
function fixture(){
 const rows:any[]=scheduledStages.map(stage=>({stage,database:'mp_accept_0000000000000000',sourceId:'runtime-healthy',fixtureRoot:'/private/healthy',scenario:'healthy'}));
 const get=(s:string)=>rows.find(r=>r.stage===s);
 for(const stage of ['scheduled.queue-rls','scheduled.queue-rls-owner-readback'])get(stage).status='passed';
 Object.assign(get('scheduled.complete'),{status:'passed',jobId:1});
 for(const [i,mode] of ['die-delayed','complete'].entries()){
  const pid=100+i,runId=`process-${i}`;
  get(`scheduled.process.${mode}`).proof={protocol:'disposable-cli-parent-v2',final:true,reaped:true,childAccounting:'ECHILD',errors:[],members:[],sessionMembers:[],pid,launched:[pid],runId,exit:i===0?-9:0};
  get(`scheduled.child-${i===0?'delayed':'completed'}`).pid=pid;
 }
 for(const phase of ['waiting','delayed','completed']){get(`scheduled.jobs.${phase}`).rows=[{id:1,status:phase==='waiting'?'waiting':phase}];get(`scheduled.attempts.${phase}`).rows=[];get(`scheduled.status.${phase}`).value={ownership:[],obligations:[{pending:'0'}]};}
 get('scheduled.attempts.completed').rows=[0,1].map(i=>({released_at:'now',state:'reaped',job_id:1,run_id:`attempt-${i}`}));
 for(const [i,stage] of ['scheduled.isolated-failure','scheduled.isolated-receipt'].entries())get(stage).receipt={protocol:'markdown-projection-reaping-v1',final:true,status:i===0?'failed':'passed',runId:`attempt-${i}`,attempts:[{reaped:true,runId:`attempt-${i}`,exitCode:i===0?1:0}]};
 Object.assign(get('scheduled.terminal-deleted-held'),{scenario:'unknown-ownership',database:'mp_accept_1111111111111111',jobId:2,jobs:[],attempts:[{job_id:2,run_id:'held',released_at:null}],status:{ownership:[{run_id:'held'}],recovery:'operator_blocked_no_automatic_recovery'}});
 return rows;
}
test('exact scheduled validator rejects missing, duplicated, wrong identity and fictional restart',()=>{
 const rows=fixture();expect(()=>verifyScheduledMarkers(rows)).not.toThrow();
 for(const stage of scheduledStages){expect(()=>verifyScheduledMarkers(rows.filter(r=>r.stage!==stage))).toThrow();expect(()=>verifyScheduledMarkers([...rows,rows.find(r=>r.stage===stage)])).toThrow();}
 for(const mutate of [(r:any[])=>{r.find(r=>r.stage==='scheduled.process.complete').proof.pid=100;},(r:any[])=>{r.find(r=>r.stage==='scheduled.jobs.delayed').database='wrong';},(r:any[])=>{r.find(r=>r.stage==='scheduled.terminal-deleted-held').attempts[0].released_at='released';},(r:any[])=>{r.find(r=>r.stage==='scheduled.isolated-failure').receipt.attempts[0].reaped=false;}]){const bad=fixture();mutate(bad);expect(()=>verifyScheduledMarkers(bad)).toThrow();}
});
