import React, { useState } from 'react';
import { asArr, asObj, articleState, type CatalogArea, MiniBadge, shortHash, type SourceIngestCatalogTree, val } from './shared';

function TreeButton({ active, depth = 0, icon, label, meta, onClick }: { active?: boolean; depth?: number; icon: string; label: React.ReactNode; meta?: React.ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} style={{
    display: 'block', width: '100%', textAlign: 'left', border: 0, borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
    background: active ? 'rgba(136,170,255,0.14)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    padding: `5px 8px 5px ${10 + depth * 18}px`, borderRadius: 6, cursor: 'pointer', fontSize: 13, lineHeight: 1.25,
  }}>
    <span style={{ display: 'inline-block', width: 18, color: 'var(--accent)' }}>{icon}</span>{label}
    {meta && <span style={{ display: 'block', paddingLeft: 18, color: 'var(--text-muted)', fontSize: 11 }}>{meta}</span>}
  </button>;
}

export function SourceIngestCatalogPanel({ tree, activeArea, activeNode, onSelectArea, onSelectNode, onSelectConnector, onSelectBaseView, onSelectTransformView, onSelectArticleView }: { tree: SourceIngestCatalogTree; activeArea: CatalogArea; activeNode: string; onSelectArea: (area: CatalogArea) => void; onSelectNode: (node: string) => void; onSelectConnector?: (row: Record<string, unknown>) => void; onSelectBaseView?: (row: Record<string, unknown>) => void; onSelectTransformView?: (row: Record<string, unknown>) => void; onSelectArticleView?: (row: Record<string, unknown>) => void }) {
  const [treeSearch, setTreeSearch] = useState('');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ connectors: true, base_views: true, transform_views: true, article_views: true, schema: true });
  const allConnectors = tree.connectors ?? [];
  const allBaseViews = tree.base_views ?? [];
  const allTransformViews = tree.transform_views ?? [];
  const allArticleViews = tree.article_views ?? [];
  const q = treeSearch.trim().toLowerCase();
  const rowMatches = (row: Record<string, unknown>, keys: string[]) => !q || keys.some(key => String(row[key] ?? '').toLowerCase().includes(q));
  const connectors = allConnectors.filter(row => rowMatches(row, ['connector_id', 'display_name', 'kind']));
  const baseViews = allBaseViews.filter(row => rowMatches(row, ['base_view_id', 'display_name', 'connector_id', 'object_name']));
  const transformViews = allTransformViews.filter(row => rowMatches(row, ['transform_view_id', 'display_name', 'sql', 'primary_key_field']));
  const articleViews = allArticleViews.filter(row => rowMatches(row, ['article_view_id', 'gbrain_type', 'target_source_id', 'status']));
  const isOpen = (key: string) => q ? true : openSections[key] !== false;
  const toggle = (key: string) => setOpenSections(prev => ({ ...prev, [key]: !isOpen(key) }));
  const setAll = (open: boolean) => setOpenSections({ connectors: open, base_views: open, transform_views: open, article_views: open, schema: open });
  const folderIcon = (key: string) => isOpen(key) ? '▾' : '▸';
  return <aside style={{
    position: 'sticky', top: 76, alignSelf: 'start', maxHeight: 'calc(100vh - 92px)', overflow: 'auto',
    background: 'linear-gradient(180deg, rgba(15,23,42,0.98), rgba(15,23,42,0.92))', border: '1px solid var(--border)', borderRadius: 10,
  }}>
    <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, letterSpacing: 0.2 }}>Source Ingest Studio</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Denodo-style catalog tree</div>
        </div>
        <button className="btn btn-secondary" style={{ padding: '4px 8px' }} onClick={() => onSelectArea(activeArea)} title="Refresh selected area">⟳</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px', flex: 1 }} onClick={() => setAll(false)}>Collapse all</button>
        <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px', flex: 1 }} onClick={() => setAll(true)}>Expand all</button>
      </div>
      <input placeholder="Search catalog…" value={treeSearch} onChange={e => setTreeSearch(e.target.value)} style={{ width: '100%' }} />
      {q && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6 }}>Filtered: {connectors.length + baseViews.length + transformViews.length + articleViews.length} of {allConnectors.length + allBaseViews.length + allTransformViews.length + allArticleViews.length}</div>}
    </div>
    <div style={{ padding: 8 }}>
      <TreeButton active={false} depth={0} icon="▾" label={<b>gbrain_source_ingest</b>} meta={`${connectors.length + baseViews.length + transformViews.length + articleViews.length} catalog objects`} onClick={() => onSelectArea(activeArea)} />

      <TreeButton active={activeNode === 'section:connectors'} depth={1} icon={folderIcon('connectors')} label="1 - connectivity" meta={`${allConnectors.length} connections`} onClick={() => { toggle('connectors'); onSelectArea('connectors'); onSelectNode('section:connectors'); }} />
      {isOpen('connectors') && connectors.map(row => {
        const id = String(row.connector_id);
        return <TreeButton key={id} active={activeNode === `connector:${id}`} depth={2} icon="🔌" label={<code>{id}</code>} meta={`${val(row.kind)} · ${row.enabled === false ? 'disabled' : 'enabled'}`} onClick={() => { onSelectArea('connectors'); onSelectNode(`connector:${id}`); onSelectConnector?.(row); }} />;
      })}
      {isOpen('connectors') && <TreeButton active={activeNode === 'connector:new'} depth={2} icon="＋" label="New connector…" meta="type + credentials + test" onClick={() => { onSelectArea('connectors'); onSelectNode('connector:new'); }} />}

      <TreeButton active={activeNode === 'section:base_views'} depth={1} icon={folderIcon('base_views')} label="2 - base views" meta={`${allBaseViews.length} source tables`} onClick={() => { toggle('base_views'); onSelectArea('base_views'); onSelectNode('section:base_views'); }} />
      {isOpen('base_views') && baseViews.map(row => {
        const id = String(row.base_view_id);
        return <TreeButton key={id} active={activeNode === `base_view:${id}`} depth={2} icon="▦" label={<code>{id}</code>} meta={`${val(row.connector_id)} / ${val(row.object_name)} · fields ${asArr(row.selected_fields).length}`} onClick={() => { onSelectArea('base_views'); onSelectNode(`base_view:${id}`); onSelectBaseView?.(row); }} />;
      })}
      {isOpen('base_views') && <TreeButton active={activeNode === 'base_view:new'} depth={2} icon="＋" label="New base view…" meta="connector + table + field profile" onClick={() => { onSelectArea('base_views'); onSelectNode('base_view:new'); }} />}

      <TreeButton active={activeNode === 'section:transform_views'} depth={1} icon={folderIcon('transform_views')} label="3 - integration" meta={`${allTransformViews.length} SQL views`} onClick={() => { toggle('transform_views'); onSelectArea('transform_views'); onSelectNode('section:transform_views'); }} />
      {isOpen('transform_views') && transformViews.map(row => {
        const id = String(row.transform_view_id);
        return <TreeButton key={id} active={activeNode === `transform_view:${id}`} depth={2} icon="▤" label={<code>{id}</code>} meta={`inputs ${asArr(row.inputs).length} · pk ${val(row.primary_key_field)}`} onClick={() => { onSelectArea('transform_views'); onSelectNode(`transform_view:${id}`); onSelectTransformView?.(row); }} />;
      })}
      {isOpen('transform_views') && <TreeButton active={activeNode === 'transform_view:new'} depth={2} icon="＋" label="New transform view…" meta="aliases + SQL execute" onClick={() => { onSelectArea('transform_views'); onSelectNode('transform_view:new'); }} />}

      <TreeButton active={activeNode === 'section:article_views'} depth={1} icon={folderIcon('article_views')} label="4 - publish" meta={`${allArticleViews.length} publish profiles`} onClick={() => { toggle('article_views'); onSelectArea('article_views'); onSelectNode('section:article_views'); }} />
      {isOpen('article_views') && articleViews.map(row => {
        const id = String(row.article_view_id);
        const state = articleState(row);
        const reasons = asArr(row.stale_reasons).map(String).filter(Boolean);
        return <TreeButton key={id} active={activeNode === `article_view:${id}`} depth={2} icon={row.stale === true ? '⚠' : '▧'} label={<code>{id}</code>} meta={<><MiniBadge tone={state.tone}>{state.icon} {state.label}</MiniBadge><MiniBadge tone={row.current_chain_hash ? 'ok' : 'muted'}>hash {shortHash(row.current_chain_hash)}</MiniBadge><span>{val(row.gbrain_type)} → {val(row.target_source_id)}</span>{reasons.length > 0 && <span style={{ display: 'block', marginTop: 2, color: 'var(--warning)' }}>why: {reasons.join(', ')}</span>}</>} onClick={() => { onSelectArea('article_views'); onSelectNode(`article_view:${id}`); onSelectArticleView?.(row); }} />;
      })}
      {isOpen('article_views') && <TreeButton active={activeNode === 'article_view:new'} depth={2} icon="＋" label="New article view…" meta="schema + template + batch run" onClick={() => { onSelectArea('article_views'); onSelectNode('article_view:new'); }} />}

      <TreeButton active={activeNode === 'section:schema'} depth={1} icon={folderIcon('schema')} label="5 - schema" meta="schema browser + legacy refresh" onClick={() => { toggle('schema'); onSelectArea('schema_view'); onSelectNode('section:schema'); }} />
      {isOpen('schema') && <TreeButton active={activeNode === 'schema_view'} depth={2} icon="▧" label="Schema view" meta={`read-only: ${String(asObj(tree.schema).read_only ?? true)}`} onClick={() => { onSelectArea('schema_view'); onSelectNode('schema_view'); }} />}
      {isOpen('schema') && <TreeButton active={activeNode === 'profiles'} depth={2} icon="▹" label="Profiles / refresh" meta="legacy status and refresh plans" onClick={() => { onSelectArea('profiles'); onSelectNode('profiles'); }} />}
    </div>
  </aside>;
}
