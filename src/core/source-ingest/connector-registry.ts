export interface SourceIngestConnectorFieldDescriptor {
  key: string;
  label: string;
  defaultValue: string;
}

export interface SourceIngestConnectorDescriptor {
  id: string;
  kind: 'appsheet' | 'fake' | 'bigquery' | 'postgres' | 'supabase' | 'bitrix' | 'unf';
  displayName: string;
  object: string;
  supportsChangedSince: boolean;
  credentialMode: 'none' | 'db-or-server-env';
  status: 'implemented' | 'scaffold';
  requiredKeys?: string[];
  requiredEnv?: string[];
  fields?: SourceIngestConnectorFieldDescriptor[];
  safety?: string[];
}

const COMMON_FIELDS: SourceIngestConnectorFieldDescriptor[] = [
  { key: 'tableName', label: 'Source table name / API object', defaultValue: '' },
  { key: 'primaryKeyField', label: 'Primary key field', defaultValue: 'id' },
  { key: 'updatedAtField', label: 'Updated-at field', defaultValue: '' },
  { key: 'targetSourceId', label: 'Target GBrain source', defaultValue: 'shared' },
  { key: 'slugPrefix', label: 'Slug prefix', defaultValue: 'source-ingest/records' },
  { key: 'freshnessPolicy', label: 'Article freshness policy', defaultValue: 'P30D' },
];

function fields(overrides: Partial<Record<SourceIngestConnectorFieldDescriptor['key'], string>>): SourceIngestConnectorFieldDescriptor[] {
  return COMMON_FIELDS.map(f => ({ ...f, defaultValue: overrides[f.key] ?? f.defaultValue }));
}

export function sourceIngestConnectorDescriptors(): SourceIngestConnectorDescriptor[] {
  return [
    {
      id: 'appsheet-vehicles',
      kind: 'appsheet',
      displayName: 'AppSheet',
      object: 'vehicle',
      supportsChangedSince: true,
      credentialMode: 'db-or-server-env',
      status: 'implemented',
      requiredKeys: ['app_id', 'access_key'],
      requiredEnv: ['APPSHEET_VEHICLES_APP_ID', 'APPSHEET_VEHICLES_ACCESS_KEY'],
      fields: fields({ tableName: 'vehicles', primaryKeyField: 'vehicleID', slugPrefix: 'source-ingest/vehicles' }),
      safety: ['Discovery/dry-run first', 'Review profile before approval', 'Refresh cycle enqueues Minion jobs only'],
    },
    {
      id: 'fake-source',
      kind: 'fake',
      displayName: 'Deterministic fake source',
      object: 'vehicle',
      supportsChangedSince: true,
      credentialMode: 'none',
      status: 'implemented',
      fields: fields({ tableName: 'vehicle', primaryKeyField: 'id', updatedAtField: 'updated_at', slugPrefix: 'source-ingest/vehicles' }),
    },
    {
      id: 'bigquery',
      kind: 'bigquery',
      displayName: 'BigQuery',
      object: 'table',
      supportsChangedSince: false,
      credentialMode: 'db-or-server-env',
      status: 'scaffold',
      requiredKeys: ['service_account_json'],
      requiredEnv: ['GOOGLE_APPLICATION_CREDENTIALS'],
      fields: fields({ tableName: 'dataset.table', primaryKeyField: 'id', updatedAtField: 'updated_at', slugPrefix: 'source-ingest/bigquery' }),
      safety: ['Scaffold only: discovery/sample connector implementation pending', 'Use source table configs now; live IO remains disabled until connector is implemented'],
    },
    {
      id: 'postgres',
      kind: 'postgres',
      displayName: 'Postgres',
      object: 'table',
      supportsChangedSince: false,
      credentialMode: 'db-or-server-env',
      status: 'scaffold',
      requiredKeys: ['connection_string'],
      fields: fields({ tableName: 'schema.table', primaryKeyField: 'id', updatedAtField: 'updated_at', slugPrefix: 'source-ingest/postgres' }),
      safety: ['Scaffold only: live SQL connector implementation pending', 'Use read-only database credentials only'],
    },
    {
      id: 'supabase',
      kind: 'supabase',
      displayName: 'Supabase',
      object: 'table',
      supportsChangedSince: false,
      credentialMode: 'db-or-server-env',
      status: 'scaffold',
      requiredKeys: ['project_url', 'service_role_key'],
      fields: fields({ tableName: 'public.table', primaryKeyField: 'id', updatedAtField: 'updated_at', slugPrefix: 'source-ingest/supabase' }),
      safety: ['Scaffold only: live connector implementation pending', 'Never expose service role key to browser/UI preview'],
    },
    {
      id: 'bitrix',
      kind: 'bitrix',
      displayName: 'Bitrix API',
      object: 'collection',
      supportsChangedSince: false,
      credentialMode: 'db-or-server-env',
      status: 'scaffold',
      requiredKeys: ['base_url', 'access_token'],
      fields: fields({ tableName: 'crm.item', primaryKeyField: 'ID', updatedAtField: 'DATE_MODIFY', slugPrefix: 'source-ingest/bitrix' }),
      safety: ['Scaffold only: live API connector implementation pending', 'Keep access token server-side/DB-encrypted'],
    },
    {
      id: 'unf',
      kind: 'unf',
      displayName: '1C:УНФ API',
      object: 'endpoint',
      supportsChangedSince: false,
      credentialMode: 'db-or-server-env',
      status: 'scaffold',
      requiredKeys: ['base_url', 'auth_code'],
      fields: fields({ tableName: '/sales', primaryKeyField: 'id', updatedAtField: 'updated_at', slugPrefix: 'source-ingest/unf' }),
      safety: ['Scaffold only: live connector implementation pending', 'Do not expose auth_code in profiles, pages, logs, or browser state'],
    },
  ];
}
