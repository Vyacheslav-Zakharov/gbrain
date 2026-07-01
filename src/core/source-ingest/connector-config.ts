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

export interface SourceConnectorSecretRow {
  config_id: string;
  connector_id: string;
  source_object: string;
  secret_json: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceConnectorSecretStatus {
  credential_mode: 'none' | 'db-or-server-env';
  required_keys: string[];
  required_env: string[];
  configured: boolean;
  missing_keys: string[];
  missing_env: string[];
  masked: Record<string, string>;
  storage: 'none' | 'db' | 'server-env' | 'db+server-env';
  updated_by?: string | null;
  updated_at?: string | null;
}

export interface SourceConnectorSecretAuditRow {
  id: number;
  config_id: string;
  connector_id: string;
  source_object: string;
  action: 'rotate' | 'delete';
  actor: string | null;
  secret_keys: string[];
  created_at: string;
}

const APPSHEET_SECRET_KEYS = ['app_id', 'access_key'];
const APPSHEET_ENV_KEYS = ['APPSHEET_VEHICLES_APP_ID', 'APPSHEET_VEHICLES_ACCESS_KEY'];

export function defaultSourceConnectorConfigId(connectorId: string, sourceObject: string): string {
  return `${connectorId}:${sourceObject}`;
}

function requiredSecretKeys(connectorId: string): string[] {
  return connectorId === 'appsheet-vehicles' ? APPSHEET_SECRET_KEYS : [];
}

function requiredEnvKeys(connectorId: string): string[] {
  return connectorId === 'appsheet-vehicles' ? APPSHEET_ENV_KEYS : [];
}

function normalizeSecretKey(key: string): string {
  if (key === 'appId') return 'app_id';
  if (key === 'accessKey') return 'access_key';
  return key;
}

function normalizeSecrets(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = normalizeSecretKey(k);
    if (!requiredSecretKeys('appsheet-vehicles').includes(key)) continue;
    if (typeof v !== 'string' || !v.trim()) continue;
    out[key] = v.trim();
  }
  return out;
}

function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const tail = value.slice(-4);
  return value.length <= 4 ? '••••' : `••••${tail}`;
}

