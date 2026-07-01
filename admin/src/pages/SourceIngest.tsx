import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

interface SourceIngestOverview {
  connectors: Array<{
    id: string;
    displayName: string;
    object: string;
    supportsChangedSince: boolean;
    credentialMode: string;
    requiredKeys?: string[];
    requiredEnv?: string[];
    fields?: Array<{ key: string; label: string; defaultValue: string }>;
    safety?: string[];
  }>;
  profiles: { rows: Array<{ profile_id: string; status: string; current_version: number; profile_json: unknown }>; count: number };
  status: { rows: Array<Record<string, unknown>>; summary?: Record<string, unknown> };
  refresh: { count: number; due?: Array<Record<string, unknown>> };
  connector_configs?: { rows: Array<Record<string, unknown>>; count: number };
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

function asObj(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? x as Record<string, unknown> : {};
}

function asArr<T = unknown>(x: unknown): T[] {
  return Array.isArray(x) ? x as T[] : [];
}

function PreviewJson({ value, empty }: { value: unknown; empty: string }) {
  return <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: 260, overflow: 'auto' }}>{value ? JSON.stringify(value, null, 2) : empty}</pre>;
}

function DiscoveryPreview({ value }: { value: unknown }) {
  const d = asObj(value);
  if (!value) return <div style={{ color: 'var(--text-muted)' }}>No discovery yet.</div>;
  const fields = asArr<Record<string, unknown>>(d.fields);
  return <div style={{ color: 'var(--text-secondary)' }}>
    <div style={{ marginBottom: 8 }}><b>{val(d.connectorId)}</b> / {val(d.objectName)} · sampled {val(d.sampled)} · fields {fields.length}</div>
    <div style={{ marginBottom: 8 }}>IDs: {asArr(d.idCandidates).map(String).join(', ') || '—'} · Updated: {asArr(d.updatedAtCandidates).map(String).join(', ') || '—'}</div>
    {asArr(d.warnings).length > 0 && <div style={{ color: 'var(--warning)', marginBottom: 8 }}>Warnings: {asArr(d.warnings).map(String).join(', ')}</div>}
    <table><thead><tr><th>field</th><th>types</th><th>null</th><th>samples</th></tr></thead><tbody>
      {fields.slice(0, 12).map((f, i) => <tr key={i}><td className="mono">{val(f.name)}</td><td>{asArr(f.observedTypes).join(', ')}</td><td>{typeof f.nullRatio === 'number' ? `${Math.round(f.nullRatio * 100)}%` : '—'}</td><td className="mono">{asArr(f.samples).slice(0, 3).map(val).join(' · ')}</td></tr>)}
    </tbody></table>
  </div>;
}

function DryRunPreview({ value }: { value: unknown }) {
  const d = asObj(value);
  if (!value) return <div style={{ color: 'var(--text-muted)' }}>No dry-run yet.</div>;
  const counts = asObj(d.counts);
  const samplePages = asArr<Record<string, unknown>>(d.sample_pages);
  const warnings = asArr(d.warnings);
  return <div style={{ color: 'var(--text-secondary)' }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(90px, 1fr))', gap: 8, marginBottom: 10 }}>
      {['sampled', 'would_write', 'skipped', 'slug_collisions'].map(k => <div className="metric" key={k}><div className="metric-value">{val(counts[k])}</div><div className="metric-label">{k}</div></div>)}
    </div>
    {warnings.length > 0 && <div style={{ color: 'var(--warning)', marginBottom: 8 }}>Warnings: {warnings.map(String).join(', ')}</div>}
    <table><thead><tr><th>slug</th><th>title</th><th>external</th></tr></thead><tbody>
      {samplePages.map((p, i) => <tr key={i}><td className="mono">{val(p.slug)}</td><td>{val(p.title)}</td><td className="mono">{val(p.external_id)}</td></tr>)}
    </tbody></table>
    {samplePages[0]?.managed_block_preview && <details style={{ marginTop: 8 }}><summary>First managed block preview</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{String(samplePages[0].managed_block_preview)}</pre></details>}
  </div>;
}

