import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {runIsolated,removeHostedHome} from './markdown-projection-isolated-caller';
const cases: [string,string][] = [
 ['null attempt',"r['attempts']=[None]"], ['scalar attempt',"r['attempts']=[1]"],
 ['array attempt',"r['attempts']=[[]]"], ['missing fields',"r['attempts']=[{}]"],
 ['null receipt',"r=None"], ['scalar receipt',"r=3"],
 ['null attempts',"r['attempts']=None"], ['empty attempts',"r['attempts']=[]"],
 ['wrong run',"r['runId']='wrong'"], ['wrong attempt run',"r['attempts'][0]['runId']='wrong'"],
 ['wrong order',"r['attempts'][0]['attempt']=2"], ['string attempt',"r['attempts'][0]['attempt']='1'"],
 ['zero PID',"r['attempts'][0]['pid']=0"], ['negative PID',"r['attempts'][0]['pid']=-1"],
 ['fractional PID',"r['attempts'][0]['pid']=1.5"], ['string PID',"r['attempts'][0]['pid']='123'"],
 ['unsafe PID',"r['attempts'][0]['pid']=9007199254740992"], ['missing PID',"del r['attempts'][0]['pid']"],
 ['wrong final',"r['final']=False"], ['wrong protocol',"r['protocol']='wrong'"],
 ['missing status',"del r['status']"], ['contradictory passed',"r['status']='passed';r['copyStatus']='idle'"],
 ['contradictory failed',"r['attempts'][0].update(exitCode=0,errors=[])"],
 ['failed copy status',"r['copyStatus']='idle'"], ['unknown status',"r['status']='unknown'"],
 ['null errors',"r['attempts'][0]['errors']=None"], ['null error',"r['attempts'][0]['errors']=[None]"],
 ['unknown error',"r['attempts'][0]['errors']=['unknown']"], ['unreaped',"r['attempts'][0]['reaped']=False"],
 ['string reaped',"r['attempts'][0]['reaped']='true'"], ['null exit',"r['attempts'][0]['exitCode']=None"],
 ['fractional exit',"r['attempts'][0]['exitCode']=1.5"], ['duplicate attempt',"r['attempts']*=2"],
 ['duplicate PID',"r['attempts'].append(dict(r['attempts'][0],attempt=2))"],
 ['retry after success',"r['attempts'].append(dict(r['attempts'][0],attempt=2,pid=124));r['attempts'][0].update(exitCode=0,errors=[])"],
 ['duplicate receipt',"print(json.dumps(r))"],
 ['missing exit diagnostic',"r['attempts'][0]['errors']=['worker_failed']"],
];
function command(home:string,mutation:string,exit=1){return ['python3','-c',`import sys,json
c=json.load(sys.stdin)
with open(${JSON.stringify(`${home}/calls`)},'a') as f: f.write('1')
r={'protocol':'markdown-projection-reaping-v1','final':True,'runId':c['supervisionRunId'],'status':'failed','attempts':[{'attempt':1,'runId':c['supervisionRunId'],'pid':123,'reaped':True,'exitCode':1,'errors':['child_exit_failure','missing_unique_completion']}]}
${mutation}
print(json.dumps(r))
print('fixture diagnostic',file=sys.stderr)
sys.exit(${exit})`];}
for(const field of ['protocol','runId','final','status','attempts'])cases.push([`missing envelope ${field}`,`del r['${field}']`]);
for(const field of ['attempt','runId','pid','reaped','exitCode','errors'])cases.push([`missing attempt ${field}`,`del r['attempts'][0]['${field}']`]);
for(const [name,mutation] of cases)test(`matching-envelope fail closed: ${name}`,async()=>{
 const home=await mkdtemp('/tmp/mp-invalid-');await writeFile(`${home}/manual`,'manual sentinel');
 let failure:any;try{runIsolated({},command(home,mutation));}catch(e){failure=e;}
 try{
  expect(failure?.unsafeFilesystemCleanup).toBe(true);
  expect(failure.primaryError).toBeInstanceOf(Error);expect(failure.cause).toBe(failure.primaryError);
  expect(failure.primaryError.status).toBe(1);expect(String(failure.primaryError.stderr)).toContain('fixture diagnostic');
  expect(failure.cleanupErrors).toContain('process stop unverified');expect(failure.validationError).toBeInstanceOf(Error);
  await expect(removeHostedHome(home,failure)).rejects.toThrow('filesystem cleanup refused');
  expect(await readFile(`${home}/manual`,'utf8')).toBe('manual sentinel');expect(await readFile(`${home}/calls`,'utf8')).toBe('1');
 }finally{await rm(home,{recursive:true,force:true});}
});
test('zero CLI exit with malformed receipt still retains manual root',async()=>{
 const home=await mkdtemp('/tmp/mp-zero-invalid-');await writeFile(`${home}/manual`,'manual sentinel');let failure:any;
 try{runIsolated({},command(home,"r['attempts']=[None]",0));}catch(e){failure=e;}
 try{expect(failure.unsafeFilesystemCleanup).toBe(true);expect(failure.primaryError).toBeUndefined();expect(failure.cause).toBe(failure.validationError);await expect(removeHostedHome(home,failure)).rejects.toThrow();expect(await readFile(`${home}/manual`,'utf8')).toBe('manual sentinel');}
 finally{await rm(home,{recursive:true,force:true});}
});
test('actual supervisor reaped failed child permits cleanup',async()=>{
 const home=await mkdtemp('/tmp/mp-real-failed-');let failure:any;
 const supervisor=new URL('./markdown-projection-isolated-supervisor.py',import.meta.url).pathname;
 const python=`import importlib.util,sys\ns=importlib.util.spec_from_file_location('m',${JSON.stringify(supervisor)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\noriginal=m.run\nm.run=lambda command,config:original([sys.executable,'-c','raise SystemExit(1)'],config,seconds=.5)\nsys.exit(m.main())`;
 try{runIsolated({},['python3','-B','-c',python]);}catch(e){failure=e;}
 try{expect(failure.unsafeFilesystemCleanup).toBe(false);expect(failure.cause).toBe(failure.primaryError);expect(failure.receipt.attempts[0].reaped).toBe(true);await removeHostedHome(home,failure);await expect(access(home)).rejects.toThrow();}
 finally{await rm(home,{recursive:true,force:true});}
});
test('valid reaped failure preserves subprocess identity and permits cleanup',async()=>{
 const home=await mkdtemp('/tmp/mp-valid-failed-');let failure:any;
 try{runIsolated({},command(home,''));}catch(e){failure=e;}
 try{expect(failure.unsafeFilesystemCleanup).toBe(false);expect(failure.cause).toBe(failure.primaryError);expect(failure.primaryError.status).toBe(1);await removeHostedHome(home,failure);await expect(access(home)).rejects.toThrow();}
 finally{await rm(home,{recursive:true,force:true});}
});
