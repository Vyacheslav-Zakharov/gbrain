import { describe, expect, test } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';
import { readFileSync } from 'fs';

const SERVE_HTTP = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');

describe('source_dry_run remote safety', () => {
  test('source_dry_run is localOnly and therefore absent from MCP operations', () => {
    const op = operationsByName.source_dry_run;
    expect(op).toBeDefined();
    expect(op.scope).toBe('read');
    expect(op.localOnly).toBe(true);
    expect(operations.filter(o => !o.localOnly).map(o => o.name)).not.toContain('source_dry_run');
  });

  test('/mcp POST route is rate-limited before bearer-auth/tool execution', () => {
    expect(SERVE_HTTP).toContain('const mcpRateLimiter = rateLimit({');
    expect(SERVE_HTTP).toContain("app.post('/mcp', mcpRateLimiter, requireBearerAuth");
  });

  test('admin approval route binds approve to last dry-run profile_hash and server-side ack state', () => {
    expect(SERVE_HTTP).toContain('sourceIngestDryRunApprovals.set(sourceIngestDryRunKey(req)');
    expect(SERVE_HTTP).toContain("error: 'dry_run_profile_hash_mismatch'");
    expect(SERVE_HTTP).toContain("error: 'sensitivity_ack_required'");
    expect(SERVE_HTTP).toContain('profile_hash: dry_run_profile_hash');
  });

  test('transform-preview validates profile and caps preview request/response size', () => {
    expect(SERVE_HTTP).toContain('clampSourceIngestPreviewLimit(req.body?.sample_limit)');
    expect(SERVE_HTTP).toContain('validateSourceIngestProfile(req.body.profile)');
    expect(SERVE_HTTP).toContain('capSourceIngestPreviewPayload(previewRecords)');
    expect(SERVE_HTTP).toContain('returned: capped.records.length');
  });
});
