// Hosted fixture only: owner provisioning is never imported by the runtime.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile,readdir,chmod,rm,realpath,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import type postgres from 'postgres';
import type {PostgresEngine} from '../src/core/postgres-engine';
import {serializePageToMarkdown} from '../src/core/markdown';
export const runtimeMarkers=['runtime.status-readonly','runtime.healthy','runtime.refusal','runtime.cleanup'] as const;
export function verifyRuntimeMarkers(rows:any[]){for(const stage of runtimeMarkers){const found=rows.filter(r=>r.stage===stage);assert.equal(found.length,1,stage);assert.equal(found[0].status,'passed');}}
export function runtimeCLI(action:string,path?:string){
 const child=spawnSync(process.execPath,['scripts/markdown-projection-runtime.ts',action,...(path?['--config',path]:[])],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',PYTHONDONTWRITEBYTECODE:'1'},timeout:30000,killSignal:'SIGKILL',encoding:'utf8',maxBuffer:1024*1024});
 assert(!child.error && !child.signal,'runtime CLI lifetime failed; outer supervisor must clean up');
 return {exit:child.status,output:child.stdout+child.stderr,stdout:child.stdout};
}
export async function runtimeHosted(db:ReturnType<typeof postgres>,engine:PostgresEngine,database:string,address:string,base:string,emit:(v:unknown)=>void){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.MARKDOWN_PROJECTION_DISPOSABLE,'CREATE_AND_DROP_DATABASE');
 assert(/^mp_accept_[0-9a-f]{16}$/.test(database));
 assert.equal(await realpath(base),base);
 for(let p=base;p!=='/';p=dirname(p)){const st=await lstat(p);assert(st.isDirectory()&&!st.isSymbolicLink()&&!(st.mode&0o022));assert(st.uid===0||st.uid===process.getuid?.());}
 const role=`${database}_runtime`,password=`sentinel_${randomBytes(24).toString('hex')}`;
 const root=`${base}/output`,configPath=`${base}/runtime.json`;
 await mkdir(root,{mode:0o700});
 let created=false,completed=false,failed=false,primaryError:unknown;
 const cleanupErrors:{stage:string,error:unknown}[]=[];
 const cleanup=async(stage:string,fn:()=>Promise<unknown>)=>{try{await fn();}catch(error){cleanupErrors.push({stage,error});}};
 try{
 await db.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '${password}'`);created=true;
 // Dedicated source; no production roles, membership, schema ownership or page DML.
 await db`INSERT INTO sources(id,name) VALUES ('runtime-fixture','Runtime fixture')`;
 await db`SELECT markdown_projection_set_policy('runtime-fixture',false)`;
 await db`UPDATE markdown_projection_policy SET root_path=${root} WHERE source_id='runtime-fixture'`;
 await db`SELECT markdown_projection_set_policy('runtime-fixture',true)`;
 await db.unsafe(`GRANT USAGE ON SCHEMA public TO ${role};
 GRANT SELECT ON pages,tags,markdown_projection_policy,markdown_projection_obligations,markdown_projection_identity TO ${role};
 GRANT UPDATE(source_id) ON markdown_projection_policy TO ${role};
 GRANT UPDATE(status,current_path,current_hash,materialized_generation,renderer_version) ON markdown_projection_obligations TO ${role};
 CREATE POLICY mp_runtime_pages ON pages FOR SELECT TO ${role} USING(source_id='runtime-fixture');
 CREATE POLICY mp_runtime_tags ON tags FOR SELECT TO ${role} USING(EXISTS(SELECT 1 FROM pages WHERE id=page_id AND source_id='runtime-fixture'));
 CREATE POLICY mp_runtime_policy ON markdown_projection_policy TO ${role} USING(source_id='runtime-fixture') WITH CHECK(source_id='runtime-fixture');
 CREATE POLICY mp_runtime_obligations ON markdown_projection_obligations TO ${role} USING(source_id='runtime-fixture') WITH CHECK(source_id='runtime-fixture');
 CREATE POLICY mp_runtime_identity ON markdown_projection_identity FOR SELECT TO ${role} USING(EXISTS(SELECT 1 FROM pages WHERE id=page_id AND source_id='runtime-fixture'));`);
 const [rights]=await db`SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
 EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS membership,
 EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) AS owns,
 has_any_column_privilege(r.oid,'pages','INSERT,UPDATE') AS page_columns,
 has_table_privilege(r.oid,'pages','DELETE,TRUNCATE') AS page_delete
 FROM pg_roles r WHERE rolname=${role}`;
 assert(rights);for(const value of Object.values(rights))assert.equal(value,false);
 const indirect=await db`SELECT p.oid::regprocedure::text AS function,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(${role},p.oid,'EXECUTE') ORDER BY 1`;
 emit({stage:'runtime.rights',rights,executableSecurityDefiners:Array.from(indirect),productionAuthorityApproved:false});
 const config={version:1,enabled:true,connection:{host:'127.0.0.1',port:5432,database,username:role,password,expectedServerAddress:address,expectedServerPort:5432,tls:'local-only'},worker:{sourceId:'runtime-fixture',root,inputRoots:[],inventoryComplete:true}};
 const save=async(c:unknown)=>{await writeFile(configPath,JSON.stringify(c),{mode:0o600});await chmod(configPath,0o600);};
 const invoke=(action:string,path?:string,expected?:string)=>{const r=runtimeCLI(action,path);assert(!r.output.includes(password),'credential leak');if(expected){assert.equal(r.exit,0,r.output);const receipt=JSON.parse(r.stdout.trim());assert.equal(receipt.status,'passed');assert.equal(receipt.copyStatus,expected);assert(receipt.final&&receipt.attempts.length===1&&receipt.attempts.every((a:any)=>a.reaped&&a.exitCode===0));return receipt;}assert.notEqual(r.exit,0);};
 const snapshot=async()=>{const tables=['pages','tags','markdown_projection_policy','markdown_projection_obligations','markdown_projection_identity','markdown_projection_current'];const rows=[];for(const table of tables)rows.push(Array.from(await db.unsafe(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`)));return JSON.stringify({rows,catalog:Array.from(await db`SELECT oid,relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid`),files:await Promise.all((await readdir(root)).sort().map(async f=>[f,(await readFile(`${root}/${f}`)).toString('base64')]))});};
 const opts={sourceId:'runtime-fixture'};
 await engine.putPage('runtime-page',{type:'note',title:'Runtime fixture',compiled_truth:'Protected CLI fixture',timeline:'',frontmatter:{}},opts);
 await save(config);const before=await snapshot(),configBefore=await readFile(configPath,'utf8');
 const status=invoke('status',configPath,'idle');assert.equal(status.projectionStatus.pending,'1');
 assert.equal(await snapshot(),before);assert.equal(await readFile(configPath,'utf8'),configBefore);
 for(const action of ['status','drain']){invoke(action,undefined,'not_required');await save({version:1,enabled:false});invoke(action,configPath,'not_required');assert.equal(await snapshot(),before);}
 await save(config);emit({stage:'runtime.status-readonly',status:'passed',statementAuditProven:false});
 for(const mutate of [(c:any)=>{c.worker.sourceId='missing';},(c:any)=>{c.worker.root=base;},(c:any)=>{c.worker.inventoryComplete=false;},(c:any)=>{c.worker.inputRoots=[root];},(c:any)=>{c.connection.expectedServerAddress='192.0.2.1';},(c:any)=>{c.fixtureFault='forbidden';}]){const bad=structuredClone(config);mutate(bad);await save(bad);invoke('status',configPath);assert.equal(await snapshot(),before);}
 await save(config);await chmod(configPath,0o644);invoke('drain',configPath);assert.equal(await snapshot(),before);await save(config);
 emit({stage:'runtime.refusal',status:'passed'});
 invoke('drain',configPath,'materialized');
 const [current]=await db`SELECT * FROM markdown_projection_current WHERE source_id='runtime-fixture'`;assert(current);
 const bytes=await readFile(`${root}/${current.current_path}`,'utf8');assert.equal(createHash('sha256').update(bytes).digest('hex'),current.current_hash);
 assert.equal(bytes,serializePageToMarkdown((await engine.getPage('runtime-page',opts))!,[]));
 const [ledger]=await db`SELECT * FROM markdown_projection_obligations WHERE source_id='runtime-fixture'`;assert.equal(String(ledger.generation),String(ledger.materialized_generation));assert.equal(ledger.status,'materialized');
 invoke('drain',configPath,'idle');emit({stage:'runtime.healthy',status:'passed',ordinaryWriterProven:false,ambiguousCommitProven:false});completed=true;
 }catch(error){failed=true;primaryError=error;}finally{
 // Independent attempts: one failure must not hide others or retain the secret.
 if(created){
 await cleanup('role.objects',async()=>{await db.unsafe(`DROP OWNED BY ${role}`);});
 await cleanup('role.login',async()=>{await db.unsafe(`DROP ROLE ${role}`);});
 await cleanup('role.absence',async()=>{assert.equal((await db`SELECT oid FROM pg_roles WHERE rolname=${role}`).length,0);});
 }
 const absent=async(path:string)=>{try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw new Error('runtime cleanup absence unproven');};
 await cleanup('config',async()=>{await rm(configPath,{force:true});await absent(configPath);});
 // Only the completed scenario proves all child lifecycles safe. Otherwise retain evidence.
 if(completed)await cleanup('root',async()=>{await rm(root,{recursive:true,force:true});await absent(root);});
 await cleanup('receipt',async()=>{emit({stage:'runtime.cleanup',status:cleanupErrors.length?'failed':'passed',root:completed&&!cleanupErrors.some(e=>e.stage==='root')?'removed':'retained',failures:cleanupErrors.map(e=>({stage:e.stage}))});});
 }
 if(cleanupErrors.length)throw Object.assign(new AggregateError([...(failed?[primaryError]:[]),...cleanupErrors.map(e=>e.error)],'runtime hosted cleanup failed',failed?{cause:primaryError}:undefined),{primaryError,cleanupErrors});
 if(failed)throw primaryError;
}
