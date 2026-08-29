#!/usr/bin/env bun
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type { OperationContext } from '../src/core/operations.ts';
import { buildZeroRowInsert, stripNoexecGuard, verifyControlManifest } from './g5-acl-hosted-lib.ts';

const ROOT = resolve(import.meta.dir, '..');
const CONTROL = resolve(ROOT, 'ops/g5-acl-control');
const RECEIPT_DIR = resolve(ROOT, 'g5-acl-hosted-receipt');
const APP_CANDIDATE_SHA = '718c04a56dd997147b49a5c9c8161b9265a5ef71';
const EXPECTED_BINDING = process.env.ACL_BINDING_SHA256;
const ADMIN_URL = (() => {
  const url = new URL(process.env.ADMIN_URL ?? 'postgresql://127.0.0.1:5432/postgres');
  url.pathname = '/postgres';
  if (!process.env.ADMIN_URL) {
    url.username = 'postgres';
    url.password = ['post', 'gres'].join('');
  }
  return url.toString();
})();
const LEGACY_PASSWORD = 'g5-hosted-legacy-synthetic';
const RUNTIME_PASSWORD = 'g5-hosted-runtime-synthetic';
const MIGRATOR_PASSWORD = 'g5-hosted-migrator-synthetic';
const STATE_PATH = resolve(RECEIPT_DIR, 'state.json');

if (!EXPECTED_BINDING) throw new Error('ACL_BINDING_SHA256 is required');
const binding = verifyControlManifest(CONTROL, EXPECTED_BINDING);
if (binding.entries !== 44) throw new Error(`expected 44 control entries, got ${binding.entries}`);

const sqlIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const sha256Json = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type RunState = { nonce: string; binding_sha256: string; application_candidate_sha: string };
function readState(): RunState {
  if (!existsSync(STATE_PATH)) throw new Error('hosted run state is missing');
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as RunState;
  if (state.binding_sha256 !== binding.bindingSha256 || state.application_candidate_sha !== APP_CANDIDATE_SHA || !/^[0-9a-f]{32}$/.test(state.nonce)) throw new Error('hosted run state mismatch');
  return state;
}
function writeStage(name: string, payload: Record<string, unknown>): void {
  const state = readState();
  writeFileSync(resolve(RECEIPT_DIR, `${name}.json`), JSON.stringify({ nonce: state.nonce, ...payload }, null, 2) + '\n');
}
function readStage(name: string): Record<string, unknown> {
  const state = readState();
  const value = JSON.parse(readFileSync(resolve(RECEIPT_DIR, `${name}.json`), 'utf8')) as Record<string, unknown>;
  if (value.nonce !== state.nonce) throw new Error(`stage nonce mismatch: ${name}`);
  return value;
}
const gbrainUrl = (user: string, password: string) => {
  const url = new URL(ADMIN_URL);
  url.pathname = '/gbrain';
  url.username = user;
  url.password = password;
  return url.toString();
};
const connectSql = (url: string) => postgres(url, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 10,
  max_lifetime: 60,
  connection: { statement_timeout: 30_000, lock_timeout: 5_000 },
  onnotice: () => {},
});

async function setSyntheticPassword(sql: postgres.Sql, role: string, value: string): Promise<void> {
  if (!/^[a-z_]+$/.test(role)) throw new Error(`unsafe role: ${role}`);
  await sql`SELECT set_config('g5.synthetic_password', ${value}, false)`;
  await sql.unsafe(`DO $g5_pw$ BEGIN EXECUTE format('ALTER ROLE ${sqlIdent(role)} PASSWORD %L', current_setting('g5.synthetic_password')); PERFORM set_config('g5.synthetic_password', '', false); END $g5_pw$;`);
}

async function reconstructExtensionContainerOwners(sql: postgres.Sql): Promise<{ containers: number; owner_dependencies: number; postgres_routines: number }> {
  return sql.begin(async (tx) => {
    await tx`UPDATE pg_extension SET extowner=(SELECT oid FROM pg_roles WHERE rolname='gbrain') WHERE extname IN ('pg_trgm','pgcrypto')`;
    await tx`
      WITH target_extensions AS (SELECT oid FROM pg_extension WHERE extname IN ('pg_trgm','pgcrypto'))
      DELETE FROM pg_shdepend d USING target_extensions e
      WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND d.classid='pg_extension'::regclass AND d.objid=e.oid AND d.objsubid=0
        AND d.refclassid='pg_authid'::regclass AND d.deptype='o'`;
    await tx`
      INSERT INTO pg_shdepend (dbid,classid,objid,objsubid,refclassid,refobjid,deptype)
      SELECT (SELECT oid FROM pg_database WHERE datname=current_database()),
             'pg_extension'::regclass,e.oid,0,'pg_authid'::regclass,r.oid,'o'
      FROM pg_extension e CROSS JOIN pg_authid r
      WHERE e.extname IN ('pg_trgm','pgcrypto') AND r.rolname='gbrain'`;
    const rows = await tx<{ containers: string; owner_dependencies: string; postgres_routines: string }[]>`
      SELECT
        (SELECT count(*)::text FROM pg_extension e JOIN pg_roles r ON r.oid=e.extowner WHERE e.extname IN ('pg_trgm','pgcrypto') AND r.rolname='gbrain') containers,
        (SELECT count(*)::text FROM pg_extension e JOIN pg_shdepend d ON d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND d.classid='pg_extension'::regclass AND d.objid=e.oid AND d.objsubid=0 AND d.refclassid='pg_authid'::regclass AND d.deptype='o' JOIN pg_roles r ON r.oid=d.refobjid WHERE e.extname IN ('pg_trgm','pgcrypto') AND r.rolname='gbrain') owner_dependencies,
        (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e' JOIN pg_extension e ON e.oid=d.refobjid JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND e.extname IN ('pg_trgm','pgcrypto','vector') AND r.rolname='postgres') postgres_routines`;
    const topology = { containers: Number(rows[0]?.containers), owner_dependencies: Number(rows[0]?.owner_dependencies), postgres_routines: Number(rows[0]?.postgres_routines) };
    if (topology.containers !== 2 || topology.owner_dependencies !== 2 || topology.postgres_routines !== 104) throw new Error(`synthetic extension owner topology mismatch: ${JSON.stringify(topology)}`);
    return topology;
  });
}

