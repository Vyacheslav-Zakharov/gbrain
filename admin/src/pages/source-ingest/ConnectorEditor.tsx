import React from 'react';
import { DangerZone } from './shared';

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
    <h2 className="section-title">0. Подключение к источнику</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      Выберите тип подключения и сохраните секреты. Конкретная таблица или объект выбирается на уровне источника (Base view).
    </p>
    <div className="source-ingest-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 16, alignItems: 'end' }}>
      <label>ID подключения
        <input value={catalogConnectorForm.connector_id} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, connector_id: e.target.value }))} placeholder="appsheet-avto" />
      </label>
      <label>Тип
        <select value={catalogConnectorForm.kind} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, kind: e.target.value }))}>
          <option value="appsheet">AppSheet</option>
          <option value="postgres">Postgres read-only</option>
          <option value="fake">Fake / demo</option>
        </select>
      </label>
      <label>Название (необязательно)
        <input value={catalogConnectorForm.display_name} onChange={e => setCatalogConnectorForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="можно оставить пустым или написать по-русски" />
      </label>
      <button className="btn btn-primary source-ingest-context-primary" style={{ justifySelf: 'start', minWidth: 220 }} disabled={busy !== null || !catalogConnectorForm.connector_id || !catalogConnectorForm.kind} onClick={() => void saveCatalogConnector()}>{busy === 'catalog-connector' ? 'Сохраняем…' : 'Сохранить подключение'}</button>
    </div>
    {(catalogConnectorForm.kind === 'appsheet' || catalogConnectorForm.kind === 'postgres') && <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Секреты подключения</h3>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 10 }}>
        Хранятся как <code>{catalogConnectorSecretConfigId()}</code> и используются источниками (Base views). Значения повторно не показываются. Здесь проверяется доступность подключения, а чтение таблицы — в источнике через исследование полей.
      </div>
      {catalogConnectorForm.kind === 'appsheet' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <label>AppSheet App ID
          <input type="password" autoComplete="off" value={secretForm.app_id} onChange={e => setSecretForm({ ...secretForm, app_id: e.target.value })} placeholder="вставьте App ID" />
        </label>
        <label>AppSheet Access Key
          <input type="password" autoComplete="off" value={secretForm.access_key} onChange={e => setSecretForm({ ...secretForm, access_key: e.target.value })} placeholder="вставьте Access Key" />
        </label>
      </div>}
      {catalogConnectorForm.kind === 'postgres' && <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
        <label>Postgres DSN / connection string
          <input type="password" autoComplete="off" value={secretForm.connection_string ?? ''} onChange={e => setSecretForm({ ...secretForm, connection_string: e.target.value })} placeholder="postgresql://user:password@host:5432/db?sslmode=disable" />
        </label>
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Разрешённые schema/object по умолчанию: <code>gbrain.companies</code>, <code>departments</code>, <code>positions</code>, <code>employees</code>. Выполняются только SELECT-запросы.</div>
      </div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id || (catalogConnectorForm.kind === 'appsheet' ? (!secretForm.app_id || !secretForm.access_key) : !secretForm.connection_string)} onClick={() => void saveCatalogConnectorCredentials()}>{busy === 'catalog-save-secret' ? 'Сохраняем секреты…' : 'Сохранить секреты'}</button>
      </div>
      {catalogConnectorSecretStatus !== null && <details style={{ marginTop: 10 }}><summary>Технические детали</summary><PreviewJson value={catalogConnectorSecretStatus} empty="Статус секретов пока отсутствует." /></details>}
    </div>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
      <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void listCatalogConnectorObjects()}>{busy === 'catalog-list-objects' ? 'Загружаем объекты…' : 'Показать доступные объекты'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void testCatalogConnector()}>{busy === 'catalog-test-connector' ? 'Проверяем…' : 'Проверить секреты'}</button>
      <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>Эта проверка не читает таблицу. Таблицы выбираются и проверяются в источниках (Base views).</span>
    </div>
    <DangerZone description="Удаление секретов отключит доступ к данным. Удаление подключения может затронуть зависимые источники и потребует подтверждения последствий.">
      {(catalogConnectorForm.kind === 'appsheet' || catalogConnectorForm.kind === 'postgres') && <button className="btn btn-danger" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void deleteCatalogConnectorCredentials()}>{busy === 'catalog-delete-secret' ? 'Удаляем секреты…' : 'Удалить секреты'}</button>}
      <button className="btn btn-danger" disabled={busy !== null || !catalogConnectorForm.connector_id} onClick={() => void deleteCatalogConnector()}>{busy === 'catalog-delete-connector' ? 'Удаляем…' : 'Удалить подключение'}</button>
    </DangerZone>
    {catalogConnectorTest !== null && <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${testOk ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)'}`, color: testOk ? 'var(--success)' : 'var(--danger)', background: testOk ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)' }}>
      Результат: <b>{testOk ? 'OK' : 'ОШИБКА'}</b>{testStatus ? ` · ${testStatus}` : ''}
    </div>}
    {(catalogConnectorObjects !== null || catalogConnectorTest !== null) && <details style={{ marginTop: 12 }}><summary>Технические детали</summary><div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginTop: 10 }}>
      {catalogConnectorObjects !== null && <div><h3 style={{ fontSize: 13, marginBottom: 6 }}>Доступные объекты и метаданные</h3><PreviewJson value={catalogConnectorObjects} empty="Результата listObjects пока нет." /></div>}
      {catalogConnectorTest !== null && <div><h3 style={{ fontSize: 13, marginBottom: 6 }}>Проверка секретов</h3><PreviewJson value={catalogConnectorTest} empty="Результата проверки пока нет." /></div>}
    </div></details>}
  </section>;
}
