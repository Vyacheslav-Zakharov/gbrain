import { asArr, articleState, MiniBadge, shortHash, statusBadge, val } from './shared';

export function ArticleViewStatePanel({ row, previewHash }: { row: Record<string, unknown> | null; previewHash: string }) {
  if (!row) return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Выберите или сохраните Article view, чтобы увидеть snapshot, chain hash и причины устаревания.</div>;
  const state = articleState(row);
  const reasons = asArr(row.stale_reasons).map(String).filter(Boolean);
  const compiledAt = String(row.compiled_at ?? '');
  const currentHash = String(row.current_chain_hash ?? '');
  const previewMatchesFrozen = Boolean(previewHash && currentHash && previewHash === currentHash);
  return <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: row.stale === true ? 'rgba(245,158,11,0.08)' : 'rgba(15,23,42,0.34)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <b>Состояние цепочки</b>
      <MiniBadge tone={state.tone}>{state.icon} {state.label}</MiniBadge>
      <MiniBadge tone={currentHash ? 'ok' : 'muted'}>зафиксирован {shortHash(currentHash)}</MiniBadge>
      {previewHash && <MiniBadge tone={previewMatchesFrozen ? 'ok' : 'info'}>хэш предпросмотра {shortHash(previewHash)}</MiniBadge>}
      {compiledAt && <MiniBadge tone="muted">собрано {compiledAt}</MiniBadge>}
    </div>
    {row.stale === true ? <div style={{ color: 'var(--warning)', marginBottom: 8 }}>Перед пакетным запуском нужен новый предпросмотр и повторное утверждение. Причины: {reasons.join(', ') || 'устаревание без указанной причины'}.</div> : <div style={{ color: 'var(--text-muted)', marginBottom: 8 }}>Snapshot актуален, пока изменение подключения, источника, преобразования или публикации не изменит chain hash.</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, fontSize: 12 }}>
      <div><b>Статус</b><br />{statusBadge(row.status)}</div>
      <div><b>Вход</b><br /><code>{val(row.input_kind)}:{val(row.input_id)}</code></div>
      <div><b>Назначение</b><br /><code>{val(row.target_source_id)}</code></div>
      <div><b>Хэш версии</b><br /><code>{shortHash(row.version_hash)}</code></div>
    </div>
  </div>;
}
