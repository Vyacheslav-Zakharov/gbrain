/**
 * E2E — `gbrain recall --today` markdown render against real Postgres.
 * Dedicated source: persisted sources from earlier shard files must not route recall.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { runRecall } from '../../src/commands/recall.ts';
import { resolveSourceId } from '../../src/core/source-resolver.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const SOURCE = 'e2e-recall-render';
let home: string | undefined;
let sourceCreated = false;

beforeAll(async () => {
  if (!RUN) return;
  await setupDB();
  home = mkdtempSync(join(tmpdir(), 'gbrain-recall-render-'));
  // Fail on a collision rather than borrowing and later deleting another fixture's row.
  await getEngine().executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SOURCE]);
  sourceCreated = true;
});
afterAll(async () => {
  if (!RUN) return;
  try {
    if (sourceCreated) {
      await getEngine().executeRaw('DELETE FROM sources WHERE id = $1', [SOURCE]);
      expect(await getEngine().executeRaw('SELECT id FROM sources WHERE id = $1', [SOURCE])).toEqual([]);
    }
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
    await teardownDB();
  }
});

d('gbrain recall --today (Postgres)', () => {
  test('renders seeded markdown with kind icons from the explicit source', async () => {
    const engine = getEngine();
    await withEnv({ GBRAIN_HOME: home!, GBRAIN_SOURCE: undefined }, async () => {
      expect(await resolveSourceId(engine, SOURCE)).toBe(SOURCE);
      const event = await engine.insertFact(
        { fact: 'render-event', kind: 'event', entity_slug: 'render-pg-e', source: 'test' },
        { source_id: SOURCE },
      );
      const preference = await engine.insertFact(
        { fact: 'render-pref', kind: 'preference', entity_slug: 'render-pg-p', source: 'test' },
        { source_id: SOURCE },
      );
      expect(event.status).toBe('inserted');
      expect(preference.status).toBe('inserted');
      const rows = await engine.listFactsSince(SOURCE, new Date(0));
      expect(rows.map(row => row.id).sort((a, b) => a - b)).toEqual(
        [event.id, preference.id].sort((a, b) => a - b),
      );
      expect(rows.every(row => row.source_id === SOURCE)).toBe(true);
      expect(rows.map(row => row.fact).sort()).toEqual(['render-event', 'render-pref']);

      const origWrite = process.stdout.write.bind(process.stdout);
      let captured = '';
      process.stdout.write = ((chunk: string | Uint8Array) => {
        captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return true;
      }) as typeof process.stdout.write;
      try {
        await runRecall(engine, ['--today', '--source', SOURCE]);
      } finally {
        process.stdout.write = origWrite;
      }
      expect(captured).toContain('Hot memory — ');
      expect(captured).toContain('render-event');
      expect(captured).toContain('render-pref');
      expect(captured).toContain('📅');
      expect(captured).toContain('🎯');
      expect(captured).not.toContain('No facts captured');
    });
  });
});
