import { PGlite } from '@electric-sql/pglite';
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

export type SourceTransformFetcher = (source: SourceTransformSource) => Promise<SourceRecord[]>;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_DENY_RE = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do|vacuum|analyze|attach|detach)\b/i;

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function sanitizeIdentifier(raw: string): string | null {
  if (IDENT_RE.test(raw)) return raw;
  return null;
}

function inferSqlType(values: unknown[]): string {
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return 'text';
  if (nonNull.every(v => typeof v === 'boolean')) return 'boolean';
  if (nonNull.every(v => typeof v === 'number' && Number.isInteger(v))) return 'bigint';
  if (nonNull.every(v => typeof v === 'number')) return 'double precision';
  return 'text';
}

function coerceValue(value: unknown, sqlType: string): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (sqlType === 'boolean') return value === true || value === 'true';
  if (sqlType === 'bigint' || sqlType === 'double precision') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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

async function loadAliasTable(db: PGlite, alias: string, records: SourceRecord[]) {
  const rawKeys = new Set<string>(['__external_id', '__source_updated_at']);
  for (const record of records) {
    for (const key of Object.keys(record.data)) {
      const sanitized = sanitizeIdentifier(key);
      if (sanitized) rawKeys.add(sanitized);
    }
  }
  const keys = [...rawKeys].sort();
  const valuesByKey = new Map<string, unknown[]>();
  for (const key of keys) valuesByKey.set(key, []);
  for (const record of records) {
    for (const key of keys) {
      if (key === '__external_id') valuesByKey.get(key)!.push(record.external_id);
      else if (key === '__source_updated_at') valuesByKey.get(key)!.push(record.source_updated_at ?? null);
      else valuesByKey.get(key)!.push(record.data[key]);
    }
  }
  const types = Object.fromEntries(keys.map(k => [k, inferSqlType(valuesByKey.get(k) || [])]));
  const ddl = `CREATE TEMP TABLE ${quoteIdent(alias)} (${keys.map(k => `${quoteIdent(k)} ${types[k]}`).join(', ')})`;
  await db.exec(ddl);
  if (records.length === 0) return;
  const columns = keys.map(quoteIdent).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const insert = `INSERT INTO ${quoteIdent(alias)} (${columns}) VALUES (${placeholders})`;
  for (const record of records) {
    const params = keys.map(k => {
      const value = k === '__external_id' ? record.external_id : k === '__source_updated_at' ? record.source_updated_at : record.data[k];
      return coerceValue(value, types[k]);
    });
    await db.query(insert, params as any[]);
  }
}

export interface SourceTransformResult {
  records: SourceRecord[];
  row_count: number;
  source_counts: Record<string, number>;
  warnings: string[];
}

export async function executeSourceTransform(config: SourceTransformConfig, fetcher: SourceTransformFetcher): Promise<SourceTransformResult> {
  const issues = validateTransformSql(config.sql);
  if (issues.length) throw new Error(`invalid transform SQL: ${issues.join(', ')}`);
  const db = new PGlite();
  const sourceCounts: Record<string, number> = {};
  const warnings: string[] = [];
  try {
    for (const source of config.sources) {
      const records = await fetcher(source);
      sourceCounts[source.alias] = records.length;
      await loadAliasTable(db, source.alias, records);
    }
    const result = await db.query(config.sql.trim().replace(/;\s*$/, ''));
    const rows = result.rows as Record<string, unknown>[];
    const keyField = config.primary_key_field || (rows.some(r => r.id !== undefined) ? 'id' : undefined);
    const updatedField = config.updated_at_field || (rows.some(r => r.updated_at !== undefined) ? 'updated_at' : undefined);
    const records = rows.map((row, i) => {
      const key = keyField && row[keyField] !== undefined && row[keyField] !== null && row[keyField] !== '' ? String(row[keyField]) : `row-${i + 1}`;
      const updated = updatedField && typeof row[updatedField] === 'string' ? row[updatedField] as string : null;
      return { external_id: key, source_updated_at: updated, data: { ...row, id: row.id ?? key } };
    });
    return { records, row_count: records.length, source_counts: sourceCounts, warnings };
  } finally {
    await db.close();
  }
}
