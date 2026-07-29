import { createHash } from 'crypto';
import { fetchWithSSRFGuard, validateAndResolveUrl } from '../../ssrf-validate.ts';
import type { SourceConnector, SourceObjectDescriptor, SourceRecord, SourceRecordBatch, SourceFetchOptions } from './types.ts';

export interface AppSheetConnectorConfig {
  connectorId?: string;
  appId?: string;
  accessKey?: string;
  tableName?: string;
  primaryKeyField?: string;
  updatedAtField?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** @deprecated Use AppSheetConnectorConfig. Kept for source compatibility. */
export type AppSheetVehicleConnectorConfig = AppSheetConnectorConfig;

export class AppSheetConnector implements SourceConnector {
  id = 'appsheet-vehicles';
  displayName = 'AppSheet';
  private readonly tableName: string;
  private readonly explicitTableName: boolean;
  private readonly primaryKeyField?: string;
  private readonly updatedAtField?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AppSheetConnectorConfig = {}) {
    this.id = config.connectorId?.trim() || 'appsheet-vehicles';
    this.displayName = this.id === 'appsheet-vehicles' || this.id === 'appsheet'
      ? 'AppSheet автотранспорт'
      : `AppSheet (${this.id})`;
    this.explicitTableName = typeof config.tableName === 'string' && config.tableName.trim().length > 0;
    this.tableName = config.tableName?.trim() || 'vehicles';
    this.primaryKeyField = config.primaryKeyField?.trim() || undefined;
    this.updatedAtField = config.updatedAtField?.trim() || undefined;
    this.baseUrl = config.baseUrl || 'https://api.appsheet.com/api/v2/apps';
    this.timeoutMs = Number.isFinite(config.timeoutMs) ? Math.min(Math.max(Number(config.timeoutMs), 1_000), 120_000) : 30_000;
    this.fetchImpl = config.fetchImpl || fetch;
  }

  async listObjects(): Promise<SourceObjectDescriptor[]> {
    const primary = { name: this.objectName(), displayName: this.usesGenericRecordShape() ? this.tableName : 'Автотранспорт AppSheet', supportsChangedSince: true };
    return this.explicitTableName && !this.usesGenericRecordShape() && primary.name !== 'vehicle'
      ? [primary, { name: 'vehicle', displayName: 'Автотранспорт AppSheet (legacy alias)', supportsChangedSince: true }]
      : [primary];
  }

  async sample(objectName: string, limit: number, opts: SourceFetchOptions = {}): Promise<SourceRecord[]> {
    const rows = await this.fetchRows(objectName, { limit, fields: opts.fields });
    return rows.map(row => this.toSourceRecord(row, true));
  }

  async *fetchAll(objectName: string, cursorOrOpts?: string | SourceFetchOptions, opts: SourceFetchOptions = {}): AsyncIterable<SourceRecordBatch> {
    const effectiveOpts = typeof cursorOrOpts === 'object' && cursorOrOpts !== null ? cursorOrOpts : opts;
    const rows = await this.fetchRows(objectName, { fields: effectiveOpts.fields });
    yield { records: rows.map(row => this.toSourceRecord(row)), cursor: null };
  }

  async *fetchChangedSince(objectName: string, since: string, opts: SourceFetchOptions = {}): AsyncIterable<SourceRecordBatch> {
    const rows = await this.fetchRows(objectName, { since, fields: opts.fields });
    yield { records: rows.map(row => this.toSourceRecord(row)), cursor: null };
  }

