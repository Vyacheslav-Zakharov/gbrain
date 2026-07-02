import { Worker } from 'node:worker_threads';
import type { SourceRecord } from './connectors/types.ts';

export interface SourceTransformSource {
  alias: string;
  connector?: string;
  object: string;
  fields?: string[];
  sample_limit?: number;
}

export interface SourceTransformConfig {
  engine?: 'pglite';
  sources: SourceTransformSource[];
  sql: string;
  primary_key_field?: string;
  updated_at_field?: string;
}

export interface SourceTransformExecuteOptions {
  /** Hard wall-clock timeout for SQL execution + temp table load in a worker. */
  timeoutMs?: number;
  /** Maximum rows the SQL result may return. The worker fetches cap+1 and fails if exceeded. */
  rowLimit?: number;
}

export type SourceTransformFetcher = (source: SourceTransformSource) => Promise<SourceRecord[]>;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_DENY_RE = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do|vacuum|analyze|attach|detach)\b/i;
const DEFAULT_TRANSFORM_TIMEOUT_MS = 15_000;
const DEFAULT_TRANSFORM_ROW_CAP = 5_000;

function sanitizeIdentifier(raw: string): string | null {
  if (IDENT_RE.test(raw)) return raw;
  return null;
}

export function validateTransformSql(sql: string): string[] {
  const issues: string[] = [];
  const trimmed = sql.trim();
  if (!trimmed) issues.push('sql_empty');
  if (!/^\s*(select|with)\b/i.test(trimmed)) issues.push('sql_must_start_with_select_or_with');
  const noTrailingSemicolon = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
  if (noTrailingSemicolon.includes(';')) issues.push('sql_multiple_statements_not_allowed');
  if (SQL_DENY_RE.test(trimmed)) issues.push('sql_contains_mutating_or_ddl_keyword');
  return issues;
}

export function normalizeTransformSource(raw: unknown): SourceTransformSource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const alias = typeof r.alias === 'string' ? sanitizeIdentifier(r.alias) : null;
  const object = typeof r.object === 'string' && r.object.trim() ? r.object.trim() : '';
  if (!alias || !object) return null;
  return {
    alias,
    connector: typeof r.connector === 'string' && r.connector.trim() ? r.connector.trim() : undefined,
    object,
    fields: Array.isArray(r.fields) ? r.fields.map(String).filter(Boolean) : undefined,
    sample_limit: typeof r.sample_limit === 'number' && Number.isFinite(r.sample_limit) ? Math.max(0, Math.floor(r.sample_limit)) : undefined,
  };
}

export function normalizeTransformConfig(raw: unknown): SourceTransformConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const sources = Array.isArray(r.sources) ? r.sources.map(normalizeTransformSource).filter((s): s is SourceTransformSource => Boolean(s)) : [];
  if (sources.length === 0 || typeof r.sql !== 'string') return undefined;
  return {
    engine: 'pglite',
    sources,
    sql: r.sql,
    primary_key_field: typeof r.primary_key_field === 'string' && r.primary_key_field.trim() ? r.primary_key_field.trim() : undefined,
    updated_at_field: typeof r.updated_at_field === 'string' && r.updated_at_field.trim() ? r.updated_at_field.trim() : undefined,
  };
}

export interface SourceTransformResult {
  records: SourceRecord[];
  row_count: number;
  source_counts: Record<string, number>;
  warnings: string[];
}

interface WorkerSourcePayload {
  alias: string;
  records: SourceRecord[];
}

interface WorkerSuccess {
  ok: true;
  rows: Record<string, unknown>[];
}

interface WorkerFailure {
  ok: false;
  error: string;
}

