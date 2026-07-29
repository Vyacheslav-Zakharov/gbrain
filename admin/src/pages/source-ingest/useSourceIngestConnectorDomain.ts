import { useState } from 'react';
import { api } from '../../api';

export type CatalogConnectorForm = {
  connector_id: string;
  kind: string;
  display_name: string;
  enabled: boolean;
};

export type ConnectorSecretForm = {
  app_id: string;
  access_key: string;
  connection_string: string;
};

type RunStep = <T>(name: string, action: () => Promise<T>) => Promise<T | undefined>;

type ConnectorDomainOptions = {
  runStep: RunStep;
  load: () => Promise<void>;
  activeNode: string;
  catalogConnectors: Array<Record<string, unknown>>;
  configId: string;
  connectorId: string;
  sourceObject: string;
  configPayload: () => Record<string, unknown>;
  connectionPayload: () => Record<string, unknown>;
};

const EMPTY_SECRET_FORM: ConnectorSecretForm = {
  app_id: '',
  access_key: '',
  connection_string: '',
};

const EMPTY_CATALOG_CONNECTOR_FORM: CatalogConnectorForm = {
  connector_id: '',
  kind: 'appsheet',
  display_name: '',
  enabled: true,
};

function connectorConfigJson(kind: string): Record<string, unknown> {
  return kind === 'postgres'
    ? { source: 'admin-ui', phase: 'catalog-tree-shell', schema: 'gbrain', allowed_objects: ['companies', 'departments', 'positions', 'employees'] }
    : { source: 'admin-ui', phase: 'catalog-tree-shell' };
}

