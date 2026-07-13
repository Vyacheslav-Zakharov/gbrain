import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceIngestConnectorDescriptors } from '../src/core/source-ingest/connector-registry.ts';

const root = process.cwd();
const sourceIngestUi = () => [
  'admin/src/pages/SourceIngest.tsx',
  'admin/src/pages/source-ingest/ArticleViewEditor.tsx',
  'admin/src/pages/source-ingest/ChangeIntelligenceEditor.tsx',
  'admin/src/pages/source-ingest/BaseViewEditor.tsx',
  'admin/src/pages/source-ingest/ConnectorEditor.tsx',
  'admin/src/pages/source-ingest/SchemaWorkbench.tsx',
  'admin/src/pages/source-ingest/SourceIngestCatalogPanel.tsx',
  'admin/src/pages/source-ingest/SourceIngestWizard.tsx',
  'admin/src/pages/source-ingest/TransformViewEditor.tsx',
  'admin/src/pages/source-ingest/ArticleViewStatePanel.tsx',
  'admin/src/pages/source-ingest/shared.tsx',
  'admin/src/pages/source-ingest/ru.ts',
].map(path => readFileSync(join(root, path), 'utf8')).join('\n');
const serveHttp = () => readFileSync(join(root, 'src/commands/serve-http.ts'), 'utf8');
const operations = () => readFileSync(join(root, 'src/core/operations.ts'), 'utf8');
const adminApi = () => readFileSync(join(root, 'admin/src/api.ts'), 'utf8');

