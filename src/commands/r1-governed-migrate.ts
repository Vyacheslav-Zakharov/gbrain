#!/usr/bin/env bun
/** Fixed Avers R1 Google migration runner. Production requires separate G5 GO. */
import postgres, { type Sql } from 'postgres';
import { closeSync, fsyncSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { configureGateway, embed, resetGateway } from '../core/ai/gateway.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { loadConfigFileSnapshotStrict } from '../core/config.ts';
import {
  R1_BACKUP_COLUMN,
  R1_ADVISORY_LOCK_KEY,
  R1_MIGRATION_OWNER_ROLE,
  R1_MIGRATOR_ROLE,
  R1_ABORTED_KEY,
  R1_NONCE_LEDGER_KEY,
  R1_COMPLETED_KEY,
  R1_SHADOW_COLUMN,
  R1_STATE_KEY,
  R1_TARGET_DIMENSIONS,
  R1_TARGET_MODEL,
  R1_SOURCE_DIMENSIONS,
  R1_SOURCE_MODEL,
  R1_WRITER_FENCE_KEY,
  R1_WRITER_FENCE_TABLES,
  assertR1DatabaseTarget,
  assertR1CompletionReality,
  assertR1AbortPrepareAuthority,
  assertR1FenceDisableAuthority,
  assertR1RegistrySafeForPrepare,
  assertR1NonDbRuntimeConfig,
  assertR1ZeroZeRuntimeConfig,
  assertR1EnvTarget,
  assertReadyForCutover,
  buildCutoverStatements,
  buildRollbackStatements,
  buildAbortPrepareStatements,
  buildR1MigrationIdentity,
  buildWriterFenceDropSql,
  buildWriterFenceSql,
  identityFingerprint,
  isExactR1WriterFence,
  parseR1MigrationArgs,
  parseR1EmbeddingRegistry,
  resolveR1WriterFenceTables,
  resolveContentPlaneCounts,
  runR1FenceLiftAfterDropHookForTests,
  runR1AbortPrepareAfterCleanupHookForTests,
  runR1ReceiptFinalizeHookForTests,
  writeR1BytesFully,
  vectorLiteral,
  type R1CutoverStatus,
  type R1MigrationArgs,
  type R1Target,
  type R1MigrationIdentity,
  type R1CompletionReality,
  type R1WriterFenceRow,
} from '../core/r1-governed-migration.ts';

interface ColumnRow { type: string }
interface CountRow { total: number; populated: number }
interface AdvisoryLockRow { backend_pid: number; ok: boolean }
interface RoleIdentityRow { current_user: string; session_user: string; search_path: string }

export async function assumeProductionMigrationOwner(sql: Sql): Promise<void> {
  await sql.unsafe('SET ROLE gbrain_migration_owner');
  await sql.unsafe('SET search_path TO pg_catalog, public');
  const rows = await sql.unsafe("SELECT current_user, session_user, current_setting('search_path') AS search_path") as RoleIdentityRow[];
  if (rows[0]?.current_user !== R1_MIGRATION_OWNER_ROLE || rows[0]?.session_user !== R1_MIGRATOR_ROLE
    || rows[0]?.search_path !== 'pg_catalog, public') {
    throw new Error('Production migration role identity or search_path mismatch');
  }
}

interface StateEnvelope {
  schema_version: 1;
  identity: R1MigrationIdentity;
  fingerprint: string;
  phase: 'preparing' | 'prepared' | 'cutover' | 'completed' | 'rolled_back';
  started_at: string;
  updated_at: string;
  from_model: string;
  from_dimensions: number;
  prior_reranker_model: string;
  prior_reranker_enabled: boolean;
  writer_fence_tables: string[];
  rollback_file_config_sha256?: string;
}

function nowIso(): string { return new Date().toISOString(); }
function assertPreCutoverStateEnvelope(state: StateEnvelope, identity: R1MigrationIdentity): void {
  const allowedKeys = ['schema_version','identity','fingerprint','phase','started_at','updated_at','from_model','from_dimensions','prior_reranker_model','prior_reranker_enabled','writer_fence_tables'].sort();
  if (JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(allowedKeys)) throw new Error('Pre-cutover state envelope has unknown or missing fields');
  const fingerprint = identityFingerprint(identity);
  if (state.schema_version !== 1 || identityFingerprint(state.identity) !== fingerprint || state.fingerprint !== fingerprint) throw new Error('Pre-cutover state identity is not canonical');
  if (state.phase !== 'preparing' && state.phase !== 'prepared') throw new Error(`Invalid pre-cutover phase ${state.phase}`);
  for (const timestamp of [state.started_at,state.updated_at]) if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error('Pre-cutover state timestamp is invalid');
  if (state.from_model !== R1_SOURCE_MODEL || state.from_dimensions !== 1280) throw new Error('Pre-cutover source identity is invalid');
  if (typeof state.prior_reranker_model !== 'string' || state.prior_reranker_model.length < 1 || typeof state.prior_reranker_enabled !== 'boolean') throw new Error('Pre-cutover reranker envelope is invalid');
  if (resolveR1WriterFenceTables(state).length === 0) throw new Error('Pre-cutover fence inventory is invalid');
}
async function getConfig(sql: Sql, key: string): Promise<string | null> {
  const rows = await sql.unsafe('SELECT value FROM config WHERE key=$1', [key]) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}
async function setConfig(sql: Sql, key: string, value: string): Promise<void> {
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
}
export async function validateHandoffNonceLedger(sql: Sql, target: R1Target, identity: R1MigrationIdentity, consume: boolean, requiredPriorNonce?: string): Promise<void> {
  if (target!=='production') return;
  const nonce=identity.handoff?.handoff_nonce;
  if (!nonce || !/^[0-9a-f]{64}$/.test(nonce)) throw new Error('Production handoff nonce is missing or invalid');
  const raw=await getConfig(sql,R1_NONCE_LEDGER_KEY);
  if (requiredPriorNonce && raw===null) throw new Error('Consumed-nonce ledger is missing after prior abort');
  let ledger:{schema_version:number;nonces:string[]}={schema_version:1,nonces:[]};
  if (raw!==null) {
    try { ledger=JSON.parse(raw); } catch { throw new Error('Consumed-nonce ledger is corrupt'); }
    if (ledger.schema_version!==1 || !Array.isArray(ledger.nonces) || ledger.nonces.length>4096
      || !ledger.nonces.every((value)=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value)) || new Set(ledger.nonces).size!==ledger.nonces.length) throw new Error('Consumed-nonce ledger is invalid');
  }
  const found=ledger.nonces.includes(nonce);
  if (requiredPriorNonce && (!/^[0-9a-f]{64}$/.test(requiredPriorNonce) || !ledger.nonces.includes(requiredPriorNonce))) {
    throw new Error('Prior aborted handoff nonce is absent from consumed-nonce ledger');
  }
  if (consume) {
    if (found) throw new Error('Production handoff nonce has already been consumed');
    if (ledger.nonces.length>=4096) throw new Error('Consumed-nonce ledger capacity reached; operator archival required');
    await setConfig(sql,R1_NONCE_LEDGER_KEY,JSON.stringify({schema_version:1,nonces:[...ledger.nonces,nonce]}));
  } else if (!found) throw new Error('Active production handoff nonce is absent from consumed-nonce ledger');
}

async function assertR1LockBackend(sql: Sql, expectedBackendPid: number): Promise<void> {
  const rows = await sql.unsafe(
    `SELECT pg_backend_pid()::int AS backend_pid,
            EXISTS (
              SELECT 1 FROM pg_locks
               WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
                 AND classid::bigint=(($1::bigint >> 32) & 4294967295)
                 AND objid::bigint=($1::bigint & 4294967295) AND objsubid=1
            ) AS lock_held`,
    [R1_ADVISORY_LOCK_KEY],
  ) as Array<{ backend_pid: number; lock_held: boolean }>;
  if (Number(rows[0]?.backend_pid) !== expectedBackendPid || rows[0]?.lock_held !== true) {
    throw new Error('R1_ADVISORY_LOCK_LOST');
  }
}

async function withR1MutationTransaction(
  sql: Sql,
  expectedBackendPid: number,
  fn: (lockedSql: Sql) => Promise<void>,
): Promise<void> {
  await sql.begin(async (tx) => {
    const lockedSql = tx as unknown as Sql;
    // PID check and writes share one transaction/connection. A disconnect
    // aborts the transaction instead of reconnecting past the session lock.
    await assertR1LockBackend(lockedSql, expectedBackendPid);
    await fn(lockedSql);
  });
}

async function columnType(sql: Sql, table: string, column: string): Promise<string | null> {
  const rows = await sql.unsafe(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=$1 AND a.attname=$2 AND a.attnum>0 AND NOT a.attisdropped`,
    [table, column],
  ) as ColumnRow[];
  return rows[0]?.type ?? null;
}
async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const rows = await sql.unsafe(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]) as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}
async function indexExists(sql: Sql, index: string): Promise<boolean> {
  const rows = await sql.unsafe(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${index}`]) as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}
