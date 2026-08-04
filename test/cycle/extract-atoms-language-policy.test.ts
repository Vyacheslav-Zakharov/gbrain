import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  atomSourcePolicyViolation,
  parseAtomsResponse,
  runPhaseExtractAtoms,
} from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function atom(json: Record<string, unknown>) {
  const parsed = parseAtomsResponse(JSON.stringify([json]));
  expect(parsed).toHaveLength(1);
  return parsed[0];
}

const russianSource = [
  'На встрече команда решила подготовить отопление лаборатории до наступления холодов.',
  'Ответственный должен проверить батареи и завершить работы заранее.',
].join(' ');

const englishSource = [
  'The team decided to prepare the laboratory heating system before cold weather arrives.',
  'The owner must inspect the radiators and finish the work early.',
].join(' ');

describe('extract_atoms source-language and quotation policy', () => {
  test('accepts Russian generated fields for a Russian source', () => {
    const candidate = atom({
      title: 'Подготовка отопления лаборатории',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее. Это снижает риск зимних сбоев.',
      lesson: 'Инфраструктурные работы следует завершать до наступления холодов.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    });
    expect(atomSourcePolicyViolation(candidate, russianSource)).toBeNull();
  });

  test('rejects English generated fields for a Russian source', () => {
    const candidate = atom({
      title: 'Prepare the laboratory heating early',
      atom_type: 'insight',
      body: 'The heating system should be prepared before winter. Early work lowers operational risk.',
      lesson: 'Finish seasonal maintenance before cold weather.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    });
    expect(atomSourcePolicyViolation(candidate, russianSource)).toBe('generated_language_mismatch');
  });

  test('checks title, body, and lesson separately rather than letting one field mask another', () => {
    const englishTitle = atom({
      title: 'Prepare the laboratory heating system early',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее. Это снижает риск зимних сбоев.',
      lesson: 'Инфраструктурные работы следует завершать до наступления холодов.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    });
    expect(atomSourcePolicyViolation(englishTitle, russianSource)).toBe('generated_language_mismatch');

    const englishLesson = atom({
      title: 'Подготовка отопления лаборатории',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее. Это снижает риск зимних сбоев.',
      lesson: 'Finish seasonal maintenance before cold weather arrives.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    });
    expect(atomSourcePolicyViolation(englishLesson, russianSource)).toBe('generated_language_mismatch');
  });

  test('rejects a short wrong-language title but permits uppercase technical identifiers', () => {
    const shortEnglishTitle = atom({
      title: 'Plan',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее.',
      lesson: 'Работы следует завершить до холодов.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    });
    expect(atomSourcePolicyViolation(shortEnglishTitle, russianSource)).toBe('generated_language_mismatch');

    const uppercaseEnglishTitle = atom({
      title: 'PLAN UPDATE',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее.',
      lesson: 'Работы следует завершить до холодов.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    });
    expect(atomSourcePolicyViolation(uppercaseEnglishTitle, russianSource)).toBe('generated_language_mismatch');

    const technicalTitle = atom({
      title: 'API SLA',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее.',
      lesson: 'Работы следует завершить до холодов.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    });
    expect(atomSourcePolicyViolation(technicalTitle, russianSource)).toBeNull();
  });

  test('accepts English generated fields for an English source', () => {
    const candidate = atom({
      title: 'Prepare laboratory heating early',
      atom_type: 'insight',
      body: 'The heating system should be prepared before winter. Early work lowers operational risk.',
      lesson: 'Finish seasonal maintenance before cold weather.',
      source_quote: 'prepare the laboratory heating system before cold weather arrives',
    });
    expect(atomSourcePolicyViolation(candidate, englishSource)).toBeNull();
  });

  test('uses the quoted relevant fragment for a genuinely mixed-language source', () => {
    const mixedSource = `${russianSource} The owner must inspect the radiators before winter. ${russianSource}`;
    const candidate = atom({
      title: 'Inspect the radiators before winter',
      atom_type: 'insight',
      body: 'The owner should inspect the radiators before cold weather arrives.',
      lesson: 'Finish heating checks before winter.',
      source_quote: 'The owner must inspect the radiators before winter.',
    });
    expect(atomSourcePolicyViolation(candidate, mixedSource)).toBeNull();
  });

  test('rejects translated, paraphrased, or punctuation-modified source quotes', () => {
    const missing = atom({
      title: 'Подготовка отопления лаборатории',
      atom_type: 'insight',
      body: 'Отопление лаборатории следует подготовить до холодов.',
      lesson: 'Инфраструктурные работы нужно планировать заранее.',
    });
    expect(atomSourcePolicyViolation(missing, russianSource)).toBe('source_quote_missing');

    const translated = atom({
      title: 'Подготовка отопления лаборатории',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее.',
      lesson: 'Работы следует завершить до холодов.',
      source_quote: 'The team decided to prepare the laboratory heating before winter.',
    });
    expect(atomSourcePolicyViolation(translated, russianSource)).toBe('source_quote_not_verbatim');

    const punctuationChanged = atom({
      title: 'Подготовка отопления лаборатории',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее.',
      lesson: 'Работы следует завершить до холодов.',
      source_quote: 'На встрече команда решила подготовить отопление лаборатории до наступления холодов!',
    });
    expect(atomSourcePolicyViolation(punctuationChanged, russianSource)).toBe('source_quote_not_verbatim');
  });

  test('rejects a quote longer than the 200-character prompt contract', () => {
    const quote = 'A'.repeat(201);
    expect(atomSourcePolicyViolation(atom({
      title: 'A sufficiently long source quotation',
      atom_type: 'insight',
      body: 'The quotation is intentionally longer than the policy permits.',
      lesson: 'Keep provenance excerpts concise.',
      source_quote: quote,
    }), `${quote} trailing source context`)).toBe('source_quote_too_long');
  });

  test('prompt pins the language rule and valid Cyrillic titles produce a non-empty stable slug', async () => {
    let systemPrompt = '';
    const response = JSON.stringify([{
      title: 'Подготовка отопления лаборатории',
      atom_type: 'insight',
      body: 'Отопление лаборатории нужно подготовить заранее. Это снижает риск зимних сбоев.',
      lesson: 'Инфраструктурные работы следует завершать до наступления холодов.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    }]);
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      systemPrompt = String(opts.system ?? '');
      return {
        text: response,
        blocks: [{ type: 'text', text: response }],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    };

    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/meeting-ru.txt', content: russianSource, contentHash: 'language-policy-ru' }],
      _pages: [],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
    });

    expect(systemPrompt).toContain('title, body, and lesson MUST use the source\'s primary natural language');
    expect(systemPrompt).toContain('source_quote MUST be copied character-for-character');
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(1);

    const rows = await engine.executeRaw<{
      slug: string;
      title: string;
      compiled_truth: string;
      source_quote: string;
      lesson: string;
      extracted_by: string;
    }>(`
      SELECT slug, title, compiled_truth,
             frontmatter->>'source_quote' AS source_quote,
             frontmatter->>'lesson' AS lesson,
             frontmatter->>'extracted_by' AS extracted_by
      FROM pages
      WHERE type = 'atom'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toMatch(/^atoms\/\d{4}-\d{2}-\d{2}\/atom-[a-f0-9]{12}$/);
    expect(rows[0].title).toBe('Подготовка отопления лаборатории');
    expect(rows[0].compiled_truth).toContain('Отопление лаборатории');
    expect(rows[0].source_quote).toBe('команда решила подготовить отопление лаборатории до наступления холодов');
    expect(rows[0].lesson).toBe('Инфраструктурные работы следует завершать до наступления холодов.');
    expect(rows[0].extracted_by).toBe('extract_atoms-source-language-v1');
  });

  test('localized titles that retain the same ASCII fragment get distinct slugs', async () => {
    const response = JSON.stringify([
      {
        title: 'План 2026',
        atom_type: 'insight',
        body: 'План отопительных работ нужно выполнить до холодов.',
        lesson: 'Сезонные работы следует завершать заранее.',
        source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
      },
      {
        title: 'Отчёт 2026',
        atom_type: 'insight',
        body: 'Отчёт должен подтвердить готовность отопления лаборатории.',
        lesson: 'Готовность инфраструктуры нужно подтверждать документально.',
        source_quote: 'Ответственный должен проверить батареи и завершить работы заранее',
      },
    ]);
    const chat = async (_opts: ChatOpts): Promise<ChatResult> => ({
      text: response,
      blocks: [{ type: 'text', text: response }],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    });

    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/meeting-ru-slugs.txt', content: russianSource, contentHash: 'language-policy-ru-slugs' }],
      _pages: [],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
    });

    expect(result.details?.atoms_extracted).toBe(2);
    const rows = await engine.executeRaw<{ slug: string }>(`
      SELECT slug FROM pages WHERE type = 'atom' ORDER BY slug
    `);
    expect(rows).toHaveLength(2);
    expect(rows[0].slug).toMatch(/\/2026-[a-f0-9]{12}$/);
    expect(rows[1].slug).toMatch(/\/2026-[a-f0-9]{12}$/);
    expect(rows[0].slug).not.toBe(rows[1].slug);
  });

  test('the phase does not persist an atom that violates the source-language policy', async () => {
    const response = JSON.stringify([{
      title: 'Prepare laboratory heating early',
      atom_type: 'insight',
      body: 'The heating system should be prepared before winter. Early work lowers operational risk.',
      lesson: 'Finish seasonal maintenance before cold weather.',
      source_quote: 'команда решила подготовить отопление лаборатории до наступления холодов',
    }]);
    const chat = async (_opts: ChatOpts): Promise<ChatResult> => ({
      text: response,
      blocks: [{ type: 'text', text: response }],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    });

    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/meeting-policy-reject.txt', content: russianSource, contentHash: 'language-policy-reject' }],
      _pages: [],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
    });

    expect(result.status).toBe('warn');
    expect(result.details?.atoms_extracted).toBe(0);
    expect(result.details?.atoms_policy_rejected).toBe(1);
    expect(result.details?.failures).toEqual([{
      source: '/meeting-policy-reject.txt',
      error: 'all atoms rejected by source policy (generated_language_mismatch:1)',
    }]);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].count).toBe(0);
  });
});
