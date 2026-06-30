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

export function profileRecords(connectorId: string, objectName: string, records: SourceRecord[], totalEstimate?: number): DiscoveryProfile {
  const fieldValues = new Map<string, unknown[]>();
  for (const r of records) {
    const flat = flatten(r.data);
    for (const [k, v] of Object.entries(flat)) {
      if (!fieldValues.has(k)) fieldValues.set(k, []);
      fieldValues.get(k)!.push(v);
    }
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
  const updatedAtCandidates = names.filter(n => /(updated|modified|changed).*(_at|date)?$/i.test(n));
  const parentCandidates = names.filter(n => /(parent|parent_id|parent_code|parent_uuid)$/i.test(n));
  const warnings: string[] = [];
  if (idCandidates.length === 0) warnings.push('no_stable_id_candidate');
  if (updatedAtCandidates.length === 0) warnings.push('no_updated_at_candidate');

  return { connectorId, objectName, totalEstimate, sampled: records.length, fields, idCandidates, updatedAtCandidates, parentCandidates, warnings, samples: records };
}

export async function discoverSourceObject(connector: SourceConnector, objectName: string, limit = 50): Promise<DiscoveryProfile> {
  const objects = await connector.listObjects();
  const descriptor = objects.find(o => o.name === objectName);
  if (!descriptor) throw new Error(`Object '${objectName}' is not exposed by connector '${connector.id}'`);
  const records = await connector.sample(objectName, limit);
  return profileRecords(connector.id, objectName, records, descriptor.estimatedCount);
}