async function assertCompleteProductionFenceInventory(sql: Sql, state: StateEnvelope, target: R1Target): Promise<void> {
  if (target !== 'production') return;
  const expected = await existingFenceTables(sql,target);
  const stamped = resolveR1WriterFenceTables(state);
  if (JSON.stringify(stamped) !== JSON.stringify(expected)) throw new Error('Production writer-fence inventory is not the complete existing approved catalog');
}
async function reservedFenceObjectsExist(sql: Sql): Promise<boolean> {
  const rows = await sql.unsafe(`SELECT
      to_regprocedure('public.avers_r1_writer_fence_guard()') IS NOT NULL AS has_function,
      EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND tg.tgname LIKE 'avers_r1_writer_fence\\_%' ESCAPE '\\') AS has_trigger`) as Array<{ has_function: boolean; has_trigger: boolean }>;
  return rows[0]?.has_function === true || rows[0]?.has_trigger === true;
}
async function assertFreshFenceNamespace(sql: Sql, allowDisabledMarker: boolean): Promise<void> {
  const marker = await getConfig(sql, R1_WRITER_FENCE_KEY);
  if (marker !== null && !(allowDisabledMarker && marker === 'disabled')) throw new Error('Fresh prepare refuses an existing writer-fence marker');
  if (await reservedFenceObjectsExist(sql)) throw new Error('Fresh prepare refuses pre-existing reserved fence objects');
}
async function assertReusableAbortMarker(sql: Sql, raw: string, identity: R1MigrationIdentity, target: R1Target): Promise<string | undefined> {
  let aborted: any;
  try { aborted=JSON.parse(raw); } catch { throw new Error('Prior abort marker is corrupt'); }
  let archivedFingerprint: string;
  try { archivedFingerprint=identityFingerprint(aborted.identity); } catch { throw new Error('Prior abort identity is invalid'); }
  if (aborted.schema_version!==1 || aborted.fingerprint!==archivedFingerprint || aborted.identity?.candidate_sha!==identity.candidate_sha
    || aborted.identity?.implementation_checksum!==identity.implementation_checksum || !['preparing','prepared'].includes(aborted.previous_phase)
    || !aborted.aborted_at || !Number.isFinite(Date.parse(aborted.aborted_at)) || new Date(aborted.aborted_at).toISOString()!==aborted.aborted_at
    || aborted.shadow_columns_removed!==true || aborted.source_model!==R1_SOURCE_MODEL || aborted.source_dimensions!==R1_SOURCE_DIMENSIONS) {
    throw new Error('Prior abort marker is not reusable authority');
  }
  try { assertPreCutoverStateEnvelope(aborted.pre_abort_state, aborted.identity); } catch { throw new Error('Prior abort marker lacks complete canonical pre-abort state'); }
  if (aborted.pre_abort_state.phase !== aborted.previous_phase
    || JSON.stringify(aborted.pre_abort_state.writer_fence_tables) !== JSON.stringify(aborted.writer_fence_tables)) {
    throw new Error('Prior abort pre-state does not match archived disposition');
  }
  const archived=resolveR1WriterFenceTables({writer_fence_tables:aborted.writer_fence_tables});
  if (archived.length===0) throw new Error('Prior abort inventory is missing');
  if (target==='production') {
    const expected=await existingFenceTables(sql,target);
    if (JSON.stringify(archived)!==JSON.stringify(expected)) throw new Error('Prior abort inventory differs from complete production catalog');
    const oldNonce=aborted.identity?.handoff?.handoff_nonce;
    const newNonce=identity.handoff?.handoff_nonce;
    if (!oldNonce || !newNonce || oldNonce===newNonce) throw new Error('New production prepare requires a fresh single-use handoff nonce');
    return oldNonce;
  } else if (archivedFingerprint===identityFingerprint(identity)) throw new Error('Clone prepare refuses replay of the same aborted identity');
  return undefined;
}
async function assertNoExtraHnswIndexes(sql: Sql, tables: string[], column: string, expectedNames: string[]): Promise<void> {
  const rows=await sql.unsafe(`SELECT DISTINCT i.relname AS index_name FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid
    JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=i.relam
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(ix.indkey)
    WHERE n.nspname='public' AND am.amname='hnsw' AND t.relname=ANY($1::text[]) AND a.attname=$2 ORDER BY i.relname`,[tables,column]) as Array<{index_name:string}>;
  if (JSON.stringify(rows.map((row)=>row.index_name))!==JSON.stringify([...expectedNames].sort())) throw new Error(`Unexpected HNSW index catalog for ${column}`);
}
async function assertPreparedIndexes(sql: Sql): Promise<void> {
  await assertNoExtraHnswIndexes(sql,['content_chunks','facts'],R1_SHADOW_COLUMN,['idx_chunks_embedding_r1_g768','idx_facts_embedding_r1_g768_hnsw']);
  const rows = await sql.unsafe(`SELECT i.relname AS index_name, t.relname AS table_name, am.amname AS method,
      ix.indisvalid AS valid, ix.indisready AS ready, ix.indislive AS live, ix.indisunique AS unique,
      ix.indisprimary AS primary, ix.indisexclusion AS exclusion, ix.indnatts::int AS natts,
      ix.indnkeyatts::int AS nkeyatts, pg_get_expr(ix.indexprs,ix.indrelid) AS expressions,
      i.reloptions AS reloptions, a.attname AS key_column, opc.opcname AS opclass,
      onsp.nspname AS opclass_schema, opf.opfname AS opfamily, pg_get_expr(ix.indpred,ix.indrelid) AS predicate
    FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_class t ON t.oid=ix.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=i.relam
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ix.indkey[0]
    JOIN pg_opclass opc ON opc.oid=ix.indclass[0]
    JOIN pg_namespace onsp ON onsp.oid=opc.opcnamespace JOIN pg_opfamily opf ON opf.oid=opc.opcfamily
    WHERE n.nspname='public' AND i.relname IN ('idx_chunks_embedding_r1_g768','idx_facts_embedding_r1_g768_hnsw')
    ORDER BY i.relname`) as Array<{ index_name: string; table_name: string; method: string; valid: boolean; ready: boolean; live: boolean;
      unique: boolean; primary: boolean; exclusion: boolean; natts: number; nkeyatts: number; expressions: string | null;
      reloptions: string[] | null; key_column: string; opclass: string; opclass_schema: string; opfamily: string; predicate: string | null }>;
  const expected = new Map([
    ['idx_chunks_embedding_r1_g768', { table: 'content_chunks', predicate: '(embedding_r1_g768 IS NOT NULL)' }],
    ['idx_facts_embedding_r1_g768_hnsw', { table: 'facts', predicate: '((embedding_r1_g768 IS NOT NULL) AND (expired_at IS NULL))' }],
  ]);
  if (rows.length !== expected.size) throw new Error('Prepared R1 index inventory is incomplete');
  const normalize = (value: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  for (const row of rows) {
    const wanted = expected.get(row.index_name);
    if (!wanted || row.table_name !== wanted.table || row.method !== 'hnsw' || !row.valid || !row.ready || !row.live
      || row.unique || row.primary || row.exclusion || row.natts !== 1 || row.nkeyatts !== 1 || row.expressions !== null || row.reloptions !== null
      || row.key_column !== R1_SHADOW_COLUMN || row.opclass !== 'vector_cosine_ops' || row.opclass_schema !== 'public' || row.opfamily !== 'vector_cosine_ops'
      || normalize(row.predicate) !== normalize(wanted.predicate)) {
      throw new Error(`Prepared R1 index definition mismatch: ${row.index_name}`);
    }
  }
}
async function assertPostCutoverIndexes(sql: Sql, archived=false): Promise<void> {
  const suffix=archived?'_g768_r1':'';
  const column=archived?'embedding_g768_r1':'embedding';
  const expectedAll=[`content_chunks_stale_idx${suffix}`,`idx_chunks_embedding${suffix}`,`idx_chunks_embedding_null${suffix}`,`idx_facts_embedding_hnsw${suffix}`,`idx_query_cache_embedding_hnsw${suffix}`].sort();
  const inventory=await sql.unsafe(`SELECT DISTINCT i.relname AS index_name FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid
    JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1::text[]) AND (
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attname=$2 AND a.attnum=ANY(ix.indkey))
      OR EXISTS (
        SELECT 1 FROM pg_depend d JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
        WHERE d.classid='pg_class'::regclass AND d.objid=ix.indexrelid
          AND d.refclassid='pg_class'::regclass AND d.refobjid=t.oid AND a.attname=$2
      )) ORDER BY i.relname`,[['content_chunks','facts','query_cache'],column]) as Array<{index_name:string}>;
  if (JSON.stringify(inventory.map((row)=>row.index_name))!==JSON.stringify(expectedAll)) throw new Error('Post-cutover governed index catalog has extras or omissions');
  await assertNoExtraHnswIndexes(sql,['content_chunks','facts','query_cache'],column,[`idx_chunks_embedding${suffix}`,`idx_facts_embedding_hnsw${suffix}`,`idx_query_cache_embedding_hnsw${suffix}`]);
  const rows = await sql.unsafe(`SELECT i.relname AS index_name,t.relname AS table_name,am.amname AS method,
      ix.indisvalid AS valid,ix.indisready AS ready,ix.indislive AS live,ix.indisunique AS unique,
      ix.indisprimary AS primary,ix.indisexclusion AS exclusion,ix.indnatts::int AS natts,ix.indnkeyatts::int AS nkeyatts,
      pg_get_expr(ix.indexprs,ix.indrelid) AS expressions,i.reloptions AS reloptions,a.attname AS key_column,
      opc.opcname AS opclass,onsp.nspname AS opclass_schema,opf.opfname AS opfamily,pg_get_expr(ix.indpred,ix.indrelid) AS predicate
    FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_class t ON t.oid=ix.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=i.relam
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ix.indkey[0] JOIN pg_opclass opc ON opc.oid=ix.indclass[0]
    JOIN pg_namespace onsp ON onsp.oid=opc.opcnamespace JOIN pg_opfamily opf ON opf.oid=opc.opcfamily
    WHERE n.nspname='public' AND i.relname=ANY($1::text[]) ORDER BY i.relname`,[[`idx_chunks_embedding${suffix}`,`idx_facts_embedding_hnsw${suffix}`,`idx_query_cache_embedding_hnsw${suffix}`]]) as Array<any>;
  const expected = new Map([
    [`idx_chunks_embedding${suffix}`,{table:'content_chunks',predicate:`(${column} IS NOT NULL)`}],
    [`idx_facts_embedding_hnsw${suffix}`,{table:'facts',predicate:`((${column} IS NOT NULL) AND (expired_at IS NULL))`}],
    [`idx_query_cache_embedding_hnsw${suffix}`,{table:'query_cache',predicate:`(${column} IS NOT NULL)`}],
  ]);
  const normalize=(value:string|null):string=>(value??'').replace(/\s+/g,' ').trim().toUpperCase();
  if (rows.length!==expected.size) throw new Error('Post-cutover HNSW index inventory is incomplete');
  for (const row of rows) {
    const wanted=expected.get(row.index_name);
    if (!wanted || row.table_name!==wanted.table || row.method!=='hnsw' || !row.valid || !row.ready || !row.live
      || row.unique || row.primary || row.exclusion || row.natts!==1 || row.nkeyatts!==1 || row.expressions!==null || row.reloptions!==null
      || row.key_column!==column || row.opclass!=='vector_cosine_ops' || row.opclass_schema!=='public' || row.opfamily!=='vector_cosine_ops'
      || normalize(row.predicate)!==normalize(wanted.predicate)) throw new Error(`Post-cutover index definition mismatch: ${row.index_name}`);
  }
  const btrees=await sql.unsafe(`SELECT i.relname AS index_name,t.relname AS table_name,am.amname AS method,ix.indisvalid AS valid,
      ix.indisready AS ready,ix.indislive AS live,ix.indisunique AS unique,ix.indisprimary AS primary,ix.indisexclusion AS exclusion,
      ix.indnatts::int AS natts,ix.indnkeyatts::int AS nkeyatts,pg_get_expr(ix.indexprs,ix.indrelid) AS expressions,i.reloptions AS reloptions,
      pg_get_expr(ix.indpred,ix.indrelid) AS predicate,
      ARRAY(SELECT a.attname FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum WHERE k.ord<=ix.indnkeyatts ORDER BY k.ord) AS key_columns,
      ARRAY(SELECT opc.opcname FROM unnest(ix.indclass::oid[]) WITH ORDINALITY k(opcoid,ord) JOIN pg_opclass opc ON opc.oid=k.opcoid WHERE k.ord<=ix.indnkeyatts ORDER BY k.ord) AS opclasses
    FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=i.relam
    WHERE n.nspname='public' AND i.relname=ANY($1::text[]) ORDER BY i.relname`,[[`idx_chunks_embedding_null${suffix}`,`content_chunks_stale_idx${suffix}`]]) as Array<any>;
  if (btrees.length!==2 || btrees.some((row)=>row.table_name!=='content_chunks' || row.method!=='btree' || !row.valid || !row.ready || !row.live
    || row.unique || row.primary || row.exclusion || row.natts!==2 || row.nkeyatts!==2 || row.expressions!==null || row.reloptions!==null
    || JSON.stringify(row.key_columns)!==JSON.stringify(['page_id','chunk_index']) || JSON.stringify(row.opclasses)!==JSON.stringify(['int4_ops','int4_ops'])
    || normalize(row.predicate)!==normalize(`(${column} IS NULL)`))) throw new Error('Post-cutover btree index definition mismatch');
}
async function assertSourceIndexCatalog(sql: Sql, backup: boolean): Promise<void> {
  const suffix=backup?'_ze_r0':'';
  const column=backup?R1_BACKUP_COLUMN:'embedding';
  const names=[`content_chunks_stale_idx${suffix}`,`idx_chunks_embedding${suffix}`,`idx_chunks_embedding_null${suffix}`,`idx_facts_embedding_hnsw${suffix}`,`idx_query_cache_embedding_hnsw${suffix}`];
  const inventory=await sql.unsafe(`SELECT DISTINCT i.relname AS index_name FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid
    JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1::text[]) AND (
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attname=$2 AND a.attnum=ANY(ix.indkey))
      OR EXISTS (
        SELECT 1 FROM pg_depend d JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
        WHERE d.classid='pg_class'::regclass AND d.objid=ix.indexrelid
          AND d.refclassid='pg_class'::regclass AND d.refobjid=t.oid AND a.attname=$2
      )) ORDER BY i.relname`,[['content_chunks','facts','query_cache'],column]) as Array<{index_name:string}>;
  if (JSON.stringify(inventory.map((row)=>row.index_name))!==JSON.stringify([...names].sort())) throw new Error(`${backup?'Rollback backup':'Restored source'} governed index catalog has extras or omissions`);
  const rows=await sql.unsafe(`SELECT i.relname AS index_name,t.relname AS table_name,am.amname AS method,ix.indisvalid AS valid,
      ix.indisready AS ready,ix.indislive AS live,ix.indisunique AS unique,ix.indisprimary AS primary,ix.indisexclusion AS exclusion,
      ix.indnatts::int AS natts,ix.indnkeyatts::int AS nkeyatts,pg_get_expr(ix.indexprs,ix.indrelid) AS expressions,
      i.reloptions AS reloptions,pg_get_expr(ix.indpred,ix.indrelid) AS predicate,
      ARRAY(SELECT a.attname FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum WHERE k.ord<=ix.indnkeyatts ORDER BY k.ord) AS key_columns,
      ARRAY(SELECT opc.opcname FROM unnest(ix.indclass::oid[]) WITH ORDINALITY k(opcoid,ord)
        JOIN pg_opclass opc ON opc.oid=k.opcoid WHERE k.ord<=ix.indnkeyatts ORDER BY k.ord) AS opclasses
    FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_class t ON t.oid=ix.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=i.relam
    WHERE n.nspname='public' AND i.relname=ANY($1::text[]) ORDER BY i.relname`,[names]) as Array<any>;
  const expected=new Map<string,{table:string;method:string;keys:string[];opclasses:string[];predicate:string}>([
    [`idx_chunks_embedding${suffix}`,{table:'content_chunks',method:'hnsw',keys:[column],opclasses:['vector_cosine_ops'],predicate:''}],
    [`idx_facts_embedding_hnsw${suffix}`,{table:'facts',method:'hnsw',keys:[column],opclasses:['vector_cosine_ops'],predicate:`((${column} IS NOT NULL) AND (expired_at IS NULL))`}],
    [`idx_query_cache_embedding_hnsw${suffix}`,{table:'query_cache',method:'hnsw',keys:[column],opclasses:['vector_cosine_ops'],predicate:`(${column} IS NOT NULL)`}],
    [`idx_chunks_embedding_null${suffix}`,{table:'content_chunks',method:'btree',keys:['page_id','chunk_index'],opclasses:['int4_ops','int4_ops'],predicate:`(${column} IS NULL)`}],
    [`content_chunks_stale_idx${suffix}`,{table:'content_chunks',method:'btree',keys:['page_id','chunk_index'],opclasses:['int4_ops','int4_ops'],predicate:`(${column} IS NULL)`}],
  ]);
  const norm=(v:string|null):string=>(v??'').replace(/\s+/g,' ').trim().toUpperCase();
  if (rows.length!==expected.size) throw new Error(`${backup?'Rollback backup':'Restored source'} index inventory is incomplete`);
  for (const row of rows) {
    const wanted=expected.get(row.index_name);
    if (!wanted || row.table_name!==wanted.table || row.method!==wanted.method || !row.valid || !row.ready || !row.live
      || row.unique || row.primary || row.exclusion || row.natts!==wanted.keys.length || row.nkeyatts!==wanted.keys.length
      || row.expressions!==null || row.reloptions!==null || JSON.stringify(row.key_columns)!==JSON.stringify(wanted.keys)
      || JSON.stringify(row.opclasses)!==JSON.stringify(wanted.opclasses) || norm(row.predicate)!==norm(wanted.predicate)) {
      throw new Error(`${backup?'Rollback backup':'Restored source'} index definition mismatch: ${row.index_name}`);
    }
  }
}
async function countPlane(sql: Sql, table: string, primary: string, shadow: string): Promise<{ total: number; populated: number }> {
  const rows = await sql.unsafe(`SELECT count(${primary})::int AS total, count(${shadow})::int AS populated FROM ${table}`) as CountRow[];
  return { total: Number(rows[0]?.total ?? 0), populated: Number(rows[0]?.populated ?? 0) };
}

async function readStatus(sql: Sql): Promise<Record<string, unknown> & R1CutoverStatus> {
  const contentShadowType = await columnType(sql, 'content_chunks', R1_SHADOW_COLUMN);
  const factsShadowType = await columnType(sql, 'facts', R1_SHADOW_COLUMN);
  const contentTotal = Number((await sql.unsafe('SELECT count(*)::int AS n FROM content_chunks') as Array<{ n: number }>)[0]?.n ?? 0);
  const contentRows = contentShadowType
    ? await sql.unsafe(`SELECT count(*)::int AS total, count(${R1_SHADOW_COLUMN})::int AS populated FROM content_chunks`) as CountRow[]
    : [];
  const contentCounts = resolveContentPlaneCounts(contentShadowType, contentRows[0], contentTotal);
  const factsCounts = factsShadowType
    ? await countPlane(sql, 'facts', 'embedding', R1_SHADOW_COLUMN)
    : { total: Number((await sql.unsafe('SELECT count(embedding)::int AS n FROM facts') as Array<{ n: number }>)[0]?.n ?? 0), populated: 0 };
  const takesPopulated = Number((await sql.unsafe('SELECT count(embedding)::int AS n FROM takes') as Array<{ n: number }>)[0]?.n ?? 0);
  const triggerRows = await sql.unsafe(
    `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS trigger,
            pn.nspname AS function_schema, p.proname AS function_name,
            pg_get_functiondef(p.oid) AS function_definition,
            pg_get_userbyid(c.relowner) AS table_owner, pg_get_userbyid(p.proowner) AS function_owner,
            current_user AS executor,
            p.provolatile AS function_volatility, p.prosecdef AS function_security_definer, p.proconfig AS function_config,
            t.tgenabled AS enabled, pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_proc p ON p.oid=t.tgfoid
       JOIN pg_namespace pn ON pn.oid=p.pronamespace
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'avers_r1_writer_fence_%'
      ORDER BY c.relname`,
  ) as R1WriterFenceRow[];
  const model = await getConfig(sql, 'embedding_model');
  const dims = await getConfig(sql, 'embedding_dimensions');
  const markerRaw = await getConfig(sql, R1_STATE_KEY);
  let marker: unknown = null;
  try { marker = markerRaw ? JSON.parse(markerRaw) : null; } catch { marker = { corrupt: true }; }
  const expectedFenceTables = resolveR1WriterFenceTables(marker);
  const writerFenceActive = (await getConfig(sql, R1_WRITER_FENCE_KEY)) === 'active'
    && isExactR1WriterFence(expectedFenceTables, triggerRows);
  return {
    schema_version: 1,
    target_model: R1_TARGET_MODEL,
    target_dimensions: R1_TARGET_DIMENSIONS,
    current_model: model,
    current_dimensions: dims ? Number(dims) : null,
    marker,
    writer_fence_active: writerFenceActive,
    writer_fence_trigger_count: triggerRows.length,
    content_chunks: {
      total: contentCounts.total,
      shadow_populated: contentCounts.populated,
      primary_type: await columnType(sql, 'content_chunks', 'embedding'),
      shadow_type: contentShadowType,
      backup_type: await columnType(sql, 'content_chunks', R1_BACKUP_COLUMN),
    },
    facts: {
      total_populated: factsCounts.total,
      shadow_populated: factsCounts.populated,
      primary_type: await columnType(sql, 'facts', 'embedding'),
      shadow_type: factsShadowType,
      backup_type: await columnType(sql, 'facts', R1_BACKUP_COLUMN),
    },
    query_cache: {
      primary_type: await columnType(sql, 'query_cache', 'embedding'),
      backup_type: await columnType(sql, 'query_cache', R1_BACKUP_COLUMN),
      rows: Number((await sql.unsafe('SELECT count(*)::int AS n FROM query_cache') as Array<{ n: number }>)[0]?.n ?? 0),
    },
    takes: { total_populated: takesPopulated, primary_type: await columnType(sql, 'takes', 'embedding') },
    image_planes: {
      embedding_image: await columnType(sql, 'content_chunks', 'embedding_image'),
      embedding_multimodal: await columnType(sql, 'content_chunks', 'embedding_multimodal'),
    },
  } as Record<string, unknown> & R1CutoverStatus;
}

async function activeEmbedJobs(sql: Sql): Promise<number> {
  const rows = await sql.unsafe(
    `SELECT count(*)::int AS n FROM minion_jobs
      WHERE status IN ('waiting','delayed','active','waiting-children')
        AND (name IN ('embed','embed-backfill','sync','extract','source-ingest') OR name LIKE '%embed%')`,
  ) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

function parseRegistryColumns(raw: string | null): string[] {
  return Object.keys(parseR1EmbeddingRegistry(raw)).sort();
}

async function validateR1CutoverRuntimePlanes(sql: Sql, expectedFileSha256?: string, requireTargetDb = false): Promise<string> {
  const fileSnapshot = loadConfigFileSnapshotStrict();
  if (expectedFileSha256 !== undefined && fileSnapshot.sha256 !== expectedFileSha256) {
    throw new Error('config.json changed during governed cutover');
  }
  const fileConfig = fileSnapshot.config;
  const dbRegistry = parseR1EmbeddingRegistry(await getConfig(sql, 'embedding_columns'));
  const dbSelectedColumn = await getConfig(sql, 'search_embedding_column');
  assertR1RegistrySafeForPrepare(
    dbRegistry,
    fileConfig?.embedding_columns,
    dbSelectedColumn,
    fileConfig?.search_embedding_column,
  );
  const nonDbRuntime = {
    file_embedding_model: fileConfig?.embedding_model,
    file_embedding_dimensions: fileConfig?.embedding_dimensions,
    file_search_embedding_column: fileConfig?.search_embedding_column,
    file_embedding_columns: fileConfig?.embedding_columns,
    file_provider_base_urls: fileConfig?.provider_base_urls,
    env_embedding_model: process.env.GBRAIN_EMBEDDING_MODEL,
    env_embedding_dimensions: process.env.GBRAIN_EMBEDDING_DIMENSIONS,
  };
  if (requireTargetDb) {
    assertR1ZeroZeRuntimeConfig({
      db_embedding_model: await getConfig(sql, 'embedding_model'),
      db_embedding_dimensions: Number(await getConfig(sql, 'embedding_dimensions')) || null,
      db_reranker_model: await getConfig(sql, 'search.reranker.model'),
      db_embedding_columns: dbRegistry,
      ...nonDbRuntime,
    });
  } else {
    assertR1NonDbRuntimeConfig(nonDbRuntime);
  }
  return fileSnapshot.sha256;
}

async function assertSourceDbIdentity(sql: Sql, status: Record<string, unknown> & R1CutoverStatus, expectedModel: string, expectedDimensions: number): Promise<void> {
  if (await getConfig(sql, 'embedding_model') !== expectedModel || Number(await getConfig(sql, 'embedding_dimensions')) !== expectedDimensions) throw new Error('source DB embedding identity mismatch');
  const expectedType = `vector(${expectedDimensions})`;
  if (status.content_chunks.primary_type !== expectedType || status.facts.primary_type !== expectedType || status.query_cache.primary_type !== expectedType) throw new Error('source physical vector planes do not match DB dimensions');
}

function validateR1RollbackRuntimePlanes(state: StateEnvelope, expectedFileSha256?: string): string {
  const snapshot = loadConfigFileSnapshotStrict();
  if (expectedFileSha256 !== undefined && snapshot.sha256 !== expectedFileSha256) throw new Error('config.json changed during governed rollback');
  const config = snapshot.config;
  if (!config || config.embedding_model !== state.from_model || config.embedding_dimensions !== state.from_dimensions) throw new Error('rollback requires durable source embedding identity in config.json');
  if (config.search_embedding_column && config.search_embedding_column !== 'embedding') throw new Error('rollback config.json selects a non-primary embedding column');
  if (Object.keys(config.embedding_columns ?? {}).length > 0) throw new Error('rollback config.json contains unresolved embedding columns');
  assertR1EnvTarget(process.env, 'source', state.from_model, state.from_dimensions);
  return snapshot.sha256;
}

async function readCompletionReality(sql: Sql): Promise<R1CompletionReality> {
  const signature = `${R1_TARGET_MODEL}:${R1_TARGET_DIMENSIONS}`;
  const counts = (await sql.unsafe(`
    SELECT
      (SELECT count(*)::int FROM content_chunks) AS content_total,
      (SELECT count(embedding)::int FROM content_chunks) AS content_populated,
      (SELECT count(${R1_BACKUP_COLUMN})::int FROM facts) AS facts_expected,
      (SELECT count(embedding)::int FROM facts) AS facts_populated,
      (SELECT count(*)::int FROM query_cache) AS query_cache_rows,
      (SELECT count(embedding)::int FROM takes) AS takes_populated,
      (SELECT count(*)::int FROM pages p WHERE p.embedding_signature=$1 AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND (c.embedding IS NULL OR c.model<>$2))) AS false_target_signatures,
      (SELECT count(*)::int FROM pages p WHERE p.embedding_signature IS NULL AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id)) AS null_signatures_with_chunks`,
    [signature, R1_TARGET_MODEL],
  ) as Array<Record<string, number>>)[0] ?? {};
  const sample = (await sql.unsafe(`SELECT id,chunk_text FROM content_chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT 1`) as Array<{ id: number; chunk_text: string }>)[0];
  let vectorRoundtripOk = false;
  if (sample) {
    const vectors = await embed([sample.chunk_text], { embeddingModel: R1_TARGET_MODEL, dimensions: R1_TARGET_DIMENSIONS, inputType: 'query', maxRetries: 1 });
    const hits = await sql.unsafe(`SELECT id FROM content_chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 1`, [vectorLiteral(vectors[0])]) as Array<{ id: number }>;
    vectorRoundtripOk = hits.length === 1;
  }
  await assertPostCutoverIndexes(sql);
  await assertSourceIndexCatalog(sql,true);
  return {
    current_model: await getConfig(sql, 'embedding_model'),
    current_dimensions: Number(await getConfig(sql, 'embedding_dimensions')) || null,
    reranker_model: await getConfig(sql, 'search.reranker.model'),
    content_primary_type: await columnType(sql, 'content_chunks', 'embedding'),
    content_backup_type: await columnType(sql, 'content_chunks', R1_BACKUP_COLUMN),
    content_total: Number(counts.content_total ?? 0), content_populated: Number(counts.content_populated ?? 0),
    facts_primary_type: await columnType(sql, 'facts', 'embedding'),
    facts_backup_type: await columnType(sql, 'facts', R1_BACKUP_COLUMN),
    facts_expected: Number(counts.facts_expected ?? 0), facts_populated: Number(counts.facts_populated ?? 0),
    query_cache_type: await columnType(sql, 'query_cache', 'embedding'),
    query_cache_backup_type: await columnType(sql, 'query_cache', R1_BACKUP_COLUMN), query_cache_rows: Number(counts.query_cache_rows ?? 0),
    takes_populated: Number(counts.takes_populated ?? 0),
    image_type: await columnType(sql, 'content_chunks', 'embedding_image'),
    multimodal_type: await columnType(sql, 'content_chunks', 'embedding_multimodal'),
    false_target_signatures: Number(counts.false_target_signatures ?? 0),
    null_signatures_with_chunks: Number(counts.null_signatures_with_chunks ?? 0),
    active_embed_jobs: await activeEmbedJobs(sql),
    custom_registry_columns: parseRegistryColumns(await getConfig(sql, 'embedding_columns')),
    scalar_watermark: Number(await getConfig(sql, 'version')),
    vector_roundtrip_ok: vectorRoundtripOk,
    postcutover_indexes_exact: true,
    rollback_indexes_exact: true,
  };
}

async function existingFenceTables(sql: Sql, target: R1Target): Promise<string[]> {
  if (target==='production') {
    const rows=await sql.unsafe(`SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`) as Array<{table_name:string}>;
    if (rows.length===0 || rows.some((row)=>!/^[a-z_][a-z0-9_]*$/.test(row.table_name))) throw new Error('Production public-table catalog is empty or unsafe');
    return rows.map((row)=>row.table_name);
  }
  const out: string[] = [];
  for (const table of R1_WRITER_FENCE_TABLES) if (await tableExists(sql, table)) out.push(table);
  return out;
}

function configureTargetGateway(): void {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is required');
  configureGateway({ embedding_model: R1_TARGET_MODEL, embedding_dimensions: R1_TARGET_DIMENSIONS, env: { ...process.env } });
}

async function probeTarget(): Promise<void> {
  configureTargetGateway();
  const vectors = await embed(['gbrain Avers R1 migration probe'], {
    embeddingModel: R1_TARGET_MODEL,
    dimensions: R1_TARGET_DIMENSIONS,
    inputType: 'query',
    maxRetries: 1,
  });
  if (vectors.length !== 1 || vectors[0]?.length !== R1_TARGET_DIMENSIONS) {
    throw new Error(`Target provider probe returned ${vectors[0]?.length ?? 0} dimensions`);
  }
}

async function revalidatePreparingState(lockedSql: Sql, identity: R1MigrationIdentity, target: R1Target): Promise<StateEnvelope> {
  await lockedSql.unsafe('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
  const raw = await getConfig(lockedSql, R1_STATE_KEY);
  if (!raw) throw new Error('Prepare authority marker disappeared');
  let current: StateEnvelope;
  try { current = JSON.parse(raw) as StateEnvelope; } catch { throw new Error('Prepare authority marker is corrupt'); }
  assertPreCutoverStateEnvelope(current, identity);
  await validateHandoffNonceLedger(lockedSql,target,identity,false);
  if (current.phase !== 'preparing') throw new Error(`Prepare batch requires preparing state, got ${current.phase}`);
  await assertCompleteProductionFenceInventory(lockedSql, current, target);
  const status = await readStatus(lockedSql);
  if (!status.writer_fence_active || status.content_chunks.shadow_type !== 'vector(768)' || status.facts.shadow_type !== 'vector(768)'
    || status.content_chunks.primary_type !== 'vector(1280)' || status.facts.primary_type !== 'vector(1280)'
    || status.query_cache.primary_type !== 'vector(1280)' || status.takes.primary_type !== 'vector(1536)' || status.takes.total_populated !== 0) {
    throw new Error('Prepare batch lost exact source/fence/shadow ownership');
  }
  await assertSourceDbIdentity(lockedSql,status,current.from_model,current.from_dimensions);
  if (await activeEmbedJobs(lockedSql)>0) throw new Error('Embedding-producing jobs appeared during prepare');
  await validateR1CutoverRuntimePlanes(lockedSql);
  current.updated_at = nowIso();
  return current;
}

async function prepare(sql: Sql, args: R1MigrationArgs, lockBackendPid: number): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--prepare requires --yes');
  if (!args.expectedCandidateSha || !args.implementationChecksum) {
    throw new Error('--prepare requires --expected-candidate-sha and --implementation-checksum');
  }
  if (args.target === 'production' && !args.handoff) throw new Error('--prepare production requires complete handoff identity');
  assertR1EnvTarget(process.env, 'target');
  const identity = buildR1MigrationIdentity(args.expectedCandidateSha, args.implementationChecksum, args.handoff);
  const fingerprint = identityFingerprint(identity);
  const statusBefore = await readStatus(sql);
  if (statusBefore.content_chunks.primary_type !== 'vector(1280)' || statusBefore.facts.primary_type !== 'vector(1280)') throw new Error('Expected ZE baseline vector(1280) primary planes');
  if (statusBefore.query_cache.primary_type !== 'vector(1280)' || statusBefore.takes.primary_type !== 'vector(1536)') throw new Error('Dim-pinned baseline does not match the approved catalog');
  if (statusBefore.takes.total_populated !== 0) throw new Error('takes.embedding became populated; STOP');
  await assertSourceDbIdentity(sql, statusBefore, String(statusBefore.current_model ?? ''), Number(statusBefore.current_dimensions ?? 0));
  if (await activeEmbedJobs(sql) > 0) throw new Error('Refusing while embedding-producing jobs are active/waiting');
  await validateR1CutoverRuntimePlanes(sql);
  await probeTarget();

  let state!: StateEnvelope;
  await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
    await lockedSql.unsafe('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const lockedStateRaw = await getConfig(lockedSql, R1_STATE_KEY);
    const lockedStatus = await readStatus(lockedSql);
    const fromModel = String(lockedStatus.current_model ?? '');
    const fromDimensions = Number(lockedStatus.current_dimensions ?? 0);
    if (fromModel !== 'zeroentropyai:zembed-1' || fromDimensions !== 1280) throw new Error('Approved ZE source config identity is missing or drifted');
    if (lockedStatus.content_chunks.primary_type !== 'vector(1280)' || lockedStatus.facts.primary_type !== 'vector(1280)'
      || lockedStatus.query_cache.primary_type !== 'vector(1280)' || lockedStatus.takes.primary_type !== 'vector(1536)'
      || lockedStatus.takes.total_populated !== 0) throw new Error('Locked source plane baseline drifted');
    await assertSourceDbIdentity(lockedSql, lockedStatus, fromModel, fromDimensions);
    if (await activeEmbedJobs(lockedSql) > 0) throw new Error('Embedding-producing jobs appeared under prepare lock');
    await validateR1CutoverRuntimePlanes(lockedSql);
    if (await getConfig(lockedSql, R1_COMPLETED_KEY) !== null) throw new Error('Prepare refuses an existing completion marker');
    if (lockedStateRaw) {
      let current: StateEnvelope;
      try { current = JSON.parse(lockedStateRaw) as StateEnvelope; } catch { throw new Error('Active R1 migration marker is corrupt'); }
      assertPreCutoverStateEnvelope(current, identity);
      await validateHandoffNonceLedger(lockedSql,args.target,identity,false);
      await assertCompleteProductionFenceInventory(lockedSql, current, args.target);
      if (!lockedStatus.writer_fence_active || lockedStatus.content_chunks.shadow_type !== 'vector(768)' || lockedStatus.facts.shadow_type !== 'vector(768)') throw new Error('Active prepare marker lacks exact owned fence/shadow planes');
      if (current.phase === 'prepared') await assertPreparedIndexes(lockedSql);
      state = current;
    } else {
      const priorAbortRaw=await getConfig(lockedSql,R1_ABORTED_KEY);
      const priorFenceMarker=await getConfig(lockedSql,R1_WRITER_FENCE_KEY);
      if ((priorAbortRaw===null)!==(priorFenceMarker===null)) throw new Error('Fresh prepare found incomplete prior-abort disposition');
      let requiredPriorNonce: string | undefined;
      if (priorAbortRaw!==null) {
        if (priorFenceMarker!=='disabled') throw new Error('Prior abort did not leave a disabled fence marker');
        requiredPriorNonce = await assertReusableAbortMarker(lockedSql,priorAbortRaw,identity,args.target);
      }
      await assertFreshFenceNamespace(lockedSql,priorAbortRaw!==null);
      await validateHandoffNonceLedger(lockedSql,args.target,identity,true,requiredPriorNonce);
      if (lockedStatus.content_chunks.shadow_type !== null || lockedStatus.facts.shadow_type !== null) throw new Error('Reserved R1 shadow columns already exist without an active marker');
      if (await indexExists(lockedSql, 'idx_chunks_embedding_r1_g768') || await indexExists(lockedSql, 'idx_facts_embedding_r1_g768_hnsw')) throw new Error('Reserved R1 shadow index names already exist without an active marker');
      const fenceTables = await existingFenceTables(lockedSql,args.target);
      state = {
        schema_version: 1, identity, fingerprint, phase: 'preparing', started_at: nowIso(), updated_at: nowIso(),
        from_model: fromModel, from_dimensions: fromDimensions,
        prior_reranker_model: await getConfig(lockedSql, 'search.reranker.model') ?? 'voyage:rerank-2.5',
        prior_reranker_enabled: (await getConfig(lockedSql, 'search.reranker.enabled')) === 'true',
        writer_fence_tables: fenceTables,
      };
      await lockedSql.unsafe(`ALTER TABLE content_chunks ADD COLUMN ${R1_SHADOW_COLUMN} vector(${R1_TARGET_DIMENSIONS})`);
      await lockedSql.unsafe(`ALTER TABLE facts ADD COLUMN ${R1_SHADOW_COLUMN} vector(${R1_TARGET_DIMENSIONS})`);
      await lockedSql.unsafe(buildWriterFenceSql(fenceTables));
      await setConfig(lockedSql, R1_WRITER_FENCE_KEY, 'active');
      await lockedSql.unsafe('DELETE FROM config WHERE key=$1', [R1_ABORTED_KEY]);
      await setConfig(lockedSql, R1_STATE_KEY, JSON.stringify(state));
      const installed = await readStatus(lockedSql);
      if (!installed.writer_fence_active || installed.content_chunks.shadow_type !== 'vector(768)' || installed.facts.shadow_type !== 'vector(768)') throw new Error('Prepare transaction failed exact ownership postcondition');
    }
  });
  if (state.phase === 'prepared') return { status: 'prepared', chunks_embedded_this_run: 0, facts_embedded_this_run: 0, batches: 0, state, ...(await readStatus(sql)) };
  if (args.noEmbed) return { status: 'prepared_no_embed', state, ...(await readStatus(sql)) };

  let chunksEmbedded = 0;
  let factsEmbedded = 0;
  let batches = 0;
  while (true) {
    const rows = await sql.unsafe(
      `SELECT id,chunk_text FROM content_chunks WHERE ${R1_SHADOW_COLUMN} IS NULL ORDER BY id LIMIT $1`,
      [args.batchSize],
    ) as Array<{ id: number; chunk_text: string }>;
    if (rows.length === 0) break;
    const vectors = await embed(rows.map((r) => r.chunk_text), {
      embeddingModel: R1_TARGET_MODEL, dimensions: R1_TARGET_DIMENSIONS, inputType: 'document', maxRetries: 2,
    });
    if (vectors.length !== rows.length) throw new Error('Chunk embedding count mismatch');
    await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
      state = await revalidatePreparingState(lockedSql, identity, args.target);
      for (let i = 0; i < rows.length; i++) {
        await lockedSql.unsafe(`UPDATE content_chunks SET ${R1_SHADOW_COLUMN}=$1::vector WHERE id=$2 AND ${R1_SHADOW_COLUMN} IS NULL`, [vectorLiteral(vectors[i]), rows[i].id]);
      }
      await setConfig(lockedSql, R1_STATE_KEY, JSON.stringify(state));
    });
    chunksEmbedded += rows.length;
    batches++;
    if (args.stopAfterBatches > 0 && batches >= args.stopAfterBatches) throw new Error(`R1_CONTROLLED_STOP_AFTER_BATCHES:${batches}`);
    if (args.paceMs > 0) await Bun.sleep(args.paceMs);
  }
  while (true) {
    const rows = await sql.unsafe(
      `SELECT id,fact,COALESCE(context,'') AS context FROM facts WHERE embedding IS NOT NULL AND ${R1_SHADOW_COLUMN} IS NULL ORDER BY id LIMIT $1`,
      [args.batchSize],
    ) as Array<{ id: number; fact: string; context: string }>;
    if (rows.length === 0) break;
    const vectors = await embed(rows.map((r) => `${r.fact}\n${r.context}`.trim()), {
      embeddingModel: R1_TARGET_MODEL, dimensions: R1_TARGET_DIMENSIONS, inputType: 'document', maxRetries: 2,
    });
    if (vectors.length !== rows.length) throw new Error('Fact embedding count mismatch');
    await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
      state = await revalidatePreparingState(lockedSql, identity, args.target);
      for (let i = 0; i < rows.length; i++) {
        await lockedSql.unsafe(`UPDATE facts SET ${R1_SHADOW_COLUMN}=$1::vector WHERE id=$2 AND ${R1_SHADOW_COLUMN} IS NULL`, [vectorLiteral(vectors[i]), rows[i].id]);
      }
      await setConfig(lockedSql, R1_STATE_KEY, JSON.stringify(state));
    });
    factsEmbedded += rows.length;
    batches++;
    if (args.stopAfterBatches > 0 && batches >= args.stopAfterBatches) throw new Error(`R1_CONTROLLED_STOP_AFTER_BATCHES:${batches}`);
    if (args.paceMs > 0) await Bun.sleep(args.paceMs);
  }
  await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
    state = await revalidatePreparingState(lockedSql, identity, args.target);
    if (await indexExists(lockedSql, 'idx_chunks_embedding_r1_g768') || await indexExists(lockedSql, 'idx_facts_embedding_r1_g768_hnsw')) throw new Error('Prepare finalization refuses pre-existing reserved indexes');
    await lockedSql.unsafe(`CREATE INDEX idx_chunks_${R1_SHADOW_COLUMN} ON content_chunks USING hnsw (${R1_SHADOW_COLUMN} vector_cosine_ops) WHERE ${R1_SHADOW_COLUMN} IS NOT NULL`);
    await lockedSql.unsafe(`CREATE INDEX idx_facts_${R1_SHADOW_COLUMN}_hnsw ON facts USING hnsw (${R1_SHADOW_COLUMN} vector_cosine_ops) WHERE ${R1_SHADOW_COLUMN} IS NOT NULL AND expired_at IS NULL`);
    await assertPreparedIndexes(lockedSql);
    state.phase = 'prepared'; state.updated_at = nowIso();
    await setConfig(lockedSql, R1_STATE_KEY, JSON.stringify(state));
  });
  return { status: 'prepared', chunks_embedded_this_run: chunksEmbedded, facts_embedded_this_run: factsEmbedded, batches, state, ...(await readStatus(sql)) };
}