export function SourceIngestPage() {
  const [data, setData] = useState<SourceIngestOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<string>('');
  const [report, setReport] = useState<unknown>(null);
  const [discovery, setDiscovery] = useState<unknown>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [dryRun, setDryRun] = useState<unknown>(null);
  const [dryRunSourceId, setDryRunSourceId] = useState<string | null>(null);
  const [approveResult, setApproveResult] = useState<unknown>(null);
  const [connectionTest, setConnectionTest] = useState<unknown>(null);
  const [secretAudit, setSecretAudit] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secretForm, setSecretForm] = useState({ app_id: '', access_key: '' });
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
  const savedConfig = data?.connector_configs?.rows?.find(c => c.connector_id === form.connector_id && c.source_object === form.source_object);
  const configId = `${form.connector_id}:${form.source_object}`;
  const secretStatus = (savedConfig?.secrets as Record<string, unknown> | undefined)
    || { configured: false, missing_keys: appSheet?.requiredKeys ?? [], required_keys: appSheet?.requiredKeys ?? [], missing_env: appSheet?.requiredEnv ?? [], required_env: appSheet?.requiredEnv ?? [], masked: {}, storage: 'none' };
  const summary = data?.status.summary ?? {};
  const activeProfile = useMemo(() => (draft as Record<string, unknown> | null)?.profile ?? null, [draft]);
  const canDryRun = Boolean(activeProfile);
  const dryRunMatchesCurrentSource = Boolean(dryRun && dryRunSourceId === form.target_source_id);
  const dryRunSourceMismatch = Boolean(dryRun && dryRunSourceId && dryRunSourceId !== form.target_source_id);
  const canApprove = Boolean(activeProfile && dryRun && dryRunMatchesCurrentSource && !(dryRun as Record<string, unknown>).error);

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
    // Table name is non-secret UI config. It can be saved through
    // source_connector_configs; AppSheet credentials remain server-side only.
    table_name: form.table_name,
  });

  const configPayload = () => ({
    config_id: `${form.connector_id}:${form.source_object}`,
    connector_id: form.connector_id,
    source_object: form.source_object,
    display_name: form.connector_id === 'appsheet-vehicles' ? 'AppSheet автотранспорт' : form.connector_id,
    table_name: form.table_name,
    target_source_id: form.target_source_id,
    slug_prefix: form.slug_prefix,
    freshness_policy: form.freshness_policy,
    enabled: true,
    config_json: { table_name: form.table_name },
  });

  const applySavedConfig = () => {
    if (!savedConfig) return;
    setForm({
      ...form,
      table_name: String(savedConfig.table_name ?? form.table_name),
      target_source_id: String(savedConfig.target_source_id ?? form.target_source_id),
      slug_prefix: String(savedConfig.slug_prefix ?? form.slug_prefix),
      freshness_policy: String(savedConfig.freshness_policy ?? form.freshness_policy),
    });
  };

  const saveConfig = async () => runStep('save-config', async () => {
    await api.sourceIngestSaveConfig(configPayload());
    await load();
  });

  const rotateSecret = async () => runStep('save-secret', async () => {
    await api.sourceIngestSaveConfig(configPayload());
    await api.sourceIngestSaveSecret({
      config_id: configId,
      connector_id: form.connector_id,
      source_object: form.source_object,
      secrets: secretForm,
    });
    setSecretForm({ app_id: '', access_key: '' });
    await load();
    setConnectionTest(await api.sourceIngestTestConnection(payload()));
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const deleteSecret = async () => runStep('delete-secret', async () => {
    await api.sourceIngestDeleteSecret({ config_id: configId, connector_id: form.connector_id, source_object: form.source_object });
    await load();
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const loadSecretAudit = async () => runStep('secret-audit', async () => {
    setSecretAudit(await api.sourceIngestSecretAudit(configId));
  });

  const testConnection = async () => runStep('test-connection', async () => {
    setConnectionTest(await api.sourceIngestTestConnection(payload()));
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
    setDryRunSourceId(null);
    setApproveResult(null);
  });

  const runDryRun = async () => runStep('dry-run', async () => {
    if (!activeProfile) return;
    setDryRun(await api.sourceIngestDryRun({ profile: activeProfile, sample_limit: form.sample_limit, target_source_id: form.target_source_id }));
    setDryRunSourceId(form.target_source_id);
  });

  const approveProfile = async () => runStep('approve', async () => {
    if (!activeProfile) return;
    if (dryRunSourceId !== form.target_source_id) {
      throw new Error(`dry_run_source_mismatch: dry-run was for ${dryRunSourceId ?? 'none'}, current target is ${form.target_source_id}. Run dry-run preview again before approving.`);
    }
    const out = await api.sourceIngestApproveProfile({
      profile: activeProfile,
      approved_source_id: form.target_source_id,
      dry_run_target_source_id: dryRunSourceId,
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
          Credential storage: <b>{val(secretStatus.storage)}</b>
          <span style={{ marginLeft: 8, color: secretStatus.configured ? 'var(--success)' : 'var(--warning)' }}>
            {secretStatus.configured ? 'configured' : `missing: ${((secretStatus.missing_keys as string[]) ?? []).join(', ') || 'unknown'}`}
          </span>
          <div style={{ marginTop: 6 }}>
            Masked: {Object.entries(asObj(secretStatus.masked)).map(([k, v]) => <span key={k} style={{ marginRight: 10 }}><code>{k}</code> {String(v)}</span>)}
            {Object.keys(asObj(secretStatus.masked)).length === 0 && '—'}
          </div>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            Updated: {val(secretStatus.updated_by)} · {val(secretStatus.updated_at)}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 12 }}>
          <label>App ID
            <input type="password" autoComplete="off" value={secretForm.app_id} onChange={e => setSecretForm({ ...secretForm, app_id: e.target.value })} placeholder="saved separately; never shown back" />
          </label>
          <label>Access Key
            <input type="password" autoComplete="off" value={secretForm.access_key} onChange={e => setSecretForm({ ...secretForm, access_key: e.target.value })} placeholder="saved separately; never shown back" />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn btn-secondary" disabled={busy !== null || !secretForm.app_id || !secretForm.access_key} onClick={() => void rotateSecret()}>{busy === 'save-secret' ? 'Saving secret…' : 'Rotate/save secret + test'}</button>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void deleteSecret()}>{busy === 'delete-secret' ? 'Deleting…' : 'Delete secret'}</button>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void loadSecretAudit()}>{busy === 'secret-audit' ? 'Loading audit…' : 'Audit'}</button>
        </div>
        {secretAudit !== null && <details open style={{ marginTop: 10 }}><summary>Secret audit</summary><PreviewJson value={secretAudit} empty="No audit." /></details>}
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void saveConfig()}>{busy === 'save-config' ? 'Saving…' : 'Save config'}</button>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void testConnection()}>{busy === 'test-connection' ? 'Testing…' : 'Test connection'}</button>
          <button className="btn btn-secondary" disabled={busy !== null || !savedConfig} onClick={applySavedConfig}>Load saved config</button>
          <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>
            saved: {savedConfig ? `${savedConfig.config_id} · ${savedConfig.enabled ? 'enabled' : 'disabled'}` : 'none'}
          </span>
        </div>
        {connectionTest !== null && (() => {
          const t = asObj(connectionTest);
          const ok = t.ok === true;
          return <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: ok ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)', color: ok ? 'var(--success)' : 'var(--warning)' }}>
            <b>{ok ? 'connection ok' : 'connection failed'}</b>
            <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>
              {ok
                ? `sampled ${val(t.sampled)} · fields ${val(t.fields_count)} · ${val(t.elapsed_ms)} ms`
                : val(t.error)}
            </span>
          </div>;
        })()}
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
          {dryRunSourceMismatch && <span style={{ color: 'var(--warning)', alignSelf: 'center' }}>Target source changed from dry-run ({dryRunSourceId}) to {form.target_source_id}; run dry-run preview again.</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Discovery</h3>
            <DiscoveryPreview value={discovery} />
          </div>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Draft profile</h3>
            <PreviewJson value={draft} empty="No draft yet." />
          </div>
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Dry-run</h3>
            <DryRunPreview value={dryRun} />
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
