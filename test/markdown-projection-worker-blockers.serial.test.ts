import {test,expect,mock} from 'bun:test';
import * as fs from 'node:fs/promises';
const real={...fs};
let failures=new Set<string>(),events:string[]=[];
let counts=new Map<string,number>();
const errors=new Map<string,Error>();
function hit(point:string){events.push(point);const n=(counts.get(point)??0)+1;counts.set(point,n);if(failures.has(point))throw errors.get(point)!;if(failures.has(point+'#'+n))throw errors.get(point+'#'+n)!;}
mock.module('node:fs/promises',()=>({...real,
 realpath:async(p:any)=>{hit('realpath');return real.realpath(p);},
 lstat:async(p:any)=>{hit('lstat');return real.lstat(p);},
 link:async(a:any,b:any)=>{hit('link');return real.link(a,b);},
 unlink:async(p:any)=>{hit('unlink');return real.unlink(p);},
 open:async(p:any,...args:any[])=>{
  const kind=String(p).includes('.pending-')?'temp':String(p).endsWith('.md')?'installed':'dir';
  hit(kind+'.open');const h=await (real.open as any)(p,...args);
  for(const method of ['writeFile','sync','stat','readFile','close']){
   const original=(h as any)[method].bind(h);
   (h as any)[method]=async(...a:any[])=>{
    // Close the real descriptor even when simulating a close error.
    if(method==='close'){await original(...a);hit(kind+'.'+method);return;}
    if(method==='writeFile'&&failures.has('temp.writeFile'))await original('partial');
    hit(kind+'.'+method);return original(...a);
   };
  }
  return h;
 }
}));
const {drainMarkdownProjectionOnce:drain}=await import('../src/core/markdown-projection-worker');
function reset(points:string[]=[]){events=[];counts.clear();failures=new Set(points);errors.clear();for(const p of points)errors.set(p,Error('injected '+p));}
function fixture(root:string,guard:any={alive:true,enabled:true,source_incarnation:'s',policy_generation:'2',root_path:root}){
 const calls:string[]=[];let ack=0;
 const s={source_id:'default',source_incarnation:'s',incarnation:'p',generation:'3',policy_generation:'2',root_path:root,page:{slug:'notes/a',type:'note',title:'T',compiled_truth:'Body',timeline:'',frontmatter:{}},tags:[]};
 const db={transaction:async(fn:any)=>fn({executeRaw:async(sql:string)=>{calls.push(sql);if(sql.startsWith('SET'))return[];if(sql.includes('FOR UPDATE'))return guard===null?[]:[guard];if(sql.includes('SELECT o.'))return[s];ack++;return[{generation:3}];}})};
 return{config:{enabled:true,sourceId:'default',root,inputRoots:[]},db,calls,get ack(){return ack;}};
}
test('authority absence refuses before filesystem or completion; explicit off is capability free',async()=>{
 for(const guard of [null,{}, {alive:true}]){reset();const f=fixture('/must-not-touch',guard);await expect(drain(f.config,f.db)).rejects.toThrow('missing_projection_guard');expect(events).toEqual([]);expect(f.calls.length).toBe(2);expect(f.ack).toBe(0);}
 for(const guard of [{alive:false,enabled:true},{alive:true,enabled:false}]){reset();const f=fixture('/must-not-touch',guard);expect(await drain(f.config,f.db)).toEqual({status:'not_required'});expect(events).toEqual([]);expect(f.ack).toBe(0);}
 reset();const db={transaction:async()=>{throw Error('DB touched');}} as any;
 expect(await drain(undefined,db)).toEqual({status:'not_required'});expect(await drain({enabled:false} as any,db)).toEqual({status:'not_required'});expect(events).toEqual([]);
});
for(const point of ['realpath','realpath#2','lstat','lstat#2','lstat#3','lstat#4','dir.open','dir.stat','temp.open','temp.writeFile','temp.sync','temp.close','link','unlink','dir.sync','installed.open','installed.stat','installed.readFile','installed.close','dir.close']){
 test('real filesystem boundary '+point,async()=>{
  const root=await real.mkdtemp('/tmp/mp-blockers-');const f=fixture(root);
  try{await real.writeFile(root+'/manual.txt','preserve');
   for(let attempt=0;attempt<3;attempt++){
    reset([point]);let error:any;try{await drain(f.config,f.db);}catch(e){error=e;}
    expect(error).toBe(errors.get(point));
    expect(f.ack).toBe(0);
    expect(await real.readFile(root+'/manual.txt','utf8')).toBe('preserve');
    const pending=(await real.readdir(root)).filter(n=>n.startsWith('.pending-'));
    expect(pending.length).toBe(point==='unlink'?attempt+1:0);
    if(events.includes('temp.close')&&events.includes('unlink'))expect(events.indexOf('temp.close')).toBeLessThan(events.indexOf('unlink'));
    if(events.includes('unlink'))expect(events.indexOf('unlink')).toBeLessThan(events.indexOf('dir.close'));
   }
  }finally{reset();await real.rm(root,{recursive:true,force:true});}
 });
}
for(const primary of ['temp.writeFile','temp.sync','link','installed.readFile'])test('primary survives cleanup errors '+primary,async()=>{
 const root=await real.mkdtemp('/tmp/mp-blockers-');const f=fixture(root);
 try{reset([primary,'temp.close','unlink','installed.close','dir.close'].filter(p=>primary!=='link'&&primary!=='installed.readFile'||p!=='temp.close').filter(p=>primary!=='installed.readFile'||p!=='unlink'));
  let error:any;try{await drain(f.config,f.db);}catch(e){error=e;}
  expect(error).toBe(errors.get(primary));expect(error.cleanupErrors.length).toBeGreaterThan(0);expect(error.cleanupErrors).toContain(errors.get('dir.close'));expect(f.ack).toBe(0);
  for(const secondary of failures)if(secondary!==primary&&events.includes(secondary))expect(error.cleanupErrors).toContain(errors.get(secondary));
 }finally{reset();await real.rm(root,{recursive:true,force:true});}
});
test('conflicting immutable destination is never removed on retries',async()=>{
 const root=await real.mkdtemp('/tmp/mp-blockers-');const f=fixture(root);
 try{reset();await drain(f.config,f.db,async p=>{if(p==='after_write')throw Error('stop');}).catch(()=>{});
 const path=(await real.readdir(root)).find(n=>n.endsWith('.md'))!;await real.writeFile(root+'/'+path,'conflict');
 for(let i=0;i<3;i++){reset();await expect(drain(f.config,f.db)).rejects.toThrow('payload_conflict');expect(await real.readFile(root+'/'+path,'utf8')).toBe('conflict');expect(await real.readdir(root)).toEqual([path]);expect(f.ack).toBe(0);}
 }finally{reset();await real.rm(root,{recursive:true,force:true});}
});
