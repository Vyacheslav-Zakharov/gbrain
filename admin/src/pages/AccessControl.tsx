import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

type AccessTab = 'permissions' | 'requests' | 'admins';

type AccessArea = {
  id: string;
  sourceId: string;
  label: string;
  hint?: string;
};

type PermissionUser = {
  email: string;
  source_id: string;
  federated_read: string[];
  federated_write: string[];
  version: string;
};

type PermissionResponse = { areas: AccessArea[]; users: PermissionUser[] };

type RequestGrant = { area: string; source_id?: string; read?: boolean; write?: boolean };
type AccessRequest = {
  id: string;
  email: string;
  status: string;
  requested_at?: string;
  reason?: string;
  requests?: RequestGrant[];
  approved_requests?: RequestGrant[];
  denied_requests?: RequestGrant[];
  decided_at?: string;
  decided_by?: string;
  rejection_reason?: string;
  version: string;
};

type RequestResponse = { requests: AccessRequest[] };

type GrantSelection = { read: boolean; write: boolean };

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'permissions_changed' || message === 'request_changed') return 'Данные изменились в другой вкладке. Список обновлён; проверьте решение ещё раз.';
  if (message === 'access_control_store_unavailable') return 'Хранилище прав временно недоступно. Изменения не применены.';
  if (message === 'expected_version_required') return 'Версия данных не передана. Обновите страницу и повторите.';
  return message;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Ожидает решения',
    approved: 'Одобрена',
    approved_partial: 'Одобрена частично',
    rejected: 'Отклонена',
    already_granted: 'Уже выдано',
  };
  return labels[status] || status;
}

function permissionSelection(user: PermissionUser, areas: AccessArea[]): Record<string, GrantSelection> {
  return Object.fromEntries(areas.map(area => [area.sourceId, {
    read: user.federated_read.includes(area.sourceId) || user.federated_write.includes(area.sourceId),
    write: user.federated_write.includes(area.sourceId),
  }]));
}

