import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface LogEntry {
  id: number;
  token_name: string;
  agent_name: string;
  operation: string;
  latency_ms: number;
  status: string;
  params: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
}

export function RequestLogPage() {
  const [data, setData] = useState<{ rows: LogEntry[]; total: number; page: number; pages: number }>({
    rows: [], total: 0, page: 1, pages: 1,
  });
  const [page, setPage] = useState(1);
  const [agentFilter, setAgentFilter] = useState('all');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  useEffect(() => { loadPage(page); }, [page, agentFilter]);

  const loadPage = (p: number) => {
    const qs = agentFilter !== 'all' ? `&agent=${encodeURIComponent(agentFilter)}` : '';
    api.requests(p, qs).then(setData).catch(() => {});
  };

  const timeAgo = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)} сек. назад`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин. назад`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч. назад`;
    return new Date(ts).toLocaleDateString();
  };



  const formatParams = (params: Record<string, unknown> | null) => {
    if (!params) return null;
    const { query, slug, partial, limit, declared_keys, unknown_key_count, approx_bytes, redacted, ...rest } = params as any;
    const parts: string[] = [];
    if (query) parts.push(`"${query}"`);
    if (slug) parts.push(slug);
    if (partial) parts.push(`~${partial}`);
    if (limit) parts.push(`limit=${limit}`);
    if (Array.isArray(declared_keys) && declared_keys.length > 0) {
      parts.push(`keys=${declared_keys.join(',')}`);
    } else if (redacted) {
      parts.push('keys=none');
    }
    if (unknown_key_count) parts.push(`+${unknown_key_count} unknown`);
    if (approx_bytes) parts.push(`~${approx_bytes}B`);
    const restCount = Object.keys(rest).length;
    if (!redacted && restCount > 0) parts.push(`+${restCount} params`);
    return parts.join(' ');
  };

  // Collect unique agents for filter (use name for display, token_name for value)
  const agentMap = new Map<string, string>();
  data.rows.forEach(r => { if (r.token_name) agentMap.set(r.token_name, r.agent_name || r.token_name); });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Журнал запросов</h1>
        <select value={agentFilter} onChange={e => { setAgentFilter(e.target.value); setPage(1); }}
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 13 }}>
          <option value="all">Все агенты</option>
          {[...agentMap.entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>

      {data.rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          Запросов пока нет.
        </div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Время</th>
                <th>Агент</th>
                <th>Операция</th>
                <th>Параметры</th>
                <th>Задержка</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <React.Fragment key={r.id}>
                  <tr onClick={() => setExpandedRow(expandedRow === r.id ? null : r.id)}
                      style={{ cursor: 'pointer' }}>
                    <td style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{timeAgo(r.created_at)}</td>
                    <td>
                      <a style={{ color: 'var(--text-link, #88aaff)', cursor: 'pointer', textDecoration: 'none', fontWeight: 500 }}
                         onClick={(e) => { e.stopPropagation(); setAgentFilter(r.token_name); setPage(1); }}>
                        {r.agent_name || r.token_name}
                      </a>
                    </td>
                    <td className="mono">{r.operation}</td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatParams(r.params)}
                    </td>
                    <td className="mono">{r.latency_ms}ms</td>
                    <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                  </tr>
                  {expandedRow === r.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--bg-secondary, #0f0f1a)', padding: 16 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '6px 12px', fontSize: 13 }}>
                          <span style={{ color: 'var(--text-muted)' }}>Время</span>
                          <span>{new Date(r.created_at).toLocaleString()}</span>
                          <span style={{ color: 'var(--text-muted)' }}>Агент</span>
                          <span className="mono">{r.token_name}</span>
                          <span style={{ color: 'var(--text-muted)' }}>Операция</span>
                          <span className="mono">{r.operation}</span>
                          <span style={{ color: 'var(--text-muted)' }}>Задержка</span>
                          <span>{r.latency_ms}ms</span>
                          {r.params && (
                            <>
                              <span style={{ color: 'var(--text-muted)' }}>Параметры</span>
                              <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
                                {JSON.stringify(r.params, null, 2)}
                              </pre>
                            </>
                          )}
                          {r.error_message && (
                            <>
                              <span style={{ color: 'var(--error, #ff6b6b)' }}>Ошибка</span>
                              <span style={{ color: 'var(--error, #ff6b6b)' }}>{r.error_message}</span>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <span>Страница {data.page} из {data.pages} · всего {data.total}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={data.page <= 1} onClick={() => setPage(p => p - 1)}>Назад</button>
              <button disabled={data.page >= data.pages} onClick={() => setPage(p => p + 1)}>Далее</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
