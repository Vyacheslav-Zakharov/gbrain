import {test,expect} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,copyFileSync,symlinkSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('actual stripped-env caller refuses and reaps without writing source artifacts',()=>{
 const repo=new URL('../',import.meta.url).pathname;
 const root=mkdtempSync(join(tmpdir(),'mp-clean-source-'));
 try {
  mkdirSync(join(root,'scripts'));
  for(const name of ['markdown-projection-isolated-caller.ts','markdown-projection-isolated-supervisor.py','markdown-projection-isolated-worker.ts','markdown-projection-engine-supervisor.py'])copyFileSync(join(repo,'scripts',name),join(root,'scripts',name));
  for(const name of ['node_modules','src'])symlinkSync(join(repo,name),join(root,name),'dir');
  const git=(args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
  git(['init','-q']);git(['add','.']);
  const baseline=git(['status','--porcelain']);
  expect(git(['ls-files','--others','--exclude-standard'])).toBe('');
  const files=readdirSync(join(root,'scripts')).sort();
  const code=`import {runIsolated} from './scripts/markdown-projection-isolated-caller.ts';try{runIsolated({});throw Error('unexpected success')}catch(e){const a=e.receipt?.attempts;if(e.unsafeFilesystemCleanup!==false||a?.length!==1||!a[0].errors.includes('admission_failed')||a[0].reaped!==true||a[0].pid<=0)throw e;try{process.kill(a[0].pid,0);throw Error('child still alive')}catch(p){if(p.code!=='ESRCH')throw p}console.log('actual worker refused; reaped; absent')}`;
  const out=execFileSync(process.execPath,['-e',code],{cwd:root,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
  expect(out).toContain('actual worker refused; reaped; absent');
  expect(git(['status','--porcelain'])).toBe(baseline);
  expect(git(['ls-files','--others','--exclude-standard'])).toBe('');
  expect(readdirSync(join(root,'scripts')).sort()).toEqual(files);
 }finally{rmSync(root,{recursive:true,force:true});}
});