async function initBaseline(): Promise<void> {
  const db = await import('../src/core/db.ts');
  const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
  const admin = connectSql(ADMIN_URL);
  try {
    await admin.unsafe("DROP DATABASE IF EXISTS gbrain WITH (FORCE)");
    for (const role of ['gbrain_runtime', 'gbrain_migrator', 'gbrain_migration_owner', 'gbrain']) {
      await admin.unsafe(`DROP ROLE IF EXISTS ${sqlIdent(role)}`);
    }
    // Production is already sealed NOSUPERUSER, but its historical event trigger can
    // only be created by a superuser. Reproduce that catalog history in the disposable
    // fixture, then seal the synthetic legacy role before census, backup or S2.
    await admin.unsafe('CREATE ROLE gbrain LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL');
    await setSyntheticPassword(admin, 'gbrain', LEGACY_PASSWORD);
    await admin.unsafe('CREATE DATABASE gbrain OWNER gbrain');
  } finally {
    await admin.end();
  }

  const dbAdmin = connectSql(gbrainUrl('postgres', 'postgres'));
  try {
    await dbAdmin.unsafe('CREATE EXTENSION vector');
    await dbAdmin.unsafe('CREATE EXTENSION pg_trgm');
    await dbAdmin.unsafe('CREATE EXTENSION pgcrypto');
    // PostgreSQL 16 has no ALTER EXTENSION OWNER syntax. Reconstruct both the
    // reviewed extowner and its shared owner dependency in this disposable fixture.
    await reconstructExtensionContainerOwners(dbAdmin);
  } finally {
    await dbAdmin.end();
  }

  const legacyUrl = gbrainUrl('gbrain', LEGACY_PASSWORD);
  await db.disconnect();
  await db.connect({ database_url: legacyUrl });
  await db.initSchema();
  const engine = new PostgresEngine();
  await engine.connect({ database_url: legacyUrl });
  await engine.initSchema();
  await engine.disconnect();
  await db.disconnect();

  const sealAdmin = connectSql(gbrainUrl('postgres', 'postgres'));
  try {
    await sealAdmin.unsafe('ALTER ROLE gbrain NOSUPERUSER');
    const sealed = await sealAdmin<{ sealed: boolean }[]>`SELECT NOT rolsuper AND rolcanlogin AND rolbypassrls sealed FROM pg_roles WHERE rolname='gbrain'`;
    if (sealed[0]?.sealed !== true) throw new Error('synthetic legacy role seal failed');
  } finally { await sealAdmin.end(); }

  // These seven intake tables exist in the reviewed production catalog but are
  // external to the frozen application candidate. Recreate only their bound
  // object/index/sequence identities; no production data or service is used.
  const externalFixture = connectSql(legacyUrl);
  try {
    await externalFixture.unsafe(`
      CREATE TABLE intake_batches (id text PRIMARY KEY);
      CREATE TABLE intake_events (id bigserial PRIMARY KEY);
      CREATE TABLE intake_files (id text PRIMARY KEY);
      CREATE TABLE intake_link_selections (
        id text PRIMARY KEY, file_id text, link_type text, direction text,
        target_source_id text, target_slug text,
        UNIQUE (file_id, link_type, direction, target_source_id, target_slug)
      );
      CREATE TABLE intake_new_objects (
        id text PRIMARY KEY, file_id text, source_id text, slug text,
        UNIQUE (file_id, source_id, slug)
      );
      CREATE TABLE intake_object_link_selections (
        id text PRIMARY KEY, object_id text, link_type text, direction text,
        target_source_id text, target_slug text,
        UNIQUE (object_id, link_type, direction, target_source_id, target_slug)
      );
      CREATE TABLE intake_review_items (id text PRIMARY KEY);
    `);

  } finally { await externalFixture.end(); }

  const frozenSequences = rowsFromTsv('G5-RUNTIME-SEQUENCES-CATALOG-READONLY.tsv');
  const sequenceNames = frozenSequences.map((row) => row.sequence_name);
  if (frozenSequences.length !== 49 || new Set(sequenceNames).size !== 49 || frozenSequences.some((row) => row.sequence_schema !== 'public' || row.owner !== 'gbrain' || row.acl !== '[NULL]')) throw new Error('frozen sequence ACL fixture mismatch');
  const fixtureAdmin = connectSql(gbrainUrl('postgres', 'postgres'));
  let normalizedSequenceAcls = 0;
  try {
    normalizedSequenceAcls = await fixtureAdmin.begin(async (tx) => {
      // Disposable fixture only: application bootstrap leaves explicit owner-USAGE
      // ACLs, while all 49 reviewed production sequences have relacl=NULL.
      const before = await tx.unsafe<{ total: string; target: string; wrong_owner: string; acl_tuples: string; invalid_acl_tuples: string; acl_dependencies: string }[]>(`
        WITH target AS (
          SELECT c.oid,c.relowner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='S' AND c.relname=ANY($1::text[])
        )
        SELECT
          (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S') total,
          (SELECT count(*)::text FROM target) target,
          (SELECT count(*)::text FROM target t JOIN pg_roles r ON r.oid=t.relowner WHERE r.rolname<>'gbrain') wrong_owner,
          (SELECT count(a.privilege_type)::text FROM target t LEFT JOIN LATERAL aclexplode(t.relacl) a ON true) acl_tuples,
          (SELECT count(*)::text FROM target t LEFT JOIN LATERAL aclexplode(t.relacl) a ON true
           WHERE a.grantor IS DISTINCT FROM t.relowner OR a.grantee IS DISTINCT FROM t.relowner
              OR a.privilege_type IS DISTINCT FROM 'USAGE' OR a.is_grantable IS DISTINCT FROM false) invalid_acl_tuples,
          (SELECT count(*)::text FROM pg_shdepend d JOIN target t ON d.classid='pg_class'::regclass AND d.objid=t.oid AND d.objsubid=0
           WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND d.deptype='a') acl_dependencies`,
        [sequenceNames],
      );
      const pre = before[0];
      if (pre?.total !== '49' || pre.target !== '49' || pre.wrong_owner !== '0' || pre.acl_tuples !== '49' || pre.invalid_acl_tuples !== '0' || pre.acl_dependencies !== '0') throw new Error(`sequence ACL fixture pre-state mismatch: ${JSON.stringify(pre ?? {})}`);
      const updated = await tx.unsafe<{ relname: string }[]>(
        `UPDATE pg_class c SET relacl=NULL FROM pg_namespace n
         WHERE n.oid=c.relnamespace AND n.nspname='public' AND c.relkind='S'
           AND c.relname=ANY($1::text[]) RETURNING c.relname`,
        [sequenceNames],
      );
      const state = await tx<{ total: string; non_null: string }[]>`
        SELECT count(*)::text total,count(*) FILTER (WHERE c.relacl IS NOT NULL)::text non_null
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='S'`;
      if (updated.length !== 49 || state[0]?.total !== '49' || state[0]?.non_null !== '0') throw new Error('sequence ACL fixture normalization mismatch');
      return updated.length;
    });
  } finally { await fixtureAdmin.end(); }

  const census = await baselineCensus();
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(resolve(RECEIPT_DIR, 'baseline-census.json'), JSON.stringify(census, null, 2) + '\n');
  if (!census.complete) throw new Error(`baseline catalog mismatch: ${JSON.stringify(census.mismatches)}`);
  writeStage('baseline', { census_sha256: sha256Json(census), sequence_acl_null_count: normalizedSequenceAcls, complete: true });
}

