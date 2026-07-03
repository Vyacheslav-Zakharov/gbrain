import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import { executeRawJsonb } from '../sql-query.ts';
import type { SourceFilterRule, SourceIngestProfile, SourceIngestProfileStatus, SourceTransformProfile, SourceLinkRule } from './profile-schema.ts';
import { profileHash, stableJson } from './store.ts';

export type SourceArticleViewStatus = 'draft' | 'reviewed' | 'active' | 'paused';
export type SourceArticleInputKind = 'base_view' | 'transform_view';

export interface SourceConnectorView {
  connector_id: string;
  kind: string;
  display_name: string;
  config_json?: Record<string, unknown>;
  enabled?: boolean;
}

export interface SourceBaseView {
  base_view_id: string;
  connector_id: string;
  object_name: string;
  display_name?: string;
  selected_fields?: string[];
  row_filter?: SourceFilterRule[];
  sample_limit?: number;
  discovery_json?: Record<string, unknown> | null;
}

export interface SourceTransformView {
  transform_view_id: string;
  inputs: Array<{ alias: string; base_view_id: string }>;
  sql: string;
  primary_key_field: string;
  updated_at_field?: string | null;
  display_name?: string;
}

export interface SourceArticleView {
  article_view_id: string;
  input: { kind: SourceArticleInputKind; id: string };
  gbrain_type: string;
  target_source_id: string;
  slug_template: string;
  identity: SourceIngestProfile['identity'];
  article_template?: NonNullable<SourceIngestProfile['mapping']>['article_template'];
  mapping?: SourceIngestProfile['mapping'];
  link_rules?: SourceLinkRule[];
  freshness_policy?: SourceIngestProfile['freshness'];
  update_policy?: SourceIngestProfile['update_policy'];
  security: SourceIngestProfile['security'];
  status?: SourceArticleViewStatus;
  display_name?: string;
}

export interface SourceArticleViewRow {
  article_view_id: string;
  input_kind: SourceArticleInputKind;
  input_id: string;
  status: SourceArticleViewStatus;
  gbrain_type: string;
  target_source_id: string;
  stale: boolean;
  stale_reasons: string[];
  current_chain_hash: string | null;
  version_hash: string | null;
  compiled_profile: SourceIngestProfile | null;
  article_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  compiled_at: string | null;
}

function sha(value: unknown): string {
  return awaitlessSha(stableJson(value));
}

