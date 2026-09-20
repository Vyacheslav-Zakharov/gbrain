import {constants} from 'node:fs';
import {open,realpath,lstat,link,unlink} from 'node:fs/promises';
import {isAbsolute,normalize,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {serializePageToMarkdown} from './markdown';

export interface ProjectionWorkerConfig {enabled:boolean;sourceId:string;root:string;inputRoots:string[]}
/** Matches the real Engine transaction/executeRaw contract, not a reserved postgres pool. */
export interface ProjectionWorkerDB {
 transaction<T>(fn:(tx:{executeRaw<T=any>(sql:string,params?:unknown[]):Promise<T[]>})=>Promise<T>):Promise<T>;
}
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
// Keep the original rejection; cleanup failures are additional diagnostics.
async function withCleanup<T>(body:()=>Promise<T>,cleanup:()=>Promise<void>):Promise<T>{
 let failed=false,primary:unknown;
 try{return await body();}catch(e){failed=true;primary=e;throw e;}
 finally{try{await cleanup();}catch(e){
  if(!failed)throw e;
  try{((primary as any).cleanupErrors??=[]).push(e);}
  catch{console.error('markdown_projection_cleanup_failed',e);}
 }}
}
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
/** Development-only one-shot. No enrollment, scheduling, tombstone cleanup or aliases. */
export async function drainMarkdownProjectionOnce(config:ProjectionWorkerConfig|undefined,db:ProjectionWorkerDB,
 fault?:(point:'before_write'|'after_write'|'before_ack')=>Promise<void>) {
 if(!config?.enabled)return {status:'not_required'};
 const {sourceId,root,inputRoots}=config;
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sourceId))throw Error('source_scope');
 return db.transaction(async tx=>{
  await tx.executeRaw("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  const [guard]=await tx.executeRaw<any>('SELECT * FROM public.markdown_projection_policy WHERE source_id=$1 FOR UPDATE',[sourceId]);
  if(!guard||typeof guard.alive!=='boolean'||typeof guard.enabled!=='boolean')throw Error('missing_projection_guard');
  if(!guard.alive||!guard.enabled)return {status:'not_required'};
  if(guard.root_path!==root)throw Error('wrong_root');
  const [s]=await tx.executeRaw<any>(`SELECT o.*,g.source_incarnation,g.root_path,row_to_json(p) AS page,
   ARRAY(SELECT tag FROM public.tags WHERE page_id=p.id ORDER BY tag) AS tags
   FROM public.markdown_projection_obligations o JOIN public.markdown_projection_policy g USING(source_id)
   JOIN public.markdown_projection_identity i ON i.incarnation=o.incarnation AND i.page_id=o.page_id
   JOIN public.pages p ON p.id=o.page_id AND p.source_id=o.source_id
   WHERE o.source_id=$1 AND o.status='pending' AND o.operation='upsert'
   AND o.policy_generation=g.policy_generation AND p.deleted_at IS NULL AND p.page_kind='markdown'
   ORDER BY o.generation LIMIT 1`,[sourceId]);
  if(!s)return {status:'idle'};
  if(s.source_id!==sourceId||s.source_incarnation!==guard.source_incarnation||String(s.policy_generation)!==String(guard.policy_generation)||s.root_path!==root)throw Error('stale_snapshot');
  if(!s.page.slug.split('/').every((v:string)=>/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v)))throw Error('unsafe_article_path');
  if(!isAbsolute(root)||normalize(root)!==root||root==='/'||await realpath(root)!==root)throw Error('unsafe_root');
  for(const input of inputRoots){const p=await realpath(input);if(p===root||p.startsWith(root+'/')||root.startsWith(p+'/'))throw Error('input_root_overlap');}
  // Protected ancestors; /tmp sticky root is permitted for disposable fixtures.
  for(let p=root;p!=='/';p=dirname(p)){const st=await lstat(p);if(!st.isDirectory()||st.isSymbolicLink()||((st.mode&0o022)!==0 && !(st.uid===0&&(st.mode&0o1000))))throw Error('unprotected_root');}
  const dir=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  let dirClosed=false;
  return withCleanup(async()=>{
   const st=await dir.stat();const named=await lstat(root);
   if(st.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.ino!==named.ino||st.dev!==named.dev)throw Error('root_identity');
   // Linux descriptor-relative anchor: pathname replacement cannot redirect writes.
   const anchor=`/proc/self/fd/${dir.fd}`;
   const bytes=serializePageToMarkdown({...s.page,frontmatter:stable(s.page.frontmatter)},[...new Set<string>(s.tags)].sort());
   const digest=hash(bytes);
   const identity=hash(JSON.stringify([sourceId,s.source_incarnation,s.incarnation,String(s.policy_generation),String(s.generation)]));
   const path=`${identity}-${digest}.md`;
   await fault?.('before_write');
   const temp=`${anchor}/.pending-${randomUUID()}`;
   const f=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   await withCleanup(async()=>{
    await withCleanup(async()=>{await f.writeFile(bytes);await f.sync();},()=>f.close());
    try{await link(temp,`${anchor}/${path}`);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   },()=>unlink(temp));
   await dir.sync();
   const installed=await open(`${anchor}/${path}`,constants.O_RDONLY|constants.O_NOFOLLOW);
   await withCleanup(async()=>{const stat=await installed.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==st.uid||hash(await installed.readFile())!==digest)throw Error('payload_conflict');},()=>installed.close());
   await fault?.('after_write');
   const now=await lstat(root);if(now.ino!==st.ino||now.dev!==st.dev||await realpath(root)!==root)throw Error('root_drift');
   // No acknowledgement until every owned filesystem resource has closed.
   // Never retry close: a failed close may already have released its descriptor.
   dirClosed=true;await dir.close();
   await fault?.('before_ack');
   const rows=await tx.executeRaw<any>(`UPDATE public.markdown_projection_obligations o SET status='materialized',
    current_path=$6,current_hash=$7,materialized_generation=generation,renderer_version='canonical-v1'
    FROM public.markdown_projection_policy g WHERE o.source_id=$1 AND o.incarnation=$2
    AND o.generation=$3 AND o.policy_generation=$4 AND o.status='pending' AND o.operation='upsert'
    AND g.source_id=o.source_id AND g.enabled AND g.alive AND g.source_incarnation=$5
    AND g.policy_generation=o.policy_generation AND g.root_path=$8 RETURNING o.generation`,
    [sourceId,s.incarnation,s.generation,s.policy_generation,s.source_incarnation,path,digest,root]);
   if(rows.length!==1)throw Error('stale_ack');
   return {status:'materialized',path,hash:digest};
  },async()=>{if(!dirClosed){dirClosed=true;await dir.close();}});
 });
}
