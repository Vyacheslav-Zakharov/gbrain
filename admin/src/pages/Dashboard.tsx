import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { mergeEvents, type FeedEvent } from '../event-merge';

interface RequestLogRow {
  id: number;
  agent_name: string;
  token_name: string;
  operation: string;
  latency_ms: number;
  status: string;
  created_at: string;
}

export function DashboardPage() {
  const [stats, setStats] = useState({ connected_agents: 0, requests_today: 0, active_tokens: 0 });
  const [health, setHealth] = useState({ expiring_soon: 0, error_rate: '0%' });
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [sseStatus, setSseStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
    api.health().then(setHealth).catch(() => {});

    const loadRecent = () => api.requests(1)
      .then((data: { rows?: RequestLogRow[] }) => {
        const recent = (data.rows ?? []).map(row => ({
          id: row.id,
          agent: row.agent_name || row.token_name,
          operation: row.operation,
          scopes: '',
          latency_ms: row.latency_ms,
          status: row.status,
          timestamp: row.created_at,
        }));
        setEvents(current => mergeEvents(current, recent));
      })
      .catch(() => {});
    void loadRecent();

    const es = new EventSource('/admin/events', { withCredentials: true });
    eventSourceRef.current = es;
    es.onopen = () => setSseStatus('connected');
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as FeedEvent;
        setEvents(prev => mergeEvents(prev, [event]));
      } catch {}
    };
    es.onerror = () => {
      setSseStatus('disconnected');
    };

    const interval = setInterval(() => {
      api.stats().then(setStats).catch(() => {});
      api.health().then(setHealth).catch(() => {});
      void loadRecent();
    }, 15000);

    return () => { es.close(); clearInterval(interval); };
  }, []);

  const timeAgo = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)} сек. назад`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин. назад`;
    return `${Math.floor(diff / 3600000)} ч. назад`;
  };

  return (
    <>
      <h1 className="page-title">Обзор</h1>

      <div style={{ display: 'flex', gap: 24 }}>
        <div style={{ flex: 1 }}>
          <div className="metrics">
            <div className="metric">
              <div className="metric-value">{stats.connected_agents}</div>
              <div className="metric-label">Подключённые агенты</div>
            </div>
            <div className="metric">
              <div className="metric-value">{stats.requests_today}</div>
              <div className="metric-label">Запросы сегодня</div>
            </div>
            <div className="metric">
              <div className="metric-value">{stats.active_tokens}</div>
              <div className="metric-label">Активные токены</div>
            </div>
          </div>

          <h2 className="section-title">
            Активность в реальном времени
            <span style={{ marginLeft: 8, fontSize: 10, color: sseStatus === 'connected' ? 'var(--success)' : sseStatus === 'connecting' ? 'var(--warning)' : 'var(--error)' }}>
              {sseStatus === 'connected' ? '● подключено' : sseStatus === 'connecting' ? '● подключаемся…' : '● отключено'}
            </span>
          </h2>

          <div className="feed">
            {events.length === 0 ? (
              <div className="feed-empty">
                {sseStatus === 'connected' ? 'Запросов пока нет. Они появятся после подключения агентов.' : 'Подключаемся…'}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Агент</th>
                    <th>Операция</th>
                    <th>Права</th>
                    <th>Задержка</th>
                    <th>Статус</th>
                    <th>Время</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{e.agent}</td>
                      <td className="mono">{e.operation}</td>
                      <td>{e.scopes ? e.scopes.split(',').map(s => (
                        <span key={s} className={`badge badge-${s.trim()}`} style={{ marginRight: 4 }}>{s.trim()}</span>
                      )) : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                      <td className="mono">{e.latency_ms} ms</td>
                      <td><span className={`badge badge-${e.status}`}>{e.status}</span></td>
                      <td style={{ color: 'var(--text-secondary)' }}>{timeAgo(e.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div style={{ width: 220 }}>
          <h2 className="section-title">Состояние токенов</h2>
          <div className="health-panel">
            <div className="health-row">
              <span style={{ color: 'var(--warning)' }}>Скоро истекают</span>
              <span className="mono">{health.expiring_soon}</span>
            </div>
            <div className="health-row">
              <span style={{ color: 'var(--error)' }}>Доля ошибок</span>
              <span className="mono">{health.error_rate}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