function awaitlessSha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sourceObjectForBase(base: SourceBaseView): string {
  return base.object_name;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try { return asStringArray(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function connectorConfigHash(row: { connector_id: string; kind: string; config_json?: Record<string, unknown>; enabled?: boolean }): string {
  return sha({ connector_id: row.connector_id, kind: row.kind, config_json: row.config_json || {}, enabled: row.enabled !== false });
}

export function baseViewHash(row: SourceBaseView): string {
  return sha({ base_view_id: row.base_view_id, connector_id: row.connector_id, object_name: row.object_name, selected_fields: row.selected_fields || [], row_filter: row.row_filter || [], sample_limit: row.sample_limit ?? null });
}

export function transformViewHash(row: SourceTransformView): string {
  return sha({ transform_view_id: row.transform_view_id, inputs: row.inputs, sql: row.sql, primary_key_field: row.primary_key_field, updated_at_field: row.updated_at_field ?? null });
}

export function articleViewDefinitionHash(row: SourceArticleView): string {
  return sha(row);
}

export async function upsertSourceConnectorView(engine: BrainEngine, input: SourceConnectorView) {
  const config = input.config_json || {};
  await executeRawJsonb(
    engine,
    `INSERT INTO source_connectors
       (connector_id, kind, display_name, config_json, enabled, config_hash, updated_at)
     VALUES ($1,$2,$3,$6::jsonb,$4,$5,now())
     ON CONFLICT (connector_id) DO UPDATE SET
       kind = EXCLUDED.kind,
       display_name = EXCLUDED.display_name,
       config_json = EXCLUDED.config_json,
       enabled = EXCLUDED.enabled,
       config_hash = EXCLUDED.config_hash,
       updated_at = now()`,
    [input.connector_id, input.kind, input.display_name, input.enabled !== false, connectorConfigHash({ ...input, config_json: config })],
    [config],
  );
  await markArticleViewsStaleForConnector(engine, input.connector_id, ['connector_changed']);
  return (await listSourceConnectorViews(engine, input.connector_id))[0];
}

export async function listSourceConnectorViews(engine: BrainEngine, connectorId?: string) {
  const params: unknown[] = [];
  const where = connectorId ? 'WHERE connector_id = $1' : '';
  if (connectorId) params.push(connectorId);
  return engine.executeRaw(
    `SELECT connector_id, kind, display_name, config_json, enabled, config_hash, last_test_ok, last_test_at::text, created_at::text, updated_at::text
       FROM source_connectors
       ${where}
       ORDER BY display_name`,
    params,
  );
}

export async function deleteSourceConnectorView(engine: BrainEngine, connectorId: string) {
  const dependents = await engine.executeRaw<{ count: number }>(
    `SELECT count(*)::int AS count FROM source_base_views WHERE connector_id = $1`,
    [connectorId],
  );
  if ((dependents[0]?.count ?? 0) > 0) {
    throw new Error(`connector_has_base_views: ${connectorId}`);
  }
  const rows = await engine.executeRaw(
    `DELETE FROM source_connectors WHERE connector_id = $1 RETURNING connector_id, kind, display_name`,
    [connectorId],
  );
  return { deleted: rows.length > 0, row: rows[0] ?? null };
}

export async function recordSourceConnectorTest(engine: BrainEngine, connectorId: string, ok: boolean) {
  await engine.executeRaw(
    `UPDATE source_connectors SET last_test_ok = $2, last_test_at = now(), updated_at = now() WHERE connector_id = $1`,
    [connectorId, ok],
  );
}

export async function upsertSourceBaseView(engine: BrainEngine, input: SourceBaseView) {
  const selected = input.selected_fields || [];
  const filter = input.row_filter || [];
  const discovery = input.discovery_json || null;
  await executeRawJsonb(
    engine,
    `INSERT INTO source_base_views
       (base_view_id, connector_id, object_name, display_name, selected_fields, row_filter, sample_limit, discovery_json, version_hash, updated_at)
     VALUES ($1,$2,$3,$4,$7::jsonb->'value',$8::jsonb->'value',$5,$9::jsonb->'value',$6,now())
     ON CONFLICT (base_view_id) DO UPDATE SET
       connector_id = EXCLUDED.connector_id,
       object_name = EXCLUDED.object_name,
       display_name = EXCLUDED.display_name,
       selected_fields = EXCLUDED.selected_fields,
       row_filter = EXCLUDED.row_filter,
       sample_limit = EXCLUDED.sample_limit,
       discovery_json = EXCLUDED.discovery_json,
       version_hash = EXCLUDED.version_hash,
       updated_at = now()`,
    [input.base_view_id, input.connector_id, input.object_name, input.display_name || input.base_view_id, input.sample_limit ?? 50, baseViewHash({ ...input, selected_fields: selected, row_filter: filter })],
    [{ value: selected }, { value: filter }, { value: discovery }],
  );
  await markArticleViewsStaleForBaseView(engine, input.base_view_id, ['base_view_changed']);
  return (await listSourceBaseViews(engine, input.base_view_id))[0];
}

export async function listSourceBaseViews(engine: BrainEngine, baseViewId?: string) {
  const params: unknown[] = [];
  const where = baseViewId ? 'WHERE base_view_id = $1' : '';
  if (baseViewId) params.push(baseViewId);
  return engine.executeRaw(
    `SELECT base_view_id, connector_id, object_name, display_name, selected_fields, row_filter, sample_limit,
            discovery_json, last_discovered_at::text, version_hash, created_at::text, updated_at::text
       FROM source_base_views
       ${where}
       ORDER BY updated_at DESC`,
    params,
  );
}

export async function upsertSourceTransformView(engine: BrainEngine, input: SourceTransformView) {
  const inputs = input.inputs || [];
  await executeRawJsonb(
    engine,
    `INSERT INTO source_transform_views
       (transform_view_id, display_name, inputs, sql, primary_key_field, updated_at_field, version_hash, updated_at)
     VALUES ($1,$2,$7::jsonb->'value',$3,$4,$5,$6,now())
     ON CONFLICT (transform_view_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       inputs = EXCLUDED.inputs,
       sql = EXCLUDED.sql,
       primary_key_field = EXCLUDED.primary_key_field,
       updated_at_field = EXCLUDED.updated_at_field,
       version_hash = EXCLUDED.version_hash,
       updated_at = now()`,
    [input.transform_view_id, input.display_name || input.transform_view_id, input.sql, input.primary_key_field, input.updated_at_field ?? null, transformViewHash({ ...input, inputs })],
    [{ value: inputs }],
  );
  await markArticleViewsStaleForTransformView(engine, input.transform_view_id, ['transform_view_changed']);
  return (await listSourceTransformViews(engine, input.transform_view_id))[0];
}

export async function listSourceTransformViews(engine: BrainEngine, transformViewId?: string) {
  const params: unknown[] = [];
  const where = transformViewId ? 'WHERE transform_view_id = $1' : '';
  if (transformViewId) params.push(transformViewId);
  return engine.executeRaw(
    `SELECT transform_view_id, display_name, inputs, sql, primary_key_field, updated_at_field,
            version_hash, last_preview_ok, last_preview_at::text, created_at::text, updated_at::text
       FROM source_transform_views
       ${where}
       ORDER BY updated_at DESC`,
    params,
  );
}

export async function upsertSourceArticleView(engine: BrainEngine, input: SourceArticleView) {
  const articleJson = { ...input, status: input.status || 'draft' };
  await executeRawJsonb(
    engine,
    `INSERT INTO source_article_views
       (article_view_id, display_name, input_kind, input_id, status, gbrain_type, target_source_id, article_json, stale, stale_reasons, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false,'[]'::jsonb,now())
     ON CONFLICT (article_view_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       input_kind = EXCLUDED.input_kind,
       input_id = EXCLUDED.input_id,
       status = EXCLUDED.status,
       gbrain_type = EXCLUDED.gbrain_type,
       target_source_id = EXCLUDED.target_source_id,
       article_json = EXCLUDED.article_json,
       stale = true,
       stale_reasons = source_article_views.stale_reasons || '["article_view_changed"]'::jsonb,
       updated_at = now()`,
    [input.article_view_id, input.display_name || input.article_view_id, input.input.kind, input.input.id, input.status || 'draft', input.gbrain_type, input.target_source_id],
    [articleJson],
  );
  return (await listSourceArticleViews(engine, input.article_view_id))[0];
}

export async function listSourceArticleViews(engine: BrainEngine, articleViewId?: string): Promise<SourceArticleViewRow[]> {
  const params: unknown[] = [];
  const where = articleViewId ? 'WHERE article_view_id = $1' : '';
  if (articleViewId) params.push(articleViewId);
  const rows = await engine.executeRaw<SourceArticleViewRow>(
    `SELECT article_view_id, input_kind, input_id, status, gbrain_type, target_source_id,
            stale, stale_reasons, current_chain_hash, version_hash, compiled_profile,
            article_json, created_at::text, updated_at::text, compiled_at::text
       FROM source_article_views
       ${where}
       ORDER BY updated_at DESC`,
    params,
  );
  return rows.map(row => ({
    ...row,
    stale_reasons: asStringArray(row.stale_reasons),
    article_json: asObject(row.article_json),
    compiled_profile: row.compiled_profile ? (typeof row.compiled_profile === 'string' ? JSON.parse(row.compiled_profile) : row.compiled_profile) : null,
  }));
}

async function markArticleViewsStale(engine: BrainEngine, whereSql: string, params: unknown[], reasons: string[]) {
  await executeRawJsonb(
    engine,
    `UPDATE source_article_views
        SET stale = true,
            stale_reasons = COALESCE(stale_reasons, '[]'::jsonb) || ($${params.length + 1}::jsonb->'value'),
            updated_at = now()
      WHERE ${whereSql}`,
    params as any,
    [{ value: reasons }],
  );
}

export async function markArticleViewsStaleForConnector(engine: BrainEngine, connectorId: string, reasons: string[]) {
  await markArticleViewsStale(engine,
    `input_id IN (SELECT base_view_id FROM source_base_views WHERE connector_id = $1)
     OR input_id IN (
       SELECT transform_view_id FROM source_transform_views tv
       WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(tv.inputs) AS i(alias text, base_view_id text)
                     JOIN source_base_views bv ON bv.base_view_id = i.base_view_id
                    WHERE bv.connector_id = $1)
     )`,
    [connectorId], reasons);
}

export async function markArticleViewsStaleForBaseView(engine: BrainEngine, baseViewId: string, reasons: string[]) {
  await markArticleViewsStale(engine,
    `(input_kind = 'base_view' AND input_id = $1)
     OR input_id IN (
       SELECT transform_view_id FROM source_transform_views tv
       WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(tv.inputs) AS i(alias text, base_view_id text)
                     WHERE i.base_view_id = $1)
     )`,
    [baseViewId], reasons);
}

export async function markArticleViewsStaleForTransformView(engine: BrainEngine, transformViewId: string, reasons: string[]) {
  await markArticleViewsStale(engine, `input_kind = 'transform_view' AND input_id = $1`, [transformViewId], reasons);
}

async function loadArticleInput(engine: BrainEngine, article: SourceArticleViewRow) {
  if (article.input_kind === 'base_view') {
    const [baseRaw] = await listSourceBaseViews(engine, article.input_id) as Array<any>;
    if (!baseRaw) throw new Error(`base_view not found: ${article.input_id}`);
    const base: SourceBaseView = {
      base_view_id: baseRaw.base_view_id,
      connector_id: baseRaw.connector_id,
      object_name: baseRaw.object_name,
      display_name: baseRaw.display_name,
      selected_fields: asStringArray(baseRaw.selected_fields),
      row_filter: Array.isArray(baseRaw.row_filter) ? baseRaw.row_filter as SourceFilterRule[] : [],
      sample_limit: Number(baseRaw.sample_limit || 50),
      discovery_json: asObject(baseRaw.discovery_json),
    };
    const [connector] = await listSourceConnectorViews(engine, base.connector_id) as Array<any>;
    return { base, connector, transform: null as SourceTransformView | null, bases: [base] };
  }

  const [transformRaw] = await listSourceTransformViews(engine, article.input_id) as Array<any>;
  if (!transformRaw) throw new Error(`transform_view not found: ${article.input_id}`);
  const inputs = Array.isArray(transformRaw.inputs) ? transformRaw.inputs as Array<{ alias: string; base_view_id: string }> : [];
  const bases: SourceBaseView[] = [];
  for (const input of inputs) {
    const [baseRaw] = await listSourceBaseViews(engine, input.base_view_id) as Array<any>;
    if (!baseRaw) throw new Error(`base_view not found: ${input.base_view_id}`);
    bases.push({
      base_view_id: baseRaw.base_view_id,
      connector_id: baseRaw.connector_id,
      object_name: baseRaw.object_name,
      display_name: baseRaw.display_name,
      selected_fields: asStringArray(baseRaw.selected_fields),
      row_filter: Array.isArray(baseRaw.row_filter) ? baseRaw.row_filter as SourceFilterRule[] : [],
      sample_limit: Number(baseRaw.sample_limit || 50),
      discovery_json: asObject(baseRaw.discovery_json),
    });
  }
  const transform: SourceTransformView = {
    transform_view_id: transformRaw.transform_view_id,
    display_name: transformRaw.display_name,
    inputs,
    sql: transformRaw.sql,
    primary_key_field: transformRaw.primary_key_field,
    updated_at_field: transformRaw.updated_at_field,
  };
  const connector = bases[0] ? (await listSourceConnectorViews(engine, bases[0].connector_id) as Array<any>)[0] : null;
  return { base: bases[0], connector, transform, bases };
}

export async function compileSourceArticleView(engine: BrainEngine, articleViewId: string, opts: { approvedBy?: string } = {}) {
  const [article] = await listSourceArticleViews(engine, articleViewId);
  if (!article) throw new Error(`article_view not found: ${articleViewId}`);
  const articleDef = article.article_json as unknown as SourceArticleView;
  const { base, connector, transform, bases } = await loadArticleInput(engine, article);
  if (!base) throw new Error(`article_view has no base input: ${articleViewId}`);
  const chain = {
    connector_hash: connector ? connector.config_hash : null,
    base_hashes: bases.map(baseViewHash).sort(),
    transform_hash: transform ? transformViewHash(transform) : null,
    article_hash: articleViewDefinitionHash(articleDef),
  };
  const currentChainHash = sha(chain);
  const sourceConnector = transform ? base.connector_id : base.connector_id;
  const sourceObject = transform ? base.object_name : sourceObjectForBase(base);
  const profile: SourceIngestProfile = {
    profile_id: article.article_view_id,
    status: (article.status === 'active' ? 'active' : 'reviewed') as SourceIngestProfileStatus,
    source_connector: sourceConnector,
    source_object: sourceObject,
    ...(transform ? { transform: {
      engine: 'pglite',
      sources: transform.inputs.map(input => {
        const bv = bases.find(b => b.base_view_id === input.base_view_id);
        return { alias: input.alias, source_table_id: input.base_view_id, connector: bv?.connector_id, object: bv?.object_name || input.base_view_id, fields: bv?.selected_fields || [], sample_limit: bv?.sample_limit };
      }),
      sql: transform.sql,
      primary_key_field: transform.primary_key_field,
      ...(transform.updated_at_field ? { updated_at_field: transform.updated_at_field } : {}),
    } satisfies SourceTransformProfile } : {}),
    target: { gbrain_type: article.gbrain_type, approved_source_id: article.target_source_id, slug_template: articleDef.slug_template },
    ...(base.row_filter?.length ? { selection: { include: base.row_filter } } : {}),
    identity: articleDef.identity,
    ...(articleDef.freshness_policy ? { freshness: articleDef.freshness_policy } : {}),
    mapping: articleDef.mapping || (articleDef.article_template ? { article_template: articleDef.article_template } : undefined),
    links: articleDef.link_rules || [],
    update_policy: articleDef.update_policy || { mode: 'managed_block', preserve_manual_sections: true },
    security: articleDef.security,
    review: { approved_by: opts.approvedBy || 'local', approved_at: new Date().toISOString() },
  };
  const versionHash = profileHash(profile);
  await executeRawJsonb(
    engine,
    `UPDATE source_article_views
        SET compiled_profile = $4::jsonb,
            version_hash = $2,
            current_chain_hash = $3,
            stale = false,
            stale_reasons = '[]'::jsonb,
            compiled_at = now(),
            status = CASE WHEN status = 'draft' THEN 'reviewed' ELSE status END,
            updated_at = now()
      WHERE article_view_id = $1`,
    [articleViewId, versionHash, currentChainHash],
    [profile],
  );
  return { article_view_id: articleViewId, compiled_profile: profile, version_hash: versionHash, current_chain_hash: currentChainHash };
}

export async function getCompiledArticleProfile(engine: BrainEngine, articleViewId: string): Promise<{ profile: SourceIngestProfile; version_hash: string; stale: boolean } | null> {
  const [row] = await listSourceArticleViews(engine, articleViewId);
  if (!row?.compiled_profile || !row.version_hash) return null;
  return { profile: row.compiled_profile, version_hash: row.version_hash, stale: row.stale };
}

export async function sourceIngestTree(engine: BrainEngine) {
  const [connectors, base_views, transform_views, article_views] = await Promise.all([
    listSourceConnectorViews(engine),
    listSourceBaseViews(engine),
    listSourceTransformViews(engine),
    listSourceArticleViews(engine),
  ]);
  return { connectors, base_views, transform_views, article_views, schema: { read_only: true } };
}
