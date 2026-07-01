import React, { useEffect, useState } from 'react';
import { api } from '../api';

interface SourceIngestOverview {
  connectors: Array<{
    id: string;
    displayName: string;
    object: string;
    supportsChangedSince: boolean;
    credentialMode: string;
    requiredEnv?: string[];
    fields?: Array<{ key: string; label: string; defaultValue: string }>;
    safety?: string[];
  }>;
  profiles: { rows: Array<{ profile_id: string; status: string; current_version: number; profile_json: unknown }>; count: number };
  status: { rows: Array<Record<string, unknown>>; summary?: Record<string, unknown> };
  refresh: { count: number; due?: Array<Record<string, unknown>> };
  sources: Array<{ id: string; name: string; path?: string; federated?: boolean }>;
}

function val(x: unknown): string {
  return x === null || x === undefined || x === '' ? '—' : String(x);
}

export function SourceIngestPage() {
  const [data, setData] = useState<SourceIngestOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<string>('');
  const [report, setReport] = useState<unknown>(null);

  const load = async () => {
    try {
      const out = await api.sourceIngestOverview();
      setData(out);
      setErr(null);
      const firstProfile = out?.profiles?.rows?.[0]?.profile_id;
      if (!selectedProfile && firstProfile) setSelectedProfile(firstProfile);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { void load(); }, []);

  const refreshReport = async () => {
    const out = await api.sourceIngestRefreshReport(selectedProfile || undefined);
    setReport(out);
    await load();
  };

  if (err) return <div style={{ color: 'var(--error)' }}><h1>Source Ingest</h1><pre>{err}</pre></div>;
  if (!data) return <div style={{ color: 'var(--text-muted)' }}>Loading source ingest console…</div>;

  const appSheet = data.connectors.find(c => c.id === 'appsheet-vehicles');
  const summary = data.status.summary ?? {};

  return (
    <div>
      <h1 className="page-title">Source Ingest</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 18 }}>
        Configure third-party connectors here; backend jobs only run after discovery, dry-run, review, and approval.
      </p>

      <div className="metrics">
        <div className="metric"><div className="metric-value">{val(summary.rows ?? data.status.rows.length)}</div><div className="metric-label">sync rows</div></div>
        <div className="metric"><div className="metric-value">{val(summary.fresh ?? 0)}</div><div className="metric-label">fresh</div></div>
        <div className="metric"><div className="metric-value">{val(summary.stale ?? 0)}</div><div className="metric-label">stale</div></div>
        <div className="metric"><div className="metric-value">{data.refresh.count}</div><div className="metric-label">due profiles</div></div>
      </div>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">Connector: AppSheet автотранспорт</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {(appSheet?.fields ?? []).map(f => (
            <label key={f.key}>{f.label}
              <input value={f.defaultValue} readOnly title="Editable persistence lands with the next UI slice" />
            </label>
          ))}
        </div>
        <div style={{ marginTop: 12, color: 'var(--text-secondary)' }}>
          Credentials are server-side only: {(appSheet?.requiredEnv ?? []).map(e => <code key={e} style={{ marginRight: 8 }}>{e}</code>)}
        </div>
        <ul style={{ marginTop: 10, paddingLeft: 18, color: 'var(--text-secondary)' }}>
          {(appSheet?.safety ?? []).map(s => <li key={s}>{s}</li>)}
        </ul>
      </section>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">Profiles / refresh</h2>
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)}>
            <option value="">All profiles</option>
            {data.profiles.rows.map(p => <option key={p.profile_id} value={p.profile_id}>{p.profile_id} · {p.status} · v{p.current_version}</option>)}
          </select>
          <button className="btn btn-secondary" onClick={() => void refreshReport()}>Report due refresh</button>
          <button className="btn btn-secondary" onClick={() => void load()}>Reload</button>
        </div>
        <table>
          <thead><tr><th>profile</th><th>external</th><th>freshness</th><th>result</th><th>slug</th><th>stale after</th></tr></thead>
          <tbody>
            {data.status.rows.map((r, i) => (
              <tr key={i}>
                <td className="mono">{val(r.profile_id)}</td>
                <td className="mono">{val(r.external_id)}</td>
                <td>{val(r.freshness)}</td>
                <td>{val(r.last_result)}</td>
                <td className="mono">{val(r.slug)}</td>
                <td className="mono">{val(r.stale_after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {report !== null && (
        <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18 }}>
          <h2 className="section-title">Last report-only refresh plan</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{JSON.stringify(report, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
