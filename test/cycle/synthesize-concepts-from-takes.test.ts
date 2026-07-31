import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  parseTakeGroupsResponse,
  runPhaseSynthesizeConcepts,
  SYNTHESIZE_CONCEPTS_PROMPT_VERSION,
  type CanonicalTakeInput,
} from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id,name,archived) VALUES ('shared','Shared',false) ON CONFLICT (id) DO UPDATE SET archived=false`);
});

function take(id: number, sourceId = 'shared'): CanonicalTakeInput {
  return {
    id, page_id: 1000 + id, source_id: sourceId, page_slug: `notes/p-${id}`,
    claim: `Подтверждённый тезис ${id} о конкретном механизме контроля.`,
    kind: 'take', holder: 'brain', weight: 0.8, source: `take-proposal:${id}`,
  };
}

function result(text: string): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  };
}

function groupingChat(slug = 'kontrol-riskov', title = 'Контроль рисков'): (o: ChatOpts) => Promise<ChatResult> {
  return async (opts: ChatOpts) => {
    const rawContent = opts.messages[0]?.content ?? '';
    const body = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
    const match = body.match(/<UNTRUSTED_TAKES_JSON>\n([\s\S]*?)\n<\/UNTRUSTED_TAKES_JSON>/);
    const rows = JSON.parse(match?.[1] ?? '[]') as Array<{ id: number }>;
    return result(JSON.stringify([{
      slug, title_ru: title,
      summary_ru: 'Концепция объединяет подтверждённые механизмы контроля и сохраняет их точный операционный смысл. Она не расширяет область действия исходных тезисов.',
      take_ids: rows.slice(0, 3).map(r => r.id),
    }]));
  };
}

describe('Take-based Russian concept synthesis', () => {
  test('skips when there are no active canonical Takes', async () => {
    const output = await runPhaseSynthesizeConcepts(engine, { _takes: [] });
    expect(output.status).toBe('skipped');
    expect(output.details?.reason).toBe('no_active_takes');
  });

  test('validator enforces Russian text, allowed IDs and slug grammar', () => {
    const takes = [take(1), take(2), take(3)];
    const summary = 'Русское описание сохраняет конкретный механизм контроля и не добавляет новых фактов.';
    const parsed = parseTakeGroupsResponse(JSON.stringify([
      { slug: 'valid-concept', title_ru: 'Валидная концепция', summary_ru: summary, take_ids: [1, 2] },
      { slug: 'Bad_Slug', title_ru: 'Плохая', summary_ru: summary, take_ids: [1, 2] },
      { slug: 'english-title', title_ru: 'English only', summary_ru: summary, take_ids: [1, 2] },
      { slug: 'foreign-id', title_ru: 'Чужой идентификатор', summary_ru: summary, take_ids: [1, 99] },
    ]), takes);
    expect(parsed).toEqual([{ slug: 'valid-concept', title_ru: 'Валидная концепция', summary_ru: summary, take_ids: [1, 2] }]);
  });

  test('normalizes PostgreSQL bigint and numeric string values before validation', async () => {
    const pgTakes = [
      { ...take(1), id: '1', page_id: '1001', weight: '0.8' },
      { ...take(2), id: '2', page_id: '1002', weight: '0.8' },
    ] as unknown as CanonicalTakeInput[];
    const output = await runPhaseSynthesizeConcepts(engine, { _takes: pgTakes, _chat: groupingChat(), dryRun: true });
    expect(output.details?.takes_seen).toBe(2);
    expect(output.details?.sources_seen).toBe(1);
    expect(output.details?.groups_found).toBe(1);
  });

  test('isolates sources and writes pending proposals with immutable source_takes only', async () => {
    await engine.executeRaw(`INSERT INTO sources (id,name,archived) VALUES ('shared','Shared',false),('hidden','Hidden',false) ON CONFLICT (id) DO UPDATE SET archived=false`);
    const takes = [take(1, 'shared'), take(2, 'shared'), take(3, 'hidden'), take(4, 'hidden')];
    const output = await runPhaseSynthesizeConcepts(engine, { _takes: takes, _chat: groupingChat() });
    expect(output.status).toBe('ok');
    expect(output.details?.concepts_written).toBe(2);
    expect(output.details?.prompt_version).toBe(SYNTHESIZE_CONCEPTS_PROMPT_VERSION);
    const rows = await engine.executeRaw<{ source_id: string; status: string; source_atoms: unknown[]; source_takes: Array<{ id: number; source_id: string }>; proposed_markdown: string }>(
      `SELECT source_id,status,source_atoms,source_takes,proposed_markdown FROM concept_proposals ORDER BY source_id`,
    );
    expect(rows.map(r => r.source_id)).toEqual(['hidden', 'shared']);
    expect(rows.every(r => r.status === 'pending' && r.source_atoms.length === 0)).toBe(true);
    expect(rows.every(r => r.source_takes.length === 2 && r.source_takes.every(t => t.source_id === r.source_id))).toBe(true);
    expect(rows.every(r => r.proposed_markdown.includes('Контроль рисков'))).toBe(true);
    expect(await engine.getPage('concepts/kontrol-riskov', { sourceId: 'shared' })).toBeNull();
    expect(await engine.getPage('concepts/kontrol-riskov', { sourceId: 'hidden' })).toBeNull();
  });

  test('DB query includes only active, non-superseded Takes on active pages', async () => {
    await engine.executeRaw(`INSERT INTO sources (id,name,archived) VALUES ('shared','Shared',false) ON CONFLICT (id) DO UPDATE SET archived=false`);
    await engine.putPage('notes/a', { title: 'A', type: 'note', compiled_truth: 'A', frontmatter: {}, timeline: '' }, { sourceId: 'shared' });
    await engine.putPage('notes/b', { title: 'B', type: 'note', compiled_truth: 'B', frontmatter: {}, timeline: '' }, { sourceId: 'shared' });
    const pages = await engine.executeRaw<{ id: number; slug: string }>(`SELECT id,slug FROM pages WHERE source_id='shared' ORDER BY slug`);
    const a = pages.find(p => p.slug === 'notes/a')!.id;
    const b = pages.find(p => p.slug === 'notes/b')!.id;
    await engine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight,source,active) VALUES ($1,1,'Активный тезис один','take','brain',0.8,'manual:a',true),($1,2,'Активный тезис два','take','brain',0.8,'manual:b',true),($2,1,'Неактивный тезис','take','brain',0.8,'manual:c',false)`, [a,b]);
    const output = await runPhaseSynthesizeConcepts(engine, { _chat: groupingChat() });
    expect(output.details?.takes_seen).toBe(2);
    const proposal = await engine.executeRaw<{ source_takes: Array<{ claim: string }> }>(`SELECT source_takes FROM concept_proposals WHERE source_id='shared'`);
    expect(proposal[0].source_takes.map(t => t.claim)).toEqual(['Активный тезис один', 'Активный тезис два']);
  });

  test('prompt requires Russian and phase never publishes canonical pages', async () => {
    let system = '';
    const chat = async (opts: ChatOpts) => { system = opts.system ?? ''; return groupingChat()(opts); };
    await runPhaseSynthesizeConcepts(engine, { _takes: [take(10), take(11)], _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat });
    expect(system).toContain('на русском языке');
    expect(system).toContain('не превращай прогноз или bet в установленный факт');
    const pages = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pages WHERE slug LIKE 'concepts/%'`);
    expect(pages[0].count).toBe(0);
  });

  test('dry-run validates and counts but writes neither proposals nor pages', async () => {
    const output = await runPhaseSynthesizeConcepts(engine, { _takes: [take(20), take(21)], _chat: groupingChat(), dryRun: true });
    expect(output.details?.concepts_written).toBe(1);
    const proposals = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM concept_proposals`);
    const pages = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pages WHERE slug LIKE 'concepts/%'`);
    expect(proposals[0].count).toBe(0);
    expect(pages[0].count).toBe(0);
  });
});