export function AccessControlPage() {
  const [tab, setTab] = useState<AccessTab>('permissions');
  const [permissions, setPermissions] = useState<PermissionResponse | null>(null);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Record<string, GrantSelection>>>({});
  const [requestDrafts, setRequestDrafts] = useState<Record<string, GrantSelection[]>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPermissions = async () => {
    const data = await api.accessControlPermissions() as PermissionResponse;
    setPermissions(data);
    setDrafts(Object.fromEntries(data.users.map(user => [user.email, permissionSelection(user, data.areas)])));
  };

  const loadRequests = async () => {
    const data = await api.accessControlRequests() as RequestResponse;
    setRequests(data.requests);
    setRequestDrafts(Object.fromEntries(data.requests.map(request => [
      request.id,
      (request.requests || []).map(grant => ({ read: !!grant.read || !!grant.write, write: !!grant.write })),
    ])));
  };

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadPermissions(), loadRequests()]);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const visibleUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!permissions) return [];
    return query ? permissions.users.filter(user => user.email.toLowerCase().includes(query) || user.source_id.toLowerCase().includes(query)) : permissions.users;
  }, [permissions, search]);

  const sortedRequests = useMemo(() => [...requests].sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (b.status === 'pending' && a.status !== 'pending') return 1;
    return String(b.requested_at || '').localeCompare(String(a.requested_at || ''));
  }), [requests]);

  const handleTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, current: AccessTab) => {
    const order: AccessTab[] = ['permissions', 'requests', 'admins'];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = order.indexOf(current);
    const next = event.key === 'Home' ? order[0]
      : event.key === 'End' ? order[order.length - 1]
      : order[(currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length];
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`access-tab-${next}`)?.focus());
  };

  const changePermission = (email: string, sourceId: string, field: 'read' | 'write', checked: boolean) => {
    setDrafts(current => {
      const userDraft = { ...(current[email] || {}) };
      const grant = { ...(userDraft[sourceId] || { read: false, write: false }) };
      grant[field] = checked;
      if (field === 'write' && checked) grant.read = true;
      if (field === 'read' && !checked) grant.write = false;
      userDraft[sourceId] = grant;
      return { ...current, [email]: userDraft };
    });
  };

  const savePermissions = async (user: PermissionUser) => {
    if (!permissions) return;
    setBusy(`permissions:${user.email}`);
    setNotice(null);
    setError(null);
    try {
      const grants = permissions.areas.map(area => ({
        source_id: area.sourceId,
        read: !!drafts[user.email]?.[area.sourceId]?.read,
        write: !!drafts[user.email]?.[area.sourceId]?.write,
      }));
      const changes = grants.filter(grant => {
        const current = permissionSelection(user, permissions.areas)[grant.source_id] || { read: false, write: false };
        return current.read !== grant.read || current.write !== grant.write;
      });
      if (!changes.length) {
        setNotice(`Изменений нет: ${user.email}`);
        return;
      }
      const labels = new Map(permissions.areas.map(area => [area.sourceId, area.label]));
      const summary = changes.map(grant => `• ${labels.get(grant.source_id) || grant.source_id}: ${grant.write ? 'R/W' : grant.read ? 'R' : 'нет доступа'}`).join('\n');
      if (!confirm(`Применить изменения для ${user.email}?\n\n${summary}`)) return;
      await api.accessControlSavePermissions(user.email, { grants, expected_version: user.version });
      setNotice(`Права сохранены: ${user.email}`);
      try {
        await loadPermissions();
      } catch {
        setError('Права сохранены, но обновить список не удалось. Нажмите «Обновить» перед следующим изменением.');
      }
    } catch (saveError) {
      setError(errorMessage(saveError));
      await loadPermissions().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const changeRequestGrant = (requestId: string, index: number, field: 'read' | 'write', checked: boolean) => {
    setRequestDrafts(current => {
      const rows = [...(current[requestId] || [])];
      const grant = { ...(rows[index] || { read: false, write: false }) };
      grant[field] = checked;
      if (field === 'write' && checked) grant.read = true;
      if (field === 'read' && !checked) grant.write = false;
      rows[index] = grant;
      return { ...current, [requestId]: rows };
    });
  };

  const approveRequest = async (request: AccessRequest) => {
    const grants = (requestDrafts[request.id] || []).map((grant, index) => ({ index, ...grant }));
    if (!grants.some(grant => grant.read || grant.write)) {
      setError('Не выбрано ни одного права. Для полного отказа используйте «Отклонить».');
      return;
    }
    if (!confirm(`Выдать выбранные права пользователю ${request.email}?`)) return;
    setBusy(`request:${request.id}`);
    setError(null);
    setNotice(null);
    try {
      await api.accessControlApproveRequest(request.id, { grants, expected_version: request.version });
      setNotice(`Решение по заявке ${request.id} сохранено.`);
      try {
        await Promise.all([loadRequests(), loadPermissions()]);
      } catch {
        setError('Решение сохранено, но обновить списки не удалось. Нажмите «Обновить» перед следующим изменением.');
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
      await loadRequests().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const rejectRequest = async (request: AccessRequest) => {
    const reason = prompt(`Укажите причину отказа для ${request.email}. Она останется в журнале заявки.`);
    if (reason === null) return;
    if (!reason.trim()) {
      setError('Для отказа нужна причина.');
      return;
    }
    setBusy(`request:${request.id}`);
    setError(null);
    setNotice(null);
    try {
      await api.accessControlRejectRequest(request.id, request.version, reason.trim());
      setNotice(`Заявка ${request.id} отклонена.`);
      try {
        await loadRequests();
      } catch {
        setError('Отказ сохранён, но обновить список не удалось. Нажмите «Обновить» перед следующим изменением.');
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
      await loadRequests().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  return <div className="access-control-page">
    <div className="access-control-heading">
      <div>
        <h1 className="page-title">Доступы</h1>
        <p className="access-control-subtitle">Права на источники, заявки и модель назначения администраторов.</p>
      </div>
      <button className="btn btn-secondary" type="button" onClick={() => void reload()} disabled={loading || !!busy}>Обновить</button>
    </div>

    <div className="tabs access-control-tabs" role="tablist" aria-label="Разделы управления доступом">
      <button id="access-tab-permissions" aria-controls="access-panel-permissions" tabIndex={tab === 'permissions' ? 0 : -1} className={`tab ${tab === 'permissions' ? 'active' : ''}`} type="button" role="tab" aria-selected={tab === 'permissions'} onKeyDown={event => handleTabKey(event, 'permissions')} onClick={() => setTab('permissions')}>Права пользователей</button>
      <button id="access-tab-requests" aria-controls="access-panel-requests" tabIndex={tab === 'requests' ? 0 : -1} className={`tab ${tab === 'requests' ? 'active' : ''}`} type="button" role="tab" aria-selected={tab === 'requests'} onKeyDown={event => handleTabKey(event, 'requests')} onClick={() => setTab('requests')}>Заявки</button>
      <button id="access-tab-admins" aria-controls="access-panel-admins" tabIndex={tab === 'admins' ? 0 : -1} className={`tab ${tab === 'admins' ? 'active' : ''}`} type="button" role="tab" aria-selected={tab === 'admins'} onKeyDown={event => handleTabKey(event, 'admins')} onClick={() => setTab('admins')}>Администраторы</button>
    </div>

    {error && <div className="access-control-alert access-control-alert-error" role="alert">{error}</div>}
    {notice && <div className="access-control-alert access-control-alert-success" role="status">{notice}</div>}
    {loading && <div className="empty-state">Загрузка данных доступа…</div>}

    {!loading && tab === 'permissions' && permissions && <section id="access-panel-permissions" role="tabpanel" aria-labelledby="access-tab-permissions">
      <div className="access-control-toolbar">
        <input aria-label="Поиск пользователя" placeholder="Поиск по email или личной области" value={search} onChange={event => setSearch(event.target.value)} />
        <span className="access-control-count">Пользователей: {visibleUsers.length}</span>
      </div>
      <div className="access-control-table-wrap">
        <table className="access-control-table">
          <thead><tr><th>Пользователь</th><th>Личная область</th>{permissions.areas.map(area => <th key={area.sourceId} title={area.hint}>{area.label}<small>{area.sourceId}</small></th>)}<th>Действие</th></tr></thead>
          <tbody>{visibleUsers.map(user => <tr key={user.email}>
            <td><strong>{user.email}</strong></td>
            <td><code>{user.source_id}</code><div className="access-control-personal">R/W неизменяемые</div></td>
            {permissions.areas.map(area => {
              const grant = drafts[user.email]?.[area.sourceId] || { read: false, write: false };
              return <td key={area.sourceId}><div className="access-control-grants">
                <label><span>R</span><input aria-label={`${user.email}, ${area.label}, чтение`} type="checkbox" checked={grant.read} onChange={event => changePermission(user.email, area.sourceId, 'read', event.target.checked)} /></label>
                <label><span>W</span><input aria-label={`${user.email}, ${area.label}, запись`} type="checkbox" checked={grant.write} onChange={event => changePermission(user.email, area.sourceId, 'write', event.target.checked)} /></label>
              </div></td>;
            })}
            <td><button className="btn btn-primary" type="button" disabled={busy === `permissions:${user.email}`} onClick={() => void savePermissions(user)}>{busy === `permissions:${user.email}` ? 'Сохранение…' : 'Сохранить'}</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {!visibleUsers.length && <div className="empty-state">Пользователи не найдены.</div>}
    </section>}

    {!loading && tab === 'requests' && <section id="access-panel-requests" role="tabpanel" aria-labelledby="access-tab-requests" className="access-request-list">
      {!sortedRequests.length && <div className="empty-state">Заявок нет.</div>}
      {sortedRequests.map(request => <article className="access-request-card" key={request.id}>
        <div className="access-request-header"><div><strong>{request.email}</strong><div className="access-control-personal">{request.id} · {request.requested_at || 'дата не указана'}</div></div><span className={`badge ${request.status === 'pending' ? 'badge-write' : request.status === 'rejected' ? 'badge-error' : 'badge-success'}`}>{statusLabel(request.status)}</span></div>
        {request.reason && <p className="access-request-reason">{request.reason}</p>}
        {request.status === 'pending' ? <div className="access-request-grants">{(request.requests || []).map((grant, index) => {
          const selection = requestDrafts[request.id]?.[index] || { read: false, write: false };
          return <div className="access-request-row" key={`${grant.source_id || grant.area}:${index}`}>
            <div><strong>{grant.area}</strong><code>{grant.source_id || 'source не определён'}</code></div>
            <div className="access-control-grants">
              <label><span>R</span><input aria-label={`${request.email}, ${grant.area}, чтение`} type="checkbox" checked={selection.read} onChange={event => changeRequestGrant(request.id, index, 'read', event.target.checked)} /></label>
              <label><span>W</span><input aria-label={`${request.email}, ${grant.area}, запись`} type="checkbox" checked={selection.write} disabled={!grant.write} onChange={event => changeRequestGrant(request.id, index, 'write', event.target.checked)} /></label>
            </div>
          </div>;
        })}</div> : <div className="access-request-grants">
          {(request.approved_requests || []).map((grant, index) => <div className="access-request-row access-request-row-approved" key={`approved:${grant.source_id || grant.area}:${index}`}>
            <div><strong>{grant.area}</strong><code>{grant.source_id || 'source не определён'}</code></div><span>Выдано: {grant.write ? 'R/W' : grant.read ? 'R' : '—'}</span>
          </div>)}
          {(request.denied_requests || []).map((grant, index) => <div className="access-request-row access-request-row-denied" key={`denied:${grant.source_id || grant.area}:${index}`}>
            <div><strong>{grant.area}</strong><code>{grant.source_id || 'source не определён'}</code></div><span>Не выдано: {grant.write && grant.read ? 'R/W' : grant.write ? 'W' : grant.read ? 'R' : '—'}</span>
          </div>)}
          {!(request.approved_requests || []).length && !(request.denied_requests || []).length && (request.requests || []).map((grant, index) => <div className="access-request-row" key={`legacy:${grant.source_id || grant.area}:${index}`}>
            <div><strong>{grant.area}</strong><code>{grant.source_id || 'source не определён'}</code></div><span>Запрошено: {grant.write ? 'R/W' : grant.read ? 'R' : '—'}</span>
          </div>)}
        </div>}
        {request.status === 'pending' && <div className="access-request-actions">
          <button className="btn btn-primary" type="button" disabled={busy === `request:${request.id}`} onClick={() => void approveRequest(request)}>Выдать выбранные права</button>
          <button className="btn btn-danger" type="button" disabled={busy === `request:${request.id}`} onClick={() => void rejectRequest(request)}>Отклонить</button>
        </div>}
        {request.rejection_reason && <p className="access-request-reason"><strong>Причина отказа:</strong> {request.rejection_reason}</p>}
        {request.decided_at && <div className="access-control-personal">Решение: {request.decided_at}{request.decided_by ? ` · ${request.decided_by}` : ''}</div>}
      </article>)}
    </section>}

    {!loading && tab === 'admins' && <section id="access-panel-admins" role="tabpanel" aria-labelledby="access-tab-admins" className="access-control-admin-info">
      <h2>Как назначаются администраторы сейчас</h2>
      <p>Для корпоративного входа администратор GBrain определяется серверным allowlist <code>GBRAIN_ADMIN_EMAILS</code>. Изменение требует обновления серверной конфигурации и перезапуска GBrain.</p>
      <p>До даты <code>GBRAIN_ADMIN_FALLBACK_UNTIL</code> сервер также может принимать ограниченные по времени bootstrap- и magic-link fallback-сессии. Этот экран не управляет ими.</p>
      <p>Решения по заявкам сохраняют email администратора либо fingerprint fallback-сессии. Прямые изменения прав до Release C фиксируются в service log; полноценный неизменяемый before/after audit появится вместе с PostgreSQL ACL в Release C.</p>
      <h2>Keycloak</h2>
      <p>На этом релизе Keycloak подтверждает личность, но его роли ещё не назначают права администратора GBrain. Роль <code>gbrain-admin</code> будет включена отдельным Release B после shadow-проверки и rollback gate.</p>
      <div className="access-control-alert">Права R/W на источники не делают пользователя администратором.</div>
    </section>}
  </div>;
}
