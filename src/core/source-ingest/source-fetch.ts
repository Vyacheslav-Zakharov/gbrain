import { createHash } from 'node:crypto';
import { stableJson } from './store';
import { prepareDirectorySnapshot, type DirectoryBaseline, type DirectoryGuardResult } from './directory-identity-guard';
import type { BrainEngine } from '../engine.ts';
import { connectorSecretConfigId, defaultSourceConnectorConfigId, getSourceConnectorSecretConfig, listSourceConnectorConfigs } from './connector-config.ts';
import { listSourceBaseViews } from './catalog.ts';
import { getSourceConnector } from './connectors/fake.ts';
import type { SourceRecord } from './connectors/types.ts';
import type { SourceIngestProfile } from './profile-schema.ts';
import { executeSourceTransform, normalizeTransformConfig, type SourceTransformSource } from './transform.ts';

export interface SourceFetchContext {
  engine?: BrainEngine;
  guardMode?: 'preview' | 'run';
  onGuardPrepared?: (result: Exclude<DirectoryGuardResult, {status: 'stopped'}>, baselineKey: string, prior: string | null) => void;
  connectorConfigOverride?: Record<string, unknown>;
  defaultConnector: string;
  defaultObject: string;
}

function fieldsForSource(profile: SourceIngestProfile, connector: string, object: string): string[] | undefined {
  const t = normalizeTransformConfig(profile.transform);
  const src = t?.sources.find(s => (s.connector || profile.source_connector) === connector && s.object === object);
  if (src?.fields?.length) return src.fields;
  if (connector === profile.source_connector && object === profile.source_object) {
    return Array.isArray(profile.mapping?.source_fields) ? profile.mapping.source_fields : profile.update_policy.field_allowlist;
  }
  return undefined;
}

interface ResolvedSourceConnectorConfig {
  resolvedCatalogId?: string;
  connectorId: string;
  objectName: string;
  config: Record<string, unknown>;
}

async function resolveSourceConnectorConfig(ctx: SourceFetchContext, source: SourceTransformSource): Promise<ResolvedSourceConnectorConfig> {
  const fallbackConnectorId = source.connector || ctx.defaultConnector;
  const fallbackObjectName = source.object || ctx.defaultObject;
  const primary = fallbackConnectorId === ctx.defaultConnector && fallbackObjectName === ctx.defaultObject;
  if (primary && ctx.connectorConfigOverride && !source.source_table_id) {
    return { connectorId: fallbackConnectorId, objectName: fallbackObjectName, config: ctx.connectorConfigOverride };
  }
  if (!ctx.engine) return { connectorId: fallbackConnectorId, objectName: fallbackObjectName, config: primary ? (ctx.connectorConfigOverride || {}) : {} };
  const candidateIds = [source.source_table_id, defaultSourceConnectorConfigId(fallbackConnectorId, fallbackObjectName)].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  for (const configId of candidateIds) {
    const [savedConfig] = await listSourceConnectorConfigs(ctx.engine, configId);
    if (savedConfig) {
      const secretConfig = await getSourceConnectorSecretConfig(ctx.engine, savedConfig.connector_id, savedConfig.source_object, connectorSecretConfigId(savedConfig.connector_id));
      const rowConfig = {
        table_name: savedConfig.table_name ?? undefined,
        target_source_id: savedConfig.target_source_id ?? undefined,
        slug_prefix: savedConfig.slug_prefix,
        freshness_policy: savedConfig.freshness_policy ?? undefined,
      };
      return { resolvedCatalogId: configId, connectorId: savedConfig.connector_id, objectName: savedConfig.source_object, config: { ...rowConfig, ...(savedConfig.config_json || {}), ...secretConfig } };
    }
  }
  if (source.source_table_id) {
    const [baseView] = await listSourceBaseViews(ctx.engine, source.source_table_id) as Array<Record<string, unknown>>;
    if (baseView) {
      const connectorId = String(baseView.connector_id || fallbackConnectorId);
      const objectName = String(baseView.object_name || fallbackObjectName);
      const secretConfig = await getSourceConnectorSecretConfig(ctx.engine, connectorId, objectName, connectorSecretConfigId(connectorId));
      return {
        resolvedCatalogId: source.source_table_id,
        connectorId,
        objectName,
        config: {
          table_name: objectName,
          primary_key_field: typeof baseView.primary_key_field === 'string' ? baseView.primary_key_field : undefined,
          updated_at_field: typeof baseView.updated_at_field === 'string' ? baseView.updated_at_field : undefined,
          selected_fields: Array.isArray(baseView.selected_fields) ? baseView.selected_fields : undefined,
          ...secretConfig,
        },
      };
    }
  }
  const secretConfig = await getSourceConnectorSecretConfig(ctx.engine, fallbackConnectorId, fallbackObjectName);
  return {
    connectorId: fallbackConnectorId,
    objectName: fallbackObjectName,
    config: {
      ...(primary ? (ctx.connectorConfigOverride || {}) : {}),
      table_name: fallbackObjectName,
      ...secretConfig,
    },
  };
}

