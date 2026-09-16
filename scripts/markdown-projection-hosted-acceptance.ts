// Hosted-only, deliberately NOT in default test discovery. Assertions authored before SQL.
// Run only on a disposable hosted pgvector service; creates/drops its OWN database.
import postgres from 'postgres';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

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
const name = `mp_accept_${randomBytes(8).toString('hex')}`;
const role = `${name}_ordinary`;
const password = randomBytes(24).toString('hex');
const admin = postgres(connectionArgs(url.pathname.slice(1)));
let databaseCreated = false, roleCreated = false;
let primaryError: unknown;
let failed = false;
let a: ReturnType<typeof postgres> | undefined;
let b: ReturnType<typeof postgres> | undefined;
let ordinary: ReturnType<typeof postgres> | undefined;
let activeStage = 'bootstrap';
function diagnostic(error: any) {
  return Object.fromEntries(['code','message','detail','hint','where','schema_name','table_name','column_name','constraint_name','routine','file'].map(key => [key, error?.[key]]));
}
async function stage<T>(name: string, work: () => PromiseLike<T>): Promise<T> {
  activeStage = name;
  console.log(JSON.stringify({stage: name, status: 'started'}));
  return await work();
}
async function denied(work: () => PromiseLike<unknown>, code: string, seam?: RegExp) {
  assert(code !== '42501' || seam, '42501 requires a specific denial seam');
  await assert.rejects(async () => { await work(); }, (e: any) => {
    console.log(JSON.stringify({stage: activeStage, expectedDenial: code, error: diagnostic(e)}));
    return e.code === code && (!seam || seam.test(e.message));
  });
}
const timelinePolicy = () => a!.unsafe(`CREATE POLICY mp_fixture_timeline ON timeline_entries FOR SELECT TO ${role}
  USING (EXISTS (SELECT 1 FROM public.pages p WHERE p.id=timeline_entries.page_id AND p.source_id='mp-a'))`);