export function useSourceIngestConnectorDomain({
  runStep,
  load,
  activeNode,
  catalogConnectors,
  configId,
  connectorId,
  sourceObject,
  configPayload,
  connectionPayload,
}: ConnectorDomainOptions) {
  const [connectionTest, setConnectionTest] = useState<unknown>(null);
  const [secretAudit, setSecretAudit] = useState<unknown>(null);
  const [secretForm, setSecretForm] = useState<ConnectorSecretForm>(EMPTY_SECRET_FORM);
  const [catalogConnectorForm, setCatalogConnectorForm] = useState<CatalogConnectorForm>(EMPTY_CATALOG_CONNECTOR_FORM);
  const [catalogConnectorObjects, setCatalogConnectorObjects] = useState<unknown>(null);
  const [catalogConnectorTest, setCatalogConnectorTest] = useState<unknown>(null);
  const [catalogConnectorSecretStatus, setCatalogConnectorSecretStatus] = useState<unknown>(null);

  const catalogConnectorSecretConfigId = () => `connector:${catalogConnectorForm.connector_id}`;
  const catalogConnectorPayload = () => ({
    connector_id: catalogConnectorForm.connector_id,
    kind: catalogConnectorForm.kind,
    config_id: catalogConnectorSecretConfigId(),
  });

  const saveConfig = async () => runStep('save-config', async () => {
    await api.sourceIngestSaveConfig(configPayload());
    await load();
  });

  const rotateSecret = async () => runStep('save-secret', async () => {
    await api.sourceIngestSaveConfig(configPayload());
    await api.sourceIngestSaveSecret({
      config_id: configId,
      connector_id: connectorId,
      source_object: sourceObject,
      secrets: secretForm,
    });
    setSecretForm(EMPTY_SECRET_FORM);
    await load();
    setConnectionTest(await api.sourceIngestTestConnection(connectionPayload()));
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const deleteSecret = async () => runStep('delete-secret', async () => {
    await api.sourceIngestDeleteSecret({ config_id: configId, connector_id: connectorId, source_object: sourceObject });
    await load();
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const loadSecretAudit = async () => runStep('secret-audit', async () => {
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const testConnection = async () => runStep('test-connection', async () => {
    setConnectionTest(await api.sourceIngestTestConnection(connectionPayload()));
  });

  const saveCatalogConnector = async () => runStep('catalog-connector', async () => {
    const normalizedConnectorId = catalogConnectorForm.connector_id.trim();
    if (!normalizedConnectorId) throw new Error('connector_id_required');
    if (activeNode === 'connector:new' && catalogConnectors.some(row => String(row.connector_id) === normalizedConnectorId)) {
      throw new Error(`connector_already_exists:${normalizedConnectorId}`);
    }
    await api.sourceIngestSaveCatalogConnector({
      ...catalogConnectorForm,
      connector_id: normalizedConnectorId,
      display_name: catalogConnectorForm.display_name.trim() || catalogConnectorForm.connector_id,
      config_json: connectorConfigJson(catalogConnectorForm.kind),
    });
    await load();
  });

  const saveCatalogConnectorCredentials = async () => runStep('catalog-save-secret', async () => {
    await api.sourceIngestSaveCatalogConnector({
      ...catalogConnectorForm,
      display_name: catalogConnectorForm.display_name.trim() || catalogConnectorForm.connector_id,
      config_json: connectorConfigJson(catalogConnectorForm.kind),
    });
    await api.sourceIngestSaveConfig({
      config_id: catalogConnectorSecretConfigId(),
      connector_id: catalogConnectorForm.connector_id,
      source_object: '__connection__',
      display_name: catalogConnectorForm.display_name.trim() || catalogConnectorForm.connector_id,
      enabled: true,
      config_json: { connector_level: true, kind: catalogConnectorForm.kind },
    });
    const status = await api.sourceIngestSaveSecret({
      config_id: catalogConnectorSecretConfigId(),
      connector_id: catalogConnectorForm.connector_id,
      source_object: '__connection__',
      secrets: secretForm,
    });
    setCatalogConnectorSecretStatus(status);
    setSecretForm(EMPTY_SECRET_FORM);
    setSecretAudit(await api.sourceIngestSecretAudit(catalogConnectorSecretConfigId()));
    await load();
  });

  const deleteCatalogConnectorCredentials = async () => runStep('catalog-delete-secret', async () => {
    const status = await api.sourceIngestDeleteSecret({
      config_id: catalogConnectorSecretConfigId(),
      connector_id: catalogConnectorForm.connector_id,
      source_object: '__connection__',
    });
    setCatalogConnectorSecretStatus(status);
    setSecretAudit(await api.sourceIngestSecretAudit(catalogConnectorSecretConfigId()));
    await load();
  });

  const listCatalogConnectorObjects = async () => runStep('catalog-list-objects', async () => {
    setCatalogConnectorObjects(await api.sourceIngestConnectorListObjects(catalogConnectorPayload()));
  });

  const testCatalogConnector = async () => runStep('catalog-test-connector', async () => {
    const out = await api.sourceIngestCatalogConnectorTest(catalogConnectorPayload());
    setCatalogConnectorTest(out);
    const objects = out && typeof out === 'object' && Array.isArray((out as Record<string, unknown>).objects)
      ? (out as Record<string, unknown>).objects as unknown[]
      : [];
    if (objects.length > 0) setCatalogConnectorObjects(out);
  });

  const resetCatalogConnector = () => {
    setCatalogConnectorForm(EMPTY_CATALOG_CONNECTOR_FORM);
    setSecretForm(EMPTY_SECRET_FORM);
    setCatalogConnectorObjects(null);
    setCatalogConnectorTest(null);
    setCatalogConnectorSecretStatus(null);
  };

  const selectCatalogConnectorState = (row: Record<string, unknown>) => {
    const selectedConnectorId = String(row.connector_id ?? '');
    setCatalogConnectorForm({
      connector_id: selectedConnectorId,
      kind: String(row.kind ?? 'appsheet'),
      display_name: String(row.display_name ?? selectedConnectorId),
      enabled: row.enabled !== false,
    });
    setCatalogConnectorObjects(null);
    setCatalogConnectorTest(null);
    return selectedConnectorId;
  };

  return {
    connectionTest,
    secretAudit,
    secretForm,
    setSecretForm,
    catalogConnectorForm,
    setCatalogConnectorForm,
    catalogConnectorObjects,
    setCatalogConnectorObjects,
    catalogConnectorTest,
    setCatalogConnectorTest,
    catalogConnectorSecretStatus,
    catalogConnectorSecretConfigId,
    saveConfig,
    rotateSecret,
    deleteSecret,
    loadSecretAudit,
    testConnection,
    saveCatalogConnector,
    saveCatalogConnectorCredentials,
    deleteCatalogConnectorCredentials,
    listCatalogConnectorObjects,
    testCatalogConnector,
    resetCatalogConnector,
    selectCatalogConnectorState,
  };
}
