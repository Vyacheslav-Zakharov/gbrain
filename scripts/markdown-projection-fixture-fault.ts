// Only the disposable hosted executable imports this fixture seam. No product hook/config.
export function admitFixtureFault(c:any):{id:string;mode:'backend-loss'|'crash';seam:'before_write'|'after_write';marker:string}|undefined {
 if(c.fixtureFault===undefined)return;
 const f=c.fixtureFault;
 if(c.admission!=='HOSTED_DISPOSABLE_ONLY'||!/^mp_accept_[a-f0-9]+$/.test(c.connection?.database??'')||
 !/^\/tmp\/mp-engine-home-[A-Za-z0-9]+\/projection-[A-Za-z0-9]+$/.test(c.worker?.root??'')||
 !f||f.approval!=='ISOLATED_RECOVERY_FIXTURE_ONLY'||
 !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(f.id??'')||
 !['backend-loss','crash'].includes(f.mode)||!['before_write','after_write'].includes(f.seam)||
 (f.mode==='crash'&&f.seam!=='after_write'))throw Error('fixture_fault_admission');
 return {...f,marker:`${c.worker.root}/.fixture-${f.id}.json`};
}
