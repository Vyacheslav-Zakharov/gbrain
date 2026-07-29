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

  test('Concept Review clears stale rows and counters when a list request fails', () => {
    const source = readFileSync(new URL('../admin/src/pages/ConceptReview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('setRows([]);');
    expect(source).toContain('setTotal(0);');
    expect(source).toContain('setSelected(null);');
  });
});
