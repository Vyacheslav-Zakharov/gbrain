import type { DiscoveryProfile, FieldProfile, SourceConnector, SourceRecord } from './connectors/types.ts';

function typeOfValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

export function profileRecords(connectorId: string, objectName: string, records: SourceRecord[], totalEstimate?: number, opts: { fields?: string[]; primaryKeyField?: string; updatedAtField?: string } = {}): DiscoveryProfile {
  const fieldValues = new Map<string, unknown[]>();
  for (const r of records) {
    const flat = flatten(r.source_fields ?? r.data);
    for (const [k, v] of Object.entries(flat)) {
      if (!fieldValues.has(k)) fieldValues.set(k, []);
      fieldValues.get(k)!.push(v);
    }
  }

  for (const name of [...(opts.fields || []), opts.primaryKeyField, opts.updatedAtField]) {
    const clean = String(name || '').trim();
    if (clean && !fieldValues.has(clean)) fieldValues.set(clean, []);
  }

  const fields: FieldProfile[] = Array.from(fieldValues.entries()).map(([name, values]) => {
    const types = Array.from(new Set(values.map(typeOfValue))).sort();
    const nulls = values.filter(v => v === null || v === undefined || v === '').length;
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
    return {
      name,
      observedTypes: types,
      nullRatio: records.length === 0 ? 0 : nulls / records.length,
      cardinality: new Set(nonNull.map(v => JSON.stringify(v))).size,
      samples: Array.from(new Set(nonNull.map(v => JSON.stringify(v)))).slice(0, 5).map(s => JSON.parse(s)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const names = fields.map(f => f.name);
  const idCandidates = names.filter(n => /(^id$|_id$|uuid$|guid$|code$|inventory|external)/i.test(n));
  if (opts.primaryKeyField && names.includes(opts.primaryKeyField) && !idCandidates.includes(opts.primaryKeyField)) idCandidates.unshift(opts.primaryKeyField);
  const updatedAtCandidates = names.filter(n => /(updated|modified|changed).*(_at|date)?$/i.test(n));
  if (opts.updatedAtField && names.includes(opts.updatedAtField) && !updatedAtCandidates.includes(opts.updatedAtField)) updatedAtCandidates.unshift(opts.updatedAtField);
  const parentCandidates = names.filter(n => /(parent|parent_id|parent_code|parent_uuid)$/i.test(n));
  const warnings: string[] = [];
  if (records.length === 0) warnings.push('sample_returned_no_rows_check_table_name_or_appsheet_filter');
  if (idCandidates.length === 0) warnings.push('no_stable_id_candidate');
  if (updatedAtCandidates.length === 0) warnings.push('no_updated_at_candidate');

  return { connectorId, objectName, totalEstimate, sampled: records.length, fields, idCandidates, updatedAtCandidates, parentCandidates, warnings, samples: records };
}

export async function discoverSourceObject(connector: SourceConnector, objectName: string, limit = 50, opts: { fields?: string[]; primaryKeyField?: string; updatedAtField?: string } = {}): Promise<DiscoveryProfile> {
  const objects = await connector.listObjects();
  const descriptor = objects.find(o => o.name === objectName);
  if (!descriptor) throw new Error(`Object '${objectName}' is not exposed by connector '${connector.id}'`);
  const records = await connector.sample(objectName, limit, { fields: opts.fields });
  return profileRecords(connector.id, objectName, records, descriptor.estimatedCount, opts);
}
