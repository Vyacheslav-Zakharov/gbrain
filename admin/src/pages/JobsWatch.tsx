import React, { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * v0.41 D2 — live jobs dashboard. Browser counterpart to the TTY
 * `gbrain jobs watch` command. Polls `/admin/api/jobs/watch` every
 * 1s (matches TTY refresh cadence; SSE upgrade is a v0.42 follow-up
 * once the same wiring lands in serve-http for the TTY command).
 *
 * Layout intentionally matches the TTY 1:1 so an operator looking at
 * both surfaces sees the same panels in the same order.
 */

interface WatchSnapshot {
  ts_ms: number;
  by_type: Array<{ name: string; total: number; completed: number; failed: number; dead: number }>;
  queue_health: { waiting: number; active: number; stalled: number };
  lease_pressure_1h: number;
  top_errors: Array<{ cluster: string; count: number }>;
  budget_owners: Array<{ owner_id: number; remaining_cents: number; total_spent_cents: number }>;
}

function leasePressureColor(n: number): string {
  if (n === 0) return 'var(--accent-success, #2ea043)';
  if (n >= 100) return 'var(--accent-danger, #f85149)';
  return 'var(--accent-warn, #d29922)';
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function JobsWatchPage() {
  const [snap, setSnap] = useState<WatchSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await api.jobsWatch();
        if (alive) {
          setSnap(data);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = setTimeout(tick, 1000);
    };

    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [retryKey]);

  if (err) {
    return (
      <div className="page-error" style={{ margin: 24 }} role="alert">
        <strong>Не удалось загрузить состояние заданий</strong>
        <span>{err}</span>
        <button className="btn btn-secondary" onClick={() => { setErr(null); setSnap(null); setRetryKey(value => value + 1); }}>Повторить</button>
      </div>
    );
  }

  if (!snap) {
    return <div className="page-loading" style={{ padding: 24 }} aria-busy="true"><span className="loading-spinner" />Загружаем состояние заданий…</div>;
  }

  const ts = new Date(snap.ts_ms).toLocaleTimeString();

  return (
    <div style={{ padding: 24, fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)' }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>
        Задания
        <span style={{ marginLeft: 12, color: 'var(--text-muted, #777)', fontSize: 12, fontWeight: 'normal' }}>
          обновлено {ts}
        </span>
      </h1>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>Очередь</h2>
        <div>
          ожидают=<b>{snap.queue_health.waiting}</b>{'  '}
          активны=<b>{snap.queue_health.active}</b>{'  '}
          зависли=<b style={{ color: snap.queue_health.stalled > 0 ? 'var(--accent-warn, #d29922)' : undefined }}>
            {snap.queue_health.stalled}
          </b>
        </div>
      </section>

      {snap.by_type.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>По типам за 24 часа</h2>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted, #777)', fontSize: 12 }}>
                <th style={{ textAlign: 'left', padding: '4px 12px 4px 0' }}>name</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>total</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>done</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>fail</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>dead</th>
              </tr>
            </thead>
            <tbody>
              {snap.by_type.slice(0, 6).map(t => (
                <tr key={t.name}>
                  <td style={{ padding: '4px 12px 4px 0' }}>{t.name}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{t.total}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{t.completed}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{t.failed}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{t.dead}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>Нагрузка lease за час</h2>
        <div style={{ color: leasePressureColor(snap.lease_pressure_1h) }}>
          {snap.lease_pressure_1h} повторных назначений
        </div>
      </section>

      {snap.top_errors.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>Частые ошибки за 24 часа</h2>
          <table style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {snap.top_errors.slice(0, 5).map(e => (
                <tr key={e.cluster}>
                  <td style={{ textAlign: 'right', padding: '4px 12px 4px 0', color: 'var(--text-muted, #777)' }}>
                    {e.count}×
                  </td>
                  <td style={{ padding: '4px 12px 4px 0' }}>{e.cluster}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {snap.budget_owners.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>Бюджеты владельцев</h2>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted, #777)', fontSize: 12 }}>
                <th style={{ textAlign: 'left', padding: '4px 12px 4px 0' }}>owner</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>spent</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>remaining</th>
              </tr>
            </thead>
            <tbody>
              {snap.budget_owners.slice(0, 5).map(b => (
                <tr key={b.owner_id}>
                  <td style={{ padding: '4px 12px 4px 0' }}>{b.owner_id}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{dollars(b.total_spent_cents)}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{dollars(b.remaining_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
