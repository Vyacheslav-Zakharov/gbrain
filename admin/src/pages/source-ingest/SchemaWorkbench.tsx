import React, { useState } from 'react';
import { asArr, asObj, MiniBadge, val } from './shared';

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
  schemaTypeCard: unknown;
  schemaWorkbench: unknown;
  explainSchemaType: (type: string) => void;
  createSchemaProposal: (payload: Record<string, unknown>) => Promise<unknown>;
  PreviewJson: React.ComponentType<{ value: unknown; empty: string }>;
  studioSectionStyle: (area: string) => React.CSSProperties;
};

function CatalogMetric({ label, count }: { label: string; count: number }) {
  return <div className="metric"><div className="metric-value">{String(count)}</div><div className="metric-label">{label}</div></div>;
}

function InlineList({ values, empty = '—' }: { values: unknown[]; empty?: string }) {
  const items = values.map(String).filter(Boolean);
  if (items.length === 0) return <span>{empty}</span>;
  return <>{items.map(item => <code key={item} style={{ marginRight: 6 }}>{item}</code>)}</>;
}

function CardBox({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, minWidth: 0 }}>
    <h3 style={{ fontSize: 13, marginBottom: 8 }}>{title}</h3>
    {children}
  </div>;
}

function SchemaProposalBox({ type, busy, createSchemaProposal, PreviewJson }: { type: string; busy: string | null; createSchemaProposal: (payload: Record<string, unknown>) => Promise<unknown>; PreviewJson: React.ComponentType<{ value: unknown; empty: string }> }) {
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [payloadText, setPayloadText] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const defaultPayload = type ? JSON.stringify([{ op: 'add_alias', type, alias: `${type}-alias` }], null, 2) : '[]';
  const text = payloadText || defaultPayload;
  const submit = async () => {
    const mutations = JSON.parse(text);
    const out = await createSchemaProposal({ type, title: title || `Schema proposal: ${type}`, reason, mutations });
    setResult(out);
  };
  return <CardBox title="Предложить изменение">
    <p style={{ color: 'var(--text-muted)', marginTop: -4 }}>Proposal создаёт страницу <code>shared:schema-proposals/...</code> с payload <code>schema_apply_mutations</code> и impact-preview. Схема не мутируется.</p>
    <div style={{ display: 'grid', gap: 8 }}>
      <input placeholder="Название proposal" value={title} onChange={e => setTitle(e.target.value)} />
      <textarea placeholder="Обоснование" value={reason} onChange={e => setReason(e.target.value)} rows={3} />
      <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>mutations JSON</label>
      <textarea value={text} onChange={e => setPayloadText(e.target.value)} rows={7} className="mono" />
      <button className="btn btn-primary" disabled={!type || busy !== null} onClick={() => void submit()}>{busy === 'schema-proposal' ? 'Создание…' : 'Создать proposal-страницу'}</button>
      {result ? <PreviewJson value={result} empty="" /> : null}
    </div>
  </CardBox>;
}

