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
async function denied(work: () => PromiseLike<unknown>, code: string) {
  await assert.rejects(async () => { await work(); }, (e: any) => e.code === code);
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
  if (process.env.MARKDOWN_PROJECTION_PHASE !== 'red') {
    await a.unsafe(await readFile(new URL('../docs/architecture/sql/markdown-projection-candidate.sql', import.meta.url), 'utf8'));
  }
  // RED phase intentionally fails here without the candidate, before fixture setup.
  assert.equal((await a`SELECT to_regclass('public.markdown_projection_obligations')::text AS name`)[0].name,
    'markdown_projection_obligations', 'atomic obligation table missing');
  await a`INSERT INTO sources(id,name) VALUES ('mp-a','mp-a'),('mp-b','mp-b')`;
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
    await a`INSERT INTO sources(id,name) VALUES (${s},${s})`;
    const [moving] = await a`INSERT INTO pages(source_id,slug,type,title) VALUES (${s},'moving','note','Before') RETURNING id`;
    await b.unsafe(`BEGIN ISOLATION LEVEL ${isolation}`);
    await b`SELECT * FROM markdown_projection_policy WHERE source_id=${s}`;
    await a`SELECT markdown_projection_set_policy(${s},true)`;
    await denied(() => b!`UPDATE pages SET source_id='mp-disabled' WHERE id=${moving.id}`, '40001');
    await b`ROLLBACK`;
    assert.equal((await a`SELECT source_id FROM pages WHERE id=${moving.id}`)[0].source_id,s);
    await a`INSERT INTO tags(page_id,tag) VALUES (${moving.id},'route')`;
    await b.unsafe(`BEGIN ISOLATION LEVEL ${isolation}`);
    await b`SELECT * FROM pages WHERE id=${moving.id}`;
    await a`UPDATE pages SET source_id='mp-disabled' WHERE id=${moving.id}`;
    await denied(() => b!`UPDATE tags SET tag='stale-route' WHERE page_id=${moving.id}`, '40001');
    await b`ROLLBACK`;
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
  // MP-B2: disposable, non-owner source-scoped LOGIN, never a production grant.
  await admin.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  roleCreated = true;
  await a.unsafe(`GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON pages,tags TO ${role};
    GRANT USAGE,SELECT ON SEQUENCE pages_id_seq,tags_id_seq TO ${role};
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
  await denied(() => ordinary!`UPDATE pages SET source_id='mp-b' WHERE id=${own.id}`, '42501');
  await denied(() => ordinary!`UPDATE tags SET page_id=${recreated.id} WHERE page_id=${own.id}`, '42501');
  assert.deepEqual(await row(recreated.id,'mp-b'),crossBefore);
  assert.equal((await ordinary`SELECT source_id FROM pages WHERE id=${own.id}`)[0].source_id,'mp-a');
  await ordinary`DELETE FROM pages WHERE id=${own.id}`;
  assert.equal((await row(own.id)).operation,'tombstone');
  await denied(() => ordinary!`SELECT * FROM markdown_projection_policy`, '42501');
  await denied(() => ordinary!`INSERT INTO markdown_projection_policy(source_id,enabled,policy_generation,activation_watermark) VALUES ('mp-a',true,1,1)`, '42501');
  console.log(JSON.stringify({ordinaryIdentity:identity, rls:roleEvidence}));
  await denied(() => ordinary!`SELECT markdown_projection_set_policy('mp-a',true)`, '42501');
  await denied(() => ordinary!`SELECT * FROM markdown_projection_obligations`, '42501');
  await denied(() => ordinary!`SELECT markdown_projection_publish_lock('mp-a')`, '42501');
} catch (error) {
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
