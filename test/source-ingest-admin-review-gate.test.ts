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
    expect(ui).toContain('Source Ingest Studio');
    expect(ui).toContain('Denodo-style catalog tree');
    expect(ui).toContain('Мастер «Новая публикация»');
    expect(ui).toContain('Alt+1…Alt+5');
    expect(ui).toContain('Lineage / цепочка публикации');
    expect(ui).toContain('window.location.hash = `#source-ingest/${routeArea}`');
    expect(ui).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(ui).toContain('handleSelectCatalogNode(hit.node)');
    expect(ui).toContain('Search catalog…');
    expect(ui).toContain('New base view…');
    expect(ui).toContain('New transform view…');
    expect(ui).toContain('New article view…');
    expect(ui).toContain('Schema view');
    expect(ui).toContain('Catalog connector instance');
    expect(ui).toContain('Base view / Источник');
    expect(ui).toContain('Transform view / Преобразование');
    expect(ui).toContain('Article view / Публикация');
    expect(ui).toContain('Определение');
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
    expect(server).toContain('/admin/api/source-ingest/catalog/base-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/transform-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view/run');
    expect(server).toContain('/admin/api/source-ingest/catalog/article-view/:article_view_id/runs');
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
