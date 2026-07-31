/**
 * v0.36.1.0 (T3) — propose_takes phase unit tests.
 *
 * Pure structural tests against a mock BrainEngine + injected extractor.
 * No real LLM gateway, no PGLite — the phase's contract is exercised through
 * the public surface and the engine's executeRaw/listPages stubs.
 *
 * Tests cover:
 *  - happy path: extracts proposals, writes via executeRaw with idempotency clause
 *  - cache hit path: skip pages already in take_proposals (F2 idempotency)
 *  - fence dedup: existing fence rows pass through to extractor as context
 *  - budget exhaustion mid-page: phase aborts cleanly with warn status
 *  - extractor parse failures: warning logged, phase continues
 *  - parseExtractorOutput unit tests for the raw JSON parser
 */

import { describe, test, expect } from 'bun:test';
import {
  runPhaseProposeTakes,
  parseExtractorOutput,
  contentHash,
  proposalClaimHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
  PROPOSE_TAKES_PROMPT_VERSION,
  EXTRACT_TAKES_PROMPT,
  type ProposeTakesExtractor,
  type ProposedTake,
} from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';

test('take extractor preserves source meaning but returns claim text in Russian', () => {
  expect(EXTRACT_TAKES_PROMPT).toContain('claim_text на русском языке');
  expect(EXTRACT_TAKES_PROMPT).toContain('Не переводите имена собственные');
  expect(EXTRACT_TAKES_PROMPT).toContain('REJECTED CLAIMS FOR THIS PAGE');
  expect(EXTRACT_TAKES_PROMPT).toContain('Do NOT recreate an exact or semantically equivalent rejected claim');
});

// ─── Mock engine ────────────────────────────────────────────────────

interface CapturedSql {
  sql: string;
  params: unknown[];
}

function buildMockEngine(opts: {
  pages: Page[];
  existingProposals?: Set<string>; // page-level scan keys retained for compatibility
  insertConflicts?: number;
  history?: Array<{ id: number; status: string; content_hash: string; prompt_version: string; claim_hash: string }>;
  rejectedClaims?: Array<{ proposal_id: number; claim: string; reason: string }>;
}): { engine: BrainEngine; captured: CapturedSql[]; transactionAttempts: () => number } {
  const captured: CapturedSql[] = [];
  const scans = opts.existingProposals ?? new Set<string>();
  let remainingInsertConflicts = opts.insertConflicts ?? 0;
  let transactionAttemptCount = 0;

  const engine = {
    kind: 'pglite',
    async transaction<T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
      transactionAttemptCount += 1;
      return fn(engine as unknown as BrainEngine);
    },
    async listPages() {
      return opts.pages;
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes('SELECT id FROM take_proposal_scans')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        const key = `${sourceId}|${slug}|${ch}|${pv}`;
        return scans.has(key) ? [{ id: 1 } as unknown as T] : [];
      }
      if (sql.includes('INSERT INTO take_proposal_scans')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        const key = `${sourceId}|${slug}|${ch}|${pv}`;
        if (scans.has(key)) return [];
        scans.add(key);
        return [{ id: scans.size } as unknown as T];
      }
      if (sql.includes('tp.id AS proposal_id') && sql.includes("tp.status='rejected'")) {
        return (opts.rejectedClaims ?? []) as unknown as T[];
      }
      if (sql.includes('SELECT id, status, content_hash, prompt_version, claim_hash') && sql.includes('claim_text = $3')) {
        return (opts.history ?? []) as unknown as T[];
      }
      if (sql.includes('INSERT INTO take_proposals')) {
        if (remainingInsertConflicts > 0) {
          remainingInsertConflicts -= 1;
          return [];
        }
        return [{ id: captured.length } as unknown as T];
      }
      return [];
    },
  } as unknown as BrainEngine;

  return { engine, captured, transactionAttempts: () => transactionAttemptCount };
}

