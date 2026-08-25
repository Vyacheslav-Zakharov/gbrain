import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { applyFtsLanguagePolicy, buildFtsTriggerFunctionsSql, getFtsLanguage, resetFtsLanguageCache } from '../src/core/fts-language.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseR1FtsArgs } from '../src/commands/r1-fts-reindex.ts';

describe('R1 configurable FTS language stack', () => {
  test('validates language and rewrites schema templates', async () => {
    await withEnv({ GBRAIN_FTS_LANGUAGE: 'russian' }, async () => {
      resetFtsLanguageCache();
      expect(getFtsLanguage()).toBe('russian');
      expect(applyFtsLanguagePolicy("SELECT to_tsvector('english', body)")).toBe("SELECT to_tsvector('russian', body)");
    });
    resetFtsLanguageCache();
  });

  test('folds language into semantic cache identity', async () => {
    let english = '';
    let russian = '';
    const knobs = resolveSearchMode({ mode: 'balanced' });
    await withEnv({ GBRAIN_FTS_LANGUAGE: 'english' }, async () => {
      resetFtsLanguageCache(); english = knobsHash(knobs);
    });
    await withEnv({ GBRAIN_FTS_LANGUAGE: 'russian' }, async () => {
      resetFtsLanguageCache(); russian = knobsHash(knobs);
    });
    resetFtsLanguageCache();
    expect(english).not.toBe(russian);
  });

  test('both engines use configured tsquery and both schema builders apply write-side policy', () => {
    for (const rel of ['../src/core/postgres-engine.ts', '../src/core/pglite-engine.ts']) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(source).toContain('getFtsLanguage');
      expect(source).not.toContain("websearch_to_tsquery('english', $1)");
    }
    for (const rel of ['../src/core/postgres-engine.ts', '../src/core/pglite-schema.ts']) {
      expect(readFileSync(new URL(rel, import.meta.url), 'utf8')).toContain('applyFtsLanguagePolicy');
    }
  });

  test('builds hardened write-side trigger functions without a numeric migration slot', () => {
    const sql = buildFtsTriggerFunctionsSql('simple');
    expect(sql).toContain("to_tsvector('simple'");
    expect(sql).toContain('SET search_path = pg_catalog, public');
    expect(sql).toContain('update_page_search_vector');
    expect(sql).toContain('update_chunk_search_vector');
    expect(sql).not.toContain('migration 123');
    expect(() => buildFtsTriggerFunctionsSql("simple'; DROP TABLE pages;--")).toThrow('Invalid FTS language');
  });

  test('requires an explicit bounded FTS command mode', () => {
    expect(parseR1FtsArgs(['--dry-run', '--language', 'russian'])).toMatchObject({ mode: 'dry-run', language: 'russian', target: 'clone' });
    expect(() => parseR1FtsArgs(['--apply', '--status'])).toThrow('exactly one mode');
    expect(() => parseR1FtsArgs(['--apply', '--language', 'bad-value!'])).toThrow('Invalid FTS language');
  });
});
