import React, { useState } from 'react';
import { asArr, asObj, articleState, type CatalogArea, MiniBadge, shortHash, type SourceIngestCatalogTree, val } from './shared';
import { ru } from './ru';

function TreeButton({ active, lineage, depth = 0, icon, label, meta, onClick }: { active?: boolean; lineage?: boolean; depth?: number; icon: string; label: React.ReactNode; meta?: React.ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} style={{
    display: 'block', width: '100%', textAlign: 'left', border: 0, borderLeft: active ? '3px solid var(--accent)' : lineage ? '3px solid rgba(52,211,153,0.75)' : '3px solid transparent',
    background: active ? 'rgba(136,170,255,0.14)' : lineage ? 'rgba(52,211,153,0.10)' : 'transparent', color: active ? 'var(--text-primary)' : lineage ? 'var(--text-primary)' : 'var(--text-secondary)',
    padding: `5px 8px 5px ${10 + depth * 18}px`, borderRadius: 6, cursor: 'pointer', fontSize: 13, lineHeight: 1.25,
  }}>
    <span style={{ display: 'inline-block', width: 18, color: 'var(--accent)' }}>{icon}</span>{label}
    {meta && <span style={{ display: 'block', paddingLeft: 18, color: 'var(--text-muted)', fontSize: 11 }}>{meta}</span>}
  </button>;
}