describe('source-ingest admin review gates', () => {
  test('article approval is pinned to dry-run current_chain_hash', () => {
    const ui = sourceIngestUi();
    const server = serveHttp();
    const ops = operations();
    const api = adminApi();

    expect(ui).toContain('articleViewCurrentChainHash');
    expect(ui).toContain('Preview required before approval');
    expect(ui).toContain('Approve / freeze snapshot');
    expect(api).toContain('sourceIngestApproveArticleView');
    expect(server).toContain('current_chain_hash_required');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view/approve');
    expect(ops).toContain('current_chain_hash: { type: \'string\', required: true');
    expect(ops).toContain('chain_hash_mismatch');
    expect(ops).toContain('buildSourceArticleViewSnapshot');
  });

  test('admin app keeps source-ingest mounted for deep-link hashes', () => {
    const app = readFileSync(join(root, 'admin/src/App.tsx'), 'utf8');
    expect(app).toContain("hash.split('/')[0]");
    expect(app).toContain("return topLevel as Page");
  });

  test('schema-template article editor and catalog surfaces expose publish workflow', () => {
    const ui = sourceIngestUi();
    const server = serveHttp();
    const api = adminApi();
    const ops = operations();

    expect(api).toContain('sourceIngestArticleTemplate');
    expect(server).toContain('/admin/api/source-ingest/article-template/:type');
    expect(ops).toContain('source_article_template');
    expect(ops).toContain('_templates/${type}');
    expect(ops).toContain('required_frontmatter');
    expect(ops).toContain('validateArticleTemplateRequired');
    expect(ui).toContain('Schema-template article sections');
    expect(ui).toContain('requiredFrontmatter');
    expect(ui).toContain('articleTemplate');
    expect(ui).toContain('sourceIngestArticleTemplate');
    expect(ui).not.toContain('Legacy source table / connector config');
    expect(ui).not.toContain('Legacy profile workflow');
    expect(ui).not.toContain('Profiles / refresh');
    expect(ui).toContain('Студия Source Ingest');
    expect(ui).toContain('Каталог подключений, преобразований и публикаций');
    expect(ui).toContain('Мастер «Новая публикация»');
    expect(ui).toContain('Embedded flow');
    expect(ui).toContain('Сохранить и дальше');
    expect(ui).toContain('Upsert step');
    expect(ui).toContain('Lineage / цепочка публикации');
    expect(ui).toContain('lastAppliedHashRoute.current = nextHash');
    expect(ui).toContain('if (window.location.hash === lastAppliedHashRoute.current) return;');
    expect(ui).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(ui).toContain('handleSelectCatalogNode(hit.node)');
    expect(ui).toContain('Поиск по каталогу…');
    expect(ui).toContain('Новый источник…');
    expect(ui).toContain('Новое преобразование…');
    expect(ui).toContain('Новая публикация…');
    expect(ui).toContain('connector_already_exists');
    expect(ui).toContain('base_view_already_exists');
    expect(ui).toContain('transform_view_already_exists');
    expect(ui).toContain('article_view_already_exists');
    expect(ui).toContain('onRefresh={refreshCatalogTree}');
    expect(ui).toContain('Схема мозга');
    expect(ui).toContain('Карточка типа');
    expect(ui).toContain('Postgres read-only');
    expect(ui).toContain('connection_string');
    expect(api).toContain('sourceIngestSchemaTypeCard');
    expect(api).toContain('sourceIngestSchemaProposalCreate');
    expect(server).toContain('/admin/api/source-ingest/schema-view/type-card/:type');
    expect(server).toContain('/admin/api/source-ingest/schema-view/proposal');
    expect(ops).toContain('schema_type_card');
    expect(ops).toContain('schema_proposal_create');
    expect(ops).toContain('schema-proposals/${date}');
    expect(ops).toContain('Impact-preview');
    expect(ui).toContain('Предложить изменение');
    expect(ui).toContain('Создать proposal-страницу');
    expect(ops).toContain('loadSchemaTypeCard');
    expect(ui).toContain('Catalog connector instance');
    expect(ui).toContain('Base view / Источник');
    expect(ui).toContain('Transform view / Преобразование');
    expect(ui).toContain('Article view / Публикация');
    expect(ui).toContain('Определение');
    expect(ui).toContain('Изменения');
    expect(ui).toContain('Change Intelligence / История изменений');
    expect(ui).toContain('Apply recommended preset');
    expect(ui).toContain('Agent interprets semantic text fields');
    expect(ui).toContain('Persisted contract preview');
    expect(ui).toContain('Превью');
    expect(ui).toContain('Запуски');
    expect(ui).toContain('Run trial batch (20)');
    expect(ui).toContain('Load runs');
    expect(ui).toContain('Stale / chain state');
    expect(ui).toContain('article stale {staleArticleCount}');
    expect(ui).toContain('frozen hash');
    expect(ui).toContain('preview hash');
    expect(ui).toContain('This Article view must be previewed and approved again before batch run');
    expect(server).toContain('/admin/api/source-ingest/catalog/connector/list-objects');
    expect(server).toContain('/admin/api/source-ingest/catalog/connector/test');
    expect(server).toContain('credentials_stored_unverified');
    expect(server).toContain('await connector.sample(objectName, 1)');
    expect(server).toContain('/admin/api/source-ingest/catalog/base-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/transform-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view/run');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view/:article_view_id/runs');
    expect(server).toContain('source_base_view_upsert');
    expect(server).toContain('source_transform_view_upsert');
    expect(server).toContain('source_article_view_upsert');
    expect(server).toContain('change_intelligence');
    expect(server).toContain('source_article_view_approve');
    expect(server).toContain('source_ingest_tree');
  });

  test('connector registry exposes implemented v1 connector kinds', () => {
    const connectors = sourceIngestConnectorDescriptors();
    expect(connectors.map(c => c.id)).toEqual(['appsheet-vehicles', 'postgres', 'fake-source']);
    expect(connectors.find(c => c.id === 'appsheet-vehicles')).toMatchObject({ status: 'implemented', kind: 'appsheet', object: 'vehicle' });
    expect(connectors.find(c => c.id === 'postgres')).toMatchObject({ status: 'implemented', kind: 'postgres', object: 'employees', requiredKeys: ['connection_string'] });
    expect(connectors.find(c => c.id === 'fake-source')).toMatchObject({ status: 'implemented', kind: 'fake', object: 'vehicle' });
    expect(connectors.find(c => c.id === 'bigquery')).toBeUndefined();
  });
});
