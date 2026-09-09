import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

type Period = '24h' | 'yesterday' | '7d' | '30d' | '365d' | 'custom';

interface ActivityPhase {
  phase: string;
  status: string;
  duration_ms: number;
  summary: string;
  details: Record<string, string | number | boolean>;
  has_error: boolean;
  error_code?: string;
  pages_affected_count: number;
}

interface ActivityRun {
  id: number;
  name: string;
  status: string;
  source_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  partial: boolean;
  has_error: boolean;
  phases: ActivityPhase[];
}

interface ActivitySnapshot {
  schema_version: 1;
  generated_at: string;
  range: { period: Period | 'custom'; since: string; until: string };
  summary: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    dead: number;
    cancelled: number;
    active: number;
    waiting: number;
    delayed: number;
    waiting_children: number;
    paused: number;
    duration_ms: number;
    estimated_spend_usd: number;
    pages_changed: number;
    atoms_extracted: number;
    concepts_written: number;
    proposals_inserted: number;
    takes_written: number;
    facts_inserted: number;
  };
  phase_rollup: Array<{ phase: string; status: string; runs: number; duration_ms: number; estimated_spend_usd: number }>;
  by_type: Array<{ name: string; total: number; completed: number; failed: number; partial: number }>;
  by_source: Array<{ source_id: string; total: number; completed: number; failed: number; partial: number }>;
  runs: ActivityRun[];
  statuses: string[];
  pagination: { limit: number; offset: number; returned: number; total: number; export_truncated: boolean };
}

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: '24h', label: '24 часа' },
  { value: 'yesterday', label: 'Вчера' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: '365d', label: 'Год' },
  { value: 'custom', label: 'Период' },
];

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function customRangeIso(since: string, until: string): { since: string; until: string } | null {
  if (!since || !until) return null;
  const sinceDate = new Date(`${since}T00:00:00`);
  const untilDate = new Date(`${until}T00:00:00`);
  untilDate.setDate(untilDate.getDate() + 1);
  if (!Number.isFinite(sinceDate.getTime()) || !Number.isFinite(untilDate.getTime()) || sinceDate >= untilDate) return null;
  return { since: sinceDate.toISOString(), until: untilDate.toISOString() };
}

function displayRangeEnd(range: ActivitySnapshot['range']): Date {
  const until = new Date(range.until);
  if (range.period === 'custom' || range.period === 'yesterday') until.setTime(until.getTime() - 1);
  return until;
}

const panel: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--bg-secondary, rgba(255,255,255,.02))',
};

function formatDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} мин ${rest} с`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function statusColor(status: string, partial = false): string {
  if (partial || status === 'partial' || status === 'warn') return 'var(--warning, #d29922)';
  if (status === 'completed' || status === 'ok' || status === 'clean') return 'var(--success, #3fb950)';
  if (status === 'failed' || status === 'dead' || status === 'fail') return 'var(--error, #f85149)';
  if (status === 'active') return 'var(--accent, #58a6ff)';
  return 'var(--text-muted, #8b949e)';
}

const STATUS_LABELS: Record<string, string> = {
  waiting: 'ожидает', active: 'выполняется', completed: 'завершено', failed: 'ошибка',
  delayed: 'отложено', dead: 'остановлено', cancelled: 'отменено',
  'waiting-children': 'ожидает подзадачи', waiting_children: 'ожидает подзадачи',
  paused: 'приостановлено', partial: 'частично', warn: 'предупреждение',
  ok: 'успешно', clean: 'без ошибок', fail: 'ошибка', skip: 'пропущено',
};

function statusLabel(status: string, partial = false): string {
  return partial ? STATUS_LABELS.partial : (STATUS_LABELS[status] ?? status);
}

function StatusBadge({ status, partial = false }: { status: string; partial?: boolean }) {
  const label = statusLabel(status, partial);
  return <span style={{
    border: `1px solid ${statusColor(status, partial)}`,
    color: statusColor(status, partial),
    borderRadius: 999,
    padding: '2px 8px',
    fontSize: 11,
    whiteSpace: 'nowrap',
  }}>{label}</span>;
}

function MetricCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div style={{ ...panel, padding: 14, minWidth: 130 }}>
    <div style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
    <div style={{ fontSize: 23, fontWeight: 650, marginTop: 5 }}>{value}</div>
    {hint && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>{hint}</div>}
  </div>;
}

function DetailValue({ value }: { value: unknown }) {
  if (value == null) return <>—</>;
  if (Array.isArray(value)) return <>{value.slice(0, 8).map(String).join(', ')}</>;
  if (typeof value === 'object') return <code>{JSON.stringify(value)}</code>;
  return <>{String(value)}</>;
}

function RunDetails({ run, id }: { run: ActivityRun; id: string }) {
  if (run.phases.length === 0) {
    return <div id={id} style={{ color: 'var(--text-muted)', padding: 14 }}>У этого задания нет структурированного отчёта по фазам.</div>;
  }
  return <div id={id} style={{ padding: '4px 14px 14px' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead><tr style={{ color: 'var(--text-muted)' }}>
        <th style={{ textAlign: 'left', padding: '8px 6px' }}>Фаза</th>
        <th style={{ textAlign: 'left', padding: '8px 6px' }}>Статус</th>
        <th style={{ textAlign: 'right', padding: '8px 6px' }}>Время</th>
        <th style={{ textAlign: 'left', padding: '8px 6px' }}>Результат</th>
      </tr></thead>
      <tbody>{run.phases.map((phase, index) => <React.Fragment key={`${phase.phase}-${index}`}>
        <tr style={{ borderTop: '1px solid var(--border)' }}>
          <td style={{ padding: '9px 6px', fontFamily: 'var(--font-mono)' }}>{phase.phase}</td>
          <td style={{ padding: '9px 6px' }}><StatusBadge status={phase.status} /></td>
          <td style={{ padding: '9px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>{formatDuration(phase.duration_ms)}</td>
          <td style={{ padding: '9px 6px' }}>{phase.summary || '—'}</td>
        </tr>
        {(Object.keys(phase.details).length > 0 || phase.pages_affected_count > 0 || phase.has_error) && <tr>
          <td colSpan={4} style={{ padding: '0 6px 10px 18px', color: 'var(--text-secondary)', fontSize: 11 }}>
            <details>
              <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>Безопасные метрики</summary>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, marginTop: 8 }}>
                {Object.entries(phase.details).slice(0, 24).map(([key, value]) => <div key={key}>
                  <span style={{ color: 'var(--text-muted)' }}>{key}: </span><DetailValue value={value} />
                </div>)}
              </div>
              {phase.pages_affected_count > 0 && <div style={{ marginTop: 8 }}>
                <span style={{ color: 'var(--text-muted)' }}>Затронуто страниц: </span>{phase.pages_affected_count}
              </div>}
              {phase.has_error && <div style={{ marginTop: 8, color: 'var(--error)' }}>
                Ошибка зафиксирована{phase.error_code ? ` · код=${phase.error_code}` : ''}; текст скрыт политикой безопасности
              </div>}
            </details>
          </td>
        </tr>}
      </React.Fragment>)}</tbody>
    </table>
    {run.has_error && <div style={{ color: 'var(--error)', margin: '10px 6px 0', fontSize: 12 }}>
      Ошибка задания зафиксирована; текст скрыт политикой безопасности
    </div>}
  </div>;
}

export function ActivityPage() {
  const initialUntil = new Date();
  const initialSince = new Date(initialUntil);
  initialSince.setDate(initialSince.getDate() - 7);
  const [period, setPeriod] = useState<Period>('24h');
  const [customSince, setCustomSince] = useState(localDateValue(initialSince));
  const [customUntil, setCustomUntil] = useState(localDateValue(initialUntil));
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const limit = 30;

  const requestFilters = () => {
    const range = period === 'custom' ? customRangeIso(customSince, customUntil) : null;
    if (period === 'custom' && !range) return null;
    return { ...(range ?? { period }), source, name, status };
  };

  useEffect(() => {
    let alive = true;
    const filters = requestFilters();
    if (!filters) {
      setError('Укажите корректный диапазон дат');
      setLoading(false);
      return () => { alive = false; };
    }
    setLoading(true);
    api.activityRuns({ ...filters, limit, offset })
      .then((data: ActivitySnapshot) => {
        if (!alive) return;
        setSnapshot(data);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [period, customSince, customUntil, source, name, status, offset, refreshKey]);

  const phaseTotals = useMemo(() => {
    if (!snapshot) return [];
    const map = new Map<string, { phase: string; runs: number; duration_ms: number; spend: number; warnings: number }>();
    for (const row of snapshot.phase_rollup) {
      const current = map.get(row.phase) ?? { phase: row.phase, runs: 0, duration_ms: 0, spend: 0, warnings: 0 };
      current.runs += row.runs;
      current.duration_ms += row.duration_ms;
      current.spend += row.estimated_spend_usd;
      if (!['ok', 'clean', 'completed'].includes(row.status)) current.warnings += row.runs;
      map.set(row.phase, current);
    }
    return [...map.values()].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 10);
  }, [snapshot]);

  const changePeriod = (value: Period) => {
    setPeriod(value);
    setOffset(0);
    setExpanded(null);
  };

  const exportJson = async () => {
    const filters = requestFilters();
    if (!snapshot || !filters) return;
    setExporting(true);
    try {
      const report = await api.activityRuns({ ...filters, export: true }) as ActivitySnapshot;
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gbrain-activity-${report.range.since.slice(0, 10)}-${report.range.until.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      if (report.pagination.export_truncated) {
        setError(`Экспорт ограничен первыми ${report.pagination.returned} запусками из ${report.pagination.total}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return <div className="activity-page" style={{ padding: 24, maxWidth: 1500, margin: '0 auto' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22 }}>Активность</h1>
        <p style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}>Что делали Autopilot и Minions за выбранный период</p>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary" onClick={() => setRefreshKey(v => v + 1)} disabled={loading}>Обновить</button>
        <button className="btn btn-secondary" onClick={exportJson} disabled={!snapshot || exporting}>{exporting ? 'Экспорт…' : 'Экспорт JSON'}</button>
      </div>
    </div>

    <div style={{ ...panel, padding: 12, marginTop: 18, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PERIODS.map(item => <button key={item.value} className={`btn ${period === item.value ? 'btn-primary' : 'btn-secondary'}`} onClick={() => changePeriod(item.value)}>{item.label}</button>)}
      </div>
      {period === 'custom' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%' }}>
        <label style={{ color: 'var(--text-muted)', fontSize: 12 }}>С <input type="date" value={customSince} onChange={e => { setCustomSince(e.target.value); setOffset(0); }} /></label>
        <label style={{ color: 'var(--text-muted)', fontSize: 12 }}>По <input type="date" value={customUntil} onChange={e => { setCustomUntil(e.target.value); setOffset(0); }} /></label>
      </div>}
      <select value={source} onChange={e => { setSource(e.target.value); setOffset(0); }} style={{ minWidth: 150 }}>
        <option value="">Все источники</option>
        {snapshot?.by_source.map(item => <option key={item.source_id} value={item.source_id}>{item.source_id} ({item.total})</option>)}
      </select>
      <select value={name} onChange={e => { setName(e.target.value); setOffset(0); }} style={{ minWidth: 180 }}>
        <option value="">Все типы заданий</option>
        {snapshot?.by_type.map(item => <option key={item.name} value={item.name}>{item.name} ({item.total})</option>)}
      </select>
      <select value={status} onChange={e => { setStatus(e.target.value); setOffset(0); }}>
        <option value="">Все статусы</option>
        {(snapshot?.statuses ?? []).map(v => <option key={v} value={v}>{statusLabel(v)}</option>)}
      </select>
      {snapshot && <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 12 }}>
        {new Date(snapshot.range.since).toLocaleDateString('ru-RU')} — {displayRangeEnd(snapshot.range).toLocaleDateString('ru-RU')}
      </span>}
    </div>

    {error && <div style={{ ...panel, borderColor: 'var(--error)', color: 'var(--error)', padding: 14, marginTop: 16 }}>{error}</div>}
    {loading && !snapshot && <div style={{ padding: 30, color: 'var(--text-muted)' }}>Загрузка истории…</div>}

    {snapshot && <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 10, marginTop: 16 }}>
        <MetricCard label="Запуски" value={snapshot.summary.total} hint={`${snapshot.summary.completed} завершено · ${snapshot.summary.active + snapshot.summary.waiting + snapshot.summary.delayed + snapshot.summary.waiting_children + snapshot.summary.paused} в очереди`} />
        <MetricCard label="Частичные" value={snapshot.summary.partial} hint={`${snapshot.summary.failed + snapshot.summary.dead} ошибок`} />
        <MetricCard label="Страницы" value={snapshot.summary.pages_changed} hint="зафиксированные изменения" />
        <MetricCard label="Атомы" value={snapshot.summary.atoms_extracted} />
        <MetricCard label="Концепции" value={snapshot.summary.concepts_written} />
        <MetricCard label="Предложения" value={snapshot.summary.proposals_inserted} />
        <MetricCard label="Тезисы" value={snapshot.summary.takes_written} />
        <MetricCard label="Расход LLM" value={`$${snapshot.summary.estimated_spend_usd.toFixed(3)}`} />
      </div>

      <div className="activity-content-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 14, marginTop: 16 }}>
        <section style={{ ...panel, overflow: 'hidden' }}>
          <div style={{ padding: '13px 14px', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>Запуски</div>
          {snapshot.runs.length === 0 && <div style={{ padding: 24, color: 'var(--text-muted)' }}>За этот период запусков не найдено.</div>}
          {snapshot.runs.map(run => <div key={run.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <button type="button" className="activity-run-row"
              aria-expanded={expanded === run.id}
              aria-controls={`activity-run-details-${run.id}`}
              onClick={() => setExpanded(expanded === run.id ? null : run.id)} style={{
              width: '100%', background: 'transparent', color: 'inherit', border: 0, padding: '12px 14px', cursor: 'pointer',
              display: 'grid', gridTemplateColumns: '82px minmax(150px, 1.5fr) minmax(100px, 1fr) 90px 80px 20px', gap: 10, alignItems: 'center', textAlign: 'left',
            }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{formatDate(run.created_at)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{run.name} <span style={{ color: 'var(--text-muted)' }}>#{run.id}</span></span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{run.source_id}</span>
              <StatusBadge status={run.status} partial={run.partial} />
              <span style={{ textAlign: 'right', fontSize: 12 }}>{formatDuration(run.duration_ms)}</span>
              <span aria-hidden="true">{expanded === run.id ? '⌃' : '⌄'}</span>
            </button>
            {expanded === run.id && <RunDetails run={run} id={`activity-run-details-${run.id}`} />}
          </div>)}
          <div style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button className="btn btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Назад</button>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {snapshot.pagination.total === 0 ? 0 : offset + 1}–{Math.min(offset + snapshot.pagination.returned, snapshot.pagination.total)} из {snapshot.pagination.total}
            </span>
            <button className="btn btn-secondary" disabled={offset + snapshot.pagination.returned >= snapshot.pagination.total} onClick={() => setOffset(offset + limit)}>Дальше</button>
          </div>
        </section>

        <section style={{ ...panel, alignSelf: 'start' }}>
          <div style={{ padding: '13px 14px', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>Самые дорогие фазы</div>
          <div style={{ padding: 14 }}>
            {phaseTotals.length === 0 && <span style={{ color: 'var(--text-muted)' }}>Нет отчётов по фазам</span>}
            {phaseTotals.map(item => <div key={item.phase} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <code>{item.phase}</code><strong>{formatDuration(item.duration_ms)}</strong>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>
                {item.runs} запусков · ${item.spend.toFixed(3)}{item.warnings ? ` · ${item.warnings} с предупреждением, пропуском или ошибкой` : ''}
              </div>
            </div>)}
          </div>
        </section>
      </div>
    </>}
  </div>;
}