function rowsFromTsv(name: string): Array<Record<string, string>> {
  const lines = readFileSync(resolve(CONTROL, name), 'utf8').trimEnd().split('\n');
  const headers = lines.shift()!.split('\t');
  return lines.map((line) => Object.fromEntries(line.split('\t').map((value, index) => [headers[index], value])));
}

async function baselineCensus() {
  const admin = connectSql(gbrainUrl('postgres', 'postgres'));
  try {
    const expectedTables = new Set(JSON.parse(readFileSync(resolve(CONTROL, 'G5-RUNTIME-TABLE-COMMAND-MODEL-PROVISIONAL.json'), 'utf8')).entries.map((entry: { table: string }) => entry.table));
    const expectedSequences = new Set(JSON.parse(readFileSync(resolve(CONTROL, 'G5-RUNTIME-SEQUENCE-ACL-PROVISIONAL.json'), 'utf8')).entries.map((entry: { sequence: string }) => entry.sequence));
    const expectedRoutines = new Set(rowsFromTsv('G5-RUNTIME-ROUTINE-EXTENSION-MAP-READONLY.tsv').map((row) => row.signature.startsWith('public.') ? row.signature : `public.${row.signature}`));
    const expectedTypes = new Set(rowsFromTsv('G5-RUNTIME-TYPES-CATALOG-READONLY.tsv').map((row) => row.type_name));
    const expectedIndexes = new Set(rowsFromTsv('G5-INDEX-IDENTITIES-READONLY.tsv').map((row) => row.index_name));
    const actualTables = new Set((await admin<{ name: string }[]>`SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')`).map((row) => row.name));
    const actualSequences = new Set((await admin<{ name: string }[]>`SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'`).map((row) => row.name));
    const actualRoutines = new Set((await admin<{ signature: string }[]>`SELECT 'public.'||regexp_replace(p.oid::regprocedure::text,'^public\\.','') signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`).map((row) => row.signature));
    const actualTypes = new Set((await admin<{ name: string }[]>`SELECT t.typname name FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'`).map((row) => row.name));
    const actualIndexes = new Set((await admin<{ name: string }[]>`SELECT i.relname name FROM pg_class i JOIN pg_namespace n ON n.oid=i.relnamespace WHERE n.nspname='public' AND i.relkind IN ('i','I')`).map((row) => row.name));
    const diff = (expected: Set<string>, actual: Set<string>) => ({ missing: [...expected].filter((x) => !actual.has(x)).sort(), extra: [...actual].filter((x) => !expected.has(x)).sort() });
    const mismatches = {
      tables: diff(expectedTables, actualTables), sequences: diff(expectedSequences, actualSequences), routines: diff(expectedRoutines, actualRoutines),
      types: diff(expectedTypes, actualTypes), indexes: diff(expectedIndexes, actualIndexes),
    };
    const extensions = await admin<{ extname: string; extversion: string }[]>`SELECT extname,extversion FROM pg_extension ORDER BY extname`;
    const version = await admin<{ server_version_num: string }[]>`SELECT current_setting('server_version_num') server_version_num`;
    const serverVersionNum = Number(version[0]?.server_version_num);
    const required = new Map([['pg_trgm', '1.6'], ['pgcrypto', '1.3'], ['vector', '0.6.0']]);
    const extensionMismatch = [...required].filter(([name, version]) => !extensions.some((row) => row.extname === name && row.extversion === version));
    const complete = Object.values(mismatches).every((value) => value.missing.length === 0 && value.extra.length === 0) && extensionMismatch.length === 0 && serverVersionNum >= 160000 && serverVersionNum < 170000;
    return { complete, server_version_num: serverVersionNum, counts: { tables: actualTables.size, sequences: actualSequences.size, routines: actualRoutines.size, types: actualTypes.size, indexes: actualIndexes.size }, mismatches, extensions, extensionMismatch };
  } finally {
    await admin.end();
  }
}