async function cutover(sql: Sql, args: R1MigrationArgs, lockBackendPid: number): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--cutover requires --yes');
  assertR1EnvTarget(process.env, 'target');
  const fileSha256 = await validateR1CutoverRuntimePlanes(sql);
  await probeTarget();
  if (!args.expectedCandidateSha || !args.implementationChecksum) throw new Error('--cutover requires exact migration identity');
  if (args.target === 'production' && !args.handoff) throw new Error('--cutover production requires complete handoff identity');
  const expectedIdentity = buildR1MigrationIdentity(args.expectedCandidateSha, args.implementationChecksum, args.handoff);
  const expectedFingerprint = identityFingerprint(expectedIdentity);
  const validateLockedIdentity = (lockedState: StateEnvelope): void => {
    if (lockedState.fingerprint !== expectedFingerprint || identityFingerprint(lockedState.identity) !== expectedFingerprint) {
      throw new Error('Cutover handoff identity differs from active marker');
    }
  };
  let state!: StateEnvelope;
  await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
    await lockedSql.unsafe('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const lockedStateRaw = await getConfig(lockedSql, R1_STATE_KEY);
    if (!lockedStateRaw) throw new Error('No active R1 migration marker under cutover lock');
    const lockedState = JSON.parse(lockedStateRaw) as StateEnvelope;
    validateLockedIdentity(lockedState);
    await validateHandoffNonceLedger(lockedSql,args.target,expectedIdentity,false);
    await assertCompleteProductionFenceInventory(lockedSql, lockedState, args.target);
    await validateR1CutoverRuntimePlanes(lockedSql, fileSha256);
    const lockedStatus = await readStatus(lockedSql);
    const alreadyCutover = lockedStatus.content_chunks.primary_type === 'vector(768)' && lockedStatus.content_chunks.backup_type === 'vector(1280)';
    if (!alreadyCutover) {
      if (lockedState.phase !== 'prepared') throw new Error(`Cutover requires prepared state, got ${lockedState.phase}`);
      await assertPreparedIndexes(lockedSql);
      await assertSourceIndexCatalog(lockedSql,false);
      for (const name of ['idx_chunks_embedding_ze_r0','idx_chunks_embedding_null_ze_r0','content_chunks_stale_idx_ze_r0','idx_facts_embedding_hnsw_ze_r0','idx_query_cache_embedding_hnsw_ze_r0']) if (await indexExists(lockedSql,name)) throw new Error(`Cutover destination index already exists: ${name}`);
      assertReadyForCutover(lockedStatus);
      await assertSourceDbIdentity(lockedSql, lockedStatus, lockedState.from_model, lockedState.from_dimensions);
      lockedState.phase = 'cutover'; lockedState.updated_at = nowIso();
      await setConfig(lockedSql, R1_STATE_KEY, JSON.stringify(lockedState));
      for (const statement of buildCutoverStatements()) await lockedSql.unsafe(statement);
      await lockedSql.unsafe(`INSERT INTO config(key,value) VALUES ('search.reranker.enabled','false') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
      await lockedSql.unsafe(`INSERT INTO config(key,value) VALUES ('search.reranker.model','voyage:rerank-2.5') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
      await setConfig(lockedSql, 'embedding_columns', '{}');
      await setConfig(lockedSql, 'search_embedding_column', 'embedding');
    } else if (lockedState.phase !== 'cutover' && lockedState.phase !== 'completed') {
      throw new Error(`Idempotent cutover has invalid state ${lockedState.phase}`);
    }
    if (lockedState.phase === 'completed') {
      const completedRaw = await getConfig(lockedSql, R1_COMPLETED_KEY);
      if (!completedRaw) throw new Error('Completed cutover is missing its completion marker');
      let completedMarker: StateEnvelope & { completed_at: string; file_config_sha256: string; completion: R1CompletionReality };
      try { completedMarker = JSON.parse(completedRaw); } catch { throw new Error('Completed cutover marker is corrupt'); }
      assertR1FenceDisableAuthority(lockedState, completedMarker, args);
    }
    await validateR1CutoverRuntimePlanes(lockedSql, fileSha256, true);
    state = lockedState;
  });
  let completion!: R1CompletionReality;
  await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
    await lockedSql.unsafe('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const lockedStateRaw = await getConfig(lockedSql, R1_STATE_KEY);
    if (!lockedStateRaw) throw new Error('Cutover state disappeared before completion publication');
    const lockedState = JSON.parse(lockedStateRaw) as StateEnvelope;
    validateLockedIdentity(lockedState);
    await validateHandoffNonceLedger(lockedSql,args.target,expectedIdentity,false);
    await assertCompleteProductionFenceInventory(lockedSql, lockedState, args.target);
    if (lockedState.phase !== 'cutover' && lockedState.phase !== 'completed') throw new Error(`Completion publication requires cutover state, got ${lockedState.phase}`);
    await validateR1CutoverRuntimePlanes(lockedSql, fileSha256, true);
    completion = await readCompletionReality(lockedSql);
    assertR1CompletionReality(completion);
    await validateR1CutoverRuntimePlanes(lockedSql, fileSha256, true);
    if (lockedState.phase === 'completed') {
      const completedRaw = await getConfig(lockedSql, R1_COMPLETED_KEY);
      if (!completedRaw) throw new Error('Completed cutover is missing its completion marker');
      let completedMarker: StateEnvelope & { completed_at: string; file_config_sha256: string; completion: R1CompletionReality };
      try { completedMarker = JSON.parse(completedRaw); } catch { throw new Error('Completed cutover marker is corrupt'); }
      assertR1FenceDisableAuthority(lockedState, completedMarker, args);
      if (completedMarker.file_config_sha256 !== fileSha256 || JSON.stringify(completedMarker.completion) !== JSON.stringify(completion)) {
        throw new Error('Completed cutover marker differs from current reality');
      }
      state = lockedState;
      return;
    }
    if (await getConfig(lockedSql, R1_COMPLETED_KEY) !== null) throw new Error('Cutover recovery refuses a pre-existing completion marker');
    lockedState.phase = 'completed'; lockedState.updated_at = nowIso();
    await setConfig(lockedSql, R1_COMPLETED_KEY, JSON.stringify({ ...lockedState, completed_at: nowIso(), file_config_sha256: fileSha256, completion }));
    await setConfig(lockedSql, R1_STATE_KEY, JSON.stringify(lockedState));
    state = lockedState;
  });
  return { status: 'cutover_complete', state, completion, ...(await readStatus(sql)) };
}

