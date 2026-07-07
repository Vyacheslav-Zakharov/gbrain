import React from 'react';
import { val } from './shared';

type Props = {
  busy: string | null;
  catalogCounts: { connectors: number; baseViews: number; transformViews: number; articleViews: number };
  activeSchemaPack: Record<string, unknown>;
  schemaStats: Record<string, unknown>;
  schemaNodes: Array<Record<string, unknown>>;
  schemaEdges: Array<Record<string, unknown>>;
  schemaType: string;
  setSchemaType: (value: string) => void;
  schemaTypeExplain: unknown;
  schemaWorkbench: unknown;
  explainSchemaType: (type: string) => void;
  PreviewJson: React.ComponentType<{ value: unknown; empty: string }>;
  studioSectionStyle: (area: string) => React.CSSProperties;
};

function CatalogMetric({ label, count }: { label: string; count: number }) {
  return <div className="metric"><div className="metric-value">{String(count)}</div><div className="metric-label">{label}</div></div>;
}

export function SchemaWorkbench({ busy, catalogCounts, activeSchemaPack, schemaStats, schemaNodes, schemaEdges, schemaType, setSchemaType, schemaTypeExplain, schemaWorkbench, explainSchemaType, PreviewJson, studioSectionStyle }: Props) {
  return <section style={studioSectionStyle('schema_view')}>
    <h2 className="section-title">5. Schema view</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      Read-only schema workbench for the active GBrain schema pack: identity, typed coverage, page-type graph, and per-type resolver settings. Schema-pack mutations stay outside Source Ingest execution.
    </p>
    <div className="metrics" style={{ marginBottom: 12 }}>
      <CatalogMetric label="connectors" count={catalogCounts.connectors} />
      <CatalogMetric label="base views" count={catalogCounts.baseViews} />
      <CatalogMetric label="transform views" count={catalogCounts.transformViews} />
      <CatalogMetric label="article views" count={catalogCounts.articleViews} />
      <div className="metric"><div className="metric-value">{String(activeSchemaPack.page_types_count ?? schemaNodes.length)}</div><div className="metric-label">schema types</div></div>
      <div className="metric"><div className="metric-value">{String(activeSchemaPack.link_types_count ?? schemaEdges.length)}</div><div className="metric-label">link types</div></div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Active schema pack</h3>
        <table><tbody>
          <tr><th>pack</th><td className="mono">{val(activeSchemaPack.pack_name)}</td></tr>
          <tr><th>version</th><td className="mono">{val(activeSchemaPack.version)}</td></tr>
          <tr><th>sha8</th><td className="mono">{val(activeSchemaPack.sha8)}</td></tr>
          <tr><th>source tier</th><td className="mono">{val(activeSchemaPack.source_tier)}</td></tr>
        </tbody></table>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Typed coverage</h3>
        <PreviewJson value={schemaStats.aggregate ?? schemaStats} empty="No schema stats." />
      </div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, marginTop: 12 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Page types</h3>
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          <table><thead><tr><th>type</th><th>primitive</th><th></th></tr></thead><tbody>
            {schemaNodes.map((node, i) => <tr key={`${String(node.name)}-${i}`}>
              <td className="mono">{val(node.name)}</td><td>{val(node.primitive)}</td>
              <td><button className="btn btn-secondary" disabled={busy !== null} onClick={() => void explainSchemaType(String(node.name))}>Explain</button></td>
            </tr>)}
          </tbody></table>
        </div>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Schema graph edges</h3>
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          <table><thead><tr><th>from</th><th>verb</th><th>to</th></tr></thead><tbody>
            {schemaEdges.map((edge, i) => <tr key={`${String(edge.from)}-${String(edge.verb)}-${i}`}><td className="mono">{val(edge.from)}</td><td>{val(edge.verb)}</td><td className="mono">{val(edge.to)}</td></tr>)}
          </tbody></table>
        </div>
      </div>
    </div>
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginTop: 12 }}>
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Type resolver / README output</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <select value={schemaType} onChange={e => { setSchemaType(e.target.value); void explainSchemaType(e.target.value); }}>
          <option value="">Select page type…</option>
          {schemaNodes.map((node, i) => <option key={`${String(node.name)}-select-${i}`} value={String(node.name)}>{String(node.name)}</option>)}
        </select>
        <button className="btn btn-secondary" disabled={busy !== null || !schemaType} onClick={() => void explainSchemaType(schemaType)}>{busy === 'schema-explain-type' ? 'Loading…' : 'Explain selected type'}</button>
      </div>
      <PreviewJson value={schemaTypeExplain ?? { note: 'Select a schema type to inspect primitive, path prefixes, aliases, extractability, and expert routing.' }} empty="No type selected." />
    </div>
    <details style={{ marginTop: 12 }}>
      <summary>Raw schema workbench payload</summary>
      <PreviewJson value={schemaWorkbench} empty="No schema metadata." />
    </details>
  </section>;
}
