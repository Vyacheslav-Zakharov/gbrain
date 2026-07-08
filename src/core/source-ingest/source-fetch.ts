import type { BrainEngine } from '../engine.ts';
import { connectorSecretConfigId, defaultSourceConnectorConfigId, getSourceConnectorSecretConfig, listSourceConnectorConfigs } from './connector-config.ts';
import { listSourceBaseViews } from './catalog.ts';
import { getSourceConnector } from './connectors/fake.ts';
import type { SourceRecord } from './connectors/types.ts';
import type { SourceIngestProfile } from './profile-schema.ts';
import { executeSourceTransform, normalizeTransformConfig, type SourceTransformSource } from './transform.ts';

export interface SourceFetchContext {
  engine?: BrainEngine;
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
      return { connectorId: savedConfig.connector_id, objectName: savedConfig.source_object, config: { ...rowConfig, ...(savedConfig.config_json || {}), ...secretConfig } };
    }
  }
  if (source.source_table_id) {
    const [baseView] = await listSourceBaseViews(ctx.engine, source.source_table_id) as Array<Record<string, unknown>>;
    if (baseView) {
      const connectorId = String(baseView.connector_id || fallbackConnectorId);
      const objectName = String(baseView.object_name || fallbackObjectName);
      const discovery = (baseView.discovery_json && typeof baseView.discovery_json === 'object') ? baseView.discovery_json as Record<string, unknown> : {};
      const secretConfig = await getSourceConnectorSecretConfig(ctx.engine, connectorId, objectName, connectorSecretConfigId(connectorId));
      return {
        connectorId,
        objectName,
        config: {
          table_name: objectName,
          primary_key_field: typeof discovery.primary_key_field === 'string' ? discovery.primary_key_field : undefined,
          updated_at_field: typeof discovery.updated_at_field === 'string' ? discovery.updated_at_field : undefined,
          selected_fields: Array.isArray(baseView.selected_fields) ? baseView.selected_fields : undefined,
          ...secretConfig,
        },
      };
    }
  }
  const secretConfig = await getSourceConnectorSecretConfig(ctx.engine, fallbackConnectorId, fallbackObjectName);
  return { connectorId: fallbackConnectorId, objectName: fallbackObjectName, config: { ...(primary ? (ctx.connectorConfigOverride || {}) : {}), ...secretConfig } };
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

export async function buildProfileAllRecords(profile: SourceIngestProfile, ctx: SourceFetchContext): Promise<SourceRecord[] | null> {
  const transform = normalizeTransformConfig(profile.transform);
  if (!transform) return null;
  const result = await executeSourceTransform(transform, async source => fetchAllSourceRecords(ctx, source, profile));
  return result.records;
}