async function disableFence(sql: Sql, args: R1MigrationArgs, lockBackendPid: number): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--disable-fence requires --yes');
  if (!args.expectedCandidateSha || !args.implementationChecksum) throw new Error('--disable-fence requires exact migration identity');
  const identity=buildR1MigrationIdentity(args.expectedCandidateSha,args.implementationChecksum,args.handoff);
  configureTargetGateway();
  let stampedTables: string[] = [];
  let disabledStatus: Record<string, unknown> & R1CutoverStatus | null = null;
  await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
    await lockedSql.unsafe('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const stateRaw = await getConfig(lockedSql, R1_STATE_KEY);
    const completedRaw = await getConfig(lockedSql, R1_COMPLETED_KEY);
    if (!stateRaw || !completedRaw) throw new Error('writer-fence lift requires state and completion markers');
    let state: StateEnvelope;
    let completed: StateEnvelope & { completed_at: string; file_config_sha256: string; completion: R1CompletionReality };
    try {
      state = JSON.parse(stateRaw) as StateEnvelope;
      completed = JSON.parse(completedRaw) as StateEnvelope & { completed_at: string; file_config_sha256: string; completion: R1CompletionReality };
    } catch {
      throw new Error('writer-fence lift markers are corrupt');
    }
    assertR1FenceDisableAuthority(state, completed, args);
    await validateHandoffNonceLedger(lockedSql,args.target,identity,false);
    await assertCompleteProductionFenceInventory(lockedSql, state, args.target);
    const fileSha256 = await validateR1CutoverRuntimePlanes(lockedSql, completed.file_config_sha256, true);
    if (fileSha256 !== completed.file_config_sha256) throw new Error('writer-fence lift file config fingerprint mismatch');
    const freshCompletion = await readCompletionReality(lockedSql);
    assertR1CompletionReality(freshCompletion);
    if (JSON.stringify(freshCompletion) !== JSON.stringify(completed.completion)) {
      throw new Error('writer-fence lift completion reality drifted');
    }
    const status = await readStatus(lockedSql);
    const rawFenceMarker=await getConfig(lockedSql,R1_WRITER_FENCE_KEY);
    if (rawFenceMarker==='disabled') {
      if (await reservedFenceObjectsExist(lockedSql) || status.writer_fence_active || status.writer_fence_trigger_count!==0) throw new Error('Disabled fence retry has contradictory reserved objects');
      stampedTables=[...state.writer_fence_tables]; disabledStatus=status; return;
    }
    if (rawFenceMarker!=='active') throw new Error('writer-fence lift marker is neither active nor proven disabled');
    if (!status.writer_fence_active) throw new Error('writer-fence lift requires the exact active stamped fence');
    stampedTables = [...state.writer_fence_tables];
    await lockedSql.unsafe(buildWriterFenceDropSql(stampedTables));
    runR1FenceLiftAfterDropHookForTests();
    await setConfig(lockedSql, R1_WRITER_FENCE_KEY, 'disabled');
    disabledStatus = await readStatus(lockedSql);
    if (disabledStatus.writer_fence_active || disabledStatus.writer_fence_trigger_count !== 0) {
      throw new Error('writer-fence lift transaction did not remove the exact fence');
    }
  });
  const finalStatus = disabledStatus as (Record<string, unknown> & R1CutoverStatus) | null;
  if (!finalStatus) throw new Error('writer-fence lift transaction returned no status');
  return { status: 'writer_fence_disabled', writer_fence_tables: stampedTables, ...finalStatus };
}