function buildPage(opts: { slug: string; body: string; sourceId?: string }): Page {
  return {
    id: 1,
    slug: opts.slug,
    type: 'analysis',
    title: opts.slug,
    compiled_truth: opts.body,
    timeline: '',
    frontmatter: {},
    source_id: opts.sourceId ?? 'default',
    created_at: new Date(),
    updated_at: new Date(),
  } as Page;
}

function buildCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

// ─── parseExtractorOutput ───────────────────────────────────────────

describe('parseExtractorOutput', () => {
  test('parses a clean JSON array', () => {
    const raw = '[{"claim_text":"Cities send messages","kind":"take","holder":"brain","weight":0.65}]';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim_text).toBe('Cities send messages');
    expect(out[0]!.kind).toBe('take');
    expect(out[0]!.weight).toBe(0.65);
  });

  test('strips markdown code fence wrapping', () => {
    const raw = '```json\n[{"claim_text":"X","kind":"bet","holder":"world","weight":0.8}]\n```';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
  });

  test('accepts a single object as a one-element array', () => {
    const raw = '{"claim_text":"Y","kind":"hunch","holder":"brain","weight":0.4}';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('hunch');
  });

  test('skips leading prose before the JSON', () => {
    const raw = 'Here are the takes:\n\n[{"claim_text":"Z","kind":"take","holder":"brain","weight":0.5}]';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
  });

  test('returns [] on empty input', () => {
    expect(parseExtractorOutput('')).toEqual([]);
    expect(parseExtractorOutput('   ')).toEqual([]);
  });

  test('returns [] on malformed JSON without throwing', () => {
    expect(parseExtractorOutput('[not valid json')).toEqual([]);
    expect(parseExtractorOutput('completely unrelated prose')).toEqual([]);
  });

  test('drops rows without claim_text and rows over 500 chars', () => {
    const longClaim = 'x'.repeat(600);
    const raw = JSON.stringify([
      { kind: 'take', holder: 'brain', weight: 0.5 }, // no claim_text
      { claim_text: longClaim, kind: 'take', holder: 'brain', weight: 0.5 },
      { claim_text: 'valid', kind: 'take', holder: 'brain', weight: 0.5 },
    ]);
    expect(parseExtractorOutput(raw)).toHaveLength(1);
  });

  test('coerces unknown kind to "take" and clamps weight to [0,1]', () => {
    const raw = JSON.stringify([
      { claim_text: 'a', kind: 'unknown_kind', holder: 'brain', weight: 2.5 },
      { claim_text: 'b', kind: 'take', holder: 'brain', weight: -0.5 },
    ]);
    const out = parseExtractorOutput(raw);
    expect(out[0]!.kind).toBe('take');
    expect(out[0]!.weight).toBe(1);
    expect(out[1]!.weight).toBe(0);
  });

  test('preserves optional domain field', () => {
    const raw = '[{"claim_text":"X","kind":"take","holder":"brain","weight":0.5,"domain":"macro"}]';
    const out = parseExtractorOutput(raw);
    expect(out[0]!.domain).toBe('macro');
  });
});

// ─── contentHash ────────────────────────────────────────────────────

