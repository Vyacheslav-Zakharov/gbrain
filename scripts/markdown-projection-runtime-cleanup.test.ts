import {test,expect,spyOn} from 'bun:test';
import * as childProcess from 'node:child_process';
import {mkdtemp,writeFile,access,mkdir,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runtimeHosted} from './markdown-projection-runtime-hosted';
import {serializePageToMarkdown} from '../src/core/markdown';

// Adapted from the independent review's actual-caller executable repro.
// Offline transport only: no database, container, or runtime subprocess.
for(const mode of ['primary','combined','cleanup-only','unproven-stop'] as const)test(`runtimeHosted cleanup: ${mode}`,async()=>{
 const base=await mkdtemp(`${process.cwd()}/.runtime-cleanup-test-`);
 const config=`${base}/runtime.json`,root=`${base}/output`;
 await writeFile(config,'offline sentinel',{mode:0o600});
 const env={GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,MARKDOWN_PROJECTION_DISPOSABLE:process.env.MARKDOWN_PROJECTION_DISPOSABLE};
 process.env.GITHUB_ACTIONS='true';process.env.MARKDOWN_PROJECTION_DISPOSABLE='CREATE_AND_DROP_DATABASE';
 const primary=new Error('PRIMARY_SEED_FAILURE'),owned=new Error('DROP_OWNED_FAILURE'),role=new Error('DROP_ROLE_FAILURE');
 const calls:string[]=[],events:any[]=[];
 const page:any={slug:'runtime-page',type:'note',title:'Runtime fixture',compiled_truth:'Protected CLI fixture',timeline:'',frontmatter:{}};
 const bytes=serializePageToMarkdown(page,[]);
 let invocation=0;
 const spawn=spyOn(childProcess,'spawnSync').mockImplementation(((_exe:any,args:string[])=>{
  invocation++;
  if(mode==='unproven-stop')return {error:new Error('timeout'),signal:'SIGKILL',status:null,stdout:'',stderr:''};
  const action=args[1],path=args[3];
  const expected=invocation===1?'idle':invocation<=5?'not_required':invocation===13?'materialized':'idle';
  const refused=invocation>=6&&invocation<=12;
  if(invocation===13)require('node:fs').writeFileSync(`${root}/page.md`,bytes);
  return {status:refused?1:0,signal:null,stdout:refused?'':JSON.stringify({status:'passed',copyStatus:expected,projectionStatus:{pending:'1'},final:true,attempts:[{reaped:true,exitCode:0}]}),stderr:''};
 }) as any);
 const db:any=async(parts:TemplateStringsArray)=>{
  const sql=parts.join('?');calls.push(sql);
  if(sql.includes('INSERT INTO sources')&&(mode==='primary'||mode==='combined'))throw primary;
  if(sql.includes('FROM pg_roles WHERE'))return [];
  if(sql.includes('FROM pg_roles r'))return [{rolsuper:false}];
  if(sql.includes('SELECT * FROM markdown_projection_current'))return [{current_path:'page.md',current_hash:createHash('sha256').update(bytes).digest('hex')}];
  if(sql.includes('SELECT * FROM markdown_projection_obligations'))return [{generation:1,materialized_generation:1,status:'materialized'}];
  return [];
 };
 db.unsafe=async(sql:string)=>{calls.push(sql.replace(/PASSWORD '[^']*'/,'PASSWORD [REDACTED]'));if(sql.startsWith('DROP OWNED'))throw owned;if(sql.startsWith('DROP ROLE')&&mode==='combined'){await rm(config);await mkdir(config);await writeFile(`${config}/block`,'fixture');throw role;}return [];};
 let caught:any;
 try{
  try{await runtimeHosted(db,{putPage:async()=>{},getPage:async()=>page} as any,'mp_accept_0123456789abcdef','192.0.2.1',base,v=>events.push(v));}catch(e){caught=e;}
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught.cleanupErrors.some((e:any)=>e.stage==='role.objects'&&e.error===owned)).toBe(true);
  expect(calls.some(s=>s.startsWith('DROP ROLE'))).toBe(true);
  expect(events.at(-1).status).toBe('failed');
  if(mode==='primary'||mode==='combined'){expect(caught.primaryError).toBe(primary);expect(caught.cause).toBe(primary);}
  if(mode==='combined'){expect(caught.cleanupErrors.map((e:any)=>e.stage)).toEqual(['role.objects','role.login','config']);}
  else expect(await access(config).then(()=>true,()=>false)).toBe(false);
  if(mode==='cleanup-only'){expect(caught.primaryError).toBeUndefined();expect(await access(root).then(()=>true,()=>false)).toBe(false);}
  else expect(await access(root).then(()=>true,()=>false)).toBe(true);
 }finally{spawn.mockRestore();for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(base,{recursive:true,force:true});}
});
