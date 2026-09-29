import { createHash } from 'node:crypto';

export interface DirectoryGuardPolicy {
  readonly fields: Readonly<Record<'id' | 'key' | 'name' | 'type' | 'created' | 'parent' | 'site', string>>;
  readonly dateFormat: 'MM/DD/YYYY HH:mm:ss' | 'DD.MM.YYYY HH:mm:ss';
  /** Fixed UTC offset, never host-local time or ambiguous named zones. */
  readonly timezone: string;
  readonly rootParentValues?: readonly (null | '')[];
  readonly passportFields: readonly string[];
  readonly anchors: readonly DirectoryIdentityRecord[];
  readonly typeAllowlist: readonly string[];
  readonly scope: { readonly sites: readonly string[] };
}
export interface DirectoryIdentityRecord {
  readonly id: string; readonly key: string; readonly name: string; readonly type: string;
  readonly created: string | null; readonly parent: string | null; readonly site: string;
}
export interface DirectoryUpstreamBinding {
  readonly connectorInstanceId: string; readonly objectName: string; readonly alias: string;
  readonly sourceTableId: string | null; readonly resolvedCatalogId: string | null;
}
export interface DirectoryBaseline {
  readonly version: 1; readonly sourceId: string; readonly profileId: string;
  readonly policyHash: string; readonly snapshotHash: string;
  readonly upstreamBinding: DirectoryUpstreamBinding; readonly upstreamBindingHash: string;
  readonly knownIdentityRecords: readonly DirectoryIdentityRecord[];
}
export interface DirectoryGuardInput {
  readonly upstreamBinding: DirectoryUpstreamBinding;
  readonly sourceId: string; readonly profileId: string; readonly policy: DirectoryGuardPolicy;
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly complete: boolean; readonly mode: 'preview' | 'run';
  readonly baseline?: DirectoryBaseline; readonly bootstrapSnapshotHash?: string;
}
export type DirectoryGuardResult =
  | { readonly status: 'stopped'; readonly diagnostics: readonly string[] }
  | { readonly status: 'review' | 'prepared'; readonly snapshotHash: string; readonly policyHash: string;
      readonly records: readonly Readonly<Record<string, unknown>>[];
      readonly identities: readonly DirectoryIdentityRecord[]; readonly candidateBaseline: DirectoryBaseline };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}
