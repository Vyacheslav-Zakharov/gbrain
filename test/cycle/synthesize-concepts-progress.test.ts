import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts, type CanonicalTakeInput } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ProgressReporter } from '../../src/core/progress.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id,name,archived) VALUES ('shared','Shared',false) ON CONFLICT (id) DO UPDATE SET archived=false`);
});

function makeMockReporter(): {
  reporter: ProgressReporter;
  events: Array<{ kind: 'tick' | 'heartbeat' | 'start' | 'finish'; note?: string }>;
} {
  const events: Array<{ kind: 'tick' | 'heartbeat' | 'start' | 'finish'; note?: string }> = [];
  const reporter: ProgressReporter = {
    start: () => { events.push({ kind: 'start' }); },
    tick: (_n, note) => { events.push({ kind: 'tick', note }); },
    heartbeat: note => { events.push({ kind: 'heartbeat', note }); },
    finish: note => { events.push({ kind: 'finish', note }); },
    child: () => reporter,
  };
  return { reporter, events };
}

function take(id: number): CanonicalTakeInput {
  return { id, page_id: 100 + id, source_id: 'shared', page_slug: `notes/${id}`, claim: `Русский тезис ${id}`, kind: 'take', holder: 'brain', weight: 0.8, source: `manual:${id}` };
}

function stubChat(groups: number): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => {
    const rows = Array.from({ length: groups }, (_, i) => ({
      slug: `concept-${i + 1}`,
      title_ru: `Концепция ${i + 1}`,
      summary_ru: `Русское описание концепции ${i + 1} сохраняет конкретные механизмы и не расширяет исходные подтверждённые тезисы.`,
      take_ids: [i * 2 + 1, i * 2 + 2],
    }));
    const text = JSON.stringify(rows);
    return {
      text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
    };
  };
}

describe('Take-based synthesize_concepts progress wiring', () => {
  test('phase does not call start or finish', async () => {
    const { reporter, events } = makeMockReporter();
    await runPhaseSynthesizeConcepts(engine, { sourceId: 'shared', _takes: [take(1), take(2)], _chat: stubChat(1), progress: reporter });
    expect(events.filter(e => e.kind === 'start')).toHaveLength(0);
    expect(events.filter(e => e.kind === 'finish')).toHaveLength(0);
  });

  test('one tick per validated concept group', async () => {
    const { reporter, events } = makeMockReporter();
    await runPhaseSynthesizeConcepts(engine, { sourceId: 'shared', _takes: [take(1), take(2), take(3), take(4)], _chat: stubChat(2), progress: reporter });
    const ticks = events.filter(e => e.kind === 'tick');
    expect(ticks).toHaveLength(2);
    expect(ticks[0].note).toMatch(/proposals/);
  });

  test('progress remains optional', async () => {
    const output = await runPhaseSynthesizeConcepts(engine, { sourceId: 'shared', _takes: [] });
    expect(output.phase).toBe('synthesize_concepts');
  });
});