async function executeGuarded(name: string, databaseUrl = gbrainUrl('postgres', 'postgres')): Promise<void> {
  const guarded = readFileSync(resolve(CONTROL, name), 'utf8');
  const body = stripNoexecGuard(guarded);
  const sql = connectSql(databaseUrl);
  try { await sql.unsafe(body); } finally { await sql.end(); }
}

async function applyS2(): Promise<void> {
  await executeGuarded('G5-ACL-S2-ASSEMBLED-NOEXEC.sql.txt');
  await executeGuarded('G5-RUNTIME-ACL-EXACT-POSTCONDITIONS-NOEXEC.sql.txt'); // fresh administrator connection
  writeStage('apply', { assembled_s2_sha256: createHash('sha256').update(readFileSync(resolve(CONTROL, 'G5-ACL-S2-ASSEMBLED-NOEXEC.sql.txt'))).digest('hex'), fresh_admin_verifier: true });
}

async function proveTransactionalRollback(): Promise<void> {
  const guarded = readFileSync(resolve(CONTROL, 'G5-ACL-S2-ASSEMBLED-NOEXEC.sql.txt'), 'utf8');
  const body = stripNoexecGuard(guarded);
  const marker = '\nCOMMIT;\n';
  if (body.lastIndexOf(marker) !== body.indexOf(marker)) throw new Error('assembled COMMIT cardinality mismatch');
  const injected = body.replace(marker, "\nDO $g5_injected$ BEGIN RAISE EXCEPTION USING ERRCODE='Z5R01', MESSAGE='G5_HOSTED_FORCED_ROLLBACK_REACHED'; END $g5_injected$;\nCOMMIT;\n");
  const admin = connectSql(gbrainUrl('postgres', 'postgres'));
  try {
    await expectSqlState(() => admin.unsafe(injected), 'Z5R01', 'forced S2 rollback', undefined, 'G5_HOSTED_FORCED_ROLLBACK_REACHED');
    await admin.unsafe('ROLLBACK');
    const roles = await admin<{ count: string }[]>`SELECT count(*)::text count FROM pg_roles WHERE rolname IN ('gbrain_runtime','gbrain_migrator','gbrain_migration_owner')`;
    if (roles[0]?.count !== '0') throw new Error('forced rollback left target roles');
  } finally { await admin.end(); }
  const census = await baselineCensus();
  if (!census.complete) throw new Error('forced rollback changed baseline catalog');
  writeStage('forced-rollback', { sqlstate: 'Z5R01', marker: 'G5_HOSTED_FORCED_ROLLBACK_REACHED', baseline_census_sha256: sha256Json(census), complete: true });
}

async function expectSqlState(action: () => Promise<unknown>, expected: string, label: string, sqlstates?: Record<string, number>, expectedMessage?: string): Promise<void> {
  try { await action(); } catch (error) {
    if ((error as { code?: string }).code === expected) {
      if (expectedMessage && (error as { message?: string }).message !== expectedMessage) throw new Error(`${label}: expected exact marker message`);
      if (sqlstates) sqlstates[expected] = (sqlstates[expected] ?? 0) + 1;
      return;
    }
    throw new Error(`${label}: expected SQLSTATE ${expected}, got ${(error as { code?: string }).code ?? String(error)}`);
  }
  throw new Error(`${label}: expected SQLSTATE ${expected}, command succeeded`);
}

async function rolledBackStatement(sql: postgres.Sql, statement: string): Promise<unknown> {
  await sql.unsafe('BEGIN');
  try { return await sql.unsafe(statement); }
  finally { await sql.unsafe('ROLLBACK'); }
}