export async function connectorConfigForSource(ctx: SourceFetchContext, connectorId: string, objectName: string, sourceTableId?: string): Promise<Record<string, unknown>> {
  return (await resolveSourceConnectorConfig(ctx, { alias: 'source', connector: connectorId, object: objectName, source_table_id: sourceTableId })).config;
}

export async function fetchSourceSample(ctx: SourceFetchContext, source: SourceTransformSource, limit: number, profile?: SourceIngestProfile): Promise<SourceRecord[]> {
  const { connectorId, objectName, config: cfg } = await resolveSourceConnectorConfig(ctx, source);
  const connector = getSourceConnector(connectorId, cfg);
  if (!connector) throw new Error(`connector not found: ${connectorId}`);
  const fields = source.fields?.length ? source.fields : (profile ? fieldsForSource(profile, connectorId, objectName) : undefined);
  return connector.sample(objectName, limit, fields?.length ? { fields } : {});
}

export async function buildProfileSampleRecords(profile: SourceIngestProfile, limit: number, ctx: SourceFetchContext): Promise<SourceRecord[]> {
  if (profile.directory_guard) return (await buildGuardedProfileRecords(profile, ctx)).slice(0, limit);
  const transform = normalizeTransformConfig(profile.transform);
  if (!transform) {
    return fetchSourceSample(ctx, { alias: 'source', connector: profile.source_connector, object: profile.source_object }, limit, profile);
  }
  const result = await executeSourceTransform(transform, async source => fetchSourceSample(ctx, source, source.sample_limit ?? limit, profile), { rowLimit: limit });
  return result.records;
}

export async function fetchAllSourceRecords(ctx: SourceFetchContext, source: SourceTransformSource, profile?: SourceIngestProfile): Promise<SourceRecord[]> {
  const { connectorId, objectName, config: cfg } = await resolveSourceConnectorConfig(ctx, source);
  const connector = getSourceConnector(connectorId, cfg);
  if (!connector) throw new Error(`connector not found: ${connectorId}`);
  const fields = source.fields?.length ? source.fields : (profile ? fieldsForSource(profile, connectorId, objectName) : undefined);
  if (!connector.fetchAll) return connector.sample(objectName, source.sample_limit ?? 1000, fields?.length ? { fields } : {});
  const records: SourceRecord[] = [];
  for await (const batch of connector.fetchAll(objectName, fields?.length ? { fields } : {})) {
    records.push(...batch.records);
  }
  return records;
}

/** Metadata only, never an accepted full baseline. Config writers must honor the source lock. */
export function firstBootstrapPin(candidate: DirectoryBaseline): string {
  const { knownIdentityRecords: _, ...pin } = candidate;
  return stableJson(pin);
}
export async function validateFirstBootstrapPin(engine: BrainEngine, key: string, prior: string | null, candidate: DirectoryBaseline): Promise<string | null> {
  const raw = await engine.getConfig(`${key}.first_bootstrap`);
  if (raw === null) {
    if (prior === null) {
      const known = await engine.executeRaw(`SELECT 1 FROM source_sync_state WHERE approved_source_id=$1 AND profile_id=$2 AND last_result IN ('success','unchanged') LIMIT 1`, [candidate.sourceId,candidate.profileId]);
      if (known.length) throw Error('directory_rebaseline_required_missing_bootstrap_pin');
    }
    return null;
  }
  let pin;
  try { pin = JSON.parse(raw); } catch { throw Error('invalid_bootstrap_pin'); }
  const binding = pin?.upstreamBinding;
  if (!pin || typeof pin !== 'object' || Object.keys(pin).sort().join(',') !== 'policyHash,profileId,snapshotHash,sourceId,upstreamBinding,upstreamBindingHash,version'
    || pin.version !== 1 || pin.sourceId !== candidate.sourceId || pin.profileId !== candidate.profileId
    || ['policyHash','snapshotHash','upstreamBindingHash'].some(k=>typeof pin[k] !== 'string' || !/^[a-f0-9]{64}$/.test(pin[k]))
    || !binding || Object.keys(binding).sort().join(',') !== 'alias,connectorInstanceId,objectName,resolvedCatalogId,sourceTableId'
    || [binding.alias,binding.connectorInstanceId,binding.objectName].some(v=>typeof v !== 'string' || !v.trim())
    || [binding.resolvedCatalogId,binding.sourceTableId].some(v=>v !== null && (typeof v !== 'string' || !v.trim()))
    || createHash('sha256').update(stableJson(binding)).digest('hex') !== pin.upstreamBindingHash) throw Error('invalid_bootstrap_pin');
  if (prior === null && stableJson(pin) !== firstBootstrapPin(candidate)) throw Error('bootstrap_pin_snapshot_or_binding_mismatch');
  return raw;
}

