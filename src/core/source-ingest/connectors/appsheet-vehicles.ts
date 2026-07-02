import { randomUUID } from 'crypto';
import { fetchWithSSRFGuard, validateAndResolveUrl } from '../../ssrf-validate.ts';
import type { SourceConnector, SourceObjectDescriptor, SourceRecord, SourceRecordBatch, SourceFetchOptions } from './types.ts';

export interface AppSheetVehicleConnectorConfig {
  appId?: string;
  accessKey?: string;
  tableName?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class AppSheetVehicleConnector implements SourceConnector {
  id = 'appsheet-vehicles';
  displayName = 'AppSheet автотранспорт';
  private readonly tableName: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AppSheetVehicleConnectorConfig = {}) {
    this.tableName = config.tableName || 'Автотранспорт';
    this.baseUrl = config.baseUrl || 'https://api.appsheet.com/api/v2/apps';
    this.fetchImpl = config.fetchImpl || fetch;
  }

  async listObjects(): Promise<SourceObjectDescriptor[]> {
    return [{ name: 'vehicle', displayName: 'Автотранспорт AppSheet', supportsChangedSince: true }];
  }

  async sample(objectName: string, limit: number, opts: SourceFetchOptions = {}): Promise<SourceRecord[]> {
    const rows = await this.fetchRows(objectName, { limit, fields: opts.fields });
    return rows.map(rowToVehicleRecord);
  }

  async *fetchAll(objectName: string, cursorOrOpts?: string | SourceFetchOptions, opts: SourceFetchOptions = {}): AsyncIterable<SourceRecordBatch> {
    const effectiveOpts = typeof cursorOrOpts === 'object' && cursorOrOpts !== null ? cursorOrOpts : opts;
    const rows = await this.fetchRows(objectName, { fields: effectiveOpts.fields });
    yield { records: rows.map(rowToVehicleRecord), cursor: null };
  }

  async *fetchChangedSince(objectName: string, since: string, opts: SourceFetchOptions = {}): AsyncIterable<SourceRecordBatch> {
    const rows = await this.fetchRows(objectName, { since, fields: opts.fields });
    yield { records: rows.map(rowToVehicleRecord), cursor: null };
  }

  private async fetchRows(objectName: string, opts: { limit?: number; since?: string; fields?: string[] }): Promise<Record<string, unknown>[]> {
    if (objectName !== 'vehicle') throw new Error(`AppSheet connector only supports vehicle object, got ${objectName}`);
    const appId = this.config.appId || process.env.APPSHEET_VEHICLES_APP_ID;
    const accessKey = this.config.accessKey || process.env.APPSHEET_VEHICLES_ACCESS_KEY;
    if (!appId || !accessKey) {
      throw new Error('AppSheet vehicle connector is scaffolded but not configured: set APPSHEET_VEHICLES_APP_ID and APPSHEET_VEHICLES_ACCESS_KEY or pass config explicitly.');
    }
    const url = `${this.baseUrl}/${encodeURIComponent(appId)}/tables/${encodeURIComponent(this.tableName)}/Action`;
    const selectorParts = opts.since
      ? [`[updated_at] > "${opts.since}"`]
      : [];
    const requestedColumns = sourceFieldsToAppSheetColumns(opts.fields);
    const body: Record<string, unknown> = {
      Action: 'Find',
      Properties: {
        Locale: 'ru-RU',
        ...(requestedColumns.length ? { ColumnNames: requestedColumns } : {}),
        ...(selectorParts.length ? { Selector: `Filter(${JSON.stringify(this.tableName)}, ${selectorParts.join(' AND ')})` } : {}),
      },
      Rows: [],
    };
    const res = await this.fetchAppSheet(url, {
      method: 'POST',
      headers: { 'ApplicationAccessKey': accessKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      maxRedirects: 3,
      timeoutMs: 10000,
    });
    if (!res.ok) throw new Error(`AppSheet vehicle fetch failed: HTTP ${res.status}`);
    const json = await res.json() as unknown;
    const rawRows: unknown[] = Array.isArray(json)
      ? json
      : Array.isArray((json as Record<string, unknown>)?.Rows)
        ? ((json as Record<string, unknown>).Rows as unknown[])
        : [];
    return (rawRows as Record<string, unknown>[]).slice(0, opts.limit ?? rawRows.length);
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

export function sourceFieldsToAppSheetColumns(fields?: string[]): string[] {
  if (!Array.isArray(fields) || fields.length === 0) return [];
  const out: string[] = [];
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

export function rowToVehicleRecord(row: Record<string, unknown>): SourceRecord {
  const id = String(pick(row, ['id', 'ID', 'key', 'Key', 'код', 'Код']) ?? pick(row, ['plate', 'ГосНомер', 'госномер']) ?? randomUUID());
  const updated = pick(row, ['updated_at', 'UpdatedAt', 'ДатаИзменения', 'modified_at']);
  const code = pick(row, ['code', 'Код', 'plate', 'ГосНомер', 'name', 'Наименование']) ?? id;
  const name = pick(row, ['name', 'Наименование', 'Марка', 'model', 'Модель']) ?? code;
  return {
    external_id: id,
    source_updated_at: typeof updated === 'string' ? updated : null,
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
