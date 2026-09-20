import {test,expect} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {runIsolated} from './markdown-projection-isolated-caller';

test('actual caller and supervisor launch real worker with stripped PATH',()=>{
 const caller=new URL('./markdown-projection-isolated-caller.ts',import.meta.url).pathname;
 const code=`import {runIsolated} from ${JSON.stringify(caller)};try{runIsolated({});throw Error('unexpected success')}catch(e){if(e.unsafeFilesystemCleanup!==false||!e.receipt?.attempts[0]?.errors.includes('admission_failed'))throw e;console.log('actual worker reached, reaped, DB admission refused')}`;
 const out=execFileSync(process.execPath,['-e',code],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
 expect(out).toContain('actual worker reached, reaped, DB admission refused');
});
for(const binary of ['', 'bun', './bun', '/nonexistent/bun', '/tmp', '/bin/true'])test(`caller rejects invalid executable ${binary}`,()=>{
 expect(()=>runIsolated({},undefined,binary)).toThrow('trusted current Bun executable required');
});