function SchemaTypeCard({ card, PreviewJson }: { card: unknown; PreviewJson: React.ComponentType<{ value: unknown; empty: string }> }) {
  const obj = asObj(card);
  if (!obj.type) return <PreviewJson value={card ?? { note: 'Выберите тип схемы, чтобы открыть карточку типа.' }} empty="Тип не выбран." />;
  const header = asObj(obj.header);
  const resolution = asObj(obj.resolution);
  const fields = asObj(obj.fields);
  const relations = asObj(obj.relations);
  const template = asObj(fields.canonical_template);
  const fieldDrift = asObj(fields.drift);
  const sourceCounts = asArr<Record<string, unknown>>(header.pages_by_source);
  const liveFields = asArr<Record<string, unknown>>(fields.live_usage);
  const frontmatterLinks = asArr<Record<string, unknown>>(fields.frontmatter_links);
  const outgoing = asArr<Record<string, unknown>>(relations.outgoing);
  const incoming = asArr<Record<string, unknown>>(relations.incoming);
  const linkCounts = new Map(asArr<Record<string, unknown>>(relations.link_counts).map(row => [String(row.link_type), val(row.count)]));
  const articleViews = asArr<Record<string, unknown>>(obj.ingest_usage);
  const lint = asArr<Record<string, unknown>>(header.lint);
  const resolverText = String(resolution.resolver_section ?? '').trim();

  return <div style={{ display: 'grid', gap: 12 }}>
    <CardBox title="Карточка типа">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <MiniBadge tone="info">{val(header.primitive)}</MiniBadge>
        <b className="mono">{val(obj.type)}</b>
        <span>страниц: <b>{val(header.total_pages)}</b></span>
        <span>extractable: <code>{String(header.extractable ?? false)}</code></span>
        <span>expert_routing: <code>{String(header.expert_routing ?? false)}</code></span>
        {lint.length > 0 && <MiniBadge tone="warn">lint {lint.length}</MiniBadge>}
      </div>
      <table><thead><tr><th>source</th><th>pages</th></tr></thead><tbody>
        {sourceCounts.map(row => <tr key={String(row.source_id)}><td className="mono">{val(row.source_id)}</td><td>{val(row.count)}</td></tr>)}
      </tbody></table>
    </CardBox>

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
      <CardBox title="Куда резолвится">
        <div style={{ marginBottom: 8 }}><b>Префиксы:</b> <InlineList values={asArr(resolution.path_prefixes)} /></div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>Первое совпадение выигрывает; первый префикс — канонический дом типа.</div>
        <div style={{ marginBottom: 8 }}><b>Алиасы:</b> <InlineList values={asArr(resolution.aliases)} /></div>
        <div style={{ marginBottom: 8 }}><b>Обратные алиасы:</b> <InlineList values={asArr(resolution.reverse_aliases)} /></div>
        <details><summary>Subtype-правила</summary><PreviewJson value={resolution.subtypes} empty="Subtype-правил нет." /></details>
      </CardBox>
      <CardBox title="RESOLVER.md">
        {resolverText ? <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{resolverText}</pre> : <div style={{ color: 'var(--text-muted)' }}>Секция для типа в shared:RESOLVER.md не найдена.</div>}
      </CardBox>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
      <CardBox title="Поля: канон и живое использование">
        <div style={{ marginBottom: 8 }}><b>Канон frontmatter:</b> <InlineList values={asArr(template.required_frontmatter)} /></div>
        <div style={{ marginBottom: 8 }}><b>Канон sections:</b> <InlineList values={asArr<Record<string, unknown>>(template.sections).map(s => s.key)} /></div>
        <div style={{ overflow: 'auto', maxHeight: 260 }}>
          <table><thead><tr><th>field</th><th>pages</th><th>coverage</th></tr></thead><tbody>
            {liveFields.map(row => <tr key={String(row.key)}><td className="mono">{val(row.key)}</td><td>{val(row.count)}</td><td>{val(row.coverage_pct)}%</td></tr>)}
          </tbody></table>
        </div>
        <details style={{ marginTop: 8 }}><summary>Дрейф канон ↔ практика</summary><PreviewJson value={fieldDrift} empty="Дрейф не найден." /></details>
      </CardBox>
      <CardBox title="Рёбра из полей">
        <table><thead><tr><th>fields</th><th>link_type</th><th>edges</th></tr></thead><tbody>
          {frontmatterLinks.map((row, i) => <tr key={i}><td><InlineList values={asArr(row.fields)} /></td><td className="mono">{val(row.link_type)}</td><td>{linkCounts.get(String(row.link_type)) ?? '0'}</td></tr>)}
        </tbody></table>
      </CardBox>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
      <CardBox title="Связи: исходящие">
        <table><thead><tr><th>verb</th><th>target</th><th>edges</th></tr></thead><tbody>
          {outgoing.map(row => <tr key={String(row.verb)}><td className="mono">{val(row.verb)}</td><td className="mono">{val(row.target_type)}</td><td>{linkCounts.get(String(row.verb)) ?? '0'}</td></tr>)}
        </tbody></table>
      </CardBox>
      <CardBox title="Связи: входящие">
        <table><thead><tr><th>from</th><th>verb</th><th>edges</th></tr></thead><tbody>
          {incoming.map(row => <tr key={`${String(row.from_type)}-${String(row.verb)}`}><td className="mono">{val(row.from_type)}</td><td className="mono">{val(row.verb)}</td><td>{linkCounts.get(String(row.verb)) ?? '0'}</td></tr>)}
        </tbody></table>
      </CardBox>
    </div>

    <CardBox title="Использование в ингесте">
      <table><thead><tr><th>publication</th><th>source</th><th>state</th></tr></thead><tbody>
        {articleViews.map(row => <tr key={String(row.article_view_id)}><td className="mono">{val(row.article_view_id)}</td><td>{val(row.target_source_id)}</td><td>{row.stale === true ? 'stale' : val(row.status)}</td></tr>)}
      </tbody></table>
    </CardBox>
  </div>;
}

