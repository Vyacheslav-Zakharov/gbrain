import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

    expect(ui).toContain('Routing / sensitivity');
    expect(ui).toContain('pii_fields:');
    expect(ui).toContain('requiresSensitivityAck');
    expect(ui).toContain('sensitivityAck');
    expect(ui).toContain('sensitivity_ack_required');
    expect(ui).toContain('[PII masked]');
    expect(ui).toContain('Article mapping editor');
    expect(ui).toContain('Rendered article previews');
    expect(ui).toContain('empty template slots');
    expect(ui).toContain('(!requiresSensitivityAck || sensitivityAck)');
  });
});