// Identical page/tag/search contract before and after installation; no shared natural
// keys with the concurrency schedules. Compare semantics, not nontransactional clocks.
async function baselineMutations(phase: 'baseline' | 'candidate') {
  const run = <T>(name: string, work: () => PromiseLike<T>) => stage(`${phase}.ordinary.${name}`, work);
  const [seed] = await run('seed.allowed', () => a!`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-a','role-seed','note','Seed') RETURNING id`);
  const [foreign] = await run('seed.forbidden', () => a!`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-b','role-foreign','note','Foreign') RETURNING id`);
  await run('seed.timeline', () => a!`INSERT INTO timeline_entries(page_id,date,summary,detail) VALUES (${seed.id},'2026-01-01','amberquartz','cobaltfern'),(${foreign.id},'2026-01-01','forbiddenviolet','hiddenorchid')`);
  const vector = async () => (await a!`SELECT search_vector @@ to_tsquery('english','amberquartz & cobaltfern') AS allowed, search_vector @@ to_tsquery('english','forbiddenviolet | hiddenorchid') AS forbidden FROM pages WHERE id=${seed.id}`)[0];
  if (phase === 'baseline') {
    await stage('baseline.negative.missing-select.revoke', () => a!.unsafe(`REVOKE SELECT(page_id,summary,detail) ON timeline_entries FROM ${role}`));
    try {
      await stage('baseline.negative.missing-select', () => denied(() => ordinary!`UPDATE pages SET title='Must rollback' WHERE id=${seed.id}`, '42501', /^permission denied for table timeline_entries$/));
      assert.equal((await a!`SELECT title FROM pages WHERE id=${seed.id}`)[0].title, 'Seed');
    } finally {
      await a!.unsafe(`GRANT SELECT(page_id,summary,detail) ON timeline_entries TO ${role}`);
    }
    await run('prime-vector', () => ordinary!`UPDATE pages SET title='Primed' WHERE id=${seed.id}`);
    assert.deepEqual(await vector(), {allowed:true, forbidden:false});
    await a!.unsafe('DROP POLICY mp_fixture_timeline ON timeline_entries');
    try {
      await stage('baseline.negative.no-policy', () => ordinary!`UPDATE pages SET last_retrieved_at=now() WHERE id=${seed.id}`);
      assert.equal((await ordinary!`SELECT page_id,summary,detail FROM timeline_entries`).length, 0);
      assert.deepEqual(await vector(), {allowed:false, forbidden:false}, 'grant alone must demonstrate silent vector loss');
    } finally { await timelinePolicy(); }
  }
  const visible = await run('timeline.visibility', () => ordinary!`SELECT page_id,summary,detail FROM timeline_entries ORDER BY page_id`);
  assert.deepEqual(Array.from(visible), [{page_id:seed.id,summary:'amberquartz',detail:'cobaltfern'}]);
  const [own] = await run('insert', () => ordinary!`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-a','role-insert','note','Ordinary') RETURNING id`);
  await run('update', () => ordinary!`UPDATE pages SET title='Authorized' WHERE id=${seed.id}`);
  assert.deepEqual(await vector(), {allowed:true, forbidden:false});
  await run('retrieval-only', () => ordinary!`UPDATE pages SET last_retrieved_at=now() WHERE id=${seed.id}`);
  const semantics = await vector();
  assert.deepEqual(semantics, {allowed:true, forbidden:false});
  const [tag] = await run('tag.insert', () => ordinary!`INSERT INTO tags(page_id,tag) VALUES (${seed.id},'role-tag') RETURNING id`);
  await run('tag.update', () => ordinary!`UPDATE tags SET tag='role-edited' WHERE id=${tag.id}`);
  await run('tag.reparent', () => ordinary!`UPDATE tags SET page_id=${own.id} WHERE id=${tag.id}`);
  assert.equal((await ordinary!`SELECT tag FROM tags WHERE page_id=${own.id}`)[0].tag,'role-edited');
  await run('tag.delete', () => ordinary!`DELETE FROM tags WHERE id=${tag.id}`);
  assert.equal((await ordinary!`SELECT id FROM tags WHERE id=${tag.id}`).length,0);
  await run('rename', () => ordinary!`UPDATE pages SET slug='role-renamed' WHERE id=${own.id}`);
  await run('soft-delete', () => ordinary!`UPDATE pages SET deleted_at=now() WHERE id=${own.id}`);
  assert((await ordinary!`SELECT deleted_at FROM pages WHERE id=${own.id}`)[0].deleted_at);
  await run('restore', () => ordinary!`UPDATE pages SET deleted_at=NULL WHERE id=${own.id}`);
  assert.equal((await ordinary!`SELECT deleted_at FROM pages WHERE id=${own.id}`)[0].deleted_at,null);
  await run('delete', () => ordinary!`DELETE FROM pages WHERE id IN (${own.id},${seed.id})`);
  assert.equal((await a!`SELECT id FROM pages WHERE id IN (${own.id},${seed.id})`).length,0);
  await run('cleanup.foreign', () => a!`DELETE FROM pages WHERE id=${foreign.id}`);
  console.log(JSON.stringify({stage:`${phase}.ordinary.complete`, semantics}));
  return semantics;
}
try {
  await verifyTarget(admin, url.pathname.slice(1), url.username);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  databaseCreated = true;
  a = postgres(connectionArgs(name)); b = postgres(connectionArgs(name));
  await verifyTarget(a, name, url.username);
  await verifyTarget(b, name, url.username);
  // Reuse the repository's actual PostgreSQL schema, not an invented minimal model.
  await a.unsafe(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  await a.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  // Separate expected missing-table RED contract: not a baseline role proof.
  if (process.env.MARKDOWN_PROJECTION_PHASE === 'red') {
    activeStage = 'red.missing-table';
    assert.equal((await a`SELECT to_regclass('public.markdown_projection_obligations')::text AS name`)[0].name,
      'markdown_projection_obligations', 'atomic obligation table missing');
    assert.fail('RED unexpectedly found candidate table');
  }
  await a`INSERT INTO sources(id,name) VALUES ('mp-a','mp-a'),('mp-b','mp-b')`;
  // MP-B2: disposable, non-owner source-scoped LOGIN, never a production grant.
  await admin.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  roleCreated = true;
  await a.unsafe(`GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON pages,tags TO ${role};
    GRANT SELECT(page_id,summary,detail) ON timeline_entries TO ${role};
    ALTER TABLE timeline_entries ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SEQUENCE pages_id_seq,tags_id_seq TO ${role};
    GRANT USAGE ON SEQUENCE public.page_generation_clock_seq TO ${role};
    ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
    CREATE POLICY mp_fixture_pages ON pages TO ${role} USING (source_id='mp-a') WITH CHECK (source_id='mp-a');
    CREATE POLICY mp_fixture_tags ON tags TO ${role}
      USING (EXISTS (SELECT 1 FROM pages WHERE id=page_id AND source_id='mp-a'))
      WITH CHECK (EXISTS (SELECT 1 FROM pages WHERE id=page_id AND source_id='mp-a'));`);
  ordinary=postgres(connectionArgs(name, role, password));
  await verifyTarget(ordinary, name, role);
  const [identity] = await ordinary`SELECT current_user AS u, session_user AS s, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  assert.equal(identity.u, role); assert.equal(identity.s, role);
  assert.equal(identity.rolsuper, false); assert.equal(identity.rolbypassrls, false);
  const roleEvidence = await ordinary`SELECT relname,relrowsecurity,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid IN ('pages'::regclass,'tags'::regclass)`;
  for (const table of roleEvidence) { assert.equal(table.relrowsecurity,true); assert.notEqual(table.owner,role); }
  await timelinePolicy();
  console.log(JSON.stringify({stage:'baseline.role.receipt', ordinaryIdentity:identity, rls:roleEvidence}));
  const baselineSemantics = await baselineMutations('baseline');
  console.log(JSON.stringify({stage:'baseline.gate',status:'passed'}));
  await stage('candidate.install', async () => a!.unsafe(await readFile(new URL('../docs/architecture/sql/markdown-projection-candidate.sql', import.meta.url), 'utf8')));
  assert.equal((await a`SELECT to_regclass('public.markdown_projection_obligations')::text AS name`)[0].name,
    'markdown_projection_obligations', 'atomic obligation table missing');
  activeStage = 'candidate.concurrency';
  const [p] = await a`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-a','old','note','Old') RETURNING id`;
  const count = async () => Number((await a!`SELECT count(*) AS n FROM markdown_projection_obligations`)[0].n);
  assert.equal(await count(), 0, 'absent policy must not enqueue');
  // MP-B1 regression: absent/disabled unrelated writes retain baseline behavior.
  await a`INSERT INTO sources(id,name) VALUES ('mp-disabled','disabled')`;
  await a`SELECT markdown_projection_set_policy('mp-disabled',false)`;
  await b`BEGIN`;
  await b`UPDATE pages SET title='before activation' WHERE id=${p.id}`;
  await a`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-disabled','unrelated','note','Unrelated')`;
  await a`UPDATE pages SET last_retrieved_at=now() WHERE source_id='missing'`;
  await b`ROLLBACK`;
  // Explicit unsupported aggregate contract: TRUNCATE cannot be source-scoped.
  await denied(() => a!`TRUNCATE tags`, '0A000');
  // MP-B3: a snapshot predating enrollment must not silently miss an obligation.
  // Require native tuple freshness 40001, not blanket isolation rejection.
  for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
    for (const state of ['absent', 'disabled', 'reenabled']) {
      const source = `stale-${isolation.replaceAll(' ', '-')}-${state}`;
      await a`INSERT INTO sources(id,name) VALUES (${source},${source})`;
      const [stale] = await a`INSERT INTO pages(source_id,slug,type,title) VALUES (${source},'snapshot','note','Before') RETURNING id`;
      if (state !== 'absent') await a`SELECT markdown_projection_set_policy(${source},false)`;
      if (state === 'reenabled') {
        await a`SELECT markdown_projection_set_policy(${source},true)`;
        await a`SELECT markdown_projection_set_policy(${source},false)`;
      }
      await b.unsafe(`BEGIN ISOLATION LEVEL ${isolation}`);
      await b`SELECT count(*) FROM pages`;
      await a`SELECT markdown_projection_set_policy(${source},true)`;
      let rejected = false;
      try {
        await b`UPDATE pages SET title='After' WHERE id=${stale.id}`;
        await b`COMMIT`;
      } catch (error: any) {
        assert.equal(error.code, '40001', `unexpected stale-snapshot error ${error.code}`);
        rejected = true; await b`ROLLBACK`;
      }
      assert.equal(rejected, true, 'fixed snapshot MUST reject changed guard');
      if (rejected) assert.equal((await a`SELECT title FROM pages WHERE id=${stale.id}`)[0].title, 'Before');
      else assert.equal(Number((await a`SELECT count(*) AS n FROM markdown_projection_obligations o JOIN markdown_projection_policy p USING(source_id) WHERE o.page_id=${stale.id} AND o.policy_generation=p.policy_generation AND o.status='pending'`)[0].n), 1, 'committed mutation missed current obligation');
      await a`SELECT markdown_projection_set_policy(${source},false)`;
    }
  }
  // SHARE admission permits independent disabled writers in the SAME source.
  await b`BEGIN`;
  await b`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-disabled','share-one','note','One')`;
  await a`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-disabled','share-two','note','Two')`;
  await denied(() => a!`SELECT markdown_projection_set_policy('mp-disabled',true)`, '55P03');
  await b`ROLLBACK`;
  // Owner-only invariant fault injection is rollback-contained; ordinary writers cannot do this.
  await a`BEGIN`;
  await a`DELETE FROM markdown_projection_policy WHERE source_id='mp-disabled'`;
  await denied(() => a!`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-disabled','missing-guard','note','No')`, '40001');
  await a`ROLLBACK`;
  for (const isolation of ['REPEATABLE READ','SERIALIZABLE']) {
    const s = `move-${isolation.replaceAll(' ','-')}`;
    // The prior case intentionally leaves its moved page in mp-disabled.
    // Slug identity must therefore be unique in the destination, not just s.
    const slug = `${s}-moving`;
    await a`INSERT INTO sources(id,name) VALUES (${s},${s})`;
    const [moving] = await a`INSERT INTO pages(source_id,slug,type,title) VALUES (${s},${slug},'note','Before') RETURNING id`;
    const retainedState = async () => ({
      pages: Array.from(await a!`SELECT * FROM pages WHERE id=${moving.id}`),
      tags: Array.from(await a!`SELECT * FROM tags WHERE page_id=${moving.id} ORDER BY id`),
      obligations: Array.from(await a!`SELECT * FROM markdown_projection_obligations WHERE page_id=${moving.id} ORDER BY source_id, incarnation`),
      policy: Array.from(await a!`SELECT * FROM markdown_projection_policy WHERE source_id IN (${s},'mp-disabled') ORDER BY source_id`),
    });
    await b.unsafe(`BEGIN ISOLATION LEVEL ${isolation}`);
    await b`SELECT * FROM markdown_projection_policy WHERE source_id=${s}`;
    await a`SELECT markdown_projection_set_policy(${s},true)`;
    const beforeMoveRefusal = await retainedState();
    await denied(() => b!`UPDATE pages SET source_id='mp-disabled' WHERE id=${moving.id}`, '40001');
    await b`ROLLBACK`;
    assert.deepEqual(await retainedState(), beforeMoveRefusal, `${isolation}: refused move changed retained state`);
    assert.equal((await a`SELECT source_id FROM pages WHERE id=${moving.id}`)[0].source_id,s);
    await a`INSERT INTO tags(page_id,tag) VALUES (${moving.id},'route')`;
    await b.unsafe(`BEGIN ISOLATION LEVEL ${isolation}`);
    await b`SELECT * FROM pages WHERE id=${moving.id}`;
    await a`UPDATE pages SET source_id='mp-disabled' WHERE id=${moving.id}`;
    const beforeTagRefusal = await retainedState();
    await denied(() => b!`UPDATE tags SET tag='stale-route' WHERE page_id=${moving.id}`, '40001');
    await b`ROLLBACK`;
    assert.deepEqual(await retainedState(), beforeTagRefusal, `${isolation}: refused tag update changed retained state`);
    assert.equal((await a`SELECT source_id FROM pages WHERE id=${moving.id}`)[0].source_id,'mp-disabled', 'concurrent committed move retained');
    assert.equal((await a`SELECT tag FROM tags WHERE page_id=${moving.id}`)[0].tag,'route');
  }
  const beforeActivation = await count();
  await a`SELECT markdown_projection_set_policy('mp-a',true)`;
  assert.equal(await count(), beforeActivation, 'activation must not scan/backfill');
  await b`BEGIN ISOLATION LEVEL READ COMMITTED`;
  await b`UPDATE pages SET title='Fresh RC' WHERE id=${p.id}`;
  assert.equal(Number((await b`SELECT count(*) AS n FROM markdown_projection_obligations o JOIN markdown_projection_policy g USING(source_id) WHERE o.page_id=${p.id} AND o.policy_generation=g.policy_generation`)[0].n),1);
  assert.equal(await count(),beforeActivation,'uncommitted obligation invisible');
  await b`COMMIT`;
  await a`INSERT INTO tags(page_id,tag) VALUES (${p.id},'direct-sql')`;
  const row = async (id = p.id, source = 'mp-a') => (await a!`SELECT * FROM markdown_projection_obligations WHERE page_id=${id} AND source_id=${source} ORDER BY generation DESC LIMIT 1`)[0];
  let r = await row(); assert.equal(r.operation, 'upsert');
  const gen = BigInt(r.generation);
  await a`BEGIN`; await a`DELETE FROM pages WHERE id=${p.id}`; await a`ROLLBACK`;
  assert.equal(BigInt((await row()).generation), gen, 'rollback must leave no obligation change');
  await a`UPDATE pages SET last_retrieved_at=now() WHERE id=${p.id}`;
  assert.equal(BigInt((await row()).generation), gen, 'retrieval-only update ignored');
  await a`UPDATE pages SET slug='renamed' WHERE id=${p.id}`;
  assert((await row()).prior_slugs.includes('old'), 'rename retains old identity');
  const [q] = await a`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-a','other','note','Other') RETURNING id`;
  const pg = BigInt((await row()).generation), qg = BigInt((await row(q.id)).generation);
  await a`UPDATE tags SET page_id=${q.id} WHERE page_id=${p.id}`;
  assert(BigInt((await row()).generation) > pg); assert(BigInt((await row(q.id)).generation) > qg);
  await a`DELETE FROM tags WHERE page_id=${q.id}`;
  assert(BigInt((await row(q.id)).generation) > qg + 1n, 'tag delete invalidates');
  // Real independent backend, deterministic lock rejection (no sleeps / timing guesses).
  assert.notEqual((await a`SELECT pg_backend_pid() AS pid`)[0].pid, (await b`SELECT pg_backend_pid() AS pid`)[0].pid);
  await a`BEGIN`; await a`SELECT markdown_projection_publish_lock('mp-a')`;
  await b`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-disabled','during-publication','note','Unrelated')`;
  await b`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-b','absent-during-publication','note','Absent')`;
  assert.equal(Number((await b`SELECT count(*) AS n FROM markdown_projection_obligations WHERE source_id='mp-disabled'`)[0].n),0);
  await denied(() => b!`INSERT INTO tags(page_id,tag) VALUES (${p.id},'race')`, '55P03');
  await denied(() => b!`UPDATE pages SET title='race' WHERE id=${p.id}`, '55P03');
  await denied(() => b!`DELETE FROM pages WHERE id=${p.id}`, '55P03');
  await denied(() => b!`SELECT markdown_projection_publish_lock('mp-a')`, '55P03');
  await a`COMMIT`;
  await b`BEGIN`; await b`INSERT INTO tags(page_id,tag) VALUES (${p.id},'writer-first')`;
  await denied(() => a!`SELECT markdown_projection_publish_lock('mp-a')`, '55P03');
  await b`COMMIT`;
  await a`SELECT markdown_projection_set_policy('mp-b',true)`;
  await a`UPDATE pages SET source_id='mp-b' WHERE id=${p.id}`;
  assert.equal((await row()).operation, 'tombstone');
  assert.equal((await row(p.id,'mp-b')).operation, 'upsert');
  await a`DELETE FROM pages WHERE id=${p.id}`;
  assert.equal((await row(p.id,'mp-b')).operation, 'tombstone', 'purge retains tombstone');
  const incarnation = (await row(p.id,'mp-b')).incarnation;
  const [recreated] = await a`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-b','renamed','note','New') RETURNING id`;
  assert.notEqual((await row(recreated.id,'mp-b')).incarnation, incarnation);
  await a`SELECT markdown_projection_set_policy('mp-a',false)`;
  const before = await row(q.id);
  await a`UPDATE pages SET title='disabled' WHERE id=${q.id}`;
  assert.equal(BigInt((await row(q.id)).generation), BigInt(before.generation));
  assert.equal((await row(q.id)).status, 'blocked_policy');
  await a`SELECT markdown_projection_set_policy('mp-a',true)`;
  assert.equal((await row(q.id)).status, 'blocked_policy', 'reenabling does not revive old work');
  await a`UPDATE pages SET title='future' WHERE id=${q.id}`;
  assert.equal((await row(q.id)).status, 'pending');
  await a`UPDATE pages SET deleted_at=now() WHERE id=${q.id}`;
  assert.equal((await row(q.id)).operation, 'tombstone');
  await a`UPDATE pages SET deleted_at=NULL WHERE id=${q.id}`;
  assert.equal((await row(q.id)).operation, 'upsert');
  const preRollbackCount = await count();
  await a`BEGIN`;
  await a`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-a','rolled-back','note','Rollback')`;
  await a`ROLLBACK`;
  assert.equal(await count(), preRollbackCount, 'rolled back insert leaves no job');
  // MP-B4: complete retained state, including deletion rollback and source reuse.
  await a`UPDATE pages SET slug='recreated-renamed' WHERE id=${recreated.id}`;
  await a`INSERT INTO tags(page_id,tag) VALUES (${recreated.id},'cascade')`;
  const retainedBefore = await a`SELECT * FROM markdown_projection_obligations WHERE source_id='mp-b' ORDER BY incarnation`;
  const policyBefore = await a`SELECT * FROM markdown_projection_policy WHERE source_id='mp-b'`;
  await a`BEGIN`; await a`DELETE FROM sources WHERE id='mp-b'`; await a`ROLLBACK`;
  assert.deepEqual(await a`SELECT * FROM markdown_projection_obligations WHERE source_id='mp-b' ORDER BY incarnation`, retainedBefore);
  assert.deepEqual(await a`SELECT * FROM markdown_projection_policy WHERE source_id='mp-b'`, policyBefore);
  await a`DELETE FROM sources WHERE id='mp-b'`;
  assert.equal((await row(recreated.id,'mp-b')).operation, 'tombstone', 'source cascade retains tombstone');
  const retainedAfter = await a`SELECT * FROM markdown_projection_obligations WHERE source_id='mp-b'`;
  const [deletedPolicy] = await a`SELECT * FROM markdown_projection_policy WHERE source_id='mp-b'`;
  assert.equal(deletedPolicy.enabled, false);
  assert.equal(retainedAfter.length, retainedBefore.length);
  for (const retained of retainedAfter) {
    assert.equal(retained.status, 'blocked_policy');
    assert(BigInt(retained.policy_generation) < BigInt(deletedPolicy.policy_generation));
  }
  assert((await row(recreated.id,'mp-b')).prior_slugs.includes('renamed'));
  await a`INSERT INTO sources(id,name) VALUES ('mp-b','recreated')`;
  const [rebornGuard] = await a`SELECT * FROM markdown_projection_policy WHERE source_id='mp-b'`;
  assert.equal(rebornGuard.alive,true); assert.equal(rebornGuard.enabled,false);
  assert.notEqual(rebornGuard.source_incarnation,deletedPolicy.source_incarnation);
  await a`SELECT markdown_projection_set_policy('mp-b',true)`;
  assert.equal(Number((await a`SELECT count(*) AS n FROM markdown_projection_obligations WHERE source_id='mp-b' AND status<>'blocked_policy'`)[0].n), 0);
  await a`INSERT INTO pages(id,source_id,slug,type,title) VALUES (${recreated.id},'mp-b','recreated-renamed','note','Fresh identity')`;
  assert.notEqual((await row(recreated.id,'mp-b')).incarnation, retainedAfter.find(x => x.page_id === recreated.id)!.incarnation);
  activeStage = 'candidate.ordinary.legacy-insert';
  const [own] = await ordinary`INSERT INTO pages(source_id,slug,type,title) VALUES ('mp-a','ordinary','note','Ordinary') RETURNING id`;
  assert.equal((await row(own.id)).operation, 'upsert');
  await ordinary`UPDATE pages SET title='Authorized',slug='ordinary-renamed' WHERE id=${own.id}`;
  assert((await row(own.id)).prior_slugs.includes('ordinary'));
  const ownGeneration = BigInt((await row(own.id)).generation);
  await ordinary`INSERT INTO tags(page_id,tag) VALUES (${own.id},'ordinary')`;
  assert(BigInt((await row(own.id)).generation) > ownGeneration);
  await a`BEGIN`; await a`SELECT markdown_projection_publish_lock('mp-b')`;
  await ordinary`UPDATE pages SET title='unrelated publication' WHERE id=${own.id}`;
  await a`COMMIT`;
  const crossBefore = await row(recreated.id,'mp-b');
  assert.equal((await ordinary`SELECT * FROM pages WHERE source_id='mp-b'`).length,0);
  assert.equal((await ordinary`UPDATE pages SET title='denied' WHERE id=${recreated.id} RETURNING id`).length,0);
  await stage('candidate.denial.pages.source-move', () => denied(() => ordinary!`UPDATE pages SET source_id='mp-b' WHERE id=${own.id}`, '42501', /^new row violates row-level security policy for table "pages"$/));
  await stage('candidate.denial.tags.reparent', () => denied(() => ordinary!`UPDATE tags SET page_id=${recreated.id} WHERE page_id=${own.id}`, '42501', /^new row violates row-level security policy for table "tags"$/));
  assert.deepEqual(await row(recreated.id,'mp-b'),crossBefore);
  assert.equal((await ordinary`SELECT source_id FROM pages WHERE id=${own.id}`)[0].source_id,'mp-a');
  await ordinary`DELETE FROM pages WHERE id=${own.id}`;
  assert.equal((await row(own.id)).operation,'tombstone');
  await stage('candidate.denial.policy.read', () => denied(() => ordinary!`SELECT * FROM markdown_projection_policy`, '42501', /^permission denied for table markdown_projection_policy$/));
  await stage('candidate.denial.policy.write', () => denied(() => ordinary!`INSERT INTO markdown_projection_policy(source_id,enabled,policy_generation,activation_watermark) VALUES ('mp-a',true,1,1)`, '42501', /^permission denied for table markdown_projection_policy$/));
  console.log(JSON.stringify({ordinaryIdentity:identity, rls:roleEvidence}));
  await stage('candidate.denial.helper.set-policy', () => denied(() => ordinary!`SELECT markdown_projection_set_policy('mp-a',true)`, '42501', /^permission denied for function markdown_projection_set_policy$/));
  await stage('candidate.denial.obligations.read', () => denied(() => ordinary!`SELECT * FROM markdown_projection_obligations`, '42501', /^permission denied for table markdown_projection_obligations$/));
  await stage('candidate.denial.helper.publish-lock', () => denied(() => ordinary!`SELECT markdown_projection_publish_lock('mp-a')`, '42501', /^permission denied for function markdown_projection_publish_lock$/));
  assert.deepEqual(await baselineMutations('candidate'), baselineSemantics, 'baseline/candidate search semantics differ');
} catch (error) {
  console.error(JSON.stringify({stage:activeStage, unexpectedError:diagnostic(error)}));
  failed = true;
  primaryError = error;
} finally {
  // Whole disposable-service teardown remains mandatory in the hosted always step.
  const cleanupErrors: { step: string; error: string }[] = [];
  const attempt = async (step: string, work: () => PromiseLike<unknown> | undefined) => {
    try { await work(); } catch (error) { cleanupErrors.push({ step, error: String(error) }); }
  };
  await Promise.all([
    attempt('close ordinary', () => ordinary?.end({timeout:2})),
    attempt('close a', () => a?.end({timeout:2})),
    attempt('close b', () => b?.end({timeout:2})),
  ]);
  if (databaseCreated) await attempt('drop database', () => admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  if (roleCreated) await attempt('drop role', () => admin.unsafe(`DROP ROLE IF EXISTS ${role}`));
  await attempt('close admin', () => admin.end({timeout:2}));
  console.log(JSON.stringify({ cleanup: cleanupErrors.length ? 'failed' : 'passed', cleanupErrors, wholeServiceTeardownRequired: true }));
  // Rethrow the original assertion unchanged so the external RED parser stays valid.
  if (failed) throw primaryError;
  assert.equal(cleanupErrors.length, 0, 'fixture cleanup failed; see cleanup receipt');
}
console.log(JSON.stringify({ status:'passed', database:name, phase:'candidate', filesystemWorkerConnected:false }));