async function assertRollbackReality(sql: Sql, state: StateEnvelope): Promise<void> {
  const expectedSourceType = `vector(${state.from_dimensions})`;
  const status = await readStatus(sql);
  if (!status.writer_fence_active) throw new Error('rollback reality lost the writer fence');
  if (status.content_chunks.primary_type !== expectedSourceType || await columnType(sql, 'content_chunks', 'embedding_g768_r1') !== 'vector(768)') throw new Error('rollback content plane mismatch');
  if (status.facts.primary_type !== expectedSourceType || await columnType(sql, 'facts', 'embedding_g768_r1') !== 'vector(768)') throw new Error('rollback facts plane mismatch');
  if (status.query_cache.primary_type !== expectedSourceType || await columnType(sql, 'query_cache', 'embedding_g768_r1') !== 'vector(768)' || status.query_cache.rows !== 0) throw new Error('rollback query-cache plane mismatch');
  if (await getConfig(sql, 'embedding_model') !== state.from_model || Number(await getConfig(sql, 'embedding_dimensions')) !== state.from_dimensions) throw new Error('rollback embedding config identity mismatch');
  if (await getConfig(sql, 'search_embedding_column') !== 'embedding') throw new Error('rollback selected embedding column mismatch');
  if (await getConfig(sql, 'search.reranker.model') !== state.prior_reranker_model || await getConfig(sql, 'search.reranker.enabled') !== String(state.prior_reranker_enabled)) throw new Error('rollback reranker config mismatch');
}

