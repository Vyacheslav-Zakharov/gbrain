import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
const producerSource = readFileSync(new URL('../src/core/cycle/propose-takes.ts', import.meta.url), 'utf8');
const reviewSource = readFileSync(new URL('../src/core/ai-review.ts', import.meta.url), 'utf8');

function routeBlock(path: string): string {
  const start = source.indexOf(`app.post('${path}'`);
  expect(start, `missing route ${path}`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\n  app.", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

describe('AI review reversible route contract', () => {
  test('defer is admin-only, same-origin, JSON, and uses the defer transition', () => {
    const block = routeBlock('/admin/api/ai-review/proposals/:id/defer');
    expect(block).toContain('requireAdmin, requireAdminSameOrigin, express.json()');
    expect(block).toContain('deferTakeProposal(');
    expect(block).not.toContain('acceptTakeProposal(');
  });

  test('restore is admin-only, same-origin, JSON, and uses the restore transition', () => {
    const block = routeBlock('/admin/api/ai-review/proposals/:id/restore');
    expect(block).toContain('requireAdmin, requireAdminSameOrigin, express.json()');
    expect(block).toContain('restoreTakeProposalToPending(');
    expect(block).not.toContain('acceptTakeProposal(');
  });

  test('same-claim pending uniqueness is database-enforced without page-wide review locks', () => {
    expect(producerSource).toContain('ON CONFLICT DO NOTHING');
    expect(producerSource).not.toContain('withPageLock(`ai-review:${sourceId}:${page.slug}`');
    expect(producerSource).toContain('withPageLock(`ai-review-claim:${sourceId}:${page.slug}:${claimHash}`');
    expect(reviewSource).toContain('withPageLock(`ai-review-claim:${identity.source_id}:${identity.page_slug}:${identity.claim_hash}`');
  });
});
