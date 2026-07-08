export interface SourceIngestConnectorFieldDescriptor {
  key: string;
  label: string;
  defaultValue: string;
}

export interface SourceIngestConnectorDescriptor {
  id: string;
  kind: 'appsheet' | 'fake' | 'postgres';
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
      id: 'postgres',
      kind: 'postgres',
      displayName: 'Postgres read-only',
      object: 'employees',
      supportsChangedSince: true,
      credentialMode: 'db-or-server-env',
      status: 'implemented',
      requiredKeys: ['connection_string'],
      fields: fields({ tableName: 'employees', primaryKeyField: 'employment_id', updatedAtField: 'updated_at', slugPrefix: 'source-ingest/org/employees', freshnessPolicy: 'P1D' }),
      safety: ['SELECT-only connector', 'Identifier allowlist: companies/departments/positions/employees by default', 'No salary/document/PII tables are exposed by this connector'],
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
  ];
}
