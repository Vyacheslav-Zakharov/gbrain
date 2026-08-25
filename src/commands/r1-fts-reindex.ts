#!/usr/bin/env bun
/** Collision-safe FTS language reindex for optional Avers R1/R1.1-FTS slice. */
import postgres, { type Sql } from 'postgres';
import { writeFileSync } from 'node:fs';
import { assertR1DatabaseTarget, type R1Target } from '../core/r1-governed-migration.ts';
import { buildFtsTriggerFunctionsSql } from '../core/fts-language.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

interface Args { mode: 'status' | 'dry-run' | 'apply'; language: string; target: R1Target; yes: boolean; batchSize: number; receipt?: string }
function value(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
export function parseR1FtsArgs(argv: string[]): Args {
  const modes = [argv.includes('--status') && 'status', argv.includes('--dry-run') && 'dry-run', argv.includes('--apply') && 'apply'].filter(Boolean) as Args['mode'][];
  if (modes.length !== 1) throw new Error('Pass exactly one mode: --status, --dry-run, or --apply');
  const language = value(argv, '--language') ?? process.env.GBRAIN_FTS_LANGUAGE ?? 'english';
  buildFtsTriggerFunctionsSql(language);
  const targetRaw = value(argv, '--target') ?? 'clone';
  if (targetRaw !== 'clone' && targetRaw !== 'production') throw new Error('--target must be clone or production');
  const batchSize = Number(value(argv, '--batch-size') ?? '1000');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('--batch-size must be in [1,5000]');
  const receipt = value(argv, '--receipt');
  return { mode: modes[0], language, target: targetRaw, yes: argv.includes('--yes'), batchSize, ...(receipt ? { receipt } : {}) };
}

async function status(sql: Sql): Promise<Record<string, unknown>> {
  const rows = await sql.unsafe(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname IN ('update_page_search_vector','update_chunk_search_vector')
     ORDER BY p.proname`) as Array<{ proname: string; def: string }>;
  const detect = (def: string): string | null => def.match(/to_tsvector\('([a-z][a-z0-9_]*)'/)?.[1] ?? null;
  const counts = await sql.unsafe(`SELECT (SELECT count(*)::int FROM pages) AS pages, (SELECT count(*)::int FROM content_chunks) AS chunks, (SELECT count(*)::int FROM query_cache) AS cache`) as Array<{ pages: number; chunks: number; cache: number }>;
  return {
    schema_version: 1,
    trigger_languages: Object.fromEntries(rows.map((row) => [row.proname, detect(row.def)])),
    pages: Number(counts[0]?.pages ?? 0), chunks: Number(counts[0]?.chunks ?? 0), query_cache_rows: Number(counts[0]?.cache ?? 0),
    recorded_language: await getConfig(sql, 'avers.r1.fts_language'),
  };
}
async function getConfig(sql: Sql, key: string): Promise<string | null> {
  const rows = await sql.unsafe('SELECT value FROM config WHERE key=$1', [key]) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}
async function setConfig(sql: Sql, key: string, value: string): Promise<void> {
  await sql.unsafe('INSERT INTO config(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
}

async function apply(sql: Sql, args: Args): Promise<Record<string, unknown>> {
  if (!args.yes) throw new Error('--apply requires --yes');
  if (process.env.GBRAIN_FTS_LANGUAGE !== args.language) throw new Error(`Set GBRAIN_FTS_LANGUAGE=${args.language} for the candidate process before apply`);
  const started = Date.now();
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL avers.r1_migration_runner='on'`);
    await tx.unsafe(buildFtsTriggerFunctionsSql(args.language));
  });
  let pagesUpdated = 0;
  let cursor = 0;
  for (;;) {
    const ids = await sql.unsafe(`SELECT id FROM pages WHERE id>$1 ORDER BY id LIMIT $2`, [cursor, args.batchSize]) as Array<{ id: number }>;
    if (ids.length === 0) break;
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL avers.r1_migration_runner='on'`);
      await tx.unsafe(`UPDATE pages SET id=id WHERE id = ANY($1::int[])`, [ids.map((r) => r.id)]);
    });
    pagesUpdated += ids.length; cursor = ids[ids.length - 1].id;
  }
  let chunksUpdated = 0;
  cursor = 0;
  for (;;) {
    const ids = await sql.unsafe(`SELECT id FROM content_chunks WHERE id>$1 ORDER BY id LIMIT $2`, [cursor, args.batchSize]) as Array<{ id: number }>;
    if (ids.length === 0) break;
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL avers.r1_migration_runner='on'`);
      await tx.unsafe(`UPDATE content_chunks SET search_vector=
        setweight(to_tsvector('${args.language}',COALESCE(doc_comment,'')),'A') ||
        setweight(to_tsvector('${args.language}',COALESCE(symbol_name_qualified,'')),'A') ||
        setweight(to_tsvector('${args.language}',COALESCE(chunk_text,'')),'B')
        WHERE id = ANY($1::int[])`, [ids.map((r) => r.id)]);
    });
    chunksUpdated += ids.length; cursor = ids[ids.length - 1].id;
  }
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL avers.r1_migration_runner='on'`);
    await tx.unsafe('DELETE FROM query_cache');
  });
  await setConfig(sql, 'avers.r1.fts_language', args.language);
  return { status: 'applied', language: args.language, pages_updated: pagesUpdated, chunks_updated: chunksUpdated, elapsed_ms: Date.now() - started, ...(await status(sql)) };
}

async function main(): Promise<void> {
  const args = parseR1FtsArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  assertR1DatabaseTarget(databaseUrl, args.target, process.env.R1_MIGRATION_CLONE_ACK, process.env.R1_MIGRATION_PRODUCTION_GO);
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 30 });
  try {
    const result = args.mode === 'apply' ? await apply(sql, args) : { status: args.mode, requested_language: args.language, ...(await status(sql)) };
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (args.receipt) writeFileSync(args.receipt, output, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(output);
  } finally { await sql.end({ timeout: 5 }); }
}
if (import.meta.main) main().catch((error) => { process.stderr.write(`[avers-r1-fts] ERROR: ${error instanceof Error ? error.message : String(error)}\n`); setCliExitVerdict(1); });