async function runFunctionalProbes(runtime: postgres.Sql, migrator: postgres.Sql, sqlstates: Record<string, number>): Promise<{ positive: number; negative: number }> {
  const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
  const { runPageToAliasCore } = await import('../src/core/schema-pack/page-to-alias.ts');
  let positive = 0, negative = 0;
  const runtimeUrl = gbrainUrl('gbrain_runtime', RUNTIME_PASSWORD);
  const engine = new PostgresEngine();
  await engine.connect({ database_url: runtimeUrl });
  try {
    const beforeClock = await runtime<{ last_value: string }[]>`SELECT last_value::text FROM public.page_generation_clock_seq`;
    await engine.putPage('g5-hosted/canonical', { type: 'concept', title: 'G5 Canonical', compiled_truth: 'canonical body', timeline: '', source_path: 'g5-canonical.md' });
    await engine.putPage('g5-hosted/redirect', { type: 'concept-redirect' as never, title: 'G5 Redirect', compiled_truth: '[[g5-hosted/canonical]] redirect body', timeline: '', source_path: 'g5-redirect.md' });
    const alias = await runPageToAliasCore({ engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false } as unknown as OperationContext, {
      rules: [{ from_type: 'concept-redirect', canonical_from: 'body_first_link', alias_slug_from: 'slug', notes_from: 'body_excerpt' }], apply: true,
    });
    if (alias.total_aliased !== 1) throw new Error('protected unify-types alias probe failed');
    const page = await engine.executeRaw<{ id: number; search_ready: boolean }>("SELECT id,(search_vector IS NOT NULL) search_ready FROM pages WHERE slug='g5-hosted/canonical'");
    if (!page[0]?.search_ready) throw new Error('page search-vector trigger failed');
    const afterClock = await runtime<{ last_value: string }[]>`SELECT last_value::text FROM public.page_generation_clock_seq`;
    if (BigInt(afterClock[0]!.last_value) <= BigInt(beforeClock[0]!.last_value)) throw new Error('page generation clock trigger failed');
    positive += 3;

    // Exact candidate schema binds content_chunks.embedding to vector(1536).
    const embeddingLiteral = `[${new Array(1536).fill('0').join(',')}]`;
    await engine.executeRaw(`INSERT INTO content_chunks (page_id,chunk_index,chunk_text,chunk_source,embedding)
      VALUES ($1,0,'g5 hosted searchable chunk','compiled_truth',$2::vector)`, [page[0]!.id, embeddingLiteral]);
    const chunk = await engine.executeRaw<{ ready: boolean }>("SELECT (search_vector IS NOT NULL) ready FROM content_chunks WHERE page_id=$1", [page[0]!.id]);
    if (!chunk[0]?.ready) throw new Error('chunk search-vector trigger failed');
    await engine.executeRaw("INSERT INTO minion_jobs (queue,name,data,status) VALUES ('default','g5-hosted','{}'::jsonb,'waiting')");
    positive += 2;

    await engine.executeRaw("INSERT INTO access_tokens (name,token_hash,permissions) VALUES ('g5-hosted','synthetic-hash','{}'::jsonb)");
    const token = await engine.executeRaw<{ ok: boolean }>("SELECT (id IS NOT NULL) ok FROM access_tokens WHERE name='g5-hosted'");
    if (!token[0]?.ok) throw new Error('access_tokens UUID default failed');
    positive++;

    await engine.executeRaw(`INSERT INTO sources (id,name,local_path,config) VALUES
      ('g5-personal','G5 Personal','/tmp/g5-personal','{}'::jsonb),('g5-shared','G5 Shared','/tmp/g5-shared','{}'::jsonb)`);
    await engine.executeRaw("INSERT INTO portal_users (email,personal_source_id,status) VALUES ('g5-user@example.invalid','g5-personal','active')");
    await engine.executeRaw("UPDATE portal_users SET keycloak_sub='g5-kc' WHERE email='g5-user@example.invalid'");
    await engine.executeRaw("INSERT INTO portal_source_grants (user_email,source_id,can_read,can_write) VALUES ('g5-user@example.invalid','g5-shared',true,false)");
    await engine.executeRaw("UPDATE portal_source_grants SET can_write=true WHERE user_email='g5-user@example.invalid' AND source_id='g5-shared'");
    await engine.executeRaw("INSERT INTO portal_acl_audit (actor_email,subject_email,action,before_state,after_state) VALUES ('g5-user@example.invalid','g5-user@example.invalid','g5-hosted','{}'::jsonb,'{}'::jsonb)");
    positive += 3;

    await migrator.unsafe('SET ROLE gbrain_migration_owner');
    await expectSqlState(() => migrator.unsafe("UPDATE public.portal_acl_audit SET action='forbidden' WHERE action='g5-hosted'"), 'P0001', 'portal audit append-only trigger', sqlstates);
    await migrator.unsafe('RESET ROLE');
    negative++;

    await runtime.unsafe('SET enable_seqscan=off');
    const trigramPlan = await runtime.unsafe("EXPLAIN (FORMAT JSON) SELECT * FROM public.pages WHERE title % 'G5 Canonical'");
    const vectorPlan = await runtime.unsafe("EXPLAIN (FORMAT JSON) SELECT * FROM public.content_chunks ORDER BY embedding <=> $1::vector LIMIT 1", [embeddingLiteral]);
    await runtime.unsafe('RESET enable_seqscan');
    if (!JSON.stringify(trigramPlan).includes('idx_pages_trgm')) throw new Error('indexed trigram path not selected');
    if (!JSON.stringify(vectorPlan).includes('idx_chunks_embedding')) throw new Error('HNSW vector path not selected');
    positive += 2;

    const triggerFunctions = rowsFromTsv('G5-RUNTIME-ROUTINE-EXTENSION-MAP-READONLY.tsv').filter((row) => row.extension === '[none]').map((row) => row.signature);
    if (triggerFunctions.length !== 9) throw new Error('application trigger routine inventory mismatch');
    for (const signature of triggerFunctions) {
      await expectSqlState(() => runtime.unsafe(`SELECT public.${signature}`), '42501', `direct trigger routine ${signature}`, sqlstates);
      negative++;
    }
    await expectSqlState(() => runtime.unsafe('ALTER TABLE public.pages ADD COLUMN g5_forbidden integer'), '42501', 'runtime ALTER TABLE', sqlstates);
    await expectSqlState(() => runtime.unsafe('CREATE TABLE public.g5_forbidden(id integer)'), '42501', 'runtime CREATE TABLE', sqlstates);
    negative += 2;

    const admin = connectSql(gbrainUrl('postgres', 'postgres'));
    try {
      const sequenceModel = JSON.parse(readFileSync(resolve(CONTROL, 'G5-RUNTIME-SEQUENCE-ACL-PROVISIONAL.json'), 'utf8')) as { entries: Array<{ sequence: string; runtime_privileges: string[] }> };
      const usage = new Set(sequenceModel.entries.filter((entry) => entry.runtime_privileges.includes('USAGE')).map((entry) => entry.sequence));
      const dependencies = rowsFromTsv('G5-RUNTIME-SEQUENCE-DEPENDENCIES-READONLY.tsv').filter((row) => usage.has(row.sequence_name));
      if (dependencies.length !== usage.size - 1) throw new Error('serial sequence dependency coverage mismatch'); // page clock is trigger-owned
      for (const dependency of dependencies) {
        const before = await admin<{ value: string }[]>`SELECT last_value::text value FROM ${admin(`public.${dependency.sequence_name}`)}`;
        try { await runtime.unsafe(`INSERT INTO public.${sqlIdent(dependency.table_name)} (${sqlIdent(dependency.column_name)}) VALUES (DEFAULT)`); }
        catch (error) { if ((error as { code?: string }).code === '42501') throw error; }
        const after = await admin<{ value: string }[]>`SELECT last_value::text value FROM ${admin(`public.${dependency.sequence_name}`)}`;
        if (BigInt(after[0]!.value) <= BigInt(before[0]!.value)) throw new Error(`omitted-ID sequence did not advance: ${dependency.sequence_name}`);
        positive++;
      }
    } finally { await admin.end(); }
  } finally { await engine.disconnect(); }
  return { positive, negative };
}