const TRANSFORM_WORKER_SRC = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { PGlite } = require('@electric-sql/pglite');

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function quoteIdent(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }
function sanitizeIdentifier(raw) { return IDENT_RE.test(String(raw)) ? String(raw) : null; }
function inferSqlType(values) {
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return 'text';
  if (nonNull.every(v => typeof v === 'boolean')) return 'boolean';
  if (nonNull.every(v => typeof v === 'number' && Number.isInteger(v))) return 'bigint';
  if (nonNull.every(v => typeof v === 'number')) return 'double precision';
  return 'text';
}
function coerceValue(value, sqlType) {
  if (value === undefined || value === null || value === '') return null;
  if (sqlType === 'boolean') return value === true || value === 'true';
  if (sqlType === 'bigint' || sqlType === 'double precision') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
async function loadAliasTable(db, alias, records) {
  const rawKeys = new Set(['__external_id', '__source_updated_at']);
  for (const record of records) {
    for (const key of Object.keys(record.data || {})) {
      const sanitized = sanitizeIdentifier(key);
      if (sanitized) rawKeys.add(sanitized);
    }
  }
  const keys = [...rawKeys].sort();
  const valuesByKey = new Map();
  for (const key of keys) valuesByKey.set(key, []);
  for (const record of records) {
    for (const key of keys) {
      if (key === '__external_id') valuesByKey.get(key).push(record.external_id);
      else if (key === '__source_updated_at') valuesByKey.get(key).push(record.source_updated_at ?? null);
      else valuesByKey.get(key).push((record.data || {})[key]);
    }
  }
  const types = Object.fromEntries(keys.map(k => [k, inferSqlType(valuesByKey.get(k) || [])]));
  await db.exec('CREATE TEMP TABLE ' + quoteIdent(alias) + ' (' + keys.map(k => quoteIdent(k) + ' ' + types[k]).join(', ') + ')');
  if (records.length === 0) return;
  const columns = keys.map(quoteIdent).join(', ');
  const placeholders = keys.map((_, i) => '$' + (i + 1)).join(', ');
  const insert = 'INSERT INTO ' + quoteIdent(alias) + ' (' + columns + ') VALUES (' + placeholders + ')';
  for (const record of records) {
    const params = keys.map(k => {
      const value = k === '__external_id' ? record.external_id : k === '__source_updated_at' ? record.source_updated_at : (record.data || {})[k];
      return coerceValue(value, types[k]);
    });
    await db.query(insert, params);
  }
}
(async () => {
  const db = new PGlite();
  try {
    for (const source of workerData.sources) await loadAliasTable(db, source.alias, source.records);
    const sql = String(workerData.sql).trim().replace(/;\s*$/, '');
    const limit = Math.max(1, Math.floor(workerData.rowLimit)) + 1;
    const wrapped = 'SELECT * FROM (' + sql + ') AS __gbrain_transform_result LIMIT ' + limit;
    const result = await db.query(wrapped);
    if (result.rows.length >= limit) {
      throw new Error('transform_row_cap_exceeded: result exceeds ' + workerData.rowLimit + ' rows');
    }
    parentPort.postMessage({ ok: true, rows: result.rows });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
  } finally {
    try { await db.close(); } catch (e) {}
  }
})();
`;

function runTransformWorker(payload: {
  sources: WorkerSourcePayload[];
  sql: string;
  rowLimit: number;
  timeoutMs: number;
}): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(TRANSFORM_WORKER_SRC, { eval: true, workerData: payload });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error(`transform_timeout: exceeded ${payload.timeoutMs}ms`));
    }, payload.timeoutMs);
    (timeout as unknown as { unref?: () => void }).unref?.();
    worker.on('message', (msg: WorkerSuccess | WorkerFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (msg?.ok) resolve(msg.rows);
      else reject(new Error(msg?.error || 'transform_worker_failed'));
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      reject(err);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) reject(new Error('transform_worker_exited_without_result'));
      else reject(new Error(`transform_worker_exit_${code}`));
    });
  });
}

function rowTimestampToIso(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

export async function executeSourceTransform(
  config: SourceTransformConfig,
  fetcher: SourceTransformFetcher,
  opts: SourceTransformExecuteOptions = {},
): Promise<SourceTransformResult> {
  const issues = validateTransformSql(config.sql);
  if (!config.primary_key_field) issues.push('primary_key_field_required');
  if (issues.length) throw new Error(`invalid transform SQL: ${issues.join(', ')}`);
  const sourceCounts: Record<string, number> = {};
  const warnings: string[] = [];
  const sources: WorkerSourcePayload[] = [];
  for (const source of config.sources) {
    const records = await fetcher(source);
    sourceCounts[source.alias] = records.length;
    sources.push({ alias: source.alias, records });
  }
  const rowLimit = Math.max(1, Math.floor(opts.rowLimit ?? DEFAULT_TRANSFORM_ROW_CAP));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_TRANSFORM_TIMEOUT_MS));
  const rows = await runTransformWorker({ sources, sql: config.sql, rowLimit, timeoutMs });
  const keyField = config.primary_key_field || (rows.some(r => r.id !== undefined) ? 'id' : undefined);
  const updatedField = config.updated_at_field || (rows.some(r => r.updated_at !== undefined) ? 'updated_at' : undefined);
  const records = rows.map((row) => {
    const keyValue = keyField ? row[keyField] : undefined;
    if (keyValue === undefined || keyValue === null || keyValue === '') {
      throw new Error(`transform_primary_key_missing: ${keyField}`);
    }
    const key = String(keyValue);
    const updated = updatedField ? rowTimestampToIso(row[updatedField]) : null;
    return { external_id: key, source_updated_at: updated, data: { ...row, id: row.id ?? key } };
  });
  return { records, row_count: records.length, source_counts: sourceCounts, warnings };
}