export function SourceIngestCatalogPanel({ tree, activeArea, activeNode, schemaNodes = [], onRefresh, onSelectArea, onSelectNode, onSelectConnector, onSelectBaseView, onSelectTransformView, onSelectArticleView, onSelectSchemaType }: { tree: SourceIngestCatalogTree; activeArea: CatalogArea; activeNode: string; schemaNodes?: Array<Record<string, unknown>>; onRefresh: () => void | Promise<void>; onSelectArea: (area: CatalogArea) => void; onSelectNode: (node: string) => void; onSelectConnector?: (row: Record<string, unknown>) => void; onSelectBaseView?: (row: Record<string, unknown>) => void; onSelectTransformView?: (row: Record<string, unknown>) => void; onSelectArticleView?: (row: Record<string, unknown>) => void; onSelectSchemaType?: (type: string) => void }) {
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
  const schemaTypes = schemaNodes.filter(row => !q || String(row.name ?? '').toLowerCase().includes(q) || String(row.primitive ?? '').toLowerCase().includes(q));
  const isOpen = (key: string) => q ? true : openSections[key] !== false;
  const toggle = (key: string) => setOpenSections(prev => ({ ...prev, [key]: !isOpen(key) }));
  const setAll = (open: boolean) => setOpenSections({ connectors: open, base_views: open, transform_views: open, article_views: open, schema: open });
  const folderIcon = (key: string) => isOpen(key) ? '▾' : '▸';
  const addLineageForArticle = (set: Set<string>, row: Record<string, unknown>) => {
    const kind = String(row.input_kind ?? asObj(row.input).kind ?? '');
    const inputId = String(row.input_id ?? asObj(row.input).id ?? '');
    if (kind === 'base_view') {
      const base = allBaseViews.find(b => String(b.base_view_id) === inputId);
      if (base) { set.add(`base_view:${inputId}`); set.add(`connector:${String(base.connector_id)}`); }
    }
    if (kind === 'transform_view') {
      const transform = allTransformViews.find(t => String(t.transform_view_id) === inputId);
      if (transform) {
        set.add(`transform_view:${inputId}`);
        for (const input of asArr(transform.inputs).map(asObj)) {
          const baseId = String(input.base_view_id ?? '');
          if (!baseId) continue;
          set.add(`base_view:${baseId}`);
          const base = allBaseViews.find(b => String(b.base_view_id) === baseId);
          if (base) set.add(`connector:${String(base.connector_id)}`);
        }
      }
    }
    const type = String(row.gbrain_type ?? '');
    if (type) set.add(`schema_type:${type}`);
  };
  const lineage = (() => {
    const set = new Set<string>();
    const [kind, id] = activeNode.split(':', 2);
    if (!id) return set;
    if (kind === 'connector') {
      for (const base of allBaseViews.filter(b => String(b.connector_id) === id)) {
        set.add(`base_view:${String(base.base_view_id)}`);
      }
    }
    if (kind === 'base_view') {
      const base = allBaseViews.find(b => String(b.base_view_id) === id);
      if (base) set.add(`connector:${String(base.connector_id)}`);
      for (const t of allTransformViews.filter(t => asArr(t.inputs).some(input => String(asObj(input).base_view_id) === id))) set.add(`transform_view:${String(t.transform_view_id)}`);
      for (const a of allArticleViews.filter(a => (String(a.input_kind) === 'base_view' && String(a.input_id) === id) || (String(a.input_kind) === 'transform_view' && set.has(`transform_view:${String(a.input_id)}`)))) set.add(`article_view:${String(a.article_view_id)}`);
    }
    if (kind === 'transform_view') {
      const transform = allTransformViews.find(t => String(t.transform_view_id) === id);
      for (const input of asArr(transform?.inputs).map(asObj)) {
        const baseId = String(input.base_view_id ?? '');
        if (!baseId) continue;
        set.add(`base_view:${baseId}`);
        const base = allBaseViews.find(b => String(b.base_view_id) === baseId);
        if (base) set.add(`connector:${String(base.connector_id)}`);
      }
      for (const a of allArticleViews.filter(a => String(a.input_kind) === 'transform_view' && String(a.input_id) === id)) set.add(`article_view:${String(a.article_view_id)}`);
    }
    if (kind === 'article_view') {
      const article = allArticleViews.find(a => String(a.article_view_id) === id);
      if (article) addLineageForArticle(set, article);
    }
    if (kind === 'schema_type') {
      for (const a of allArticleViews.filter(a => String(a.gbrain_type) === id)) set.add(`article_view:${String(a.article_view_id)}`);
    }
    set.delete(activeNode);
    return set;
  })();
  const inLineage = (node: string) => lineage.has(node);
  return <aside style={{
    position: 'sticky', top: 76, alignSelf: 'start', maxHeight: 'calc(100vh - 92px)', overflow: 'auto',
    background: 'linear-gradient(180deg, rgba(15,23,42,0.98), rgba(15,23,42,0.92))', border: '1px solid var(--border)', borderRadius: 10,
  }}>
    <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, letterSpacing: 0.2 }}>{ru.studioTitle}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{ru.studioSubtitle}</div>
        </div>
        <button className="btn btn-secondary" style={{ padding: '4px 8px' }} onClick={() => { void onRefresh(); }} title={ru.refreshSelected}>⟳</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px', flex: 1 }} onClick={() => setAll(false)}>{ru.collapse}</button>
        <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px', flex: 1 }} onClick={() => setAll(true)}>{ru.expandAll}</button>
      </div>
      <input placeholder={ru.searchPlaceholder} value={treeSearch} onChange={e => setTreeSearch(e.target.value)} style={{ width: '100%' }} />
      {q && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6 }}>{ru.found}: {connectors.length + baseViews.length + transformViews.length + articleViews.length + schemaTypes.length} из {allConnectors.length + allBaseViews.length + allTransformViews.length + allArticleViews.length + schemaNodes.length}</div>}
    </div>
    <div style={{ padding: 8 }}>
      <TreeButton active={false} depth={0} icon="▾" label={<b>gbrain_source_ingest</b>} meta={`${connectors.length + baseViews.length + transformViews.length + articleViews.length} ${ru.catalogObjects}`} onClick={() => onSelectArea(activeArea)} />

      <TreeButton active={activeNode === 'section:connectors'} depth={1} icon={folderIcon('connectors')} label={ru.sections.connectors} meta={`${allConnectors.length} ${ru.meta.connections}`} onClick={() => { toggle('connectors'); onSelectArea('connectors'); onSelectNode('section:connectors'); }} />
      {isOpen('connectors') && connectors.map(row => {
        const id = String(row.connector_id);
        return <TreeButton key={id} active={activeNode === `connector:${id}`} lineage={inLineage(`connector:${id}`)} depth={2} icon="🔌" label={<code>{id}</code>} meta={`${val(row.kind)} · ${row.enabled === false ? ru.disabled : ru.enabled}`} onClick={() => { onSelectArea('connectors'); onSelectNode(`connector:${id}`); onSelectConnector?.(row); }} />;
      })}
      {isOpen('connectors') && <TreeButton active={activeNode === 'connector:new'} depth={2} icon="＋" label={ru.newItems.connector} meta={ru.newItems.connectorMeta} onClick={() => { onSelectArea('connectors'); onSelectNode('connector:new'); }} />}

      <TreeButton active={activeNode === 'section:base_views'} depth={1} icon={folderIcon('base_views')} label={ru.sections.baseViews} meta={`${allBaseViews.length} ${ru.meta.sourceTables}`} onClick={() => { toggle('base_views'); onSelectArea('base_views'); onSelectNode('section:base_views'); }} />
      {isOpen('base_views') && baseViews.map(row => {
        const id = String(row.base_view_id);
        return <TreeButton key={id} active={activeNode === `base_view:${id}`} lineage={inLineage(`base_view:${id}`)} depth={2} icon="▦" label={<code>{id}</code>} meta={`${val(row.connector_id)} / ${val(row.object_name)} · ${asArr(row.selected_fields).length} ${ru.meta.fields}`} onClick={() => { onSelectArea('base_views'); onSelectNode(`base_view:${id}`); onSelectBaseView?.(row); }} />;
      })}
      {isOpen('base_views') && <TreeButton active={activeNode === 'base_view:new'} depth={2} icon="＋" label={ru.newItems.baseView} meta={ru.newItems.baseViewMeta} onClick={() => { onSelectArea('base_views'); onSelectNode('base_view:new'); }} />}

      <TreeButton active={activeNode === 'section:transform_views'} depth={1} icon={folderIcon('transform_views')} label={ru.sections.transformViews} meta={`${allTransformViews.length} ${ru.meta.sqlViews}`} onClick={() => { toggle('transform_views'); onSelectArea('transform_views'); onSelectNode('section:transform_views'); }} />
      {isOpen('transform_views') && transformViews.map(row => {
        const id = String(row.transform_view_id);
        return <TreeButton key={id} active={activeNode === `transform_view:${id}`} lineage={inLineage(`transform_view:${id}`)} depth={2} icon="▤" label={<code>{id}</code>} meta={`${asArr(row.inputs).length} ${ru.meta.inputs} · pk ${val(row.primary_key_field)}`} onClick={() => { onSelectArea('transform_views'); onSelectNode(`transform_view:${id}`); onSelectTransformView?.(row); }} />;
      })}
      {isOpen('transform_views') && <TreeButton active={activeNode === 'transform_view:new'} depth={2} icon="＋" label={ru.newItems.transformView} meta={ru.newItems.transformViewMeta} onClick={() => { onSelectArea('transform_views'); onSelectNode('transform_view:new'); }} />}

      <TreeButton active={activeNode === 'section:article_views'} depth={1} icon={folderIcon('article_views')} label={ru.sections.articleViews} meta={`${allArticleViews.length} ${ru.meta.publishProfiles}`} onClick={() => { toggle('article_views'); onSelectArea('article_views'); onSelectNode('section:article_views'); }} />
      {isOpen('article_views') && articleViews.map(row => {
        const id = String(row.article_view_id);
        const state = articleState(row);
        const reasons = asArr(row.stale_reasons).map(String).filter(Boolean);
        const lastRun = asObj(row.last_run);
        const runMeta = lastRun.run_id ? <span style={{ display: 'block', marginTop: 2 }}>{ru.meta.lastRun}: {val(lastRun.success)} ok / {val(lastRun.failed)} fail · {val(lastRun.finished_at)}</span> : null;
        return <TreeButton key={id} active={activeNode === `article_view:${id}`} lineage={inLineage(`article_view:${id}`)} depth={2} icon={row.stale === true ? '⚠' : '▧'} label={<code>{id}</code>} meta={<><MiniBadge tone={state.tone}>{state.icon} {state.label}</MiniBadge><MiniBadge tone={row.current_chain_hash ? 'ok' : 'muted'}>hash {shortHash(row.current_chain_hash)}</MiniBadge><span>{val(row.gbrain_type)} → {val(row.target_source_id)}</span>{runMeta}{reasons.length > 0 && <span style={{ display: 'block', marginTop: 2, color: 'var(--warning)' }}>{ru.meta.why}: {reasons.join(', ')}</span>}</>} onClick={() => { onSelectArea('article_views'); onSelectNode(`article_view:${id}`); onSelectArticleView?.(row); }} />;
      })}
      {isOpen('article_views') && <TreeButton active={activeNode === 'article_view:new'} depth={2} icon="＋" label={ru.newItems.articleView} meta={ru.newItems.articleViewMeta} onClick={() => { onSelectArea('article_views'); onSelectNode('article_view:new'); }} />}

      <TreeButton active={activeNode === 'section:schema_view'} depth={1} icon={folderIcon('schema')} label={ru.sections.schema} meta={`${schemaNodes.length} ${ru.meta.schemaTypes}`} onClick={() => { toggle('schema'); onSelectArea('schema_view'); onSelectNode('section:schema_view'); }} />
      {isOpen('schema') && <TreeButton active={activeNode === 'schema_view'} depth={2} icon="▧" label={ru.schemaOverview} meta={`${ru.meta.readOnly}: ${String(asObj(tree.schema).read_only ?? true)}`} onClick={() => { onSelectArea('schema_view'); onSelectNode('schema_view'); }} />}
      {isOpen('schema') && schemaTypes.map(row => {
        const type = String(row.name ?? '');
        return <TreeButton key={type} active={activeNode === `schema_type:${type}`} lineage={inLineage(`schema_type:${type}`)} depth={2} icon="◇" label={<code>{type}</code>} meta={val(row.primitive)} onClick={() => { onSelectArea('schema_view'); onSelectNode(`schema_type:${type}`); onSelectSchemaType?.(type); }} />;
      })}
    </div>
  </aside>;
}
