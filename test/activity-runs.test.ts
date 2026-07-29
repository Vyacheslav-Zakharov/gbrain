import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  normalizeActivityRun,
  readActivitySnapshot,
  resolveActivityRange,
} from '../src/commands/activity-runs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
}, 30_000);

describe('activity runs', () => {
  test('resolves preset and bounded custom ranges', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    expect(resolveActivityRange({ period: '7d' }, now)).toEqual({
      period: '7d',
      since: '2026-07-13T12:00:00.000Z',
      until: '2026-07-20T12:00:00.000Z',
    });
    expect(resolveActivityRange({ since: '2026-07-01', until: '2026-07-20' }, now).period).toBe('custom');
    const yesterday = resolveActivityRange({ period: 'yesterday' }, now);
    expect(yesterday.period).toBe('yesterday');
    expect(new Date(yesterday.until).getTime() - new Date(yesterday.since).getTime()).toBe(24 * 60 * 60 * 1000);
    expect(new Date(yesterday.until).getHours()).toBe(0);
    expect(() => resolveActivityRange({ period: '2d' }, now)).toThrow('Invalid period');
    expect(() => resolveActivityRange({ since: '2025-01-01', until: '2026-07-20' }, now)).toThrow('366 days');
  });

  test('normalizes a job report into safe run and phase details', () => {
    const run = normalizeActivityRun({
      id: 42,
      name: 'autopilot-cycle',
      status: 'completed',
      source_id: 'shared',
      created_at: '2026-07-20T10:00:00Z',
      started_at: '2026-07-20T10:01:00Z',
      finished_at: '2026-07-20T10:03:00Z',
      error_text: 'postgresql://user:password@db.example/private',
      result: {
        status: 'partial',
        report: {
          phases: [{
            phase: 'extract_atoms',
            status: 'ok',
            duration_ms: 1234,
            summary: '2 atoms token=abc https://private.example/path',
            details: {
              atoms_extracted: 2,
              connection_string: 'postgresql://user:password@db.example/private',
              per_source: { shared: { prompt: 'secret' } },
            },
            pagesAffected: ['notes/a', 7, 'notes/b'],
            error: { code: 'ETIMEDOUT', message: 'secret=abc' },
          }],
        },
      },
    });

    expect(run.partial).toBe(true);
    expect(run.duration_ms).toBe(120_000);
    expect(run.phases).toEqual([{
      phase: 'extract_atoms',
      status: 'ok',
      duration_ms: 1234,
      summary: '2 atoms [redacted-secret] [redacted-url]',
      details: { atoms_extracted: 2 },
      has_error: true,
      error_code: 'ETIMEDOUT',
      pages_affected_count: 2,
    }]);
    expect(run.has_error).toBe(true);
    expect(JSON.stringify(run)).not.toContain('password');
    expect(JSON.stringify(run)).not.toContain('connection_string');
    expect(JSON.stringify(run)).not.toContain('notes/a');
  });

  test('builds a period snapshot from aggregate and run queries', async () => {
    const responses: unknown[][] = [
      [{ total: '2', completed: '2', partial: '1', failed: '0', dead: '0', cancelled: '0', active: '0', waiting: '0', duration_ms: '180000' }],
      [{ estimated_spend_usd: '0.25', pages_changed: '3', atoms_extracted: '2', concepts_written: '1', proposals_inserted: '4', takes_written: '1', facts_inserted: '5' }],
      [{ phase: 'propose_takes', status: 'ok', runs: '2', duration_ms: '120000', estimated_spend_usd: '0.2' }],
      [{ key: 'autopilot-cycle', total: '2', completed: '2', failed: '0', partial: '1' }],
      [{ key: 'shared', total: '2', completed: '2', failed: '0', partial: '1' }],
      [{
        id: 7,
        name: 'autopilot-cycle',
        status: 'completed',
        source_id: 'shared',
        created_at: '2026-07-20T11:00:00Z',
        started_at: '2026-07-20T11:00:00Z',
        finished_at: '2026-07-20T11:01:00Z',
        error_text: null,
        result: { report: { status: 'clean', phases: [] } },
      }],
    ];
    let index = 0;
    const engine = {
      executeRaw: async () => responses[index++] ?? [],
    } as unknown as BrainEngine;

    const snap = await readActivitySnapshot(engine, { period: '24h', source: 'shared', limit: 10 }, new Date('2026-07-20T12:00:00Z'));
    expect(snap.summary).toMatchObject({
      total: 2,
      partial: 1,
      estimated_spend_usd: 0.25,
      atoms_extracted: 2,
      concepts_written: 1,
    });
    expect(snap.filters).toEqual({ source: 'shared' });
    expect(snap.phase_rollup[0].phase).toBe('propose_takes');
    expect(snap.runs[0]).toMatchObject({ id: 7, source_id: 'shared', duration_ms: 60_000 });
    expect(snap.pagination).toEqual({ limit: 10, offset: 0, returned: 1, total: 2, export_truncated: false });
    expect(snap.statuses).toContain('waiting-children');
  });

  test('executes safe aggregates, independent facets, and bounded export on PGLite', async () => {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, result, error_text, created_at, started_at, finished_at)
       VALUES
       ($1, 'completed', $2::text::jsonb, $3::text::jsonb, $4, now(), now() - interval '2 seconds', now()),
       ('sync', 'delayed', '{"source_id":"shared"}'::jsonb, NULL, NULL, now(), NULL, NULL),
       ('sync', 'completed', '{"source_id":"other"}'::jsonb, NULL, NULL, now(), now(), now())`,
      [
        'autopilot-cycle',
        JSON.stringify({ source_id: 'shared', connection_string: 'postgresql://data-secret@db/private' }),
        JSON.stringify({ report: { status: 'partial', phases: [{
          phase: 'extract_atoms', status: 'ok', duration_ms: 1500,
          summary: 'done token=result-secret',
          details: {
            atoms_extracted: 3,
            estimated_spend_usd: 0.02,
            connection_string: 'postgresql://phase-secret@db/private',
            nested: { prompt: 'prompt-secret' },
          },
          error: { code: 'E_PHASE', message: 'password=error-secret' },
          pagesAffected: ['private/page-slug'],
        }] } }),
        'authorization=job-error-secret',
      ],
    );

    const snap = await readActivitySnapshot(engine, { period: '24h', source: 'shared', limit: 10 });
    expect(snap.summary).toMatchObject({ total: 2, completed: 1, delayed: 1, partial: 1, atoms_extracted: 3 });
    expect(snap.summary.estimated_spend_usd).toBeCloseTo(0.02);
    expect(snap.phase_rollup).toEqual([expect.objectContaining({ phase: 'extract_atoms', runs: 1 })]);
    expect(snap.by_type.map(row => row.name)).toEqual(['autopilot-cycle', 'sync']);
    expect(snap.by_source.map(row => row.source_id)).toEqual(['shared', 'other']);
    expect(snap.runs[0]).toMatchObject({ source_id: 'shared' });
    const serialized = JSON.stringify(snap);
    for (const secret of ['data-secret', 'phase-secret', 'prompt-secret', 'error-secret', 'job-error-secret', 'private/page-slug']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('connection_string');

    const exported = await readActivitySnapshot(engine, { period: '24h', exportAll: true, limit: 1, offset: 1 });
    expect(exported.pagination).toEqual({ limit: 5000, offset: 0, returned: 3, total: 3, export_truncated: false });
    expect(exported.runs).toHaveLength(3);
  });
});