  private async fetchRows(objectName: string, opts: { limit?: number; since?: string; fields?: string[] }): Promise<Record<string, unknown>[]> {
    if (objectName !== this.objectName() && !(objectName === 'vehicle' && !this.usesGenericRecordShape())) throw new Error(`AppSheet connector is configured for object/table ${this.objectName()}, got ${objectName}`);
    const legacyVehicleConnector = this.id === 'appsheet-vehicles' || this.id === 'appsheet';
    const appId = this.config.appId || (legacyVehicleConnector ? process.env.APPSHEET_VEHICLES_APP_ID : undefined);
    const accessKey = this.config.accessKey || (legacyVehicleConnector ? process.env.APPSHEET_VEHICLES_ACCESS_KEY : undefined);
    if (!appId || !accessKey) {
      throw new Error(`AppSheet credentials are not configured for connector ${this.id}; store app_id/access_key under connector:${this.id}.`);
    }
    const url = `${this.baseUrl}/${encodeURIComponent(appId)}/tables/${encodeURIComponent(this.tableName)}/Action`;
    const changedSinceField = this.updatedAtField || (this.usesGenericRecordShape() ? undefined : 'updated_at');
    const selectorParts = opts.since && changedSinceField
      ? [`[${changedSinceField}] > ${JSON.stringify(normalizeAppSheetSince(opts.since))}`]
      : [];
    // Do not pass Properties.ColumnNames to AppSheet Find.
    // Some AppSheet apps return an empty array when ColumnNames is present even
    // for valid columns (observed with the Avers vehicles table). Fetch the row
    // shape as-is, then let GBrain profile/filter/mapping operate locally.
    const body: Record<string, unknown> = {
      Action: 'Find',
      Properties: {
        Locale: 'ru-RU',
        ...(selectorParts.length ? { Selector: `Filter(${JSON.stringify(this.tableName)}, ${selectorParts.join(' AND ')})` } : {}),
      },
      Rows: [],
    };
    const res = await this.fetchAppSheet(url, {
      method: 'POST',
      headers: { 'ApplicationAccessKey': accessKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      maxRedirects: 3,
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok) throw new Error(`AppSheet fetch failed for connector ${this.id}, table ${this.tableName}: HTTP ${res.status}`);
    const json = await res.json() as unknown;
    const hasRowsEnvelope = json !== null && typeof json === 'object' && !Array.isArray(json) && Array.isArray((json as Record<string, unknown>).Rows);
    if (!Array.isArray(json) && !hasRowsEnvelope) {
      throw new Error(`AppSheet unexpected response shape for table ${this.tableName}; expected an array of rows.`);
    }
    const rawRows: unknown[] = Array.isArray(json)
      ? json
      : ((json as Record<string, unknown>).Rows as unknown[]);
    return (rawRows as Record<string, unknown>[]).slice(0, opts.limit ?? rawRows.length);
  }

  private objectName(): string {
    return this.explicitTableName ? this.tableName : 'vehicle';
  }

  private usesGenericRecordShape(): boolean {
    const normalized = this.tableName.trim().toLowerCase();
    return normalized !== 'vehicles' && normalized !== 'автотранспорт';
  }

  private toSourceRecord(row: Record<string, unknown>, allowUnstableDiscoveryId = false): SourceRecord {
    return this.usesGenericRecordShape()
      ? rowToGenericAppSheetRecord(row, {
          tableName: this.tableName,
          primaryKeyField: this.primaryKeyField,
          updatedAtField: this.updatedAtField,
          allowUnstableDiscoveryId,
        })
      : rowToVehicleRecord(row);
  }

  private async fetchAppSheet(url: string, init: RequestInit & { maxRedirects?: number; timeoutMs?: number }): Promise<Response> {
    if (this.fetchImpl === fetch) {
      return fetchWithSSRFGuard(url, init);
    }

    // Test/custom fetch seam: still run the same SSRF validator before handing
    // a credentialed AppSheet request to the injected fetch implementation.
    const target = await validateAndResolveUrl(url);
    const headers = new Headers(init.headers || {});
    if (target.originalHost) headers.set('Host', target.originalHost);
    return this.fetchImpl(target.resolvedUrl, { ...init, redirect: 'manual', headers });
  }
}

/** @deprecated Use AppSheetConnector. Kept for existing imports and legacy vehicle profiles. */
export class AppSheetVehicleConnector extends AppSheetConnector {}

function normalizeAppSheetSince(since: string): string {
  const trimmed = since.trim();
  if (!trimmed || /["\\]/.test(trimmed)) {
    throw new Error('invalid AppSheet changed-since timestamp');
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error('invalid AppSheet changed-since timestamp');
  }
  return new Date(ms).toISOString();
}

const VEHICLE_FIELD_COLUMN_MAP: Record<string, string[]> = {
  id: ['ID', 'id', 'Key', 'key', 'Код', 'код'],
  code: ['ГосНомер', 'plate', 'Код', 'code', 'Наименование', 'name'],
  name: ['Модель', 'Марка', 'Наименование', 'name', 'model'],
  model: ['Модель', 'model'],
  plate: ['ГосНомер', 'plate'],
  status: ['Статус', 'status'],
  vehicle_class: ['Класс', 'Тип', 'vehicle_class'],
  location_id: ['location_id', 'Локация', 'Местоположение'],
  responsible_person_id: ['responsible_person_id', 'Ответственный'],
  updated_at: ['ДатаИзменения', 'UpdatedAt', 'updated_at', 'modified_at'],
  source_updated_at: ['ДатаИзменения', 'UpdatedAt', 'updated_at', 'modified_at'],
};

function addUnique(out: string[], value: string) {
  const trimmed = value.trim();
  if (trimmed && !out.includes(trimmed)) out.push(trimmed);
}

export function sourceFieldsToAppSheetColumns(fields?: string[], opts: { primaryKeyField?: string; updatedAtField?: string; generic?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.primaryKeyField) addUnique(out, opts.primaryKeyField);
  if (opts.updatedAtField) addUnique(out, opts.updatedAtField);
  if (opts.generic) {
    for (const field of fields || []) {
      if (field && !field.includes('.')) addUnique(out, field);
    }
    return out;
  }
  if (!Array.isArray(fields) || fields.length === 0) fields = [];
  // Keep the minimal raw columns needed to build stable external_id/code/name
  // and changed-since metadata even when the UI selection only contains the
  // normalized GBrain field names.
  for (const f of ['id', 'code', 'name', 'updated_at']) {
    for (const col of VEHICLE_FIELD_COLUMN_MAP[f] || []) addUnique(out, col);
  }
  for (const field of fields) {
    if (!field || field === 'type' || field === 'is_group') continue;
    const mapped = VEHICLE_FIELD_COLUMN_MAP[field];
    if (mapped) {
      for (const col of mapped) addUnique(out, col);
    } else if (!field.includes('.')) {
      addUnique(out, field);
    }
  }
  return out;
}

function pick(row: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  return undefined;
}

function firstString(row: Record<string, unknown>, names: string[]): string | null {
  const value = pick(row, names);
  return value === undefined || value === null || value === '' ? null : String(value);
}

export function rowToGenericAppSheetRecord(row: Record<string, unknown>, opts: {
  tableName: string;
  primaryKeyField?: string;
  updatedAtField?: string;
  allowUnstableDiscoveryId?: boolean;
}): SourceRecord {
  const keyCandidates = [opts.primaryKeyField, 'id', 'ID', 'key', 'Key', 'uuid', 'UUID'].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const rawId = pick(row, keyCandidates);
  if ((rawId === undefined || rawId === null || rawId === '') && (opts.primaryKeyField || !opts.allowUnstableDiscoveryId)) {
    throw new Error(`AppSheet table ${opts.tableName} row is missing stable identity column; configure primary_key_field before ingest.`);
  }
  const id = rawId === undefined || rawId === null || rawId === ''
    ? `discovery-${createHash('sha256').update(JSON.stringify(row, Object.keys(row).sort())).digest('hex').slice(0, 16)}`
    : String(rawId);
  const updated = opts.updatedAtField ? pick(row, [opts.updatedAtField]) : pick(row, ['updated_at', 'UpdatedAt', 'modified_at', 'ModifiedAt', 'DATE_MODIFY']);
  const code = firstString(row, ['code', 'Code', 'Код', 'number', 'Number', 'name', 'Name', 'Наименование']) ?? id;
  const name = firstString(row, ['name', 'Name', 'Наименование', 'title', 'Title', 'description', 'Description']) ?? code;
  return {
    external_id: id,
    source_updated_at: typeof updated === 'string' ? updated : null,
    source_fields: { ...row },
    data: {
      ...row,
      id,
      code,
      name,
      type: opts.tableName,
      is_group: row.is_group === true || row.is_group === 'true' ? true : false,
      updated_at: typeof updated === 'string' ? updated : null,
    },
  };
}

export function rowToVehicleRecord(row: Record<string, unknown>): SourceRecord {
  const rawId = pick(row, ['vehicleID', 'VehicleID', 'id', 'ID', 'key', 'Key', 'код', 'Код']) ?? pick(row, ['plate', 'ГосНомер', 'госномер']);
  if (rawId === undefined || rawId === null || rawId === '') {
    throw new Error('AppSheet vehicle row is missing a stable identity column; configure/allowlist id, ID, key, Key, код, Код, plate, or ГосНомер before ingest.');
  }
  const id = String(rawId);
  const updated = pick(row, ['updated_at', 'UpdatedAt', 'ДатаИзменения', 'modified_at']);
  const code = pick(row, ['code', 'Код', 'plate', 'ГосНомер', 'name', 'Наименование']) ?? id;
  const name = pick(row, ['name', 'Наименование', 'Марка', 'model', 'Модель']) ?? code;
  return {
    external_id: id,
    source_updated_at: typeof updated === 'string' ? updated : null,
    source_fields: { ...row },
    data: {
      ...row,
      id,
      code: String(code),
      name: String(name),
      type: 'vehicle',
      is_group: row.is_group === true || row.is_group === 'true' ? true : false,
      updated_at: typeof updated === 'string' ? updated : null,
    },
  };
}