export async function sourceConnectorSecretStatus(engine: BrainEngine, connectorId: string, configId?: string): Promise<SourceConnectorSecretStatus> {
  const required_keys = requiredSecretKeys(connectorId);
  const required_env = requiredEnvKeys(connectorId);
  if (required_keys.length === 0) return { credential_mode: 'none', required_keys: [], required_env: [], configured: true, missing_keys: [], missing_env: [], masked: {}, storage: 'none' };

  const id = configId || defaultSourceConnectorConfigId(connectorId, 'vehicle');
  const [row] = await listSourceConnectorSecrets(engine, id);
  const dbSecrets = row?.secret_json || {};
  const envSecrets: Record<string, string | undefined> = connectorId === 'appsheet-vehicles'
    ? { app_id: process.env.APPSHEET_VEHICLES_APP_ID, access_key: process.env.APPSHEET_VEHICLES_ACCESS_KEY }
    : {};
  const missing_keys = required_keys.filter(k => !(typeof dbSecrets[k] === 'string' && String(dbSecrets[k]).trim()) && !(typeof envSecrets[k] === 'string' && String(envSecrets[k]).trim()));
  const missing_env = required_env.filter(k => !process.env[k]);
  const masked: Record<string, string> = {};
  for (const k of required_keys) {
    const source = typeof dbSecrets[k] === 'string' ? dbSecrets[k] : envSecrets[k];
    if (source) masked[k] = maskSecret(source);
  }
  const hasDb = required_keys.some(k => typeof dbSecrets[k] === 'string' && String(dbSecrets[k]).trim());
  const hasEnv = required_keys.some(k => typeof envSecrets[k] === 'string' && String(envSecrets[k]).trim());
  return {
    credential_mode: 'db-or-server-env',
    required_keys,
    required_env,
    configured: missing_keys.length === 0,
    missing_keys,
    missing_env,
    masked,
    storage: hasDb && hasEnv ? 'db+server-env' : hasDb ? 'db' : hasEnv ? 'server-env' : 'none',
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  };
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

export async function listSourceConnectorSecrets(engine: BrainEngine, configId?: string): Promise<SourceConnectorSecretRow[]> {
  const params: unknown[] = [];
  const where = configId ? 'WHERE config_id = $1' : '';
  if (configId) params.push(configId);
  const rows = await engine.executeRaw<SourceConnectorSecretRow>(
    `SELECT config_id, connector_id, source_object, secret_json, created_by, updated_by,
            created_at::text, updated_at::text
       FROM source_connector_secrets
       ${where}
       ORDER BY updated_at DESC`,
    params,
  );
  return rows.map(row => ({ ...row, secret_json: (row.secret_json || {}) as Record<string, unknown> }));
}

export async function getSourceConnectorSecretConfig(engine: BrainEngine, connectorId: string, sourceObject: string): Promise<Record<string, string>> {
  const configId = defaultSourceConnectorConfigId(connectorId, sourceObject);
  const [row] = await listSourceConnectorSecrets(engine, configId);
  const raw = row?.secret_json || {};
  const out: Record<string, string> = {};
  if (connectorId === 'appsheet-vehicles') {
    if (typeof raw.app_id === 'string' && raw.app_id.trim()) out.app_id = raw.app_id.trim();
    if (typeof raw.access_key === 'string' && raw.access_key.trim()) out.access_key = raw.access_key.trim();
  }
  return out;
}

export async function putSourceConnectorSecrets(
  engine: BrainEngine,
  input: { config_id?: string; connector_id: string; source_object: string; secret_json: Record<string, unknown> },
  opts: { actor?: string } = {},
): Promise<SourceConnectorSecretStatus> {
  const configId = input.config_id || defaultSourceConnectorConfigId(input.connector_id, input.source_object);
  const secretJson = normalizeSecrets(input.secret_json);
  const keys = Object.keys(secretJson).sort();
  if (keys.length === 0) throw new Error('no_supported_secret_keys');
  await executeRawJsonb(
    engine,
    `INSERT INTO source_connector_secrets
       (config_id, connector_id, source_object, secret_json, created_by, updated_by, updated_at)
     VALUES ($1,$2,$3,$6::jsonb,$4,$5,now())
     ON CONFLICT (config_id) DO UPDATE SET
       connector_id = EXCLUDED.connector_id,
       source_object = EXCLUDED.source_object,
       secret_json = EXCLUDED.secret_json,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [configId, input.connector_id, input.source_object, opts.actor ?? 'local', opts.actor ?? 'local'],
    [secretJson],
  );
  await executeRawJsonb(
    engine,
    `INSERT INTO source_connector_secret_audit
       (config_id, connector_id, source_object, action, actor, secret_keys)
     VALUES ($1,$2,$3,$4,$5,($6::jsonb)->'keys')`,
    [configId, input.connector_id, input.source_object, 'rotate', opts.actor ?? 'local'],
    [{ keys }],
  );
  return sourceConnectorSecretStatus(engine, input.connector_id, configId);
}

export async function deleteSourceConnectorSecrets(
  engine: BrainEngine,
  input: { config_id?: string; connector_id: string; source_object: string },
  opts: { actor?: string } = {},
): Promise<SourceConnectorSecretStatus> {
  const configId = input.config_id || defaultSourceConnectorConfigId(input.connector_id, input.source_object);
  const [row] = await listSourceConnectorSecrets(engine, configId);
  const keys = Object.keys(row?.secret_json || {}).sort();
  await engine.executeRaw(`DELETE FROM source_connector_secrets WHERE config_id = $1`, [configId]);
  await executeRawJsonb(
    engine,
    `INSERT INTO source_connector_secret_audit
       (config_id, connector_id, source_object, action, actor, secret_keys)
     VALUES ($1,$2,$3,$4,$5,($6::jsonb)->'keys')`,
    [configId, input.connector_id, input.source_object, 'delete', opts.actor ?? 'local'],
    [{ keys }],
  );
  return sourceConnectorSecretStatus(engine, input.connector_id, configId);
}

export async function listSourceConnectorSecretAudit(engine: BrainEngine, configId?: string, limit = 20): Promise<SourceConnectorSecretAuditRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (configId) {
    where = 'WHERE config_id = $1';
    params.push(configId);
  }
  params.push(Math.max(1, Math.min(100, limit)));
  const rows = await engine.executeRaw<SourceConnectorSecretAuditRow>(
    `SELECT id, config_id, connector_id, source_object, action, actor, secret_keys, created_at::text
       FROM source_connector_secret_audit
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.map(row => ({ ...row, secret_keys: Array.isArray(row.secret_keys) ? row.secret_keys : [] }));
}