describe('contentHash', () => {
  test('produces deterministic SHA-256 hex', () => {
    const h1 = contentHash('hello world');
    const h2 = contentHash('hello world');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).toMatch(/^[0-9a-f]+$/);
  });

  test('different input produces different hash', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

test('proposalClaimHash normalizes absent, empty, and whitespace-only domains to one identity', () => {
  const base: ProposedTake = { claim_text: 'Claim', kind: 'take', holder: 'brain', weight: 0.7 };
  expect(proposalClaimHash(base)).toBe(proposalClaimHash({ ...base, domain: '' }));
  expect(proposalClaimHash(base)).toBe(proposalClaimHash({ ...base, domain: '   ' }));
});

// ─── hasCompleteFence ───────────────────────────────────────────────

describe('hasCompleteFence', () => {
  test('detects a well-formed fence', () => {
    const body = `# Page

<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | X | take | brain | 0.5 | 2026-01 | |
<!-- gbrain:takes:end -->

prose continues
`;
    expect(hasCompleteFence(body)).toBe(true);
  });

  test('returns false when fence is incomplete (begin only)', () => {
    expect(hasCompleteFence('<!-- gbrain:takes:begin -->\n| #')).toBe(false);
  });

  test('returns false when no fence at all', () => {
    expect(hasCompleteFence('just some prose')).toBe(false);
  });

  test('detects fence with triple-dash variant', () => {
    expect(hasCompleteFence('<!--- gbrain:takes:begin -->\n| # |\n<!--- gbrain:takes:end -->')).toBe(true);
  });
});

// ─── extractExistingTakesForDedup ───────────────────────────────────

describe('extractExistingTakesForDedup', () => {
  test('returns [] when no fence present', () => {
    expect(extractExistingTakesForDedup('plain prose')).toEqual([]);
  });

  test('parses active rows from a well-formed fence', () => {
    const body = `<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Cities send messages | take | brain | 0.65 | 2026-01 | essay |
| 2 | Y will happen | bet | garry | 0.8 | 2026-01 | |
<!-- gbrain:takes:end -->`;
    const out = extractExistingTakesForDedup(body);
    expect(out).toHaveLength(2);
    expect(out[0]!.claim).toBe('Cities send messages');
    expect(out[0]!.kind).toBe('take');
    expect(out[1]!.weight).toBe(0.8);
  });

  test('skips strikethrough rows', () => {
    const body = `<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight |
|---|-------|------|-----|--------|
| 1 | ~~stale claim~~ | take | brain | 0.5 |
| 2 | active claim | take | brain | 0.5 |
<!-- gbrain:takes:end -->`;
    const out = extractExistingTakesForDedup(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toBe('active claim');
  });
});

// ─── Phase integration ──────────────────────────────────────────────

describe('runPhaseProposeTakes — phase integration', () => {
  test('happy path: scans pages, extracts proposals, writes via INSERT', async () => {
    const pages = [buildPage({ slug: 'wiki/concepts/network-effects', body: 'Marketplaces with cold-start liquidity always win.' })];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Marketplaces with cold-start liquidity win', kind: 'bet', holder: 'brain', weight: 0.7, domain: 'market' },
    ];
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(1);
    expect(details.cache_misses).toBe(1);
    expect(details.cache_hits).toBe(0);
    expect(details.proposals_inserted).toBe(1);

    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[6]).toBe('Marketplaces with cold-start liquidity win'); // claim_text
    expect(inserts[0]!.params[8]).toBe('bet'); // kind
    expect(inserts[0]!.params[11]).toBe('market'); // domain
  });

  test('retries the whole claim transaction when a concurrent pending row wins the unique race', async () => {
    const pages = [buildPage({ slug: 'wiki/retry-claim', body: 'A bounded claim that must not be lost.' })];
    const { engine, transactionAttempts } = buildMockEngine({ pages, insertConflicts: 1 });
    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor: async () => [
        { claim_text: 'Claim survives a concurrent restore', kind: 'take', holder: 'brain', weight: 0.7 },
      ],
    });

    expect(result.status).toBe('ok');
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(1);
    expect(transactionAttempts()).toBe(2);
  });

  test('cache hit: page already in take_proposals is skipped', async () => {
    const body = 'A page that was already processed.';
    const pages = [buildPage({ slug: 'wiki/old-page', body })];
    const ch = contentHash(body);
    const existing = new Set([`default|wiki/old-page|${ch}|${PROPOSE_TAKES_PROMPT_VERSION}`]);
    const { engine, captured } = buildMockEngine({ pages, existingProposals: existing });
    let extractorCalled = false;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalled = true;
      return [];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(extractorCalled).toBe(false);
    const details = result.details as Record<string, unknown>;
    expect(details.cache_hits).toBe(1);
    expect(details.proposals_inserted).toBe(0);
    // v0.42: extract rollup row UPSERTs on every phase invocation (best-
    // effort cache). Filter the assertion to take_proposals INSERTs only.
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposals'))).toHaveLength(0);
  });

  test('Russian prompt rollout reuses a completed scan from the previous production version', async () => {
    const body = 'A page already processed before the Russian-output rollout.';
    const pages = [buildPage({ slug: 'wiki/rollout-safe', body })];
    const ch = contentHash(body);
    const existing = new Set([`default|wiki/rollout-safe|${ch}|v0.36.1.0-tuned-cat15`]);
    const { engine } = buildMockEngine({ pages, existingProposals: existing });
    let extractorCalled = false;
    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor: async () => { extractorCalled = true; return []; },
    });

    expect(extractorCalled).toBe(false);
    expect((result.details as Record<string, unknown>).cache_hits).toBe(1);
    expect((result.details as Record<string, unknown>).cache_misses).toBe(0);
  });

  test('Russian governed rollout reuses a completed scan from ru-v1', async () => {
    const body = 'A page already processed by the prior Russian-output prompt.';
    const pages = [buildPage({ slug: 'wiki/rollout-safe-ru', body })];
    const ch = contentHash(body);
    const existing = new Set([`default|wiki/rollout-safe-ru|${ch}|v0.36.1.1-ru-v1`]);
    const { engine } = buildMockEngine({ pages, existingProposals: existing });
    let extractorCalled = false;
    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor: async () => { extractorCalled = true; return []; },
    });

    expect(extractorCalled).toBe(false);
    expect((result.details as Record<string, unknown>).cache_hits).toBe(1);
    expect((result.details as Record<string, unknown>).cache_misses).toBe(0);
  });

  test('persists every distinct claim returned for one page', async () => {
    const pages = [buildPage({ slug: 'wiki/multi', body: 'Two gradeable claims.' })];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Claim A', kind: 'take', holder: 'brain', weight: 0.6 },
      { claim_text: 'Claim B', kind: 'bet', holder: 'brain', weight: 0.8 },
    ];
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(2);
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposals'))).toHaveLength(2);
  });

  test('caches an empty extraction result at page level', async () => {
    const pages = [buildPage({ slug: 'wiki/empty-result', body: 'No gradeable claims.' })];
    const { engine } = buildMockEngine({ pages });
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => { calls++; return []; };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    const second = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(calls).toBe(1);
    expect((second.details as Record<string, unknown>).cache_hits).toBe(1);
  });

  test('passes existing fence rows to extractor as dedup context (F2 fix)', async () => {
    const body = `# Page

<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Already captured claim | take | brain | 0.5 | 2026-01 | |
<!-- gbrain:takes:end -->

New prose appended here.`;
    const pages = [buildPage({ slug: 'wiki/existing', body })];
    const { engine } = buildMockEngine({ pages });
    let receivedExistingTakes: unknown;
    const extractor: ProposeTakesExtractor = async ({ existingTakes }) => {
      receivedExistingTakes = existingTakes;
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(Array.isArray(receivedExistingTakes)).toBe(true);
    expect((receivedExistingTakes as Array<{ claim: string }>)[0]?.claim).toBe('Already captured claim');
  });

  test('passes page-scoped rejected claims and reason codes to the extractor', async () => {
    const pages = [buildPage({ slug: 'wiki/governed', body: 'A page with prior reviewed noise.' })];
    const rejectedClaims = [{ proposal_id: 41, claim: 'Generic rejected statement', reason: 'generic_low_value' }];
    const { engine } = buildMockEngine({ pages, rejectedClaims });
    let received: unknown;
    await runPhaseProposeTakes(buildCtx(engine), {
      promptVersion: 'governed-context-test',
      extractor: async ({ rejectedClaims: rows }) => { received = rows; return []; },
    });
    expect(received).toEqual(rejectedClaims);
  });

  for (const status of ['accepted', 'rejected', 'deferred'] as const) {
    test(`does not recreate an exact ${status} claim after content and prompt changes`, async () => {
      const proposal: ProposedTake = { claim_text: 'Reviewed claim must stay closed', kind: 'take', holder: 'brain', weight: 0.7 };
      const pages = [buildPage({ slug: `wiki/terminal-${status}`, body: 'Materially refreshed page body.' })];
      const { engine, captured } = buildMockEngine({
        pages,
        history: [{ id: 9, status, content_hash: 'old-content', prompt_version: 'old-prompt', claim_hash: 'legacy-md5-does-not-equal-current-sha' }],
      });
      const result = await runPhaseProposeTakes(buildCtx(engine), {
        promptVersion: 'new-prompt',
        extractor: async () => [proposal],
      });
      expect((result.details as Record<string, unknown>).proposals_inserted).toBe(0);
      expect((result.details as Record<string, unknown>).proposals_suppressed).toBe(1);
      expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposals'))).toHaveLength(0);
      const lookup = captured.find(c => c.sql.includes('claim_text = $3'));
      expect(lookup?.params.slice(2, 7)).toEqual([proposal.claim_text, proposal.kind, proposal.holder, proposal.weight, '']);
    });
  }

  test('does not silently reopen an exact claim whose only history is superseded', async () => {
    const proposal: ProposedTake = { claim_text: 'Superseded historical claim', kind: 'take', holder: 'brain', weight: 0.6 };
    const claimHash = proposalClaimHash(proposal);
    const pages = [buildPage({ slug: 'wiki/superseded-history', body: 'Updated source text.' })];
    const { engine } = buildMockEngine({
      pages,
      history: [{ id: 10, status: 'superseded', content_hash: 'old-content', prompt_version: 'old-prompt', claim_hash: claimHash }],
    });
    const result = await runPhaseProposeTakes(buildCtx(engine), {
      promptVersion: 'new-prompt',
      extractor: async () => [proposal],
    });
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(0);
    expect((result.details as Record<string, unknown>).proposals_suppressed).toBe(1);
  });

  test('extractor throw on a single page logs warning + phase continues', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page A prose' }),
      buildPage({ slug: 'wiki/b', body: 'page B prose' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let callCount = 0;
    const extractor: ProposeTakesExtractor = async () => {
      callCount++;
      if (callCount === 1) throw new Error('LLM timeout');
      return [{ claim_text: 'second page claim', kind: 'take', holder: 'brain', weight: 0.5 }];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(2);
    expect(details.proposals_inserted).toBe(1);
    expect((details.warnings as string[]).length).toBeGreaterThan(0);
    expect((details.warnings as string[])[0]).toContain('LLM timeout');
  });

  test('pages with empty compiled_truth are skipped silently (no extractor call)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/empty', body: '' }),
      buildPage({ slug: 'wiki/whitespace', body: '   \n   ' }),
      buildPage({ slug: 'wiki/real', body: 'has prose' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(extractorCalls).toBe(1);
  });

  test('skipPagesWithFence:true bypasses pages that already have a complete fence', async () => {
    const pages = [
      buildPage({
        slug: 'wiki/fenced',
        body: `<!-- gbrain:takes:begin -->\n| # | claim | kind | who | weight |\n|---|---|---|---|---|\n| 1 | x | take | brain | 0.5 |\n<!-- gbrain:takes:end -->\n\nprose`,
      }),
      buildPage({ slug: 'wiki/unfenced', body: 'plain prose only' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor, skipPagesWithFence: true });
    expect(extractorCalls).toBe(1);
  });

  test('proposal_run_id is stable across all proposals from one phase invocation', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page a' }),
      buildPage({ slug: 'wiki/b', body: 'page b' }),
    ];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'x', kind: 'take', holder: 'brain', weight: 0.5 },
    ];
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts).toHaveLength(2);
    const runIdA = inserts[0]!.params[5];
    const runIdB = inserts[1]!.params[5];
    expect(runIdA).toBe(runIdB);
    expect(typeof runIdA).toBe('string');
    expect((runIdA as string).startsWith('propose-')).toBe(true);
  });
});
