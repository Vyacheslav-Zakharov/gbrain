import type { BrainEngine } from '../engine.ts';
import { executeRawJsonb } from '../sql-query.ts';

export interface SourceConnectorConfigInput {
  config_id?: string;
  connector_id: string;
  source_object: string;
  display_name?: string;
  table_name?: string | null;
  target_source_id?: string | null;
  slug_prefix?: string | null;
  freshness_policy?: string | null;
  enabled?: boolean;
  config_json?: Record<string, unknown>;
}

export interface SourceConnectorConfigRow extends Required<Omit<SourceConnectorConfigInput, 'config_id' | 'table_name' | 'target_source_id' | 'slug_prefix' | 'freshness_policy' | 'config_json'>> {
  config_id: string;
  table_name: string | null;
  target_source_id: string | null;
  slug_prefix: string;
  freshness_policy: string | null;
  config_json: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export function defaultSourceConnectorConfigId(connectorId: string, sourceObject: string): string {
  return `${connectorId}:${sourceObject}`;
}

export function sourceConnectorSecretStatus(connectorId: string): { credential_mode: 'none' | 'server-env'; required_env: string[]; configured: boolean; missing_env: string[] } {
  if (connectorId !== 'appsheet-vehicles') return { credential_mode: 'none', required_env: [], configured: true, missing_env: [] };
  const required = ['APPSHEET_VEHICLES_APP_ID', 'APPSHEET_VEHICLES_ACCESS_KEY'];
  const missing = required.filter(k => !process.env[k]);
  return { credential_mode: 'server-env', required_env: required, configured: missing.length === 0, missing_env: missing };
}

export async function listSourceConnectorConfigs(engine: BrainEngine, configId?: string): Promise<SourceConnectorConfigRow[]> {
  const params: unknown[] = [];
  const where = configId ? 'WHERE config_id = $1' : '';
  if (configId) params.push(configId);
  const rows = await engine.executeRaw<SourceConnectorConfigRow>(
    `SELECT config_id, connector_id, source_object, display_name, table_name, target_source_id,
            slug_prefix, freshness_policy, enabled, config_json, created_by, updated_by,
            created_at::text, updated_at::text
       FROM source_connector_configs
       ${where}
       ORDER BY updated_at DESC`,
    params,
  );
  return rows.map(row => ({ ...row, config_json: (row.config_json || {}) as Record<string, unknown> }));
}

export async function putSourceConnectorConfig(
  engine: BrainEngine,
  input: SourceConnectorConfigInput,
  opts: { actor?: string } = {},
): Promise<SourceConnectorConfigRow> {
  const configId = input.config_id || defaultSourceConnectorConfigId(input.connector_id, input.source_object);
  const configJson = input.config_json || {};
  await executeRawJsonb(
    engine,
    `INSERT INTO source_connector_configs
       (config_id, connector_id, source_object, display_name, table_name, target_source_id,
        slug_prefix, freshness_policy, enabled, config_json, created_by, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$12::jsonb,$10,$11,now())
     ON CONFLICT (config_id) DO UPDATE SET
       connector_id = EXCLUDED.connector_id,
       source_object = EXCLUDED.source_object,
       display_name = EXCLUDED.display_name,
       table_name = EXCLUDED.table_name,
       target_source_id = EXCLUDED.target_source_id,
       slug_prefix = EXCLUDED.slug_prefix,
       freshness_policy = EXCLUDED.freshness_policy,
       enabled = EXCLUDED.enabled,
       config_json = EXCLUDED.config_json,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [
      configId,
      input.connector_id,
      input.source_object,
      input.display_name || `${input.connector_id} ${input.source_object}`,
      input.table_name ?? null,
      input.target_source_id ?? null,
      input.slug_prefix || '',
      input.freshness_policy ?? null,
      input.enabled ?? false,
      opts.actor ?? 'local',
      opts.actor ?? 'local',
    ],
    [configJson],
  );
  const [row] = await listSourceConnectorConfigs(engine, configId);
  return row;
}
