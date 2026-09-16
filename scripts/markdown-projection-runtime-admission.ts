import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,normalize} from 'node:path';
const fail=():never=>{throw Error('admission_failed');};
const exact=(v:any,keys:string[])=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k=>keys.includes(k));
function pathName(p:unknown): asserts p is string {if(typeof p!=='string'||!isAbsolute(p)||normalize(p)!==p||p==='/')fail();}
function protectedPath(p:string,privateDirectory=false){
 if(realpathSync(p)!==p)fail();
 for(let q=p;q!=='/';q=dirname(q)){
  const s=lstatSync(q);
  if(s.isSymbolicLink()||!s.isDirectory()||(s.uid!==0&&s.uid!==process.getuid?.())||(s.mode&0o022)!==0)fail();
  if(q===p&&privateDirectory&&(s.uid!==process.getuid?.()||(s.mode&0o077)!==0))fail();
 }
}
/** No discovery, credentials from argv/env, implicit enablement or fixture overrides. */
export function admitRuntime(request:any){
 if(!exact(request,['admission','action','configPath','supervisionRunId'])||request.admission!=='PROTECTED_RUNTIME_V1'||!['status','drain'].includes(request.action))fail();
 if(Object.keys(process.env).some(k=>k.startsWith('PG')||k==='DATABASE_URL'||k.startsWith('MARKDOWN_PROJECTION_')))fail();
 if(request.configPath===undefined)return undefined;
 pathName(request.configPath); protectedPath(dirname(request.configPath));
 const fd=openSync(request.configPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 let c:any;
 try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>16384)fail();c=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
 if(!exact(c,['version','enabled','connection','worker'])||c.version!==1||typeof c.enabled!=='boolean')fail();
 if(JSON.stringify(c).includes('fixtureFault'))fail();
 if(!c.enabled)return undefined;
 const w=c.worker,b=c.connection;
 if(!exact(w,['sourceId','root','inputRoots','inventoryComplete'])||!exact(b,['host','port','database','username','password','expectedServerAddress','expectedServerPort','tls'])||
 !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(w?.sourceId??'')||w.inventoryComplete!==true||!Array.isArray(w.inputRoots)||!w.inputRoots.every((p:unknown)=>typeof p==='string')||
 typeof b?.host!=='string'||!b.host||typeof b.database!=='string'||!b.database||! /^[A-Za-z_][A-Za-z0-9_]*$/.test(b.username??'')||typeof b.password!=='string'||
 typeof b.expectedServerAddress!=='string'||!Number.isInteger(b.port)||b.port<1||b.port>65535||!Number.isInteger(b.expectedServerPort)||b.expectedServerPort<1||b.expectedServerPort>65535||
 !['verify-full','local-only'].includes(b.tls)||(b.tls==='local-only'&&!['127.0.0.1','::1'].includes(b.host)))fail();
 pathName(w.root);
 // Validate every lexical field before touching any output/input root.
 for(const p of w.inputRoots)pathName(p);
 protectedPath(w.root,true);
 for(const p of w.inputRoots){if(realpathSync(p)!==p||p===w.root||p.startsWith(w.root+'/')||w.root.startsWith(p+'/'))fail();}
 return {connection:b,worker:{enabled:true,sourceId:w.sourceId,root:w.root,inputRoots:w.inputRoots}};
}
