import { asArr, articleState, MiniBadge, shortHash, statusBadge, val } from './shared';

export function ArticleViewStatePanel({ row, previewHash }: { row: Record<string, unknown> | null; previewHash: string }) {
  if (!row) return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Select or save an Article view to see frozen snapshot, chain hash, and stale reasons.</div>;
  const state = articleState(row);
  const reasons = asArr(row.stale_reasons).map(String).filter(Boolean);
  const compiledAt = String(row.compiled_at ?? '');
  const currentHash = String(row.current_chain_hash ?? '');
  const previewMatchesFrozen = Boolean(previewHash && currentHash && previewHash === currentHash);
  return <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: row.stale === true ? 'rgba(245,158,11,0.08)' : 'rgba(15,23,42,0.34)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <b>Stale / chain state</b>
      <MiniBadge tone={state.tone}>{state.icon} {state.label}</MiniBadge>
      <MiniBadge tone={currentHash ? 'ok' : 'muted'}>frozen hash {shortHash(currentHash)}</MiniBadge>
      {previewHash && <MiniBadge tone={previewMatchesFrozen ? 'ok' : 'info'}>preview hash {shortHash(previewHash)}</MiniBadge>}
      {compiledAt && <MiniBadge tone="muted">compiled {compiledAt}</MiniBadge>}
    </div>
    {row.stale === true ? <div style={{ color: 'var(--warning)', marginBottom: 8 }}>This Article view must be previewed and approved again before batch run. Reasons: {reasons.join(', ') || 'stale flag set without reason'}.</div> : <div style={{ color: 'var(--text-muted)', marginBottom: 8 }}>Frozen snapshot is current unless an upstream connector/base/transform/article edit changes the chain hash.</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, fontSize: 12 }}>
      <div><b>Status</b><br />{statusBadge(row.status)}</div>
      <div><b>Input</b><br /><code>{val(row.input_kind)}:{val(row.input_id)}</code></div>
      <div><b>Target</b><br /><code>{val(row.target_source_id)}</code></div>
      <div><b>Version hash</b><br /><code>{shortHash(row.version_hash)}</code></div>
    </div>
  </div>;
}