export function SchemaWorkbench({ busy, catalogCounts, activeSchemaPack, schemaStats, schemaNodes, schemaEdges, schemaType, setSchemaType, schemaTypeExplain, schemaTypeCard, schemaWorkbench, explainSchemaType, createSchemaProposal, PreviewJson, studioSectionStyle }: Props) {
  return <section style={studioSectionStyle('schema_view')}>
    <h2 className="section-title">5 · Схема мозга</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      Карточка типа активного GBrain schema pack: резолвер, поля из шаблона, живое покрытие frontmatter, связи и публикации Source Ingest. Мутации схемы остаются за proposal/live-флагом; этот slice только читает.
    </p>
    <div className="metrics" style={{ marginBottom: 12 }}>
      <CatalogMetric label="подключения" count={catalogCounts.connectors} />
      <CatalogMetric label="источники" count={catalogCounts.baseViews} />
      <CatalogMetric label="преобразования" count={catalogCounts.transformViews} />
      <CatalogMetric label="публикации" count={catalogCounts.articleViews} />
      <div className="metric"><div className="metric-value">{String(activeSchemaPack.page_types_count ?? schemaNodes.length)}</div><div className="metric-label">типы схемы</div></div>
      <div className="metric"><div className="metric-value">{String(activeSchemaPack.link_types_count ?? schemaEdges.length)}</div><div className="metric-label">типы связей</div></div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
      <CardBox title="Активный schema pack">
        <table><tbody>
          <tr><th>pack</th><td className="mono">{val(activeSchemaPack.pack_name)}</td></tr>
          <tr><th>version</th><td className="mono">{val(activeSchemaPack.version)}</td></tr>
          <tr><th>sha8</th><td className="mono">{val(activeSchemaPack.sha8)}</td></tr>
          <tr><th>source tier</th><td className="mono">{val(activeSchemaPack.source_tier)}</td></tr>
        </tbody></table>
      </CardBox>
      <CardBox title="Typed coverage">
        <PreviewJson value={schemaStats.aggregate ?? schemaStats} empty="Нет статистики схемы." />
      </CardBox>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 0.45fr) minmax(0, 1fr)', gap: 12, marginTop: 12 }}>
      <CardBox title="Типы страниц">
        <div style={{ maxHeight: 620, overflow: 'auto' }}>
          <table><thead><tr><th>type</th><th>primitive</th><th>pages</th></tr></thead><tbody>
            {schemaNodes.map((node, i) => {
              const byType = asArr<Record<string, unknown>>(asObj(schemaStats.aggregate).by_type).find(row => String(row.type) === String(node.name));
              return <tr key={`${String(node.name)}-${i}`} style={{ background: schemaType === String(node.name) ? 'rgba(136,170,255,0.10)' : undefined, cursor: 'pointer' }} onClick={() => void explainSchemaType(String(node.name))}>
                <td className="mono">{val(node.name)}</td><td>{val(node.primitive)}</td><td>{val(byType?.count)}</td>
              </tr>;
            })}
          </tbody></table>
        </div>
      </CardBox>
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <select value={schemaType} onChange={e => { setSchemaType(e.target.value); void explainSchemaType(e.target.value); }}>
            <option value="">Выберите тип…</option>
            {schemaNodes.map((node, i) => <option key={`${String(node.name)}-select-${i}`} value={String(node.name)}>{String(node.name)}</option>)}
          </select>
          <button className="btn btn-secondary" disabled={busy !== null || !schemaType} onClick={() => void explainSchemaType(schemaType)}>{busy === 'schema-explain-type' ? 'Загрузка…' : 'Открыть карточку типа'}</button>
        </div>
        <SchemaTypeCard card={schemaTypeCard ?? schemaTypeExplain} PreviewJson={PreviewJson} />
        <div style={{ marginTop: 12 }}>
          <SchemaProposalBox type={schemaType} busy={busy} createSchemaProposal={createSchemaProposal} PreviewJson={PreviewJson} />
        </div>
      </div>
    </div>
    <details style={{ marginTop: 12 }}>
      <summary>Schema graph edges / raw payload</summary>
      <PreviewJson value={{ schemaEdges, schemaWorkbench }} empty="Нет schema metadata." />
    </details>
  </section>;
}
