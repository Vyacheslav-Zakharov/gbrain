#!/usr/bin/env bun
/** Deterministic private-corpus runner for R1 retrieval comparisons. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';
import { assertCloneTarget } from './r1-additive-column-spike.ts';

interface ExpectedHit { source_id: string; slug: string; min_rank?: number }
export interface CorpusRow {
  id: string;
  query: string;
  source_id?: string;
  k: number;
  critical: boolean;
  must_have: ExpectedHit[];
  must_not_have: Array<Omit<ExpectedHit, 'min_rank'>>;
}
interface RankedHit { source_id?: string; slug: string }
interface EvaluatedExpectation extends ExpectedHit { found_rank: number | null; passed: boolean }
export interface CorpusResult {
  id: string;
  query_sha256: string;
  source_id?: string;
  critical: boolean;
  k: number;
  passed: boolean;
  vector_enabled: boolean;
  degradation_reasons: Record<string, number>;
  must_have: EvaluatedExpectation[];
  must_not_have: Array<Omit<ExpectedHit, 'min_rank'> & { found_rank: number | null; passed: boolean }>;
  ranked: Array<{ source_id: string; slug: string; rank: number }>;
}

function expectedHit(value: unknown, allowRank: boolean): ExpectedHit {
  if (!value || typeof value !== 'object') throw new Error('expectation must be an object');
  const v = value as Record<string, unknown>;
  if (typeof v.source_id !== 'string' || !v.source_id) throw new Error('expectation source_id is required');
  if (typeof v.slug !== 'string' || !v.slug) throw new Error('expectation slug is required');
  const minRank = v.min_rank === undefined ? undefined : Number(v.min_rank);
  if (!allowRank && minRank !== undefined) throw new Error('must_not_have cannot set min_rank');
  if (minRank !== undefined && (!Number.isInteger(minRank) || minRank < 1 || minRank > 100)) throw new Error('min_rank must be in [1,100]');
  return { source_id: v.source_id, slug: v.slug, ...(minRank === undefined ? {} : { min_rank: minRank }) };
}

export function parseCorpusLine(line: string): CorpusRow {
  const raw = JSON.parse(line) as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !/^[a-z0-9_-]+$/.test(raw.id)) throw new Error('id must be a stable lowercase identifier');
  if (typeof raw.query !== 'string' || raw.query.trim().length < 2) throw new Error('query is required');
  const k = Number(raw.k);
  if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error('k must be an integer in [1,100]');
  if (typeof raw.critical !== 'boolean') throw new Error('critical must be boolean');
  if (!Array.isArray(raw.must_have) || !Array.isArray(raw.must_not_have)) throw new Error('must_have and must_not_have must be arrays');
  const sourceId = raw.source_id === undefined ? undefined : String(raw.source_id);
  return {
    id: raw.id,
    query: raw.query,
    ...(sourceId ? { source_id: sourceId } : {}),
    k,
    critical: raw.critical,
    must_have: raw.must_have.map((x) => expectedHit(x, true)),
    must_not_have: raw.must_not_have.map((x) => {
      const h = expectedHit(x, false);
      return { source_id: h.source_id, slug: h.slug };
    }),
  };
}

function rankOf(hits: RankedHit[], expected: { source_id: string; slug: string }): number | null {
  const index = hits.findIndex((hit) => (hit.source_id ?? 'default') === expected.source_id && hit.slug === expected.slug);
  return index < 0 ? null : index + 1;
}

export function evaluateCorpusResult(row: CorpusRow, hits: RankedHit[], meta?: Pick<HybridSearchMeta, 'vector_enabled' | 'arms'>): CorpusResult {
  const ranked = hits.slice(0, row.k).map((hit, index) => ({ source_id: hit.source_id ?? 'default', slug: hit.slug, rank: index + 1 }));
  const mustHave = row.must_have.map((expected) => {
    const foundRank = rankOf(ranked, expected);
    const maxRank = expected.min_rank ?? row.k;
    return { ...expected, found_rank: foundRank, passed: foundRank !== null && foundRank <= maxRank };
  });
  const mustNotHave = row.must_not_have.map((expected) => {
    const foundRank = rankOf(ranked, expected);
    return { ...expected, found_rank: foundRank, passed: foundRank === null };
  });
  return {
    id: row.id,
    query_sha256: createHash('sha256').update(row.query).digest('hex'),
    ...(row.source_id ? { source_id: row.source_id } : {}),
    critical: row.critical,
    k: row.k,
    passed: mustHave.every((x) => x.passed) && mustNotHave.every((x) => x.passed),
    vector_enabled: meta?.vector_enabled ?? false,
    degradation_reasons: Object.fromEntries(Object.entries(meta?.arms?.failure_reasons ?? {}).filter(([, value]) => value !== undefined)) as Record<string, number>,
    must_have: mustHave,
    must_not_have: mustNotHave,
    ranked,
  };
}

export function summarizeCorpus(results: CorpusResult[]): { total: number; passed: number; failed: number; critical_failed: number; vector_disabled: number } {
  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    critical_failed: results.filter((r) => r.critical && !r.passed).length,
    vector_disabled: results.filter((r) => !r.vector_enabled).length,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const corpusPath = arg('--corpus');
  const outputPath = arg('--output');
  const model = arg('--model') ?? 'google:gemini-embedding-001';
  const dimensions = Number(arg('--dimensions') ?? '768');
  const column = arg('--column') ?? 'embedding';
  const ftsOnly = process.argv.includes('--fts-only');
  const databaseUrl = process.env.DATABASE_URL;
  if (!corpusPath || !outputPath || !databaseUrl) throw new Error('--corpus, --output, and DATABASE_URL are required');
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error('--dimensions must be a positive integer');
  assertCloneTarget(databaseUrl, process.env.R1_RETRIEVAL_CLONE_ACK);
  const rows = readFileSync(corpusPath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map(parseCorpusLine);
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`duplicate corpus id: ${row.id}`);
    ids.add(row.id);
  }
  configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { ...process.env } });
  const engine = new PostgresEngine();
  await engine.connect({ database_url: databaseUrl });
  try {
    const results: CorpusResult[] = [];
    for (const row of rows) {
      let meta: HybridSearchMeta | undefined;
      const hits = ftsOnly
        ? await engine.searchKeyword(row.query, {
            limit: row.k,
            ...(row.source_id ? { sourceId: row.source_id } : {}),
          })
        : await hybridSearch(engine, row.query, {
            limit: row.k,
            expansion: false,
            relationalRetrieval: false,
            graph_signals: false,
            ...(row.source_id ? { sourceId: row.source_id } : {}),
            embeddingColumn: column,
            onMeta: (value) => { meta = value; },
          });
      results.push(evaluateCorpusResult(row, hits, meta));
    }
    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      corpus_sha256: createHash('sha256').update(readFileSync(corpusPath)).digest('hex'),
      model,
      dimensions,
      column,
      retrieval_mode: ftsOnly ? 'fts_only' : 'hybrid',
      summary: summarizeCorpus(results),
      results,
    };
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report.summary)}\n`);
    if (report.summary.critical_failed > 0) process.exitCode = 1;
  } finally {
    resetGateway();
    await engine.disconnect();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[r1-corpus] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