async function abortPrepareReality(
  sql: Sql,
  identity: R1MigrationIdentity,
  production: boolean,
  expected?: { previousPhase: 'preparing' | 'prepared'; stampedTables: string[] },
): Promise<Record<string, unknown> & R1CutoverStatus> {
  const fingerprint = identityFingerprint(identity);
  const status = await readStatus(sql);
  if (status.writer_fence_active || status.writer_fence_trigger_count !== 0) throw new Error('abort-prepare reality still has an active writer fence');
  if (await reservedFenceObjectsExist(sql)) throw new Error('abort-prepare reality still has reserved fence objects');
  if (await getConfig(sql, R1_WRITER_FENCE_KEY) !== 'disabled') throw new Error('abort-prepare raw writer-fence marker is not disabled');
  if (status.content_chunks.primary_type !== 'vector(1280)' || status.content_chunks.shadow_type !== null || status.content_chunks.backup_type !== null) throw new Error('abort-prepare content planes are not restored to source-only state');
  if (status.facts.primary_type !== 'vector(1280)' || status.facts.shadow_type !== null || status.facts.backup_type !== null) throw new Error('abort-prepare fact planes are not restored to source-only state');
  if (status.query_cache.primary_type !== 'vector(1280)' || status.query_cache.backup_type !== null) throw new Error('abort-prepare query-cache plane changed');
  if (await indexExists(sql, 'idx_chunks_embedding_r1_g768') || await indexExists(sql, 'idx_facts_embedding_r1_g768_hnsw')) throw new Error('abort-prepare reserved index remains');
  if (await getConfig(sql, R1_STATE_KEY) !== null || await getConfig(sql, R1_COMPLETED_KEY) !== null) throw new Error('abort-prepare active/completed marker remains');
  const abortedRaw = await getConfig(sql, R1_ABORTED_KEY);
  if (!abortedRaw) throw new Error('abort-prepare audit marker missing');
  let aborted: {
    schema_version?: number; identity?: R1MigrationIdentity; fingerprint?: string; previous_phase?: string; aborted_at?: string;
    writer_fence_tables?: string[]; shadow_columns_removed?: boolean; source_model?: string; source_dimensions?: number;
    pre_abort_state?: StateEnvelope;
  };
  try { aborted = JSON.parse(abortedRaw); } catch { throw new Error('abort-prepare audit marker is corrupt'); }
  if (aborted.schema_version !== 1) throw new Error('abort-prepare audit schema version is invalid');
  if (!aborted.identity || identityFingerprint(aborted.identity) !== fingerprint || aborted.fingerprint !== fingerprint) throw new Error('abort-prepare audit marker identity mismatch');
  if (aborted.previous_phase !== 'preparing' && aborted.previous_phase !== 'prepared') throw new Error('abort-prepare audit marker phase is invalid');
  try { assertPreCutoverStateEnvelope(aborted.pre_abort_state!, aborted.identity); } catch { throw new Error('abort-prepare audit pre-state is missing or invalid'); }
  if (aborted.pre_abort_state!.phase !== aborted.previous_phase
    || JSON.stringify(aborted.pre_abort_state!.writer_fence_tables) !== JSON.stringify(aborted.writer_fence_tables)) {
    throw new Error('abort-prepare audit pre-state differs from archived disposition');
  }
  if (!aborted.aborted_at || !Number.isFinite(Date.parse(aborted.aborted_at)) || new Date(aborted.aborted_at).toISOString() !== aborted.aborted_at) throw new Error('abort-prepare audit timestamp is invalid');
  const archivedTables = resolveR1WriterFenceTables({ writer_fence_tables: aborted.writer_fence_tables });
  if (archivedTables.length === 0) throw new Error('abort-prepare audit inventory is invalid');
  if (production && JSON.stringify(archivedTables) !== JSON.stringify(await existingFenceTables(sql,'production'))) throw new Error('abort-prepare audit inventory is not the complete production catalog');
  if (aborted.shadow_columns_removed !== true) throw new Error('abort-prepare cleanup flag is missing');
  if (aborted.source_model !== R1_SOURCE_MODEL || aborted.source_dimensions !== 1280) throw new Error('abort-prepare source identity marker is invalid');
  if (await getConfig(sql, 'embedding_model') !== aborted.source_model || Number(await getConfig(sql, 'embedding_dimensions')) !== aborted.source_dimensions) throw new Error('abort-prepare source config drifted');
  if (await getConfig(sql, 'search_embedding_column') !== 'embedding') throw new Error('abort-prepare selected embedding column drifted');
  if (expected && (aborted.previous_phase !== expected.previousPhase || JSON.stringify(archivedTables) !== JSON.stringify(expected.stampedTables))) throw new Error('abort-prepare audit marker differs from locked cleanup authority');
  return status;
}

