import postgres from 'postgres';
import type { SourceConnector, SourceFetchOptions, SourceObjectDescriptor, SourceRecord, SourceRecordBatch } from './types.ts';

export interface PostgresSourceConnectorConfig {
  connectorId?: string;
  connection_string?: string;
  connectionString?: string;
  schema?: string;
  allowed_objects?: string[];
  allowedObjects?: string[];
  primary_key_field?: string;
  updated_at_field?: string;
  batch_size?: number;
}

const DEFAULT_ORG_OBJECTS = ['companies', 'departments', 'positions', 'employees'] as const;
const DEFAULT_PK_BY_OBJECT: Record<string, string> = {
  companies: 'company_id',
  departments: 'department_id',
  positions: 'position_id',
  employees: 'employment_id',
};

export class PostgresSourceConnector implements SourceConnector {
  id = 'postgres';
  displayName = 'Postgres read-only';
  private readonly connectionString?: string;
  private readonly schema: string;
  private readonly allowedObjects: string[];
  private readonly primaryKeyField?: string;
  private readonly updatedAtField: string;
  private readonly batchSize: number;

  constructor(private readonly config: PostgresSourceConnectorConfig = {}) {
    this.id = config.connectorId?.trim() || 'postgres';
    this.connectionString = config.connection_string || config.connectionString || process.env.SOURCE_INGEST_POSTGRES_DSN;
    this.schema = sanitizeIdentifier(config.schema || 'gbrain', 'schema');
    const configuredObjects = Array.isArray(config.allowed_objects) ? config.allowed_objects : (Array.isArray(config.allowedObjects) ? config.allowedObjects : undefined);
    this.allowedObjects = (configuredObjects?.length ? configuredObjects : [...DEFAULT_ORG_OBJECTS]).map(v => sanitizeIdentifier(String(v), 'object'));
    this.primaryKeyField = typeof config.primary_key_field === 'string' && config.primary_key_field.trim() ? sanitizeIdentifier(config.primary_key_field, 'primary_key_field') : undefined;
    this.updatedAtField = typeof config.updated_at_field === 'string' && config.updated_at_field.trim() ? sanitizeIdentifier(config.updated_at_field, 'updated_at_field') : 'updated_at';
    this.batchSize = Math.max(1, Math.min(1000, Number(config.batch_size) || 500));
  }

  async listObjects(): Promise<SourceObjectDescriptor[]> {
    const rows = await this.withSql(async sql => {
      const out: SourceObjectDescriptor[] = [];
      for (const objectName of this.allowedObjects) {
        const countRows = await sql.unsafe(`SELECT count(*)::int AS count FROM ${this.qualifiedTable(objectName)}`) as Array<{ count: number }>;
        out.push({ name: objectName, displayName: `${this.schema}.${objectName}`, estimatedCount: Number(countRows[0]?.count ?? 0), supportsChangedSince: true });
      }
      return out;
    });
    return rows;
  }

  async sample(objectName: string, limit: number, opts: SourceFetchOptions = {}): Promise<SourceRecord[]> {
    const object = this.assertAllowedObject(objectName);
    const fields = await this.selectedColumns(object, opts.fields);
    const pk = this.primaryKeyFor(object);
    const updatedAt = this.updatedAtField;
    const rows = await this.withSql(sql => sql.unsafe(
      `SELECT ${fields.map(quoteIdentifier).join(', ')} FROM ${this.qualifiedTable(object)} ORDER BY ${quoteIdentifier(updatedAt)} DESC NULLS LAST, ${quoteIdentifier(pk)} ASC LIMIT $1`,
      [Math.max(0, Math.min(1000, Number(limit) || 0))],
    ) as Promise<Array<Record<string, unknown>>>);
    return rows.map(row => this.toSourceRecord(object, row));
  }

  async *fetchAll(objectName: string, cursorOrOpts?: string | SourceFetchOptions, opts: SourceFetchOptions = {}): AsyncIterable<SourceRecordBatch> {
    const object = this.assertAllowedObject(objectName);
    const effectiveOpts = typeof cursorOrOpts === 'object' && cursorOrOpts !== null ? cursorOrOpts : opts;
    let offset = typeof cursorOrOpts === 'string' ? Number(cursorOrOpts) || 0 : 0;
    while (true) {
      const rows = await this.fetchPage(object, { offset, fields: effectiveOpts.fields });
      const next = rows.length >= this.batchSize ? offset + rows.length : null;
      yield { records: rows.map(row => this.toSourceRecord(object, row)), cursor: next === null ? null : String(next) };
      if (next === null || rows.length === 0) break;
      offset = next;
    }
  }

