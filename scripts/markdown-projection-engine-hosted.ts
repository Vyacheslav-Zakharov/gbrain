// Hosted-only, deliberately NOT in default test discovery. Assertions authored before SQL.
// Run only on a disposable hosted pgvector service; creates/drops its OWN database.
import postgres from 'postgres';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {runIsolated,removeHostedHome,hostedWorkerMode} from './markdown-projection-isolated-caller';
const workerMode=hostedWorkerMode(process.env.MARKDOWN_PROJECTION_WORKER_MODE);

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'hosted Actions only');
assert.equal(process.env.MARKDOWN_PROJECTION_DISPOSABLE, 'CREATE_AND_DROP_DATABASE');
assert(process.env.MARKDOWN_PROJECTION_ADMIN_URL, 'dedicated hosted admin URL required');
assert(!process.env.DATABASE_URL, 'refuse inherited application DATABASE_URL');
assert(!Object.keys(process.env).some(key => key.startsWith('PG')), 'refuse inherited PostgreSQL environment options');
const rawUrl = process.env.MARKDOWN_PROJECTION_ADMIN_URL!;
// Require a single canonical TCP endpoint; never pass URL options to postgres.js.
assert(!/[?#\s\\]/.test(rawUrl), 'URL query/hash/options/whitespace forbidden');
assert(/^postgres(?:ql)?:\/\/[A-Za-z_][A-Za-z0-9_]*(?::[^@/?#]*)?@(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}\/[A-Za-z_][A-Za-z0-9_]*$/.test(rawUrl), 'ambiguous hosted endpoint');
const url = new URL(rawUrl);
assert(Number(url.port) <= 65535, 'invalid port');
// Independently captured by hosted docker inspect, never inferred from this connection.
const expectedServiceIP = process.env.MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP;
assert(expectedServiceIP && isIP(expectedServiceIP) === 4, 'exact expected service IP required');
// Explicit fields prevent PG* environment defaults and URL startup overrides.
const connectionArgs = (database: string, username = url.username, secret = decodeURIComponent(url.password)) => ({
  host: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/[\[\]]/g, ''),
  port: Number(url.port), database, username, password: secret,
  ssl: false as const, max: 1, connect_timeout: 5,
  connection: { statement_timeout: 5000, lock_timeout: 1500, idle_in_transaction_session_timeout: 10000, search_path: 'public' },
});
async function verifyTarget(client: ReturnType<typeof postgres>, database: string, user: string) {
  const [target] = await client`SELECT current_database() AS database, session_user AS username, host(inet_server_addr()) AS address, inet_server_port() AS port`;
  assert.equal(target.database, database, 'wrong database');
  assert.equal(target.username, user, 'wrong session user');
  assert.equal(target.address, expectedServiceIP, 'wrong server address');
  assert.equal(Number(target.port), 5432, 'wrong server port');
}
// Service-owner compatibility, NOT application-auth or nonowner RLS proof.
const { readlink, mkdtemp, rm } = await import('node:fs/promises');
const { execFileSync } = await import('node:child_process');
const { admitNamespace, assertMigration } = await import('./markdown-projection-engine-admission.ts');
const { LATEST_VERSION } = await import('../src/core/migrate.ts');
const ip = (...args:string[]) => JSON.parse(execFileSync('ip',['-j',...args],{timeout:2000,encoding:'utf8',maxBuffer:1024*1024}));
const confinement = admitNamespace(ip('link','show'),ip('-4','route','show','table','all'),ip('-6','route','show','table','all'),await readFile('/proc/self/status','utf8'),await readlink('/proc/self/ns/net'),process.env.MARKDOWN_PROJECTION_HOST_NETNS ?? '',process.env.MARKDOWN_PROJECTION_RUNNER_UID ?? '',process.env.MARKDOWN_PROJECTION_RUNNER_GID ?? '');
console.log(JSON.stringify({stage:'namespace.admission',confinement}));
assert.equal(process.env.GBRAIN_DISABLE_DIRECT_POOL, '1');
assert(!process.env.GBRAIN_DIRECT_DATABASE_URL);
assert(!Object.keys(process.env).some(k => /API_KEY|TOKEN|SECRET|PROVIDER/.test(k)), 'provider credentials forbidden');
const home = await mkdtemp('/tmp/mp-engine-home-');
process.env.HOME = home; process.env.GBRAIN_HOME = home;
process.env.GBRAIN_STATEMENT_TIMEOUT = '15000';
process.env.GBRAIN_IDLE_TX_TIMEOUT = '15000';
const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
const name = `mp_accept_${randomBytes(8).toString('hex')}`;
const admin = postgres(connectionArgs(url.pathname.slice(1)));
let observer: ReturnType<typeof postgres> | undefined;
const engine = new PostgresEngine();
let created = false, failure: unknown, failed = false;
let stage = 'admission';
const emit = (value: unknown) => console.log(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const enter = (s: string) => { stage=s; emit({stage:s,status:'started'}); };
try {
  await verifyTarget(admin, url.pathname.slice(1), url.username);
  await admin.unsafe(`CREATE DATABASE ${name}`); created=true;
  observer=postgres(connectionArgs(name));
  await verifyTarget(observer,name,url.username);
  const target = new URL(rawUrl); target.pathname=`/${name}`;
  await engine.connect({engine:'postgres', database_url:target.href,poolSize:1});
  const [identity] = await engine.executeRaw<any>(`SELECT current_database() AS database,session_user,current_user,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('search_path') AS search_path,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE rolname=current_user`);
  assert.equal(identity.database,name); assert.equal(identity.session_user,url.username);
  assert.equal(identity.current_user,url.username); assert.equal(identity.address,expectedServiceIP); assert.equal(identity.port,5432);
  // v35 creates an event trigger and explicitly requires BYPASSRLS.
  assert.equal(identity.rolsuper,true); assert.equal(identity.rolbypassrls,true);
  await engine.executeRaw(`SET search_path TO public`);
  await engine.executeRaw(`SET lock_timeout TO '1500ms'`);
  emit({stage:'service.identity',identity,applicationAuthProven:false});
  enter('real.initSchema'); await engine.initSchema();
  const inventory = async (phase: string) => {
    const events=await engine.executeRaw<any>(`SELECT evtname,evtenabled,pg_get_userbyid(evtowner) AS owner FROM pg_event_trigger ORDER BY evtname`);
    assert(events.some(e=>e.evtname==='auto_rls_on_create_table' && e.evtenabled==='O'));
    const tables=await engine.executeRaw<any>(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`);
    for (const t of tables.filter(t=>['pages','tags','timeline_entries'].includes(t.relname) || t.relname.startsWith('markdown_projection_'))) {
      assert.equal(t.relrowsecurity,true); assert.equal(t.relforcerowsecurity,false); assert.equal(t.owner,url.username);
    }
    const config=await engine.executeRaw<{key:string,value:string}>(`SELECT key,value FROM config WHERE key='version'`);
    const migration=assertMigration(Array.from(config),LATEST_VERSION);
    emit({stage:`${phase}.catalog`,events,tables,config,migration});
  };
  await inventory('baseline');
  const opts={sourceId:'default'};
  const input={type:'note',title:'Engine amberquartz',compiled_truth:'cobaltfern engine content',timeline:'',frontmatter:{nested:{keep:true},labels:['one','two']}};
  const ledger=async()=>Array.from(await observer!`SELECT * FROM markdown_projection_obligations ORDER BY source_id,page_id,incarnation`);
  async function scenario(phase:'baseline'|'candidate') {
    const candidate=phase==='candidate';
    const obligation=async(id:number,op:string,previous?:bigint)=>{
      if(!candidate)return;
      const rows=await observer!`SELECT * FROM markdown_projection_obligations WHERE page_id=${id} ORDER BY generation DESC`;
      assert.equal(rows.length,1); assert.equal(rows[0].operation,op); assert.equal(rows[0].status,'pending');
      if(previous!==undefined)assert(BigInt(rows[0].generation)>previous);
      return BigInt(rows[0].generation);
    };
    enter(`${phase}.putPage.insert`);
    const page=await engine.putPage('engine-lane',input,opts); let gen=await obligation(page.id,'upsert');
    // Nonempty structured timeline and chunk fixtures; real engine search is chunk-based.
    await engine.executeRaw(`INSERT INTO timeline_entries(page_id,date,summary,detail) VALUES ($1,'2026-01-01','amberquartz','cobaltfern')`,[page.id]);
    await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text,chunk_source) VALUES ($1,0,'amberquartz cobaltfern','compiled_truth')`,[page.id]);
    enter(`${phase}.putPage.conflict`);
    await engine.putPage('engine-lane',{...input,title:'Updated amberquartz'},opts); gen=await obligation(page.id,'upsert',gen);
    const got=await engine.getPage('engine-lane',opts); assert(got); assert.deepEqual(got.frontmatter,input.frontmatter); assert.equal(got.compiled_truth,input.compiled_truth);
    const vectors=await engine.executeRaw(`SELECT search_vector @@ to_tsquery('english','amberquartz & cobaltfern') AS matches FROM pages WHERE id=$1`,[page.id]);
    assert.deepEqual(Array.from(vectors),[{matches:true}]);
    const hits=await engine.searchKeyword('amberquartz',opts); assert(hits.some(h=>h.slug==='engine-lane'));
    enter(`${phase}.tags`);
    await engine.addTag('engine-lane','alpha',opts); gen=await obligation(page.id,'upsert',gen);
    assert.deepEqual(await engine.getTags('engine-lane',opts),['alpha']);
    const beforeNoop=candidate?await ledger():[];
    await engine.addTag('engine-lane','alpha',opts);
    await engine.removeTag('engine-lane','missing',opts);
    if(candidate)assert.deepEqual(await ledger(),beforeNoop);
    await engine.removeTag('engine-lane','alpha',opts); gen=await obligation(page.id,'upsert',gen);
    assert.deepEqual(await engine.getTags('engine-lane',opts),[]);
    enter(`${phase}.transaction.rollback`);
    const before=await engine.getPage('engine-lane',opts), beforeLedger=candidate?await ledger():[];
    const sentinel=new Error('ENGINE_ROLLBACK_SENTINEL');
    await assert.rejects(()=>engine.transaction(async tx=>{
      await tx.putPage('engine-lane',{...input,title:'Rollback'},opts);
      await tx.addTag('engine-lane','rollback',opts);
      if(candidate) {
        const inside=await tx.executeRaw<any>(`SELECT generation FROM markdown_projection_obligations WHERE page_id=$1`,[page.id]);
        assert(BigInt(inside[0].generation)>gen!);
        assert.deepEqual(await ledger(),beforeLedger,'uncommitted obligation leaked');
      }
      throw sentinel;
    }),e=>e===sentinel);
    assert.deepEqual(await engine.getPage('engine-lane',opts),before);
    assert.deepEqual(await engine.getTags('engine-lane',opts),[]);
    if(candidate)assert.deepEqual(await ledger(),beforeLedger);
    enter(`${phase}.soft-delete.restore`);
    assert.deepEqual(await engine.softDeletePage('engine-lane',opts),{slug:'engine-lane'}); gen=await obligation(page.id,'tombstone',gen);
    assert.equal(await engine.getPage('engine-lane',opts),null);
    assert.equal(await engine.restorePage('engine-lane',opts),true); gen=await obligation(page.id,'upsert',gen);
    enter(`${phase}.deletePage`); await engine.deletePage('engine-lane',opts); await obligation(page.id,'tombstone',gen);
    assert.equal(await engine.getPage('engine-lane',opts),null);
    const semantics={frontmatter:got.frontmatter,body:got.compiled_truth,vectors:Array.from(vectors),hits:hits.map(h=>({slug:h.slug,title:h.title,score:h.score}))};
    emit({stage:`${phase}.complete`,semantics}); return semantics;
  }
  const baseline=await scenario('baseline');
  enter('candidate.install'); await observer.unsafe(await readFile(new URL('../docs/architecture/sql/markdown-projection-candidate.sql',import.meta.url),'utf8'));
  await inventory('candidate');
  assert.equal((await ledger()).length,0);
  await observer`SELECT markdown_projection_set_policy('default',true)`;
  assert.equal((await ledger()).length,0,'activation backfilled');
  assert.deepEqual(await scenario('candidate'),baseline);
  enter('worker.install');
  await observer.unsafe(await readFile(new URL('../docs/architecture/sql/markdown-projection-worker-candidate.sql',import.meta.url),'utf8'));
  const {drainMarkdownProjectionOnce}=await import('../src/core/markdown-projection-worker.ts');
  const root=await mkdtemp(`${home}/projection-`);
  await observer`SELECT markdown_projection_set_policy('default',false)`;
  await observer`UPDATE markdown_projection_policy SET root_path=${root} WHERE source_id='default'`;
  await observer`SELECT markdown_projection_set_policy('default',true)`;
  const page=await engine.putPage('worker-lane',input,opts);
  await engine.addTag('worker-lane','worker-tag',opts);
  const config={enabled:true,sourceId:'default',root,inputRoots:[]};
  await assert.rejects(()=>drainMarkdownProjectionOnce(config,engine,async p=>{if(p==='after_write')throw Error('WORKER_CRASH');}),/WORKER_CRASH/);
  assert.equal((await observer`SELECT status FROM markdown_projection_obligations WHERE page_id=${page.id}`)[0].status,'pending');
  assert.equal((await observer`SELECT * FROM markdown_projection_current`).length,0);
  const result=await drainMarkdownProjectionOnce(config,engine);
  assert.equal(result.status,'materialized');assert('path' in result);
  const [current]=await observer`SELECT * FROM markdown_projection_current WHERE source_id='default'`;
  assert(current);assert.equal(current.current_path,result.path);
  const bytes=await readFile(`${root}/${current.current_path}`,'utf8');
  const {createHash}=await import('node:crypto');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),current.current_hash);
  const {serializePageToMarkdown}=await import('../src/core/markdown.ts');
  assert.equal(bytes,serializePageToMarkdown((await engine.getPage('worker-lane',opts))!,['worker-tag']));
  assert.equal((await drainMarkdownProjectionOnce(config,engine)).status,'idle');
  emit({stage:'worker.complete',status:'passed',filesystemWorkerConnected:true,applicationAuthProven:false});
  // Independent parent invokes the actual process-isolated caller while fixture lives.
  // This authored lane is NOT real connection-loss recovery acceptance yet.
  enter('worker.isolated');
  await engine.putPage('worker-lane',{...input,title:'Isolated worker'},opts);
  const isolatedConfig={admission:'HOSTED_DISPOSABLE_ONLY',
    connection:{host:'127.0.0.1',port:Number(url.port),database:name,username:url.username,
      password:decodeURIComponent(url.password),expectedServerAddress:expectedServiceIP,expectedServerPort:5432},
    worker:config};
  const isolated=runIsolated(isolatedConfig);
  assert.equal(isolated.status,'passed');assert.equal(isolated.copyStatus,'materialized');
  assert(isolated.attempts.every((a:any)=>a.reaped && a.exitCode===0));
  const [isolatedCurrent]=await observer`SELECT * FROM markdown_projection_current WHERE source_id='default'`;
  assert(isolatedCurrent);
  const isolatedBytes=await readFile(`${root}/${isolatedCurrent.current_path}`,'utf8');
  assert.equal(createHash('sha256').update(isolatedBytes).digest('hex'),isolatedCurrent.current_hash);
  assert.equal(isolatedBytes,serializePageToMarkdown((await engine.getPage('worker-lane',opts))!,['worker-tag']));
  emit({stage:'worker.isolated',status:'passed',receipt:isolated,connectionLossRecoveryProven:false});
  if(workerMode==='legacy') {
    enter('worker.races');
    const {workerRaces}=await import('./markdown-projection-worker-races');
    await workerRaces(engine,observer,target.href,config,emit);
  } else {
    const {isolatedRecovery}=await import('./markdown-projection-isolated-recovery');
    await isolatedRecovery(engine,observer,isolatedConfig,emit);
  }
} catch(e) { failed=true; failure=e; emit({stage,status:'failed',message:String(e),code:(e as any)?.code}); }
finally {
  const errors:unknown[]=[];
  const attempt=async(label:string,fn:()=>Promise<unknown>)=>{try{await fn();}catch(e){errors.push({label,error:String(e)});}};
  await attempt('engine.disconnect',()=>engine.disconnect());
  await attempt('observer.close',async()=>observer?.end({timeout:2}));
  if(created)await attempt('database.drop',()=>admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  await attempt('catalog.residue',async()=>assert.equal((await admin`SELECT datname FROM pg_database WHERE datname=${name}`).length,0));
  await attempt('admin.close',()=>admin.end({timeout:2}));
  // A timed-out JS callback can still write: retain its root for supervisor teardown.
  await attempt('home.remove',()=>removeHostedHome(home,failure));
  emit({cleanup:errors.length?'failed':'passed',errors,wholeServiceTeardownRequired:true});
  if(failed && errors.length)throw Object.assign(new AggregateError([failure,...errors],'hosted failure with cleanup failures'),{primaryError:failure,cleanupErrors:errors,unsafeFilesystemCleanup:(failure as any)?.unsafeFilesystemCleanup});
  if(failed)throw failure; assert.equal(errors.length,0);
}
emit({status:'passed',phase:'engine',workerMode,isolatedHealthyCompletion:true,isolatedBackendLoss:workerMode==='isolated'?'passed':'excluded-not-passed',legacyRaces:workerMode==='legacy'?'passed':'excluded-not-passed',filesystemWorkerConnected:true,applicationAuthProven:false});
