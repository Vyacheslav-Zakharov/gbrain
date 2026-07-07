import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
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

export interface SourceTableSummary {
  source_table_id: string;
  connector_id: string;
  source_object: string;
  table_name: string | null;
  display_name: string;
  primary_key_field: string | null;
  updated_at_field: string | null;
  target_source_id: string | null;
  slug_prefix: string;
  freshness_policy: string | null;
  enabled: boolean;
  fields: string[];
  updated_at: string;
}

const APPSHEET_SECRET_KEYS = ['app_id', 'access_key'];
const APPSHEET_ENV_KEYS = ['APPSHEET_VEHICLES_APP_ID', 'APPSHEET_VEHICLES_ACCESS_KEY'];
const SECRET_ENVELOPE_MARKER = '__encrypted';

function keyFilePath(): string {
  return process.env.GBRAIN_SOURCE_CONNECTOR_SECRET_KEY_FILE
    || join(process.env.GBRAIN_HOME || join(homedir(), '.gbrain'), 'source-connector-secrets.key');
}

function decodeKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32) return b64;
  } catch {}
  return createHash('sha256').update(trimmed).digest();
}

function connectorSecretKey(): Buffer {
  const envKey = process.env.GBRAIN_SOURCE_CONNECTOR_SECRET_KEY || process.env.GBRAIN_SECRET_KEY;
  if (envKey && envKey.trim()) return decodeKeyMaterial(envKey);
  const p = keyFilePath();
  if (existsSync(p)) return decodeKeyMaterial(readFileSync(p, 'utf8'));
  mkdirSync(dirname(p), { recursive: true });
  const generated = randomBytes(32).toString('base64');
  writeFileSync(p, generated, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
  return Buffer.from(generated, 'base64');
}

function encryptSecretJson(secretJson: Record<string, string>): Record<string, unknown> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', connectorSecretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secretJson), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    [SECRET_ENVELOPE_MARKER]: true,
    version: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecretJson(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw?.[SECRET_ENVELOPE_MARKER] !== true) return raw || {};
  if (raw.alg !== 'aes-256-gcm' || raw.version !== 1) throw new Error('unsupported_secret_envelope');
  if (typeof raw.iv !== 'string' || typeof raw.tag !== 'string' || typeof raw.ciphertext !== 'string') {
    throw new Error('invalid_secret_envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', connectorSecretKey(), Buffer.from(raw.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(raw.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export function isEncryptedConnectorSecretEnvelope(raw: Record<string, unknown>): boolean {
  return raw?.[SECRET_ENVELOPE_MARKER] === true;
}

export function safeSourceTableSuffix(raw: string): string {
  return raw.toLowerCase().trim().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

export function defaultSourceConnectorConfigId(connectorId: string, sourceObject: string, tableName?: string | null): string {
  const table = typeof tableName === 'string' && tableName.trim() && tableName.trim() !== sourceObject ? `:${safeSourceTableSuffix(tableName)}` : '';
  return `${connectorId}:${sourceObject}${table}`;
}

function requiredSecretKeys(connectorId: string): string[] {
  if (connectorId === 'appsheet-vehicles' || connectorId === 'appsheet' || connectorId.startsWith('appsheet-')) return APPSHEET_SECRET_KEYS;
  if (connectorId === 'bigquery') return ['service_account_json'];
  if (connectorId === 'postgres') return ['connection_string'];
  if (connectorId === 'supabase') return ['project_url', 'service_role_key'];
  if (connectorId === 'bitrix') return ['base_url', 'access_token'];
  if (connectorId === 'unf') return ['base_url', 'auth_code'];
  return [];
}

function requiredEnvKeys(connectorId: string): string[] {
  if (connectorId === 'appsheet-vehicles') return APPSHEET_ENV_KEYS;
  if (connectorId === 'bigquery') return ['GOOGLE_APPLICATION_CREDENTIALS'];
  return [];
}

function normalizeSecretKey(key: string): string {
  if (key === 'appId') return 'app_id';
  if (key === 'accessKey') return 'access_key';
  if (key === 'serviceRoleKey') return 'service_role_key';
  if (key === 'accessToken') return 'access_token';
  if (key === 'authCode') return 'auth_code';
  if (key === 'connectionString') return 'connection_string';
  if (key === 'serviceAccountJson') return 'service_account_json';
  if (key === 'projectUrl') return 'project_url';
  if (key === 'baseUrl') return 'base_url';
  return key;
}

function normalizeSecrets(connectorId: string, raw: Record<string, unknown>): Record<string, string> {
  const supported = requiredSecretKeys(connectorId);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = normalizeSecretKey(k);
    if (!supported.includes(key)) continue;
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

function legacyConfigIdForSecretFallback(connectorId: string, sourceObject: string, configId?: string): string | null {
  const legacy = defaultSourceConnectorConfigId(connectorId, sourceObject);
  if (!configId || configId === legacy) return null;
  return configId.startsWith(`${legacy}:`) ? legacy : null;
}

async function sourceConnectorSecretRowWithLegacyFallback(
  engine: BrainEngine,
  connectorId: string,
  sourceObject: string,
  configId?: string,
): Promise<SourceConnectorSecretRow | undefined> {
  const id = configId || defaultSourceConnectorConfigId(connectorId, sourceObject);
  const [exact] = await listSourceConnectorSecrets(engine, id);
  if (exact) return exact;
  const legacyId = legacyConfigIdForSecretFallback(connectorId, sourceObject, id);
  if (!legacyId) return undefined;
  const [legacy] = await listSourceConnectorSecrets(engine, legacyId);
  return legacy;
}

export async function sourceConnectorSecretStatus(engine: BrainEngine, connectorId: string, configId?: string, sourceObject = 'vehicle'): Promise<SourceConnectorSecretStatus> {
  const required_keys = requiredSecretKeys(connectorId);
  const required_env = requiredEnvKeys(connectorId);
  if (required_keys.length === 0) return { credential_mode: 'none', required_keys: [], required_env: [], configured: true, missing_keys: [], missing_env: [], masked: {}, storage: 'none' };

  const row = await sourceConnectorSecretRowWithLegacyFallback(engine, connectorId, sourceObject, configId);
  const dbSecrets = row?.secret_json || {};
  const envSecrets: Record<string, string | undefined> = {};
  if (connectorId === 'appsheet-vehicles') Object.assign(envSecrets, { app_id: process.env.APPSHEET_VEHICLES_APP_ID, access_key: process.env.APPSHEET_VEHICLES_ACCESS_KEY });
  if (connectorId === 'bigquery') Object.assign(envSecrets, { service_account_json: process.env.GOOGLE_APPLICATION_CREDENTIALS });
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

export function sourceTableSummaryFromConfig(row: SourceConnectorConfigRow): SourceTableSummary {
  const cfg = row.config_json || {};
  const fields = Array.isArray(cfg.selected_fields) ? cfg.selected_fields.map(String).filter(Boolean) : [];
  const tableName = row.table_name || (typeof cfg.table_name === 'string' ? cfg.table_name : null);
  return {
    source_table_id: row.config_id,
    connector_id: row.connector_id,
    source_object: row.source_object,
    table_name: tableName,
    display_name: row.display_name || tableName || row.source_object,
    primary_key_field: typeof cfg.primary_key_field === 'string' && cfg.primary_key_field.trim() ? cfg.primary_key_field.trim() : null,
    updated_at_field: typeof cfg.updated_at_field === 'string' && cfg.updated_at_field.trim() ? cfg.updated_at_field.trim() : null,
    target_source_id: row.target_source_id,
    slug_prefix: row.slug_prefix,
    freshness_policy: row.freshness_policy,
    enabled: row.enabled,
    fields,
    updated_at: row.updated_at,
  };
}

export function sourceTableSummariesFromConfigs(rows: SourceConnectorConfigRow[]): SourceTableSummary[] {
  return rows.map(sourceTableSummaryFromConfig);
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
  return rows.map(row => ({ ...row, secret_json: decryptSecretJson((row.secret_json || {}) as Record<string, unknown>) }));
}

export async function getSourceConnectorSecretConfig(engine: BrainEngine, connectorId: string, sourceObject: string, configIdOverride?: string): Promise<Record<string, string>> {
  const configId = configIdOverride || defaultSourceConnectorConfigId(connectorId, sourceObject);
  const row = await sourceConnectorSecretRowWithLegacyFallback(engine, connectorId, sourceObject, configId);
  const raw = row?.secret_json || {};
  const out: Record<string, string> = {};
  for (const key of requiredSecretKeys(connectorId)) {
    if (typeof raw[key] === 'string' && raw[key].trim()) out[key] = raw[key].trim();
  }
  return out;
}

export async function putSourceConnectorSecrets(
  engine: BrainEngine,
  input: { config_id?: string; connector_id: string; source_object: string; secret_json: Record<string, unknown> },
  opts: { actor?: string } = {},
): Promise<SourceConnectorSecretStatus> {
  const configId = input.config_id || defaultSourceConnectorConfigId(input.connector_id, input.source_object);
  const secretJson = normalizeSecrets(input.connector_id, input.secret_json);
  const keys = Object.keys(secretJson).sort();
  if (keys.length === 0) throw new Error('no_supported_secret_keys');
  const storedSecretJson = encryptSecretJson(secretJson);
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
    [storedSecretJson],
  );
  await executeRawJsonb(
    engine,
    `INSERT INTO source_connector_secret_audit
       (config_id, connector_id, source_object, action, actor, secret_keys)
     VALUES ($1,$2,$3,$4,$5,($6::jsonb)->'keys')`,
    [configId, input.connector_id, input.source_object, 'rotate', opts.actor ?? 'local'],
    [{ keys }],
  );
  return sourceConnectorSecretStatus(engine, input.connector_id, configId, input.source_object);
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
  return sourceConnectorSecretStatus(engine, input.connector_id, configId, input.source_object);
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
