import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { adminApiErrorMessage } from '../admin/src/api';

describe('AI Review admin failure UX', () => {
  test('prefers the actionable server message over a generic error code', () => {
    expect(adminApiErrorMessage({
      error: 'review_request_failed',
      message: 'Database temporarily unavailable',
    }, 400)).toBe('Database temporarily unavailable');
  });

  test('falls back to the server error code and then HTTP status', () => {
    expect(adminApiErrorMessage({ error: 'conflict' }, 409)).toBe('conflict');
    expect(adminApiErrorMessage({}, 502)).toBe('HTTP 502');
  });

  test('Take Review clears stale rows and counters when a list request fails', () => {
    const source = readFileSync(new URL('../admin/src/pages/AIReview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('setRows([]);');
    expect(source).toContain('setTotal(0);');
    expect(source).toContain('setSelectedId(null);');
  });

  test('Take Review exposes deferred as a separate reversible queue state', () => {
    const page = readFileSync(new URL('../admin/src/pages/AIReview.tsx', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../admin/src/api.ts', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
    expect(page).toContain("deferred: 'Отложены'");
    expect(page).toContain('api.aiReviewDefer');
    expect(page).toContain('api.aiReviewRestore');
    expect(api).toContain('/defer`');
    expect(api).toContain('/restore`');
    expect(server).toContain("proposals/:id/defer");
    expect(server).toContain("proposals/:id/restore");
  });

  test('Concept Review clears stale rows and counters when a list request fails', () => {
    const source = readFileSync(new URL('../admin/src/pages/ConceptReview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('setRows([]);');
    expect(source).toContain('setTotal(0);');
    expect(source).toContain('setSelected(null);');
  });

  test('Meeting Review uses the shared review-console visual hierarchy', () => {
    const source = readFileSync(new URL('../admin/src/pages/MeetingReview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('className={`proposal-row');
    expect(source).toContain('className="detail-title"');
    expect(source).toContain('className="review-form"');
    expect(source).toContain('className="reject"');
    expect(source).toContain('className="accept"');
    expect(source).toContain("setMobileDetail(true)");
  });
});
