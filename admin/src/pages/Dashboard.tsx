import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { describeFeedError, feedEventKey, formatSafeParams, mergeEvents, type FeedEvent } from '../event-merge';

interface RequestLogRow {
  id: number;
  agent_name: string;
  token_name: string;
  operation: string;
  latency_ms: number;
  status: string;
  params: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
}

function diagnosticText(event: FeedEvent): string {
  const diagnostic = describeFeedError(event);
  return [
    `Ошибка: ${diagnostic.title}`,
    'Технический текст ошибки не включён, чтобы не копировать значения параметров и локальные пути.',
    `Что делать: ${diagnostic.nextAction}`,
    `Код: ${diagnostic.code}`,
    `Операция: ${event.operation}`,
    `Агент: ${event.agent}`,
    `Время: ${new Date(event.timestamp).toLocaleString('ru-RU')}`,
    `Задержка: ${event.latency_ms} мс`,
    `Идентификатор запроса: ${event.id ?? 'ещё не присвоен'}`,
    `Безопасные параметры: ${formatSafeParams(event.params)}`,
  ].join('\n');
}

export function DashboardPage() {
  const [stats, setStats] = useState({ connected_agents: 0, requests_today: 0, active_tokens: 0 });
  const [health, setHealth] = useState({ expiring_soon: 0, error_rate: '0%' });
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [copiedEvent, setCopiedEvent] = useState<string | null>(null);
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
          params: row.params,
          error_message: row.error_message,
          timestamp: row.created_at,
        }));
        setEvents(current => mergeEvents(current, recent));
      })
      .catch(() => {});
    void loadRecent();

    const es = new EventSource('/admin/events', { withCredentials: true });
    eventSourceRef.current = es;
    es.onopen = () => setSseStatus('connected');
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as FeedEvent;
        const keyedEvent = event.id == null && !event.ui_key
          ? { ...event, ui_key: `sse-${crypto.randomUUID()}` }
          : event;
        setEvents(prev => mergeEvents(prev, [keyedEvent]));
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

  const copyDiagnostics = async (event: FeedEvent) => {
    const key = feedEventKey(event);
    try {
      await navigator.clipboard.writeText(diagnosticText(event));
      setCopiedEvent(key);
      window.setTimeout(() => setCopiedEvent(current => current === key ? null : current), 2000);
    } catch {
      setCopiedEvent(null);
    }
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
                  {events.map(e => {
                    const key = feedEventKey(e);
                    const isError = e.status === 'error';
                    const diagnostic = isError ? describeFeedError(e) : null;
                    const isExpanded = isError && expandedEvent === key;
                    const detailId = `request-error-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
                    return <React.Fragment key={key}>
                      <tr
                        className={isError ? 'feed-row feed-row-error' : 'feed-row'}
                        onClick={isError ? () => setExpandedEvent(isExpanded ? null : key) : undefined}
                      >
                        <td className="mono">{e.agent}</td>
                        <td className="mono">{e.operation}</td>
                        <td>{e.scopes ? e.scopes.split(',').map(s => (
                          <span key={s} className={`badge badge-${s.trim()}`} style={{ marginRight: 4 }}>{s.trim()}</span>
                        )) : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        <td className="mono">{e.latency_ms} ms</td>
                        <td>
                          {isError ? (
                            <button
                              type="button"
                              className={`badge badge-${e.status} feed-error-toggle`}
                              title={diagnostic?.title}
                              aria-expanded={isExpanded}
                              aria-controls={detailId}
                              onClick={event => {
                                event.stopPropagation();
                                setExpandedEvent(isExpanded ? null : key);
                              }}
                            >
                              {e.status}{isExpanded ? ' ▲' : ' ▼'}
                            </button>
                          ) : (
                            <span className={`badge badge-${e.status}`}>{e.status}</span>
                          )}
                        </td>
                        <td style={{ color: 'var(--text-secondary)' }}>{timeAgo(e.timestamp)}</td>
                      </tr>
                      {isExpanded && diagnostic && <tr className="feed-error-detail-row">
                        <td colSpan={6}>
                          <section id={detailId} className="feed-error-detail" aria-label={`Диагностика ошибки ${e.operation}`}>
                            <div className="feed-error-detail-header">
                              <div>
                                <strong>{diagnostic.title}</strong>
                                <div className="feed-error-reason">{diagnostic.reason}</div>
                              </div>
                              <button type="button" className="btn btn-secondary" onClick={event => { event.stopPropagation(); void copyDiagnostics(e); }}>
                                {copiedEvent === key ? 'Скопировано' : 'Скопировать диагностику'}
                              </button>
                            </div>
                            <dl className="feed-error-grid">
                              <dt>Что делать</dt><dd>{diagnostic.nextAction}</dd>
                              <dt>Код</dt><dd className="mono">{diagnostic.code}</dd>
                              <dt>Безопасные параметры</dt><dd>{formatSafeParams(e.params)}</dd>
                              <dt>Идентификатор запроса</dt><dd className="mono">{e.id ?? 'ещё не присвоен'}</dd>
                              <dt>Время</dt><dd>{new Date(e.timestamp).toLocaleString('ru-RU')}</dd>
                              <dt>Агент</dt><dd className="mono">{e.agent}</dd>
                            </dl>
                            <div className="feed-error-privacy">Значения параметров скрыты; показаны только названия полей и размер запроса.</div>
                          </section>
                        </td>
                      </tr>}
                    </React.Fragment>;
                  })}
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