async function probeRuntime(): Promise<void> {
  const admin = connectSql(gbrainUrl('postgres', 'postgres'));
  await setSyntheticPassword(admin, 'gbrain_runtime', RUNTIME_PASSWORD);
  await setSyntheticPassword(admin, 'gbrain_migrator', MIGRATOR_PASSWORD);
  await admin.end();

  const runtime = connectSql(gbrainUrl('gbrain_runtime', RUNTIME_PASSWORD));
  const migrator = connectSql(gbrainUrl('gbrain_migrator', MIGRATOR_PASSWORD));
  const model = JSON.parse(readFileSync(resolve(CONTROL, 'G5-RUNTIME-TABLE-COMMAND-MODEL-PROVISIONAL.json'), 'utf8')) as { entries: Array<{ table: string; commands: string[] }> };
  const sequenceModel = JSON.parse(readFileSync(resolve(CONTROL, 'G5-RUNTIME-SEQUENCE-ACL-PROVISIONAL.json'), 'utf8')) as { entries: Array<{ sequence: string; runtime_privileges: string[] }> };
  let positive = 0, negative = 0;
  const sqlstates: Record<string, number> = {};
  try {
    const identity = await runtime<{ session_user: string; current_user: string }[]>`SELECT session_user,current_user`;
    if (identity[0]?.session_user !== 'gbrain_runtime' || identity[0]?.current_user !== 'gbrain_runtime') throw new Error('runtime identity mismatch');
    await expectSqlState(() => runtime.unsafe('SET ROLE gbrain_migration_owner'), '42501', 'runtime SET ROLE owner', sqlstates);
    const migratorIdentity = await migrator<{ session_user: string; current_user: string }[]>`SELECT session_user,current_user`;
    if (migratorIdentity[0]?.current_user !== 'gbrain_migrator') throw new Error('migrator must not inherit owner');
    await migrator.unsafe('SET ROLE gbrain_migration_owner');
    const afterSet = await migrator<{ current_user: string }[]>`SELECT current_user`;
    if (afterSet[0]?.current_user !== 'gbrain_migration_owner') throw new Error('migrator SET ROLE failed');
    await migrator.unsafe('RESET ROLE');

    const columns = await runtime<{ table_name: string; column_name: string; type_sql: string }[]>`
      SELECT c.relname table_name,a.attname column_name,format_type(a.atttypid,a.atttypmod) type_sql
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
        AND a.attgenerated='' AND a.attidentity=''
      ORDER BY c.relname,a.attnum`;
    const columnsByTable = new Map<string, Array<{ column_name: string; type_sql: string }>>();
    for (const column of columns) {
      const list = columnsByTable.get(column.table_name) ?? [];
      list.push(column);
      columnsByTable.set(column.table_name, list);
    }
    for (const entry of model.entries) {
      const table = `public.${sqlIdent(entry.table)}`;
      const tableColumns = columnsByTable.get(entry.table);
      if (!tableColumns?.length) throw new Error(`no writable column: ${entry.table}`);
      const insertStatement = buildZeroRowInsert(entry.table, tableColumns);
      const updateColumn = sqlIdent(tableColumns[0].column_name);
      const actions: Record<string, () => Promise<unknown>> = {
        SELECT: () => rolledBackStatement(runtime, `SELECT * FROM ${table} LIMIT 0`),
        INSERT: () => rolledBackStatement(runtime, insertStatement),
        UPDATE: () => rolledBackStatement(runtime, `UPDATE ${table} SET ${updateColumn}=DEFAULT WHERE false`),
        DELETE: () => rolledBackStatement(runtime, `DELETE FROM ${table} WHERE false`),
      };
      for (const command of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const expected = entry.commands.includes(command);
        const privilege = await runtime<{ allowed: boolean }[]>`SELECT has_table_privilege('gbrain_runtime', ${`public.${entry.table}`}, ${command}) allowed`;
        if (privilege[0]?.allowed !== expected) throw new Error(`${entry.table} ${command}: has_table_privilege mismatch`);
        if (expected) { await actions[command](); positive++; }
        else { await expectSqlState(actions[command], '42501', `${entry.table} ${command}`, sqlstates); negative++; }
      }
      await expectSqlState(() => rolledBackStatement(runtime, `TRUNCATE TABLE ${table}`), '42501', `${entry.table} TRUNCATE`, sqlstates);
      negative++;
    }

    for (const entry of sequenceModel.entries) {
      const sequence = `public.${sqlIdent(entry.sequence)}`;
      for (const [privilegeName, statement] of [
        ['USAGE', `SELECT nextval('${sequence}'::regclass)`],
        ['SELECT', `SELECT last_value FROM ${sequence}`],
        ['UPDATE', `SELECT setval('${sequence}'::regclass, 1, false)`],
      ] as const) {
        const expected = entry.runtime_privileges.includes(privilegeName);
        const privilege = await runtime<{ allowed: boolean }[]>`SELECT has_sequence_privilege('gbrain_runtime', ${`public.${entry.sequence}`}, ${privilegeName}) allowed`;
        if (privilege[0]?.allowed !== expected) throw new Error(`${entry.sequence} ${privilegeName}: has_sequence_privilege mismatch`);
        if (expected) { await runtime.unsafe(statement); positive++; }
        else { await expectSqlState(() => runtime.unsafe(statement), '42501', `${entry.sequence} ${privilegeName}`, sqlstates); negative++; }
      }
    }

    await runtime.unsafe("SELECT public.similarity('abc','abc')");
    await runtime.unsafe("SELECT public.similarity_op('abc','abc')");
    await runtime.unsafe("SELECT public.cosine_distance('[1,0]'::vector,'[1,0]'::vector)");
    await runtime.unsafe('SELECT public.gen_random_uuid()');
    positive += 4;
    await expectSqlState(() => runtime.unsafe("SELECT public.digest('abc','sha256')"), '42501', 'pgcrypto digest', sqlstates);
    await expectSqlState(() => runtime.unsafe("SELECT public.show_trgm('abc')"), '42501', 'show_trgm', sqlstates);
    await expectSqlState(() => runtime.unsafe("SELECT public.vector_dims('[1,2]'::vector)"), '42501', 'vector_dims', sqlstates);
    negative += 3;
    const functional = await runFunctionalProbes(runtime, migrator, sqlstates);
    positive += functional.positive;
    negative += functional.negative;
    if (positive !== 344 || negative !== 338 || sqlstates['42501'] !== 338 || sqlstates['P0001'] !== 1) {
      throw new Error(`probe count mismatch: ${JSON.stringify({ positive, negative, sqlstates })}`);
    }
  } finally {
    await runtime.end(); await migrator.end();
    const reset = connectSql(gbrainUrl('postgres', 'postgres'));
    await reset.unsafe('ALTER ROLE gbrain_runtime PASSWORD NULL; ALTER ROLE gbrain_migrator PASSWORD NULL');
    await reset.end();
  }
  await executeGuarded('G5-RUNTIME-ACL-EXACT-POSTCONDITIONS-NOEXEC.sql.txt');
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(resolve(RECEIPT_DIR, 'probe-counts.json'), JSON.stringify({ positive, negative, sqlstates }, null, 2) + '\n');
  writeStage('probe', { positive, negative, sqlstates, complete: true });
}