function normalizeDate(value: unknown, policy: DirectoryGuardPolicy): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw Error('invalid_created');
  const re = policy.dateFormat === 'MM/DD/YYYY HH:mm:ss'
    ? /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/
    : /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
  const m = re.exec(value);
  if (!m) throw Error('invalid_created');
  const [, a, b, y, h, minute, second] = m.map(Number);
  const month = policy.dateFormat === 'MM/DD/YYYY HH:mm:ss' ? a : b;
  const day = policy.dateFormat === 'MM/DD/YYYY HH:mm:ss' ? b : a;
  const date = new Date(0);
  date.setUTCFullYear(y, month - 1, day); date.setUTCHours(h, minute, second, 0);
  if (y < 1 || date.getUTCFullYear() !== y || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== h || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw Error('invalid_created');
  const zone = /^([+-])(\d{2}):(\d{2})$/.exec(policy.timezone)!;
  const offset = (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === '+' ? 1 : -1);
  const utc = new Date(date.getTime() - offset * 60_000);
  if (utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) throw Error('invalid_created');
  return utc.toISOString();
}
/** Strict, reusable policy validation; throws rather than coercing policy values. */
export function validateDirectoryGuardPolicy(raw: unknown): asserts raw is DirectoryGuardPolicy {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(raw) || Object.keys(raw).some(k => !['fields','dateFormat','timezone','passportFields','anchors','typeAllowlist','scope','rootParentValues'].includes(k))) throw Error('invalid_guard_policy');
  if (!object(raw.fields) || Object.keys(raw.fields).sort().join(',') !== 'created,id,key,name,parent,site,type' || Object.values(raw.fields).some(v => !safeId(v)) || new Set(Object.values(raw.fields)).size !== 7) throw Error('invalid_field_policy');
  const zone = typeof raw.timezone === 'string' && /^([+-])(\d{2}):(\d{2})$/.exec(raw.timezone);
  if (!zone || +zone[2] > 14 || +zone[3] > 59 || (+zone[2] === 14 && +zone[3] !== 0) || !['MM/DD/YYYY HH:mm:ss','DD.MM.YYYY HH:mm:ss'].includes(String(raw.dateFormat))) throw Error('invalid_date_policy');
  for (const key of ['passportFields','typeAllowlist']) if (!Array.isArray(raw[key]) || (raw[key] as unknown[]).some(v => typeof v !== 'string' || !v) || new Set(raw[key] as unknown[]).size !== (raw[key] as unknown[]).length) throw Error('invalid_guard_policy');
  if ((raw.passportFields as unknown[]).some(v => !safeId(v)) || !object(raw.scope) || Object.keys(raw.scope).join(',') !== 'sites' || !Array.isArray(raw.scope.sites) || raw.scope.sites.some(v => !safeId(v))) throw Error('invalid_guard_scope');
  if (raw.rootParentValues !== undefined && (!Array.isArray(raw.rootParentValues) || !raw.rootParentValues.length || raw.rootParentValues.some(v => v !== null && v !== '') || new Set(raw.rootParentValues).size !== raw.rootParentValues.length)) throw Error('invalid_root_policy');
  if (!Array.isArray(raw.anchors) || raw.anchors.some(v => !object(v) || Object.keys(v).sort().join(',') !== 'created,id,key,name,parent,site,type' || !safeId(v.id) || !safeId(v.key) || !safeId(v.site) || typeof v.name !== 'string' || !v.name || typeof v.type !== 'string' || (v.parent !== null && !safeId(v.parent)) || (v.created !== null && (typeof v.created !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(v.created))))) throw Error('invalid_anchor_policy');
}
export function prepareDirectorySnapshot(input: DirectoryGuardInput): DirectoryGuardResult {
  try { return prepare(input); } catch (error) {
    return Object.freeze({ status: 'stopped', diagnostics: Object.freeze([error instanceof Error ? error.message : 'invalid_input']) });
  }
}
function prepare(input: DirectoryGuardInput): DirectoryGuardResult {
  const p = input.policy;
  validateDirectoryGuardPolicy(p);
  if (!input.complete) throw Error('incomplete_snapshot');
  if (!safeId(input.sourceId) || !safeId(input.profileId)) throw Error('invalid_binding');
  const binding = input.upstreamBinding;
  if (!binding || Object.keys(binding).sort().join(',') !== 'alias,connectorInstanceId,objectName,resolvedCatalogId,sourceTableId'
    || [binding.connectorInstanceId, binding.objectName, binding.alias].some(v => typeof v !== 'string' || !v.trim() || /[\p{C}]/u.test(v))
    || [binding.sourceTableId, binding.resolvedCatalogId].some(v => v !== null && (typeof v !== 'string' || !v.trim() || /[\p{C}]/u.test(v)))) throw Error('invalid_upstream_binding');
  const upstreamBinding = Object.freeze({ ...binding });
  const upstreamBindingHash = hash(upstreamBinding);
  if (!['preview', 'run'].includes(input.mode)) throw Error('invalid_mode');
  const zone = /^([+-])(\d{2}):(\d{2})$/.exec(p.timezone);
  if (!zone || +zone[2] > 14 || +zone[3] > 59 || (+zone[2] === 14 && +zone[3] !== 0)
    || !['MM/DD/YYYY HH:mm:ss', 'DD.MM.YYYY HH:mm:ss'].includes(p.dateFormat)) throw Error('invalid_date_policy');
  const fields = Object.values(p.fields);
  if (fields.length !== 7 || new Set(fields).size !== 7 || fields.some(f => !safeId(f))) throw Error('invalid_field_policy');
  const identities: DirectoryIdentityRecord[] = [];
  const byId = new Map<string, DirectoryIdentityRecord>();
  for (const raw of input.records) {
    const f = p.fields;
    const id = raw[f.id], key = raw[f.key], rawParent = raw[f.parent], site = raw[f.site];
    const parent = (p.rootParentValues ?? [null]).includes(rawParent as null | '') ? null : rawParent;
    if (!safeId(id) || !safeId(key) || !safeId(site) || (parent !== null && !safeId(parent))) throw Error('unsafe_identity');
    if (byId.has(id)) throw Error('duplicate_id');
    const name = raw[f.name], type = raw[f.type];
    if (typeof name !== 'string' || !name.trim() || typeof type !== 'string') throw Error('invalid_identity');
    if (p.scope.sites.includes(site) && !p.typeAllowlist.includes(type)) throw Error('unknown_scope_type');
    const identity = Object.freeze({ id, key, name, type, parent, site, created: normalizeDate(raw[f.created], p) });
    byId.set(id, identity); identities.push(identity);
  }
  const done = new Set<string>();
  for (const row of identities) {
    const path = new Set<string>(); let current: DirectoryIdentityRecord | undefined = row;
    while (current && !done.has(current.id)) {
      if (path.has(current.id)) throw Error('parent_cycle');
      path.add(current.id);
      if (current.parent === null) break;
      const parent = byId.get(current.parent);
      if (!parent) throw Error('missing_parent');
      if (parent.site !== current.site) throw Error('cross_site_parent');
      current = parent;
    }
    for (const id of path) done.add(id);
  }
  const policyHash = hash(input.policy);
  if (input.baseline) {
    const b = input.baseline;
    if (!b || typeof b !== 'object' || Object.keys(b).sort().join(',') !== 'knownIdentityRecords,policyHash,profileId,snapshotHash,sourceId,upstreamBinding,upstreamBindingHash,version') throw Error('invalid_baseline');
    if (b.upstreamBindingHash !== upstreamBindingHash || hash(b.upstreamBinding) !== upstreamBindingHash) throw Error('baseline_upstream_binding_mismatch');
    if (b.version !== 1 || b.sourceId !== input.sourceId || b.profileId !== input.profileId || b.policyHash !== policyHash)
      throw Error('baseline_binding_mismatch');
    if (!/^[a-f0-9]{64}$/.test(b.snapshotHash) || !Array.isArray(b.knownIdentityRecords)) throw Error('invalid_baseline');
    const seen = new Set<string>();
    let priorId: string | undefined;
    for (const prior of b.knownIdentityRecords) {
      if (!prior || typeof prior !== 'object' || Object.keys(prior).sort().join(',') !== 'created,id,key,name,parent,site,type' || (priorId !== undefined && priorId >= prior.id)) throw Error('invalid_baseline');
      priorId = prior.id;
      if (!safeId(prior.id) || !safeId(prior.key) || !safeId(prior.site) || typeof prior.name !== 'string' || !prior.name.trim() || typeof prior.type !== 'string' || (prior.parent !== null && !safeId(prior.parent)) || (prior.created !== null && (typeof prior.created !== 'string' || !/^[0-9]{4}-/.test(prior.created) || !Number.isFinite(Date.parse(prior.created)))) || seen.has(prior.id)) throw Error('invalid_baseline');
      seen.add(prior.id);
      const current = byId.get(prior.id);
      if (!current) throw Error('known_id_disappeared');
      if (prior.created !== current.created) throw Error('created_identity_changed');
      if (prior.key !== current.key) throw Error('key_identity_changed');
      if (prior.name !== current.name && prior.type !== current.type) throw Error('name_and_type_changed');
    }
  }
  for (const anchor of p.anchors) {
    const actual = byId.get(anchor.id);
    if (!actual || hash(actual) !== hash(anchor)) throw Error('anchor_identity_drift');
  }
  identities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const projectionFields = [...new Set([...Object.values(p.fields), ...p.passportFields])].sort();
  if (projectionFields.some(k => !safeId(k))) throw Error('invalid_passport_field');
  const records = input.records.map(r => Object.freeze(Object.fromEntries(projectionFields.map(k => {
    const value = r[k] ?? null;
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)))
      throw Error('non_scalar_passport_field');
    if (typeof value === 'string' && (/\[\[|\]\]|<\s*[!/?A-Za-z]|-->|[\p{C}\u2028\u2029]/u.test(value))) throw Error('unsafe_source_text');
    return [k, value];
  })))).sort((a, b) => String(a[p.fields.id]) < String(b[p.fields.id]) ? -1 : 1);
  Object.freeze(records); Object.freeze(identities);
  const snapshotHash = hash({ version: 1, sourceId: input.sourceId, profileId: input.profileId, upstreamBinding, upstreamBindingHash, policyHash, records });
  if (input.mode === 'run' && !input.baseline && input.bootstrapSnapshotHash !== snapshotHash)
    throw Error('bootstrap_required');
  const candidateBaseline: DirectoryBaseline = Object.freeze({ version: 1, sourceId: input.sourceId, profileId: input.profileId,
    upstreamBinding, upstreamBindingHash, policyHash, snapshotHash, knownIdentityRecords: identities });
  return Object.freeze({ status: input.mode === 'preview' ? 'review' : 'prepared', snapshotHash, policyHash, records, identities, candidateBaseline });
}