async function abortPrepare(sql: Sql, args: R1MigrationArgs, lockBackendPid: number): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--abort-prepare requires --yes');
  if (!args.expectedCandidateSha || !args.implementationChecksum) {
    throw new Error('--abort-prepare requires --expected-candidate-sha and --implementation-checksum');
  }
  if (args.target === 'production' && !args.handoff) throw new Error('--abort-prepare production requires complete handoff identity');
  const identity = buildR1MigrationIdentity(args.expectedCandidateSha, args.implementationChecksum, args.handoff);
  const fingerprint = identityFingerprint(identity);
  const stateRaw = await getConfig(sql, R1_STATE_KEY);
  if (!stateRaw) {
    const status = await abortPrepareReality(sql, identity, args.target === 'production');
    return { status: 'prepare_already_aborted', identity, ...status };
  }
  if (await getConfig(sql, R1_COMPLETED_KEY) !== null) throw new Error('abort-prepare refuses an existing completion marker');
  const preflightState = JSON.parse(stateRaw) as StateEnvelope;
  assertPreCutoverStateEnvelope(preflightState, identity);
  await assertCompleteProductionFenceInventory(sql, preflightState, args.target);
  assertR1AbortPrepareAuthority(preflightState, await readStatus(sql), args);
  let previousPhase!: 'preparing' | 'prepared';
  let stampedTables!: string[];
  await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
    await lockedSql.unsafe('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const lockedStateRaw = await getConfig(lockedSql, R1_STATE_KEY);
    if (!lockedStateRaw) throw new Error('abort-prepare state disappeared before cleanup');
    if (await getConfig(lockedSql, R1_COMPLETED_KEY) !== null) throw new Error('abort-prepare refuses a completion marker under lock');
    const lockedState = JSON.parse(lockedStateRaw) as StateEnvelope;
    const lockedStatus = await readStatus(lockedSql);
    assertPreCutoverStateEnvelope(lockedState, identity);
    await validateHandoffNonceLedger(lockedSql,args.target,identity,false);
    await assertCompleteProductionFenceInventory(lockedSql, lockedState, args.target);
    assertR1AbortPrepareAuthority(lockedState, lockedStatus, args);
    previousPhase = lockedState.phase as 'preparing' | 'prepared';
    stampedTables = resolveR1WriterFenceTables(lockedState);
    for (const statement of buildAbortPrepareStatements(stampedTables)) await lockedSql.unsafe(statement);
    runR1AbortPrepareAfterCleanupHookForTests();
    await setConfig(lockedSql, R1_WRITER_FENCE_KEY, 'disabled');
    await lockedSql.unsafe('DELETE FROM config WHERE key=$1', [R1_STATE_KEY]);
    await setConfig(lockedSql, R1_ABORTED_KEY, JSON.stringify({
      schema_version: 1,
      identity,
      fingerprint,
      previous_phase: previousPhase,
      pre_abort_state: lockedState,
      aborted_at: nowIso(),
      writer_fence_tables: stampedTables,
      shadow_columns_removed: true,
      source_model: lockedState.from_model,
      source_dimensions: lockedState.from_dimensions,
    }));
    await abortPrepareReality(lockedSql, identity, args.target === 'production', { previousPhase, stampedTables });
  });
  return {
    status: 'prepare_aborted',
    identity,
    previous_phase: previousPhase,
    writer_fence_tables: stampedTables,
    ...(await abortPrepareReality(sql, identity, args.target === 'production', { previousPhase, stampedTables })),
  };
}

