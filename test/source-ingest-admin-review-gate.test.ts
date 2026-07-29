import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
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
const adminCss = () => readFileSync(join(root, 'admin/src/index.css'), 'utf8');

describe('source-ingest admin review gates', () => {
  test('article approval is pinned to dry-run current_chain_hash', () => {
    const ui = sourceIngestUi();
    const server = serveHttp();
    const ops = operations();
    const api = adminApi();

    expect(ui).toContain('articleViewCurrentChainHash');
    expect(ui).toContain('Для утверждения сначала выполните предпросмотр');
    expect(ui).toContain('Зафиксировать snapshot');
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
    expect(ui).toContain('Разделы статьи из schema-template');
    expect(ui).toContain('requiredFrontmatter');
    expect(ui).toContain('articleTemplate');
    expect(ui).toContain('sourceIngestArticleTemplate');
    expect(ui).not.toContain('Legacy source table / connector config');
    expect(ui).not.toContain('Legacy profile workflow');
    expect(ui).not.toContain('Profiles / refresh');
    expect(ui).toContain('Студия Source Ingest');
    expect(ui).toContain('Каталог подключений, преобразований и публикаций');
    expect(ui).toContain('Мастер «Новая публикация»');
    expect(ui).toContain('На шаге «Сохранить и дальше»');
    expect(ui).toContain('Сохранить и дальше');
    expect(ui).toContain('Операция сохранения:');
    expect(ui).toContain('<summary>Цепочка публикации</summary>');
    expect(ui).toContain('lastAppliedHashRoute.current = nextHash');
    expect(ui).toContain('if (window.location.hash === lastAppliedHashRoute.current) return;');
    expect(ui).toContain('const preserveExistingSections = opts.resetEmpty === true && articleDirty;');
    expect(ui).not.toContain('setArticleSections({ ...DEFAULT_ARTICLE_SECTIONS, ...Object.fromEntries');
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
    expect(ui).toContain('Подключение к источнику');
    expect(ui).toContain('Источник (Base view)');
    expect(ui).toContain('Преобразование (Transform view)');
    expect(ui).toContain('Публикация (Article view)');
    expect(ui).toContain('Определение');
    expect(ui).toContain('Изменения');
    expect(ui).toContain('История изменений (Change Intelligence)');
    expect(ui).toContain('Применить рекомендуемый шаблон');
    expect(ui).toContain('Агент анализирует смысловые текстовые поля');
    expect(ui).toContain('Сохранённый контракт');
    expect(ui).toContain('Превью');
    expect(ui).toContain('Запуски');
    expect(ui).toContain('Пробный запуск (20)');
    expect(ui).toContain('Загрузить запуски');
    expect(ui).toContain('Состояние цепочки');
    expect(ui).toContain('article stale {staleArticleCount}');
    expect(ui).toContain('зафиксирован');
    expect(ui).toContain('хэш предпросмотра');
    expect(ui).toContain('Перед пакетным запуском нужен новый предпросмотр и повторное утверждение');
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

  test('source-ingest guided workflow reduces competing navigation and advanced noise', () => {
    const ui = sourceIngestUi();
    const css = adminCss();

    expect(ui).toContain('navigateToStep');
    expect(ui).toContain('onClick={() => navigateToStep(step - 1)}');
    expect(ui).toContain('onClick={() => navigateToStep(step + 1)}');
    expect(ui).not.toContain('onClick={() => setStep(Math.max(0, step - 1))}');
    expect(ui).not.toContain('onClick={() => setStep(Math.min(steps.length - 1, step + 1))}');

    expect(ui).toContain('<details className="source-ingest-lineage"');
    expect(ui).toContain('<summary>Цепочка публикации</summary>');
    expect(ui).toContain('<summary>Дополнительные настройки</summary>');
    expect(ui).toContain('<summary>Технические детали</summary>');

    expect(ui).toContain('btn btn-primary source-ingest-context-primary');
    expect(ui).toContain("articleViewCurrentChainHash || tab === 'preview'");
    expect(ui).not.toContain('done: counts.');
    expect(ui).toContain('btn btn-danger');
    expect(ui).toContain('source-ingest-layout');
    expect(ui).toContain('source-ingest-article-definition');
    expect(css).toContain('.source-ingest-layout { grid-template-columns: minmax(0, 1fr) !important; }');
    expect(css).toContain('.source-ingest-form-grid { grid-template-columns: minmax(0, 1fr) !important; }');
    expect(css).toContain('main:has(> .source-ingest-wizard--open) .source-ingest-context-primary { display: none; }');
  });

  test('source-ingest editors use Russian actions and non-primary tabs', () => {
    const ui = sourceIngestUi();
    const forbiddenVisibleCopy = [
      'Seed from legacy discovery',
      'Save base view',
      'Seed from selected base view',
      'Generate SELECT',
      'Save transform view',
      'Seed from current transform/base',
      'Save article view',
      'Preview required before approval.',
      'Required fields not filled:',
      'No article preview yet.',
      'Load runs',
      'Run trial batch (20)',
      'Run changed_since',
      'Apply recommended preset',
      'Policy needs attention',
      'Persisted contract preview',
    ];
    for (const copy of forbiddenVisibleCopy) expect(ui).not.toContain(copy);

    expect(ui).toContain('role="tablist"');
    expect(ui).toContain('role="tab"');
    expect(ui).toContain('aria-selected={active === tab}');
    expect(ui).toContain('className="btn btn-secondary source-ingest-tab"');
    expect(ui).toContain('return <button className="btn btn-secondary" disabled={busy !== null} onClick={() => { setOpen(true)');
    expect(ui).toContain('Сохранить источник');
    expect(ui).toContain('Создать SELECT');
    expect(ui).toContain('Сохранить преобразование');
    expect(ui).toContain('Сохранить публикацию');
    expect(ui).toContain('Запустить только изменившиеся');
  });

  test('destructive source-ingest actions live in one collapsed danger-zone contract', () => {
    const shared = readFileSync(join(root, 'admin/src/pages/source-ingest/shared.tsx'), 'utf8');
    const css = adminCss();
    const editors = [
      ['ConnectorEditor.tsx', 2],
      ['BaseViewEditor.tsx', 1],
      ['TransformViewEditor.tsx', 1],
      ['ArticleViewEditor.tsx', 1],
    ] as const;
    const editorSources = editors.map(([name]) => readFileSync(join(root, 'admin/src/pages/source-ingest', name), 'utf8'));

    expect(shared).toContain('export function DangerZone');
    expect(shared).toContain('<details className="source-ingest-danger-zone">');
    expect(shared).toContain('<summary>Опасные действия</summary>');
    expect(shared).not.toContain('<details className="source-ingest-danger-zone" open');
    expect(css).toContain('.source-ingest-danger-zone');
    expect(editorSources.reduce((count, editor) => count + (editor.match(/<DangerZone/g)?.length ?? 0), 0)).toBe(4);
    for (const [index, editor] of editorSources.entries()) {
      expect(editor).toMatch(/<DangerZone[\s\S]*className="btn btn-danger"[\s\S]*<\/DangerZone>/);
      expect(editor.match(/className="btn btn-danger"/g)?.length).toBe(editors[index][1]);
    }
  });

  test('source-ingest orchestration uses one typed async action runner', () => {
    const hookPath = join(root, 'admin/src/pages/source-ingest/useAsyncActionRunner.ts');
    const coordinator = readFileSync(join(root, 'admin/src/pages/SourceIngest.tsx'), 'utf8');

    expect(existsSync(hookPath)).toBe(true);
    if (!existsSync(hookPath)) return;
    const hook = readFileSync(hookPath, 'utf8');
    expect(hook).toContain('export function useAsyncActionRunner');
    expect(hook).toContain('Promise<T | undefined>');
    expect(hook).toContain('setBusy(name)');
    expect(hook).toContain('setError(toErrorMessage(error))');
    expect(hook).toContain('finally');
    expect(coordinator).toContain("import { useAsyncActionRunner } from './source-ingest/useAsyncActionRunner';");
    expect(coordinator).toContain('const { busy, error: err, setError: setErr, run: runStep } = useAsyncActionRunner();');
    expect(coordinator).not.toContain('const [busy, setBusy] = useState');
    expect(coordinator).not.toContain('const [err, setErr] = useState');
    expect(coordinator).not.toContain('const runStep = async');
    expect(coordinator).toContain("return (await runStep('schema-proposal'");
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
