import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile,readdir,writeFile,symlink,mkdir} from 'node:fs/promises';
import * as worker from '../src/core/markdown-projection-worker';

test('one-shot caller commits only readback-verified immutable canonical bytes',async()=>{
 expect(typeof worker.drainMarkdownProjectionOnce).toBe('function');
 const root=await mkdtemp('/tmp/mp-worker-');
 const snapshot={source_id:'default',source_incarnation:'source1',incarnation:'page1',generation:'3',policy_generation:'2',root_path:root,page:{id:1,slug:'notes/a',source_id:'default',page_kind:'markdown',title:'Example',type:'note',compiled_truth:'Body',timeline:'History',frontmatter:{z:1,a:{z:2,a:1}}},tags:['z','a']};
 let current:any=null; let pending=true;
 const calls:string[]=[];
 const db={transaction:async(fn:any)=>{let next=current;const out=await fn({executeRaw:async(sql:string,args:any[])=>{calls.push(sql);if(sql.startsWith('SET TRANSACTION'))return[];if(sql.includes('FOR UPDATE'))return[{alive:true,enabled:true,source_incarnation:'source1',policy_generation:'2',root_path:root}];if(sql.includes('SELECT o.'))return pending?[snapshot]:[];if(sql.includes('UPDATE public.markdown_projection_obligations')){next={path:args[5],hash:args[6]};return[{generation:'3'}];}throw Error(sql);}}); current=next;pending=false;return out;}};
 try{const result=await worker.drainMarkdownProjectionOnce({enabled:true,sourceId:'default',root,inputRoots:[]},db as any);expect(result.status).toBe('materialized');expect(current).not.toBeNull();const bytes=await readFile(root+'/'+current.path,'utf8');expect(bytes).toContain('Body');expect(bytes).toContain('History');expect(bytes).toContain('Example');expect(await readdir(root)).toEqual([current.path]);expect(calls.length).toBe(4);}finally{await rm(root,{recursive:true,force:true});}
 });

test('disabled is capability-free',async()=>{
 const db={transaction:()=>{throw Error('DB touched');}};
 expect(await worker.drainMarkdownProjectionOnce(undefined,db as any)).toEqual({status:'not_required'});
 expect(await worker.drainMarkdownProjectionOnce({enabled:false} as any,db as any)).toEqual({status:'not_required'});
});

for(const point of ['before_write','after_write','before_ack','lost_connection','wrong_root','symlink','escape','conflict'] as const){
 test(`caller fail closed and retry: ${point}`,async()=>{
 const root=await mkdtemp('/tmp/mp-worker-');let pending=true;let committed:any=null;let fail=true;
 const s:any={source_id:'default',source_incarnation:'s',incarnation:'p',generation:'3',policy_generation:'2',root_path:root,page:{id:1,slug:'notes/a',source_id:'default',page_kind:'markdown',title:'T',type:'note',compiled_truth:'Body',timeline:'Time',frontmatter:{}},tags:[]};
 const db={transaction:async(fn:any)=>{let next:any=null;const out=await fn({executeRaw:async(sql:string,a:any[])=>{
 if(sql.startsWith('SET TRANSACTION'))return[];
 if(sql.includes('FOR UPDATE'))return[{alive:true,enabled:true,source_incarnation:'s',policy_generation:'2',root_path:root}];
 if(sql.includes('SELECT o.'))return pending?[s]:[];
 if(sql.includes('UPDATE public.')){if(fail&&point==='lost_connection')throw Error('connection_lost');next={path:a[5],hash:a[6]};return[{generation:3}];}
 throw Error(sql);}});committed=next;pending=false;return out;}};
 const config:any={enabled:true,sourceId:'default',root,inputRoots:[]};
 try{
 await writeFile(root+'/manual.txt','preserve');await writeFile(root+'/original.pdf','original');
 if(point==='wrong_root')config.root=root+'/other';
 if(point==='escape')s.page.slug='../escape';
 if(point==='symlink'){await symlink(root,root+'-link');config.root=root+'-link';}
 const fault=async(p:string)=>{if(!fail)return;if(p===point)throw Error(point);
 if(point==='conflict'&&p==='before_ack') {const names=await readdir(root);await writeFile(root+'/'+names.find(n=>n.endsWith('.md')),'conflicting');throw Error('injected_conflict');}};
 await expect(worker.drainMarkdownProjectionOnce(config,db as any,fault)).rejects.toThrow();
 expect(pending).toBe(true);expect(committed).toBeNull();
 expect(await readFile(root+'/manual.txt','utf8')).toBe('preserve');expect(await readFile(root+'/original.pdf','utf8')).toBe('original');
 fail=false;config.root=root;s.page.slug='notes/a';
 if(point==='conflict')await expect(worker.drainMarkdownProjectionOnce(config,db as any)).rejects.toThrow('payload_conflict');
 else {expect((await worker.drainMarkdownProjectionOnce(config,db as any)).status).toBe('materialized');expect((await readdir(root)).filter(n=>n.endsWith('.md')).length).toBe(1);}
 }finally{await rm(root,{recursive:true,force:true});await rm(root+'-link',{force:true});}
 });
}