async function rollback(sql: Sql, args: R1MigrationArgs, lockBackendPid: number): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--rollback requires --yes');
  if (!args.expectedCandidateSha || !args.implementationChecksum) throw new Error('--rollback requires exact migration identity');
  if (args.target === 'production' && !args.handoff) throw new Error('--rollback production requires complete handoff identity');
  const identity = buildR1MigrationIdentity(args.expectedCandidateSha, args.implementationChecksum, args.handoff);
  const fingerprint = identityFingerprint(identity);
  let state!: StateEnvelope;
  let alreadyRolledBack=false;
  await withR1MutationTransaction(sql, lockBackendPid, async (lockedSql) => {
    await lockedSql.unsafe('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const stateRaw = await getConfig(lockedSql, R1_STATE_KEY);
    if (!stateRaw) throw new Error('No R1 migration marker available for rollback');
    try { state = JSON.parse(stateRaw) as StateEnvelope; } catch { throw new Error('Rollback state marker is corrupt'); }
    if (state.schema_version !== 1 || !state.identity || identityFingerprint(state.identity) !== fingerprint || state.fingerprint !== fingerprint) throw new Error('Rollback migration identity mismatch');
    await validateHandoffNonceLedger(lockedSql,args.target,identity,false);
    if (state.phase==='rolled_back') {
      for (const timestamp of [state.started_at,state.updated_at]) if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString()!==timestamp) throw new Error('Rolled-back retry timestamp is invalid');
      if (state.from_model!==R1_SOURCE_MODEL || state.from_dimensions!==R1_SOURCE_DIMENSIONS || typeof state.prior_reranker_model!=='string' || typeof state.prior_reranker_enabled!=='boolean') throw new Error('Rolled-back retry envelope is invalid');
      await assertCompleteProductionFenceInventory(lockedSql,state,args.target);
      if (await getConfig(lockedSql,R1_COMPLETED_KEY)!==null) throw new Error('Rolled-back retry found a completion marker');
      if (!state.rollback_file_config_sha256 || !/^[0-9a-f]{64}$/.test(state.rollback_file_config_sha256)) throw new Error('Rolled-back retry lacks runtime fingerprint');
      validateR1RollbackRuntimePlanes(state,state.rollback_file_config_sha256);
      const rolledStatus=await readStatus(lockedSql);
      if (!rolledStatus.writer_fence_active) throw new Error('Rolled-back retry requires retained exact writer fence');
      await assertRollbackReality(lockedSql,state); await assertSourceIndexCatalog(lockedSql,false); await assertPostCutoverIndexes(lockedSql,true);
      alreadyRolledBack=true; return;
    }
    if (state.phase !== 'completed' && state.phase !== 'cutover') throw new Error(`Rollback requires completed or schema-cutover state, got ${state.phase}`);
    for (const timestamp of [state.started_at,state.updated_at]) if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error('Rollback state timestamp is invalid');
    if (state.from_model !== R1_SOURCE_MODEL || state.from_dimensions !== R1_SOURCE_DIMENSIONS) throw new Error('Rollback source identity is invalid');
    if (typeof state.prior_reranker_model !== 'string' || !state.prior_reranker_model || typeof state.prior_reranker_enabled !== 'boolean') throw new Error('Rollback reranker envelope is invalid');
    await assertCompleteProductionFenceInventory(lockedSql, state, args.target);
    const completedRaw = await getConfig(lockedSql, R1_COMPLETED_KEY);
    if (state.phase === 'completed') {
      if (!completedRaw) throw new Error('Completed rollback requires its completion marker');
      let completed: StateEnvelope & { completed_at: string; file_config_sha256: string; completion: R1CompletionReality };
      try { completed = JSON.parse(completedRaw); } catch { throw new Error('Rollback completion marker is corrupt'); }
      assertR1FenceDisableAuthority(state, completed, args);
    } else if (completedRaw !== null) throw new Error('Cutover-phase rollback refuses a contradictory completion marker');
    const rollbackFileSha256 = validateR1RollbackRuntimePlanes(state);
    const status = await readStatus(lockedSql);
    if (!status.writer_fence_active) throw new Error('Rollback requires the writer fence to remain active');
    if (status.content_chunks.primary_type !== 'vector(768)' || status.content_chunks.backup_type !== `vector(${state.from_dimensions})`) throw new Error('Content vector planes are not in the expected post-cutover state');
    if (status.facts.primary_type !== 'vector(768)' || status.facts.backup_type !== `vector(${state.from_dimensions})`) throw new Error('Fact vector planes are not in the expected post-cutover state');
    if (status.query_cache.primary_type !== 'vector(768)' || status.query_cache.backup_type !== `vector(${state.from_dimensions})`) throw new Error('Query-cache vector planes are not in the expected post-cutover state');
    await assertPostCutoverIndexes(lockedSql);
    await assertSourceIndexCatalog(lockedSql,true);
    if (await columnType(lockedSql,'content_chunks','embedding_g768_r1') || await columnType(lockedSql,'facts','embedding_g768_r1') || await columnType(lockedSql,'query_cache','embedding_g768_r1')) throw new Error('Rollback destination column already exists');
    for (const name of ['idx_chunks_embedding_g768_r1','idx_chunks_embedding_null_g768_r1','content_chunks_stale_idx_g768_r1','idx_facts_embedding_hnsw_g768_r1','idx_query_cache_embedding_hnsw_g768_r1']) if (await indexExists(lockedSql,name)) throw new Error(`Rollback destination index already exists: ${name}`);
    validateR1RollbackRuntimePlanes(state, rollbackFileSha256);
    for (const statement of buildRollbackStatements(state.from_model,state.from_dimensions,state.prior_reranker_model,state.prior_reranker_enabled)) await lockedSql.unsafe(statement);
    await assertRollbackReality(lockedSql, state);
    await assertSourceIndexCatalog(lockedSql,false);
    await assertPostCutoverIndexes(lockedSql,true);
    validateR1RollbackRuntimePlanes(state, rollbackFileSha256);
    state.phase = 'rolled_back'; state.updated_at = nowIso(); state.rollback_file_config_sha256 = rollbackFileSha256;
    await lockedSql.unsafe('DELETE FROM config WHERE key=$1', [R1_COMPLETED_KEY]);
    await setConfig(lockedSql, R1_STATE_KEY, JSON.stringify(state));
  });
  return { status: alreadyRolledBack?'rollback_already_complete':'rollback_complete', state, ...(await readStatus(sql)) };
}

async function main(): Promise<void> {
  const args = parseR1MigrationArgs(process.argv.slice(2));
  const invocationIdentityFingerprint = args.expectedCandidateSha && args.implementationChecksum
    && /^[0-9a-f]{40}$/.test(args.expectedCandidateSha) && /^[0-9a-f]{64}$/.test(args.implementationChecksum)
    ? identityFingerprint(buildR1MigrationIdentity(args.expectedCandidateSha, args.implementationChecksum, args.handoff))
    : null;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  assertR1DatabaseTarget(databaseUrl, args.target, process.env.R1_MIGRATION_CLONE_ACK, process.env.R1_MIGRATION_PRODUCTION_GO);
  let receiptFd: number | null = args.receipt ? openSync(args.receipt, 'wx', 0o600) : null;
  let receiptFinalized = false;
  let operationStarted = false;
  let operationReturned = false;
  try {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 0, max_lifetime: null });
    let lockBackendPid: number | null = null;
    try {
      if (args.target === 'production') await assumeProductionMigrationOwner(sql);
      if (args.mode !== 'status' && args.mode !== 'dry-run') {
        const lock = await sql.unsafe('SELECT pg_backend_pid()::int AS backend_pid, pg_try_advisory_lock($1) AS ok', [R1_ADVISORY_LOCK_KEY]) as AdvisoryLockRow[];
        if (lock[0]?.ok !== true) throw new Error('Another Avers R1 migration runner holds the global lock');
        lockBackendPid = Number(lock[0].backend_pid);
      }
      operationStarted = true;
      let result: Record<string, unknown>;
      if (args.mode === 'status' || args.mode === 'dry-run') {
        const status = await readStatus(sql);
        if (args.target === 'production' && status.writer_fence_active) {
          const stateRaw = await getConfig(sql, R1_STATE_KEY);
          if (!stateRaw) throw new Error('Active production fence requires migration state');
          let state: StateEnvelope;
          try { state = JSON.parse(stateRaw) as StateEnvelope; } catch { throw new Error('Active production fence state is corrupt'); }
          await assertCompleteProductionFenceInventory(sql, state, args.target);
        }
        result = { status: args.mode, ...status, active_embed_jobs: await activeEmbedJobs(sql) };
      } else {
        result = args.mode === 'prepare' ? await prepare(sql, args, lockBackendPid!)
          : args.mode === 'abort-prepare' ? await abortPrepare(sql, args, lockBackendPid!)
          : args.mode === 'cutover' ? await cutover(sql, args, lockBackendPid!)
          : args.mode === 'disable-fence' ? await disableFence(sql, args, lockBackendPid!)
          : await rollback(sql, args, lockBackendPid!);
      }
      operationReturned = true;
      const output = `${JSON.stringify(result, null, 2)}\n`;
      runR1ReceiptFinalizeHookForTests();
      if (receiptFd !== null) {
        ftruncateSync(receiptFd, 0);
        writeR1BytesFully(Buffer.from(output, 'utf8'), (buffer, offset, length, position) =>
          writeSync(receiptFd!, buffer, offset, length, position));
        fsyncSync(receiptFd);
        receiptFinalized = true;
      }
      process.stdout.write(output);
    } finally {
      resetGateway();
      if (lockBackendPid !== null) {
        await sql.unsafe('SELECT CASE WHEN pg_backend_pid()=$2 THEN pg_advisory_unlock($1) ELSE false END', [R1_ADVISORY_LOCK_KEY, lockBackendPid]).catch(() => {});
      }
      await sql.end({ timeout: 5 });
    }
  } catch (error) {
    if (receiptFd !== null && !receiptFinalized) {
      try {
        const outcome = !operationStarted
          ? 'operation_not_dispatched'
          : operationReturned ? 'operation_completed' : 'operation_outcome_unknown';
        const incomplete = `${JSON.stringify({
          status: 'incomplete',
          outcome,
          mode: args.mode,
          candidate_sha: args.expectedCandidateSha ?? null,
          implementation_checksum: args.implementationChecksum ?? null,
          invocation_identity_fingerprint: invocationIdentityFingerprint,
          handoff_nonce: args.handoff?.handoff_nonce ?? null,
        }, null, 2)}\n`;
        ftruncateSync(receiptFd, 0);
        writeR1BytesFully(Buffer.from(incomplete, 'utf8'), (buffer, offset, length, position) =>
          writeSync(receiptFd!, buffer, offset, length, position));
        fsyncSync(receiptFd);
        receiptFinalized = true;
      } catch {
        try { ftruncateSync(receiptFd, 0); fsyncSync(receiptFd); } catch { /* best-effort incomplete marker */ }
      }
    }
    throw error;
  } finally {
    if (receiptFd !== null) {
      closeSync(receiptFd);
      receiptFd = null;
    }
  }
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`[avers-r1-migrate] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  setCliExitVerdict(1);
});
