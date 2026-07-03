import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceIngestConnectorDescriptors } from '../src/core/source-ingest/connector-registry.ts';

const root = process.cwd();
const sourceIngestUi = () => readFileSync(join(root, 'admin/src/pages/SourceIngest.tsx'), 'utf8');
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

    expect(ui).toContain('Routing / sensitivity');
    expect(ui).toContain('pii_fields:');
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
    expect(ui).toContain('Source table / connector config');
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
    expect(ui).toContain('Scaffold only: можно сохранить source table config');
  });

  test('connector registry exposes scaffold connector types without enabling live IO implicitly', () => {
    const connectors = sourceIngestConnectorDescriptors();
    expect(connectors.map(c => c.id)).toEqual(expect.arrayContaining(['appsheet-vehicles', 'fake-source', 'bigquery', 'postgres', 'supabase', 'bitrix', 'unf']));
    expect(connectors.find(c => c.id === 'appsheet-vehicles')).toMatchObject({ status: 'implemented', object: 'vehicle' });
    expect(connectors.find(c => c.id === 'bigquery')).toMatchObject({ status: 'scaffold', object: 'table', credentialMode: 'db-or-server-env' });
    expect(connectors.find(c => c.id === 'unf')).toMatchObject({ status: 'scaffold', object: 'endpoint' });
    expect(connectors.find(c => c.id === 'bigquery')?.fields?.some(f => f.key === 'primaryKeyField')).toBe(true);
  });
});
