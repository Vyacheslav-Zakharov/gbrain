import React, { useEffect, useMemo, useState } from 'react';
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

interface ReviewForm {
  connector_id: string;
  source_object: string;
  table_name: string;
  target_source_id: string;
  slug_prefix: string;
  freshness_policy: string;
  sample_limit: number;
}

function val(x: unknown): string {
  return x === null || x === undefined || x === '' ? '—' : String(x);
}

function profileId(profile: unknown): string {
  return String((profile as Record<string, unknown> | null)?.profile_id ?? 'draft');
}

function statusBadge(status: unknown) {
  const s = String(status ?? 'unknown');
  const color = s === 'active' || s === 'reviewed' ? 'var(--success)' : s === 'draft' ? 'var(--warning)' : 'var(--text-muted)';
  return <span style={{ color }}>{s}</span>;
}

export function SourceIngestPage() {
  const [data, setData] = useState<SourceIngestOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<string>('');
  const [report, setReport] = useState<unknown>(null);
  const [discovery, setDiscovery] = useState<unknown>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [dryRun, setDryRun] = useState<unknown>(null);
  const [approveResult, setApproveResult] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<ReviewForm>({
    connector_id: 'appsheet-vehicles',
    source_object: 'vehicle',
    table_name: 'Автотранспорт',
    target_source_id: 'shared',
    slug_prefix: 'source-ingest/vehicles',
    freshness_policy: 'P30D',
    sample_limit: 25,
  });

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

  const appSheet = data?.connectors.find(c => c.id === 'appsheet-vehicles');
  const summary = data?.status.summary ?? {};
  const activeProfile = useMemo(() => (draft as Record<string, unknown> | null)?.profile ?? null, [draft]);
  const canDryRun = Boolean(activeProfile);
  const canApprove = Boolean(activeProfile && dryRun && !(dryRun as Record<string, unknown>).error);

  const runStep = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setErr(null);
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const payload = () => ({
    connector_id: form.connector_id,
    source_object: form.source_object,
    target_source_id: form.target_source_id,
    slug_prefix: form.slug_prefix,
    freshness_policy: form.freshness_policy,
    sample_limit: form.sample_limit,
    // Table name is intentionally UI-visible config, not a credential. The current
    // connector reads its default from server env/config; persistence lands in the
    // next slice once connector config storage exists.
    table_name: form.table_name,
  });

  const refreshReport = async () => runStep('refresh-report', async () => {
    const out = await api.sourceIngestRefreshReport(selectedProfile || undefined);
    setReport(out);
    await load();
  });

  const discover = async () => runStep('discover', async () => {
    setDiscovery(await api.sourceIngestDiscover(payload()));
  });

  const draftProfile = async () => runStep('draft', async () => {
    const out = await api.sourceIngestDraft(payload());
    setDraft(out);
    setDryRun(null);
    setApproveResult(null);
  });

  const runDryRun = async () => runStep('dry-run', async () => {
    if (!activeProfile) return;
    setDryRun(await api.sourceIngestDryRun({ profile: activeProfile, sample_limit: form.sample_limit }));
  });

  const approveProfile = async () => runStep('approve', async () => {
    if (!activeProfile) return;
    const out = await api.sourceIngestApproveProfile({
      profile: activeProfile,
      approved_source_id: form.target_source_id,
      change_note: `approved AppSheet vehicle profile from admin UI (${form.slug_prefix})`,
    });
    setApproveResult(out);
    await load();
  });

  if (err && !data) return <div style={{ color: 'var(--error)' }}><h1>Source Ingest</h1><pre>{err}</pre></div>;
  if (!data) return <div style={{ color: 'var(--text-muted)' }}>Loading source ingest console…</div>;

  return (
    <div>
      <h1 className="page-title">Source Ingest</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 18 }}>
        Review workflow: configure → discover → draft profile → dry-run preview → approve. Import/refresh remains separate and guarded.
      </p>
      {err && <div style={{ color: 'var(--error)', marginBottom: 12 }}><b>Error:</b> {err}</div>}

      <div className="metrics">
        <div className="metric"><div className="metric-value">{val(summary.rows ?? data.status.rows.length)}</div><div className="metric-label">sync rows</div></div>
        <div className="metric"><div className="metric-value">{val(summary.fresh ?? 0)}</div><div className="metric-label">fresh</div></div>
        <div className="metric"><div className="metric-value">{val(summary.stale ?? 0)}</div><div className="metric-label">stale</div></div>
        <div className="metric"><div className="metric-value">{data.refresh.count}</div><div className="metric-label">due profiles</div></div>
      </div>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">1. Configure connector: AppSheet автотранспорт</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <label>Connector
            <select value={form.connector_id} onChange={e => setForm({ ...form, connector_id: e.target.value })}>
              {data.connectors.map(c => <option key={c.id} value={c.id}>{c.displayName} ({c.id})</option>)}
            </select>
          </label>
          <label>Source object
            <input value={form.source_object} onChange={e => setForm({ ...form, source_object: e.target.value })} />
          </label>
          <label>AppSheet table name
            <input value={form.table_name} onChange={e => setForm({ ...form, table_name: e.target.value })} />
          </label>
          <label>Target GBrain source
            <select value={form.target_source_id} onChange={e => setForm({ ...form, target_source_id: e.target.value })}>
              {data.sources.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}
            </select>
          </label>
          <label>Slug prefix
            <input value={form.slug_prefix} onChange={e => setForm({ ...form, slug_prefix: e.target.value })} />
          </label>
          <label>Freshness policy
            <input value={form.freshness_policy} onChange={e => setForm({ ...form, freshness_policy: e.target.value })} />
          </label>
          <label>Sample limit
            <input type="number" min={1} max={200} value={form.sample_limit} onChange={e => setForm({ ...form, sample_limit: Number(e.target.value) || 25 })} />
          </label>
        </div>
        <div style={{ marginTop: 12, color: 'var(--text-secondary)' }}>
          Credentials are server-side only: {(appSheet?.requiredEnv ?? []).map(e => <code key={e} style={{ marginRight: 8 }}>{e}</code>)}
        </div>
        <ul style={{ marginTop: 10, paddingLeft: 18, color: 'var(--text-secondary)' }}>
          {(appSheet?.safety ?? []).map(s => <li key={s}>{s}</li>)}
        </ul>
      </section>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">2. Review workflow</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void discover()}>{busy === 'discover' ? 'Discovering…' : 'Discover'}</button>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void draftProfile()}>{busy === 'draft' ? 'Drafting…' : 'Draft profile'}</button>
          <button className="btn btn-secondary" disabled={busy !== null || !canDryRun} onClick={() => void runDryRun()}>{busy === 'dry-run' ? 'Running…' : 'Dry-run preview'}</button>
          <button className="btn btn-primary" disabled={busy !== null || !canApprove} onClick={() => void approveProfile()}>{busy === 'approve' ? 'Approving…' : 'Approve profile'}</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Discovery</h3>
            <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: 260, overflow: 'auto' }}>{discovery ? JSON.stringify(discovery, null, 2) : 'No discovery yet.'}</pre>
          </div>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Draft profile</h3>
            <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: 260, overflow: 'auto' }}>{draft ? JSON.stringify(draft, null, 2) : 'No draft yet.'}</pre>
          </div>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Dry-run</h3>
            <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: 260, overflow: 'auto' }}>{dryRun ? JSON.stringify(dryRun, null, 2) : 'No dry-run yet.'}</pre>
          </div>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Approval</h3>
            <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: 260, overflow: 'auto' }}>{approveResult ? JSON.stringify(approveResult, null, 2) : activeProfile ? `Ready: ${profileId(activeProfile)}` : 'Draft a profile first.'}</pre>
          </div>
        </div>
      </section>

      <section style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 18, marginBottom: 20 }}>
        <h2 className="section-title">3. Profiles / refresh</h2>
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)}>
            <option value="">All profiles</option>
            {data.profiles.rows.map(p => <option key={p.profile_id} value={p.profile_id}>{p.profile_id} · {p.status} · v{p.current_version}</option>)}
          </select>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void refreshReport()}>Report due refresh</button>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void load()}>Reload</button>
        </div>
        <table>
          <thead><tr><th>profile</th><th>external</th><th>freshness</th><th>result</th><th>slug</th><th>stale after</th></tr></thead>
          <tbody>
            {data.status.rows.map((r, i) => (
              <tr key={i}>
                <td className="mono">{val(r.profile_id)}</td>
                <td className="mono">{val(r.external_id)}</td>
                <td>{statusBadge(r.freshness)}</td>
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
