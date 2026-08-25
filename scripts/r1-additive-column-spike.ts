#!/usr/bin/env bun
/** Disposable-clone-only R1 additive-column emergency bridge spike. */
import postgres from 'postgres';
import { writeFileSync } from 'node:fs';
import { configureGateway, embed, resetGateway } from '../src/core/ai/gateway.ts';

export const COLUMN = 'embedding_g768';
export const MODEL = 'google:gemini-embedding-001';
export const DIMENSIONS = 768;

type Mode = 'status' | 'prepare' | 'activate' | 'rollback';
export interface SpikeArgs { mode: Mode; batchSize: number; receipt?: string }

export function assertCloneTarget(databaseUrl: string, ack: string | undefined): URL {
  if (ack !== '1') throw new Error('Explicit clone acknowledgement R1_ADDITIVE_BRIDGE_CLONE_ACK=1 is required');
  const parsed = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`Refusing non-loopback database host: ${parsed.hostname}`);
  }
  if (parsed.pathname.replace(/^\//, '') !== 'gbrain_clone') {
    throw new Error(`Refusing database other than gbrain_clone: ${parsed.pathname}`);
  }
  return parsed;
}

export function mergeRegistryEntry(raw: string | null | undefined): Record<string, unknown> {
  let registry: Record<string, unknown> = {};
  if (raw?.trim()) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('embedding_columns is not a JSON object');
    }
    registry = { ...parsed };
  }
  registry[COLUMN] = { provider: MODEL, dimensions: DIMENSIONS, type: 'vector' };
  return registry;
}

export function parseSpikeArgs(argv: string[]): SpikeArgs {
  const selected: Mode[] = [];
  if (argv.includes('--status')) selected.push('status');
  if (argv.includes('--prepare')) selected.push('prepare');
  if (argv.includes('--activate')) selected.push('activate');
  if (argv.includes('--rollback')) selected.push('rollback');
  if (selected.length !== 1) throw new Error('Pass exactly one mode: --status, --prepare, --activate, or --rollback');
  const batchIndex = argv.indexOf('--batch-size');
  const batchSize = batchIndex >= 0 ? Number(argv[batchIndex + 1]) : 64;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new Error('--batch-size must be an integer in [1, 256]');
  }
  const receiptIndex = argv.indexOf('--receipt');
  const receipt = receiptIndex >= 0 ? argv[receiptIndex + 1] : undefined;
  if (receiptIndex >= 0 && !receipt) throw new Error('--receipt requires a path');
  return { mode: selected[0], batchSize, receipt };
}

function vectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(',')}]`;
}

async function upsertConfig(sql: postgres.Sql, key: string, value: string): Promise<void> {
  await sql.unsafe(
    'INSERT INTO config(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
    [key, value],
  );
}

async function readConfig(sql: postgres.Sql, key: string): Promise<string | null> {
  const rows = await sql.unsafe('SELECT value FROM config WHERE key=$1', [key]) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

async function status(sql: postgres.Sql): Promise<Record<string, unknown>> {
  const columnRows = await sql.unsafe(
    `SELECT pg_catalog.format_type(a.atttypid,a.atttypmod) AS type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid=a.attrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='content_chunks'
        AND a.attname=$1 AND a.attnum>0 AND NOT a.attisdropped`,
    [COLUMN],
  ) as Array<{ type: string }>;
  const exists = columnRows.length === 1;
  let total = 0;
  let populated = 0;
  if (exists) {
    const counts = await sql.unsafe(
      `SELECT count(*)::int AS total, count("${COLUMN}")::int AS populated FROM content_chunks`,
    ) as Array<{ total: number; populated: number }>;
    total = Number(counts[0]?.total ?? 0);
    populated = Number(counts[0]?.populated ?? 0);
  }
  const registryRaw = await readConfig(sql, 'embedding_columns');
  let registryEntry: unknown = null;
  try { registryEntry = registryRaw ? JSON.parse(registryRaw)[COLUMN] ?? null : null; } catch { registryEntry = 'invalid_json'; }
  return {
    schema_version: 1,
    clone_only: true,
    column: COLUMN,
    model: MODEL,
    dimensions: DIMENSIONS,
    exists,
    column_type: columnRows[0]?.type ?? null,
    total,
    populated,
    missing: Math.max(0, total - populated),
    registry_entry: registryEntry,
    active_column: await readConfig(sql, 'search_embedding_column') ?? 'embedding',
    primary_column_untouched: true,
    semantic_cache_supported: false,
    facts_migrated: false,
    query_cache_migrated: false,
    takes_migrated: false,
  };
}

async function prepare(sql: postgres.Sql, batchSize: number): Promise<Record<string, unknown>> {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is required for clone backfill');
  }
  configureGateway({
    embedding_model: MODEL,
    embedding_dimensions: DIMENSIONS,
    env: { ...process.env },
  });
  await sql.unsafe(`ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS "${COLUMN}" vector(${DIMENSIONS})`);
  const started = Date.now();
  let batches = 0;
  let embedded = 0;
  let tokenCount = 0;
  while (true) {
    const rows = await sql.unsafe(
      `SELECT id,chunk_text,COALESCE(token_count,0)::int AS token_count
         FROM content_chunks
        WHERE "${COLUMN}" IS NULL AND length(trim(chunk_text)) > 0
        ORDER BY id
        LIMIT $1`,
      [batchSize],
    ) as Array<{ id: number; chunk_text: string; token_count: number }>;
    if (rows.length === 0) break;
    const vectors = await embed(rows.map((r) => r.chunk_text), {
      embeddingModel: MODEL,
      dimensions: DIMENSIONS,
      inputType: 'document',
      maxRetries: 2,
    });
    if (vectors.length !== rows.length) throw new Error('Embedding count mismatch');
    await sql.begin(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        const vector = vectors[i];
        if (!vector || vector.length !== DIMENSIONS) throw new Error(`Invalid vector width for chunk ${rows[i].id}`);
        await tx.unsafe(
          `UPDATE content_chunks SET "${COLUMN}"=$1::vector WHERE id=$2 AND "${COLUMN}" IS NULL`,
          [vectorLiteral(vector), rows[i].id],
        );
      }
    });
    embedded += rows.length;
    tokenCount += rows.reduce((sum, row) => sum + row.token_count, 0);
    batches++;
    process.stderr.write(`[r1-additive] embedded=${embedded} batches=${batches}\n`);
  }
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_chunks_${COLUMN} ON content_chunks USING hnsw ("${COLUMN}" vector_cosine_ops) WHERE "${COLUMN}" IS NOT NULL`,
  );
  const registry = mergeRegistryEntry(await readConfig(sql, 'embedding_columns'));
  await upsertConfig(sql, 'embedding_columns', JSON.stringify(registry));
  return { ...(await status(sql)), operation: 'prepare', batches, embedded_this_run: embedded, token_count: tokenCount, elapsed_ms: Date.now() - started };
}

async function activate(sql: postgres.Sql): Promise<Record<string, unknown>> {
  const before = await status(sql);
  if (!before.exists || before.missing !== 0) throw new Error('Refusing activation before complete backfill');
  const current = await readConfig(sql, 'search_embedding_column') ?? 'embedding';
  await upsertConfig(sql, 'r1_additive_bridge.previous_search_column', current);
  await upsertConfig(sql, 'search_embedding_column', COLUMN);
  return { ...(await status(sql)), operation: 'activate', previous_active_column: current };
}

async function rollback(sql: postgres.Sql): Promise<Record<string, unknown>> {
  const previous = await readConfig(sql, 'r1_additive_bridge.previous_search_column') ?? 'embedding';
  await upsertConfig(sql, 'search_embedding_column', previous);
  return { ...(await status(sql)), operation: 'rollback', restored_active_column: previous };
}

async function main(): Promise<void> {
  const args = parseSpikeArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  assertCloneTarget(databaseUrl, process.env.R1_ADDITIVE_BRIDGE_CLONE_ACK);
  const sql = postgres(databaseUrl, { max: 2, connect_timeout: 10, idle_timeout: 10 });
  try {
    const report = args.mode === 'status' ? await status(sql)
      : args.mode === 'prepare' ? await prepare(sql, args.batchSize)
      : args.mode === 'activate' ? await activate(sql)
      : await rollback(sql);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (args.receipt) writeFileSync(args.receipt, output, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(output);
  } finally {
    resetGateway();
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[r1-additive] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
