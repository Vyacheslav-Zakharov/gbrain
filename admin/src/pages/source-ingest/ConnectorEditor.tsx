import React from 'react';

type Busy = string | null;
type ConnectorForm = { connector_id: string; kind: string; display_name: string };
type SecretForm = { app_id: string; access_key: string; connection_string?: string };

type Props = {
  busy: Busy;
  catalogConnectorForm: ConnectorForm;
  setCatalogConnectorForm: React.Dispatch<React.SetStateAction<ConnectorForm>>;
  secretForm: SecretForm;
  setSecretForm: React.Dispatch<React.SetStateAction<SecretForm>>;
  catalogConnectorSecretStatus: unknown;
  catalogConnectorObjects: unknown;
  catalogConnectorTest: unknown;
  catalogConnectorSecretConfigId: () => string;
  saveCatalogConnector: () => void;
  saveCatalogConnectorCredentials: () => void;
  deleteCatalogConnectorCredentials: () => void;
  listCatalogConnectorObjects: () => void;
  testCatalogConnector: () => void;
  deleteCatalogConnector: () => void;
  PreviewJson: React.ComponentType<{ value: unknown; empty: string }>;
  studioSectionStyle: (area: string) => React.CSSProperties;
};

export function ConnectorEditor({ busy, catalogConnectorForm, setCatalogConnectorForm, secretForm, setSecretForm, catalogConnectorSecretStatus, catalogConnectorObjects, catalogConnectorTest, catalogConnectorSecretConfigId, saveCatalogConnector, saveCatalogConnectorCredentials, deleteCatalogConnectorCredentials, listCatalogConnectorObjects, testCatalogConnector, deleteCatalogConnector, PreviewJson, studioSectionStyle }: Props) {
  const testStatus = catalogConnectorTest && typeof catalogConnectorTest === 'object' ? String((catalogConnectorTest as Record<string, unknown>).status ?? '') : '';
  const testOk = catalogConnectorTest && typeof catalogConnectorTest === 'object' ? (catalogConnectorTest as Record<string, unknown>).ok === true : false;
  return <section style={studioSectionStyle('connectors')}>
    <h2 className="section-title">0. Catalog connector instance</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      Connection-level object: choose connector type and store credentials here. Table/object binding is intentionally in Base views, not in connector test.
    </p>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 14, alignItems: 'end' }}>
      <label>Connector id
        <input value={catalogConnectorForm.connector_id} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, connector_id: e.target.value }))} placeholder="appsheet-avto" />
      </label>
      <label>Kind
        <select value={catalogConnectorForm.kind} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, kind: e.target.value }))}>
          <option value="appsheet">AppSheet</option>
          <option value="postgres">Postgres read-only</option>
          <option value="fake">Fake / demo</option>
        </select>
      </label>
      <label>Display name (optional)
        <input value={catalogConnectorForm.display_name} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="можно оставить пустым или написать по-русски" />
      </label>
      <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id || !catalogConnectorForm.kind} onClick={() => void saveCatalogConnector()}>{busy === 'catalog-connector' ? 'Saving…' : 'Save connector'}</button>
    </div>
    {(catalogConnectorForm.kind === 'appsheet' || catalogConnectorForm.kind === 'postgres') && <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Credentials for this connector</h3>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 10 }}>
        Stored under <code>{catalogConnectorSecretConfigId()}</code> and reused by Base views. Values are never shown back; status is masked only. Connector test checks that credentials are configured and that the connector type is loadable; concrete table extraction is tested in Base view Execute/Discover.
      </div>
      {catalogConnectorForm.kind === 'appsheet' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <label>AppSheet App ID
          <input type="password" autoComplete="off" value={secretForm.app_id} onChange={e => setSecretForm({ ...secretForm, app_id: e.target.value })} placeholder="paste App ID" />
        </label>
        <label>AppSheet Access Key
          <input type="password" autoComplete="off" value={secretForm.access_key} onChange={e => setSecretForm({ ...secretForm, access_key: e.target.value })} placeholder="paste Access Key" />
        </label>
      </div>}
      {catalogConnectorForm.kind === 'postgres' && <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
        <label>Postgres DSN / connection string
          <input type="password" autoComplete="off" value={secretForm.connection_string ?? ''} onChange={e => setSecretForm({ ...secretForm, connection_string: e.target.value })} placeholder="postgresql://user:password@host:5432/db?sslmode=disable" />
        </label>
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Default schema/object allowlist: <code>gbrain.companies</code>, <code>departments</code>, <code>positions</code>, <code>employees</code>. Only SELECT queries are issued.</div>
      </div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id || (catalogConnectorForm.kind === 'appsheet' ? (!secretForm.app_id || !secretForm.access_key) : !secretForm.connection_string)} onClick={() => void saveCatalogConnectorCredentials()}>{busy === 'catalog-save-secret' ? 'Saving credentials…' : 'Save credentials'}</button>
        <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void deleteCatalogConnectorCredentials()}>{busy === 'catalog-delete-secret' ? 'Deleting credentials…' : 'Delete credentials'}</button>
      </div>
      {catalogConnectorSecretStatus !== null && <div style={{ marginTop: 10 }}><PreviewJson value={catalogConnectorSecretStatus} empty="No credential status yet." /></div>}
    </div>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
      <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void listCatalogConnectorObjects()}>{busy === 'catalog-list-objects' ? 'Loading objects…' : 'List available objects'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void testCatalogConnector()}>{busy === 'catalog-test-connector' ? 'Testing…' : 'Test connector credentials'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void deleteCatalogConnector()}>{busy === 'catalog-delete-connector' ? 'Deleting…' : 'Delete connector'}</button>
      <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>No table is sent from this connector test. Tables/objects are selected and sampled in Base views.</span>
    </div>
    {catalogConnectorTest !== null && <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${testOk ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)'}`, color: testOk ? 'var(--success)' : 'var(--danger)', background: testOk ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)' }}>
      Test result: <b>{testOk ? 'OK' : 'FAILED'}</b>{testStatus ? ` · ${testStatus}` : ''}
    </div>}
    {(catalogConnectorObjects !== null || catalogConnectorTest !== null) && <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginTop: 12 }}>
      {catalogConnectorObjects !== null && <div><h3 style={{ fontSize: 13, marginBottom: 6 }}>Available objects / metadata</h3><PreviewJson value={catalogConnectorObjects} empty="No listObjects result yet." /></div>}
      {catalogConnectorTest !== null && <div><h3 style={{ fontSize: 13, marginBottom: 6 }}>Credential test</h3><PreviewJson value={catalogConnectorTest} empty="No test result yet." /></div>}
    </div>}
  </section>;
}
