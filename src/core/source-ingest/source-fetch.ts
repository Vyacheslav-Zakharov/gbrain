import type { BrainEngine } from '../engine.ts';
import { getSourceConnectorSecretConfig, listSourceConnectorConfigs } from './connector-config.ts';
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

export async function connectorConfigForSource(ctx: SourceFetchContext, connectorId: string, objectName: string): Promise<Record<string, unknown>> {
  const primary = connectorId === ctx.defaultConnector && objectName === ctx.defaultObject;
  if (primary && ctx.connectorConfigOverride) return ctx.connectorConfigOverride;
  if (!ctx.engine) return primary ? (ctx.connectorConfigOverride || {}) : {};
  const configId = `${connectorId}:${objectName}`;
  const [savedConfig] = await listSourceConnectorConfigs(ctx.engine, configId);
  const secretConfig = await getSourceConnectorSecretConfig(ctx.engine, connectorId, objectName);
  return { ...(savedConfig?.config_json || {}), ...secretConfig };
}

export async function fetchSourceSample(ctx: SourceFetchContext, source: SourceTransformSource, limit: number, profile?: SourceIngestProfile): Promise<SourceRecord[]> {
  const connectorId = source.connector || ctx.defaultConnector;
  const objectName = source.object || ctx.defaultObject;
  const cfg = await connectorConfigForSource(ctx, connectorId, objectName);
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
  const result = await executeSourceTransform(transform, async source => fetchSourceSample(ctx, source, source.sample_limit ?? limit, profile));
  return result.records.slice(0, limit);
}

export async function fetchAllSourceRecords(ctx: SourceFetchContext, source: SourceTransformSource, profile?: SourceIngestProfile): Promise<SourceRecord[]> {
  const connectorId = source.connector || ctx.defaultConnector;
  const objectName = source.object || ctx.defaultObject;
  const cfg = await connectorConfigForSource(ctx, connectorId, objectName);
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