/** Read the original complete stream once. No sampling, projection, dedupe or cursor shortcuts. */
async function buildGuardedProfileRecords(profile: SourceIngestProfile, ctx: SourceFetchContext): Promise<SourceRecord[]> {
  const guard = profile.directory_guard!;
  const transform = normalizeTransformConfig(profile.transform);
  if (transform && (transform.sources.length !== 1 || transform.sources[0].alias !== guard.source_alias)) throw Error('guard_requires_single_explicit_source');
  if (!transform && guard.source_alias !== 'source') throw Error('invalid_guard_alias');
  const source = transform?.sources[0] ?? { alias: 'source', connector: profile.source_connector, object: profile.source_object };
  const resolved = await resolveSourceConnectorConfig(ctx, source);
  const connector = getSourceConnector(resolved.connectorId, resolved.config);
  if (!connector?.fetchAll) throw Error('guard_requires_complete_fetchAll');
  const original: SourceRecord[] = [];
  let cursor: string | null | undefined;
  for await (const batch of connector.fetchAll(resolved.objectName, {})) { original.push(...batch.records); cursor = batch.cursor; }
  if (cursor) throw Error('incomplete_snapshot_cursor');
  for (const record of original) if (record.external_id !== record.data[guard.policy.fields.id]) throw Error('wrapper_identity_mismatch');
  const sourceId = profile.target.approved_source_id;
  if (!sourceId || !ctx.engine) throw Error('guard_requires_bound_engine');
  const baselineKey = `source_ingest.directory_guard.${sourceId}.${profile.profile_id}`;
  const prior = await ctx.engine.getConfig(baselineKey);
  let baseline;
  if (prior !== null) {
    try { baseline = JSON.parse(prior); } catch { throw Error('invalid_baseline'); }
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw Error('invalid_baseline');
  }
  const prepared = prepareDirectorySnapshot({ sourceId, profileId: profile.profile_id, policy: guard.policy,
    upstreamBinding: { connectorInstanceId: resolved.connectorId, objectName: resolved.objectName, alias: source.alias,
      sourceTableId: source.source_table_id ?? null, resolvedCatalogId: resolved.resolvedCatalogId ?? null },
    records: original.map(r => r.data), complete: true, mode: ctx.guardMode ?? 'preview', baseline,
    bootstrapSnapshotHash: guard.approved_bootstrap_hash });
  if (prepared.status === 'stopped') throw Error(`directory_guard: ${prepared.diagnostics.join(',')}`);
  await validateFirstBootstrapPin(ctx.engine, baselineKey, prior, prepared.candidateBaseline);
  ctx.onGuardPrepared?.(prepared, baselineKey, prior);
  const projected = prepared.records.map(data => Object.freeze({ external_id: data[guard.policy.fields.id] as string, data }));
  if (!transform) return projected;
  const result = await executeSourceTransform(transform, async () => projected);
  const seen = new Set<string>();
  for (const record of result.records) {
    if (seen.has(record.external_id) || !prepared.identities.some(i => i.id === record.external_id) || record.external_id !== record.data[profile.identity.external_id_field]) throw Error('guard_transform_identity_mismatch');
    seen.add(record.external_id);
  }
  return result.records;
}
export async function buildProfileAllRecords(profile: SourceIngestProfile, ctx: SourceFetchContext): Promise<SourceRecord[] | null> {
  if (profile.directory_guard) return buildGuardedProfileRecords(profile, ctx);
  const transform = normalizeTransformConfig(profile.transform);
  if (!transform) return null;
  const result = await executeSourceTransform(transform, async source => fetchAllSourceRecords(ctx, source, profile));
  return result.records;
}
