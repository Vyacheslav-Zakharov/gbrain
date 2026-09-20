import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {runIsolated,removeHostedHome} from './markdown-projection-isolated-caller';
test('actual CLI failure without trusted reaping retains root and manual bytes',async()=>{
 for(const output of ['', 'not json', JSON.stringify({status:'failed',attempts:[{pid:123,reaped:false}]})]) {
  const home=await mkdtemp('/tmp/mp-containment-');await writeFile(`${home}/manual`,'manual');
  let failure:any;
  try{runIsolated({},['python3','-c',`print(${JSON.stringify(output)});raise SystemExit(1)`]);}catch(e){failure=e;}
  try{expect(failure?.unsafeFilesystemCleanup).toBe(true);await expect(removeHostedHome(home,failure)).rejects.toThrow('filesystem cleanup refused');expect(await readFile(`${home}/manual`,'utf8')).toBe('manual');}
  finally{await rm(home,{recursive:true,force:true});}
 }
});