async function verifyRestored(): Promise<void> {
  await executeGuarded('G5-RUNTIME-ACL-EXACT-INVERSE-POSTCONDITIONS-NOEXEC.sql.txt');
  const restored = await baselineCensus();
  const baselineCensusValue = JSON.parse(readFileSync(resolve(RECEIPT_DIR, 'baseline-census.json'), 'utf8'));
  if (!restored.complete || sha256Json(restored) !== sha256Json(baselineCensusValue)) throw new Error('restored census differs from baseline');
  writeStage('restore', { census_sha256: sha256Json(restored), inverse_verifier: true, complete: true });
}

async function writeReceipt(): Promise<void> {
  const census = await baselineCensus();
  const probePath = resolve(RECEIPT_DIR, 'probe-counts.json');
  if (!census.complete || !existsSync(probePath)) throw new Error('cannot seal incomplete hosted receipt');
  const probeCounts = JSON.parse(readFileSync(probePath, 'utf8')) as { positive: number; negative: number; sqlstates: Record<string, number> };
  if (probeCounts.positive !== 344 || probeCounts.negative !== 338 || probeCounts.sqlstates['42501'] !== 338 || probeCounts.sqlstates['P0001'] !== 1) throw new Error('invalid probe counts');
  const baselineStage = readStage('baseline');
  const forcedRollbackStage = readStage('forced-rollback');
  const applyStage = readStage('apply');
  const probeStage = readStage('probe');
  const extensionRestoreStage = readStage('extension-restore');
  const restoreStage = readStage('restore');
  const baselineSchemaHash = readFileSync(resolve(RECEIPT_DIR, 'baseline-schema.sha256'), 'utf8').trim().split(/\s+/)[0];
  const restoredSchemaHash = readFileSync(resolve(RECEIPT_DIR, 'restored-schema.sha256'), 'utf8').trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(baselineSchemaHash) || baselineSchemaHash !== restoredSchemaHash) throw new Error('schema restore hash mismatch');
  const data = {
    application_candidate_sha: APP_CANDIDATE_SHA,
    harness_sha: process.env.GITHUB_SHA ?? '[LOCAL-NO-RUN]',
    run_id: process.env.GITHUB_RUN_ID ?? '[LOCAL-NO-RUN]',
    run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '[LOCAL-NO-RUN]',
    acl_binding_sha256: binding.bindingSha256,
    acl_entries: binding.entries,
    assembled_s2_sha256: createHash('sha256').update(readFileSync(resolve(CONTROL, 'G5-ACL-S2-ASSEMBLED-NOEXEC.sql.txt'))).digest('hex'),
    baseline_complete: census.complete,
    extension_versions: census.extensions,
    server_version_num: census.server_version_num,
    positive_probe_count: probeCounts.positive,
    negative_probe_count: probeCounts.negative,
    stage_hashes: { baseline: sha256Json(baselineStage), forced_rollback: sha256Json(forcedRollbackStage), apply: sha256Json(applyStage), probe: sha256Json(probeStage), extension_restore: sha256Json(extensionRestoreStage), restore: sha256Json(restoreStage) },
    baseline_schema_sha256: baselineSchemaHash,
    restored_schema_sha256: restoredSchemaHash,
    forward_verifier_sha256: createHash('sha256').update(readFileSync(resolve(CONTROL, 'G5-RUNTIME-ACL-EXACT-POSTCONDITIONS-NOEXEC.sql.txt'))).digest('hex'),
    inverse_verifier_sha256: createHash('sha256').update(readFileSync(resolve(CONTROL, 'G5-RUNTIME-ACL-EXACT-INVERSE-POSTCONDITIONS-NOEXEC.sql.txt'))).digest('hex'),
    application_candidate_tree_sha: 'b2b0eb03230ac447cf1b3d7cad8fa18468ae2e8d',
    full_restore_identity: true,
    logical_dump_alone_full_restore_identity: false,
    governed_extension_owner_reconstruction: true,
    postgres_image_digest: 'sha256:b740286128ce8e232fe0de3c8db2267d91aedc598dfbeaefb7ffb0b79ceef1b3',
    production_db_or_services_touched: false,
    complete: true,
  };
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(resolve(RECEIPT_DIR, 'receipt.json'), JSON.stringify(data, null, 2) + '\n');
}

