import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceIngestConnectorDescriptors } from '../src/core/source-ingest/connector-registry.ts';

const root = process.cwd();
const sourceIngestUi = () => [
  'admin/src/pages/SourceIngest.tsx',
  'admin/src/pages/source-ingest/ArticleViewEditor.tsx',
  'admin/src/pages/source-ingest/BaseViewEditor.tsx',
  'admin/src/pages/source-ingest/ConnectorEditor.tsx',
  'admin/src/pages/source-ingest/SchemaWorkbench.tsx',
  'admin/src/pages/source-ingest/SourceIngestCatalogPanel.tsx',
  'admin/src/pages/source-ingest/SourceIngestWizard.tsx',
  'admin/src/pages/source-ingest/TransformViewEditor.tsx',
  'admin/src/pages/source-ingest/ArticleViewStatePanel.tsx',
  'admin/src/pages/source-ingest/shared.tsx',
].map(path => readFileSync(join(root, path), 'utf8')).join('\n');
const serveHttp = () => readFileSync(join(root, 'src/commands/serve-http.ts'), 'utf8');
const adminApi = () => readFileSync(join(root, 'admin/src/api.ts'), 'utf8');

describe('source-ingest admin review gates', () => {
  test('approval is pinned to the dry-run target source', () => {
    const ui = sourceIngestUi();
    const server = serveHttp();
    const api = adminApi();

    expect(ui).toContain('dryRunSourceId');
    expect(ui).toContain('dryRunSourceMismatch');
    expect(ui).toContain('dryRunSourceId === form.target_source_id');
    expect(ui).toContain('dry_run_target_source_id: dryRunSourceId');
    expect(ui).toContain('Target source changed from dry-run');
    expect(api).toContain('sourceIngestApproveProfile');
    expect(server).toContain('dry_run_target_source_id');
    expect(server).toContain("error: 'dry_run_source_mismatch'");
    expect(server).toContain('res.status(409)');
  });

  test('PII/cross-source dry-runs require explicit acknowledgement and article preview exposes mapping review surface', () => {
    const ui = sourceIngestUi();
    const server = serveHttp();

    expect(ui).toContain('Routing</b>');
    expect(ui).toContain('sensitivity.pii_fields');
    expect(ui).toContain('requiresSensitivityAck');
    expect(ui).toContain('sensitivityAck');
    expect(ui).toContain('sensitivity_ack_required');
    expect(ui).toContain('[PII masked]');
    expect(ui).toContain('Article mapping editor');
    expect(ui).toContain('Fields to carry forward');
    expect(ui).toContain('Exclude noisy');
    expect(ui).toContain('selected_fields: selectedSourceFields');
    expect(ui).toContain('articleDirty');
    expect(ui).toContain('Rendered article previews');
    expect(ui).toContain('empty template slots');
    expect(ui).toContain('Optional SQL transform');
    expect(ui).toContain('Enable SQL transform before mapping');
    expect(ui).toContain('Transform sources JSON');
    expect(ui).toContain('raw.transform = transformConfig');
    expect(ui).toContain('mutating SQL is rejected server-side');
    expect(ui).toContain('Preview transform rows');
    expect(ui).toContain('Transform result rows');
    expect(ui).toContain('sourceIngestTransformPreview');
    expect(server).toContain('/admin/api/source-ingest/transform-preview');
    expect(ui).toContain('(!requiresSensitivityAck || sensitivityAck)');
    expect(ui).toContain('article_sections: articleSections');
    expect(ui).toContain('setTransformEnabled(savedJson.transform_enabled === true)');
    expect(ui).toContain('setArticleSections({ ...DEFAULT_ARTICLE_SECTIONS');
    expect(ui).toContain('Legacy source table / connector config');
    expect(ui).toContain('safeSourceTableId(form.connector_id, form.source_object, form.table_name)');
    expect(ui).toContain('Primary key field');
    expect(ui).toContain("table_name: 'vehicles'");
    expect(ui).toContain("primary_key_field: 'vehicleID'");
    expect(ui).toContain('source_table_id: safeSourceTableId');
    expect(ui).toContain('Article freshness policy');
    expect(server).toContain('defaultSourceConnectorConfigId(connector_id, source_object');
    expect(server).toContain('source_tables: sourceTableSummariesFromConfigs');
    expect(ui).toContain('Saved source tables');
    expect(ui).toContain('Use in transform sources');
    expect(server).toContain('sourceIngestConnectorDescriptors()');
    expect(ui).toContain('Credentials for this connector');
    expect(ui).toContain('Save credentials');
    expect(ui).toContain('connector:${catalogConnectorForm.connector_id}');
    expect(ui).toContain('No table is sent from this connector test');
    expect(ui).toContain('Test connector credentials');
    expect(ui).toContain('Display name (optional)');
    expect(ui).toContain('можно оставить пустым или написать по-русски');
    expect(ui).toContain('Search catalog…');
    expect(ui).toContain('Filtered:');
    expect(ui).toContain('activeNode');
    expect(ui).toContain('onSelectNode');
    expect(ui).toContain('Generate SELECT');
    expect(ui).toContain('appendBaseViewInput');
    expect(ui).toContain('Execute SQL preview');
    expect(ui).toContain('Source Ingest Studio');
    expect(ui).toContain('Denodo-style catalog tree');
    expect(ui).toContain('New base view…');
    expect(ui).toContain('New transform view…');
    expect(ui).toContain('Schema view');
    expect(ui).toContain('Catalog connector instance');
    expect(ui).toContain('sourceIngestConnectorListObjects');
    expect(ui).toContain('sourceIngestCatalogConnectorTest');
    expect(ui).toContain('Base view / Источник');
    expect(ui).toContain('sourceIngestSaveBaseView');
    expect(ui).toContain('Seed from legacy discovery');
    expect(ui).toContain('Source object / AppSheet table');
    expect(ui).toContain('Select connector…');
    expect(ui).toContain('Available objects / metadata');
    expect(server).toContain('No table/object was requested');
    expect(ui).toContain('Execute / Discover fields');
    expect(ui).toContain('sourceIngestExecuteBaseView');
    expect(ui).toContain('Schema / selected fields');
    expect(server).toContain('/admin/api/source-ingest/catalog/base-view/discover');
    expect(server).toContain('table_name: object_name');
    expect(ui).toContain('row_filter: rowFilter');
    expect(ui).toContain('{catalogConnectorChoices.map(c => <option key={c.id} value={c.id}>{c.displayName} ({c.id})</option>)}');
    expect(ui).toContain('connectorChoices.map(c => <option key={c.id} value={c.id}>{c.displayName} ({c.id}){c.status ===');
    expect(ui).toContain('Stable ID field');
    expect(ui).toContain('Updated-at field');
    expect(ui).toContain('primary_key_field: baseViewForm.primary_key_field');
    expect(server).toContain('selected_fields');
    expect(server).toContain('primary_key_field');
    expect(server).toContain('updated_at_field');
    expect(ui).toContain('Read-only schema workbench for the active GBrain schema pack');
    expect(ui).toContain('sourceIngestSchemaView');
    expect(ui).toContain('sourceIngestSchemaExplainType');
    expect(ui).toContain('Active schema pack');
    expect(ui).toContain('Schema graph edges');
    expect(ui).toContain('Type resolver / README output');
    expect(server).toContain('/admin/api/source-ingest/schema-view');
    expect(server).toContain('get_active_schema_pack');
    expect(server).toContain('schema_explain_type');
    expect(ui).toContain('Transform view / Преобразование');
    expect(ui).toContain('sourceIngestSaveTransformView');
    expect(ui).toContain('Seed from selected base view');
    expect(ui).toContain('parseTransformInputs(transformViewForm.inputs_text)');
    expect(ui).toContain('Article view / Публикация');
    expect(ui).toContain('sourceIngestSaveArticleView');
    expect(ui).toContain('sourceIngestApproveArticleView');
    expect(ui).toContain('Stale / chain state');
    expect(ui).toContain('article stale {staleArticleCount}');
    expect(ui).toContain('frozen hash');
    expect(ui).toContain('preview hash');
    expect(ui).toContain('why: {reasons.join');
    expect(ui).toContain('This Article view must be previewed and approved again before batch run');
    expect(ui).toContain('Approve / freeze snapshot');
    expect(ui).toContain('articleViewPayload');
    expect(server).toContain('/admin/api/source-ingest/catalog/connector/list-objects');
    expect(server).toContain('/admin/api/source-ingest/catalog/connector/test');
    expect(server).toContain('/admin/api/source-ingest/catalog/base-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/transform-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view/approve');
    expect(server).toContain('source_base_view_upsert');
    expect(server).toContain('source_transform_view_upsert');
    expect(server).toContain('source_article_view_upsert');
    expect(server).toContain('source_article_view_approve');
    expect(server).toContain('source_ingest_tree');
  });

  test('connector registry only exposes implemented v1 connector kinds', () => {
    const connectors = sourceIngestConnectorDescriptors();
    expect(connectors.map(c => c.id)).toEqual(['appsheet-vehicles', 'fake-source']);
    expect(connectors.find(c => c.id === 'appsheet-vehicles')).toMatchObject({ status: 'implemented', kind: 'appsheet', object: 'vehicle' });
    expect(connectors.find(c => c.id === 'fake-source')).toMatchObject({ status: 'implemented', kind: 'fake', object: 'vehicle' });
    expect(connectors.find(c => c.id === 'bigquery')).toBeUndefined();
    expect(connectors.find(c => c.id === 'postgres')).toBeUndefined();
  });
});
