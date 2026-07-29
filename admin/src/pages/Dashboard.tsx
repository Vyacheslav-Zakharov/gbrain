import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';

interface FeedEvent {
  agent: string;
  operation: string;
  scopes: string;
  latency_ms: number;
  status: string;
  timestamp: string;
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

    const es = new EventSource('/admin/events');
    eventSourceRef.current = es;
    es.onopen = () => setSseStatus('connected');
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as FeedEvent;
        setEvents(prev => [event, ...prev].slice(0, 50));
      } catch {}
    };
    es.onerror = () => {
      setSseStatus('disconnected');
      setTimeout(() => {
        setSseStatus('connecting');
        es.close();
        // Reconnect handled by browser EventSource auto-retry
      }, 3000);
    };

    const interval = setInterval(() => {
      api.stats().then(setStats).catch(() => {});
      api.health().then(setHealth).catch(() => {});
    }, 30000);

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
                      <td>{e.scopes.split(',').map(s => (
                        <span key={s} className={`badge badge-${s.trim()}`} style={{ marginRight: 4 }}>{s.trim()}</span>
                      ))}</td>
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