  async *fetchChangedSince(objectName: string, since: string, opts: SourceFetchOptions = {}): AsyncIterable<SourceRecordBatch> {
    const object = this.assertAllowedObject(objectName);
    const sinceDate = new Date(since);
    if (!Number.isFinite(sinceDate.getTime())) throw new Error('invalid Postgres changed-since timestamp');
    const fields = await this.selectedColumns(object, opts.fields);
    const pk = this.primaryKeyFor(object);
    const updatedAt = this.updatedAtField;
    let offset = 0;
    while (true) {
      const rows = await this.withSql(sql => sql.unsafe(
        `SELECT ${fields.map(quoteIdentifier).join(', ')} FROM ${this.qualifiedTable(object)} WHERE ${quoteIdentifier(updatedAt)} > $1 ORDER BY ${quoteIdentifier(updatedAt)} ASC, ${quoteIdentifier(pk)} ASC LIMIT $2 OFFSET $3`,
        [sinceDate.toISOString(), this.batchSize, offset],
      ) as Promise<Array<Record<string, unknown>>>);
      const next = rows.length >= this.batchSize ? offset + rows.length : null;
      yield { records: rows.map(row => this.toSourceRecord(object, row)), cursor: next === null ? null : String(next) };
      if (next === null || rows.length === 0) break;
      offset = next;
    }
  }

  async fetchById(objectName: string, id: string, opts: SourceFetchOptions = {}): Promise<SourceRecord | null> {
    const object = this.assertAllowedObject(objectName);
    const fields = await this.selectedColumns(object, opts.fields);
    const pk = this.primaryKeyFor(object);
    const rows = await this.withSql(sql => sql.unsafe(
      `SELECT ${fields.map(quoteIdentifier).join(', ')} FROM ${this.qualifiedTable(object)} WHERE ${quoteIdentifier(pk)} = $1 LIMIT 1`,
      [id],
    ) as Promise<Array<Record<string, unknown>>>);
    return rows[0] ? this.toSourceRecord(object, rows[0]) : null;
  }

  private async fetchPage(object: string, opts: { offset: number; fields?: string[] }): Promise<Array<Record<string, unknown>>> {
    const fields = await this.selectedColumns(object, opts.fields);
    const pk = this.primaryKeyFor(object);
    return this.withSql(sql => sql.unsafe(
      `SELECT ${fields.map(quoteIdentifier).join(', ')} FROM ${this.qualifiedTable(object)} ORDER BY ${quoteIdentifier(pk)} ASC LIMIT $1 OFFSET $2`,
      [this.batchSize, opts.offset],
    ) as Promise<Array<Record<string, unknown>>>);
  }

  private async selectedColumns(object: string, requested?: string[]): Promise<string[]> {
    const pk = this.primaryKeyFor(object);
    const requestedClean = (requested || []).map(v => String(v).trim()).filter(Boolean).map(v => sanitizeIdentifier(v, 'field'));
    if (requestedClean.length === 0) return await this.introspectColumns(object, pk);
    const base = [pk, this.updatedAtField];
    return Array.from(new Set([...base, ...requestedClean]));
  }

  private async introspectColumns(object: string, pk: string): Promise<string[]> {
    const rows = await this.withSql(sql => sql.unsafe(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [this.schema, object],
    ) as Promise<Array<{ column_name: string }>>);
    const columns = rows.map(r => String(r.column_name)).filter(Boolean).map(v => sanitizeIdentifier(v, 'field'));
    if (columns.length === 0) throw new Error(`Postgres connector could not introspect columns for ${this.schema}.${object}`);
    return Array.from(new Set([pk, ...columns.filter(c => c !== pk)]));
  }

  private toSourceRecord(object: string, row: Record<string, unknown>): SourceRecord {
    const pk = this.primaryKeyFor(object);
    const rawId = row[pk];
    if (rawId === undefined || rawId === null || rawId === '') {
      throw new Error(`Postgres ${this.schema}.${object} row is missing primary key ${pk}`);
    }
    const normalized = normalizeRow(row);
    const updated = normalized[this.updatedAtField];
    return {
      external_id: String(rawId),
      source_updated_at: typeof updated === 'string' ? updated : null,
      source_fields: normalized,
      data: {
        ...normalized,
        id: String(rawId),
        code: typeof normalized.code === 'string' && normalized.code ? normalized.code : String(rawId),
        name: typeof normalized.name === 'string' && normalized.name ? normalized.name : String(rawId),
        type: object,
        is_group: object === 'departments' || object === 'companies',
        updated_at: typeof updated === 'string' ? updated : null,
      },
    };
  }

  private primaryKeyFor(object: string): string {
    return this.primaryKeyField || DEFAULT_PK_BY_OBJECT[object] || 'id';
  }

  private qualifiedTable(object: string): string {
    return `${quoteIdentifier(this.schema)}.${quoteIdentifier(object)}`;
  }

  private assertAllowedObject(objectName: string): string {
    const object = sanitizeIdentifier(objectName, 'object');
    if (!this.allowedObjects.includes(object)) {
      throw new Error(`Postgres connector object not allowed: ${object}. Allowed: ${this.allowedObjects.join(', ')}`);
    }
    return object;
  }

  private async withSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    if (!this.connectionString) throw new Error('Postgres connector is not configured: set connection_string secret or SOURCE_INGEST_POSTGRES_DSN.');
    const sql = postgres(this.connectionString, { max: 1, idle_timeout: 1, connect_timeout: 10 });
    try {
      await sql`SET default_transaction_read_only = on`;
      return await fn(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

function sanitizeIdentifier(raw: string, label: string): string {
  const value = raw.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid Postgres ${label} identifier: ${raw}`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) out[key] = value.toISOString();
    else if (typeof value === 'bigint') out[key] = value.toString();
    else out[key] = value;
  }
  return out;
}
