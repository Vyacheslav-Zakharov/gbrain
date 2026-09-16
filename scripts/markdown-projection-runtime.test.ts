import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const cli=new URL('./markdown-projection-runtime.ts',import.meta.url).pathname;
const child=new URL('./markdown-projection-runtime-worker.ts',import.meta.url).pathname;
function run(args:string[],input?:object){return spawnSync(process.execPath,args,{input:input?JSON.stringify(input):undefined,encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});}
test('actual supervised runtime defaults disabled for status and drain',()=>{
 for(const action of ['status','drain']){const r=run([cli,action]);expect(r.status).toBe(0);const receipt=JSON.parse(r.stdout);expect(receipt.copyStatus).toBe('not_required');expect(receipt.attempts[0].reaped).toBe(true);}
});
test('private disabled file unchanged; missing, public, malformed and fixture configuration refuse',()=>{
 const home=mkdtempSync(join(homedir(),'.mp-runtime-test-'));chmodSync(home,0o700);
 const configPath=join(home,'config.json');
 try{
  const bytes=JSON.stringify({version:1,enabled:false});writeFileSync(configPath,bytes,{mode:0o600});
  for(const action of ['status','drain'])expect(run([cli,action,'--config',configPath]).status).toBe(0);
  expect(readFileSync(configPath,'utf8')).toBe(bytes);expect(readdirSync(home)).toEqual(['config.json']);
  expect(run([cli,'drain','--config',join(home,'missing')]).status).toBe(1);
  chmodSync(configPath,0o644);expect(run([cli,'status','--config',configPath]).status).toBe(1);chmodSync(configPath,0o600);
  for(const data of [{version:1,enabled:false,fixtureFault:{}},{version:1,enabled:true,worker:{root:'/must-not-touch'}}]){
   writeFileSync(configPath,JSON.stringify(data));const r=run([child],{admission:'PROTECTED_RUNTIME_V1',action:'drain',configPath});expect(r.status).toBe(1);expect(r.stderr).toContain('admission_failed');
  }
  for(const hook of ['fixtureFault','connection','worker','command']){
   const r=run([child],{admission:'PROTECTED_RUNTIME_V1',action:'status',[hook]:{}});expect(r.status).toBe(1);expect(r.stderr).toContain('admission_failed');
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('status uses read-only transaction; no install, enrollment or fixture import in runtime',()=>{
 const source=readFileSync(child,'utf8');expect(source).toContain("sql.begin('READ ONLY'");
 for(const forbidden of ['initSchema','applyMigration','admitFixtureFault','PostgresEngine','CREATE TABLE','INSERT INTO'])expect(source).not.toContain(forbidden);
});
