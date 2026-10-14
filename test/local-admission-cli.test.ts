import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('configured local admission rejects before main; missing configured guard fails closed',async()=>{
 const home=mkdtempSync(join(tmpdir(),'local-admission-'));
 try{
  mkdirSync(join(home,'.gbrain'));const script=join(home,'guard.py');
  writeFileSync(script,'import sys\nsys.exit(42)\n');
  for(const path of [script,join(home,'missing.py')]){
   writeFileSync(join(home,'.gbrain','config.json'),JSON.stringify({engine:'pglite',local_admission_script:path}));
   const p=Bun.spawn([process.execPath,'src/cli.ts','--version'],{cwd:join(import.meta.dir,'..'),env:{...process.env,HOME:home,GBRAIN_HOME:home,DATABASE_URL:undefined},stdout:'pipe',stderr:'pipe'});
   const [code,out]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
   expect(code).toBe(75);expect(out).toBe('');
  }
 }finally{rmSync(home,{recursive:true,force:true})}
},30000);
