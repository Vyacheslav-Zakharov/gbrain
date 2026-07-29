import React from 'react';

export interface SourceIngestCatalogTree {
  connectors?: Array<Record<string, unknown>>;
  base_views?: Array<Record<string, unknown>>;
  transform_views?: Array<Record<string, unknown>>;
  article_views?: Array<Record<string, unknown>>;
  schema?: Record<string, unknown>;
}

export type CatalogArea = 'connectors' | 'base_views' | 'transform_views' | 'article_views' | 'schema_view' | 'profiles';

export function DangerZone({ description, children }: { description: string; children: React.ReactNode }) {
  return <details className="source-ingest-danger-zone">
    <summary>Опасные действия</summary>
    <div className="source-ingest-danger-zone__content">
      <p>{description}</p>
      <div className="source-ingest-danger-zone__actions">{children}</div>
    </div>
  </details>;
}

export function val(x: unknown): string {
  return x === null || x === undefined || x === '' ? '—' : String(x);
}

export function asObj(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? x as Record<string, unknown> : {};
}

export function asArr<T = unknown>(x: unknown): T[] {
  return Array.isArray(x) ? x as T[] : [];
}

export function statusBadge(status: unknown) {
  const s = String(status ?? 'unknown');
  const color = s === 'active' || s === 'reviewed' ? 'var(--success)' : s === 'draft' ? 'var(--warning)' : 'var(--text-muted)';
  return <span style={{ color }}>{s}</span>;
}

export function MiniBadge({ tone = 'muted', children, title }: { tone?: 'ok' | 'warn' | 'error' | 'muted' | 'info'; children: React.ReactNode; title?: string }) {
  const colors: Record<string, { fg: string; bg: string; border: string }> = {
    ok: { fg: 'var(--success)', bg: 'rgba(16,185,129,0.10)', border: 'rgba(16,185,129,0.25)' },
    warn: { fg: 'var(--warning)', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.25)' },
    error: { fg: 'var(--error)', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.25)' },
    info: { fg: 'var(--accent)', bg: 'rgba(136,170,255,0.10)', border: 'rgba(136,170,255,0.25)' },
    muted: { fg: 'var(--text-muted)', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.16)' },
  };
  const c = colors[tone] || colors.muted;
  return <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: c.fg, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 999, padding: '1px 6px', fontSize: 10, lineHeight: 1.4, marginRight: 4 }}>{children}</span>;
}

export function shortHash(value: unknown): string {
  const s = String(value ?? '');
  return s ? `${s.slice(0, 8)}…` : '—';
}

export function articleState(row: Record<string, unknown>) {
  const stale = row.stale === true;
  const hasFrozen = Boolean(row.current_chain_hash || row.compiled_at || row.compiled_profile);
  const status = String(row.status ?? 'draft');
  if (stale) return { tone: 'warn' as const, label: 'stale', icon: '⚠' };
  if (hasFrozen) return { tone: 'ok' as const, label: 'frozen', icon: '✓' };
  if (status === 'draft') return { tone: 'muted' as const, label: 'draft', icon: '○' };
  return { tone: 'info' as const, label: status, icon: '•' };
}