const mode = process.argv[2];
if (mode === 'init') {
  mkdirSync(RECEIPT_DIR, { recursive: true });
  const state: RunState = { nonce: randomBytes(16).toString('hex'), binding_sha256: binding.bindingSha256, application_candidate_sha: APP_CANDIDATE_SHA };
  const stateTemp = `${STATE_PATH}.tmp-${process.pid}`;
  writeFileSync(stateTemp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
  renameSync(stateTemp, STATE_PATH);
} else if (mode === 'baseline') await initBaseline();
else if (mode === 'forced-rollback') await proveTransactionalRollback();
else if (mode === 'apply') await applyS2();
else if (mode === 'probe') await probeRuntime();
else if (mode === 'cleanup') await executeGuarded('G5-HOSTED-ACL-ROLE-CLEANUP-NOEXEC.sql.txt', ADMIN_URL);
else if (mode === 'set-recovery-credential') {
  const admin = connectSql(ADMIN_URL);
  await setSyntheticPassword(admin, 'gbrain', LEGACY_PASSWORD);
  await admin.end();
} else if (mode === 'elevate-legacy-for-restore') {
  const admin = connectSql(ADMIN_URL);
  try {
    await admin.unsafe('ALTER ROLE gbrain SUPERUSER');
    const rows = await admin<{ elevated: boolean }[]>`SELECT rolsuper AND rolcanlogin elevated FROM pg_roles WHERE rolname='gbrain'`;
    if (rows[0]?.elevated !== true) throw new Error('legacy restore elevation failed');
  } finally { await admin.end(); }
} else if (mode === 'seal-legacy-after-restore') {
  const admin = connectSql(ADMIN_URL);
  try {
    await admin.unsafe('ALTER ROLE gbrain NOSUPERUSER');
    const rows = await admin<{ sealed: boolean }[]>`SELECT NOT rolsuper AND rolcanlogin AND rolbypassrls sealed FROM pg_roles WHERE rolname='gbrain'`;
    if (rows[0]?.sealed !== true) throw new Error('legacy restore seal failed');
  } finally { await admin.end(); }
} else if (mode === 'ensure-legacy-sealed') {
  const admin = connectSql(ADMIN_URL);
  try {
    const before = await admin<{ exists: boolean; superuser: boolean }[]>`SELECT true exists,rolsuper superuser FROM pg_roles WHERE rolname='gbrain'`;
    if (before[0]?.superuser === true) await admin.unsafe('ALTER ROLE gbrain NOSUPERUSER');
    const after = await admin<{ exists: boolean; superuser: boolean }[]>`SELECT true exists,rolsuper superuser FROM pg_roles WHERE rolname='gbrain'`;
    const attestation = { role_exists: after[0]?.exists === true, superuser: after[0]?.superuser === true, safe: after[0]?.superuser !== true, complete: after[0]?.superuser !== true };
    writeStage('seal-attestation', attestation);
    if (!attestation.safe) throw new Error('legacy role remains superuser');
  } finally { await admin.end(); }
} else if (mode === 'verify-restored') await verifyRestored();
else if (mode === 'reconstruct-extension-owners') {
  const admin = connectSql(gbrainUrl('postgres', 'postgres'));
  try {
    const topology = await reconstructExtensionContainerOwners(admin);
    writeStage('extension-restore', { ...topology, logical_dump_alone_sufficient: false, complete: true });
  } finally { await admin.end(); }
}
else if (mode === 'receipt') await writeReceipt();
else if (mode === 'failure-receipt') {
  mkdirSync(RECEIPT_DIR, { recursive: true });
  const stages = ['baseline', 'forced-rollback', 'apply', 'probe', 'extension-restore', 'restore', 'seal-attestation'].filter((name) => existsSync(resolve(RECEIPT_DIR, `${name}.json`)));
  writeFileSync(resolve(RECEIPT_DIR, 'receipt.json'), JSON.stringify({ complete: false, status: 'failed', stages, acl_binding_sha256: binding.bindingSha256, application_candidate_sha: APP_CANDIDATE_SHA, harness_sha: process.env.GITHUB_SHA ?? '[LOCAL-NO-RUN]', production_db_or_services_touched: false }, null, 2) + '\n');
}
else throw new Error(`unknown mode: ${mode}`);
