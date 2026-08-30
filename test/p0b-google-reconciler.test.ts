import { describe, expect, test } from 'bun:test';
import {
  P0B_GOOGLE_RECONCILER_CONTRACT,
  P0BGoogleReconcilerError,
  type P0BGoogleReconcilerErrorCode,
  fingerprintP0BGoogleSource,
  parseP0BGoogleReconcilerLimits,
  runP0BGoogleReconciler,
} from '../src/core/p0b-google-reconciler.ts';

const DIGEST = 'a'.repeat(64);
const NOW = 1_800_000_000_000;
const checkpoint = (cursor: { chunk_index: number; chunk_id: string } | null = null, pass = 1) => ({
  schema_version: 1 as const,
  pass,
  cursor,
  revision: DIGEST,
});
const limits = (overrides: Record<string, unknown> = {}) => ({
  max_rows: 100,
  max_batch_rows: 10,
  max_batch_tokens: 10_000,
  max_total_tokens: 100_000,
  max_cost_usd: 1,
  deadline_epoch_ms: NOW + 60_000,
  ...overrides,
});
const row = (id: string, index: number, overrides: Record<string, unknown> = {}) => ({
  chunk_id: id,
  page_id: `page-${id}`,
  chunk_index: index,
  chunk_text: `text-${id}`,
  chunk_source: 'body',
  page_content_hash: null,
  page_generation: 1,
  has_embedding: false,
  stored_source_fingerprint: null,
  ...overrides,
});
const sourceOf = (value: ReturnType<typeof row>) => ({
  schema_version: 1 as const,
  chunk_id: value.chunk_id,
  page_id: value.page_id,
  chunk_index: value.chunk_index,
  chunk_text: value.chunk_text,
  chunk_source: value.chunk_source,
  page_content_hash: value.page_content_hash,
  page_generation: value.page_generation,
  embedding_model: 'google:gemini-embedding-001' as const,
  embedding_dimensions: 768 as const,
});
const vector = (width = 768, value = 0.25) => Array.from({ length: width }, () => value);

function harness(options: {
  reads?: unknown[] | ((request: any, call: number) => unknown);
  embed?: (request: any, call: number) => unknown | Promise<unknown>;
  commit?: (request: any, call: number) => unknown | Promise<unknown>;
  cancelled?: () => boolean;
  clock?: () => unknown;
  limitOverrides?: Record<string, unknown>;
  initial?: unknown;
} = {}) {
  const readRequests: any[] = [];
  const providerRequests: any[] = [];
  const commitRequests: any[] = [];
  let readCall = 0;
  let providerCall = 0;
  let commitCall = 0;
  const reads = options.reads ?? [
    { schema_version: 1, rows: [], has_more: false },
    { schema_version: 1, rows: [], has_more: false },
  ];
  const input = {
    initial_checkpoint: options.initial ?? checkpoint(),
    limits: limits(options.limitOverrides),
    authority: { lease_id: 'lease-12345678', fence_token: 'fence-12345678' },
    clock: { now_epoch_ms: () => options.clock?.() ?? NOW },
    reader: {
      read_batch: async (request: any) => {
        readRequests.push(request);
        const result = typeof reads === 'function' ? reads(request, readCall) : reads[readCall];
        readCall += 1;
        return result ?? { schema_version: 1, rows: [], has_more: false };
      },
    },
    provider: {
      embed: async (request: any) => {
        providerRequests.push(request);
        const result = await options.embed?.(request, providerCall);
        providerCall += 1;
        return result ?? { schema_version: 1, vectors: request.inputs.map(() => vector()) };
      },
    },
    committer: {
      commit: async (request: any) => {
        commitRequests.push(request);
        const result = await options.commit?.(request, commitCall);
        commitCall += 1;
        return result ?? {
          schema_version: 1,
          status: 'updated',
          updated_rows: request.updates.length,
          conflicted_rows: 0,
          checkpoint: request.new_checkpoint,
        };
      },
    },
    cancellation: { is_cancelled: () => options.cancelled?.() ?? false },
  };
  return { input, readRequests, providerRequests, commitRequests };
}

async function expectCode(promise: Promise<unknown>, code: P0BGoogleReconcilerErrorCode) {
  try {
    await promise;
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(P0BGoogleReconcilerError);
    expect((error as P0BGoogleReconcilerError).code).toBe(code);
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name']);
  }
}

describe('P0-B Google source contract and strict parsers', () => {
  test('pins model, dimensions, price, deterministic estimator, and fixed-schema fingerprint', () => {
    expect(P0B_GOOGLE_RECONCILER_CONTRACT).toEqual({
      schema_version: 1,
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      cost_per_1m_tokens_usd: 0.15,
      token_estimator: 'UTF8_BYTES_CEIL_DIV_4_MIN_1',
    });
    const a = row('a', 0);
    expect(fingerprintP0BGoogleSource(sourceOf(a))).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintP0BGoogleSource({ ...sourceOf(a) })).toBe(fingerprintP0BGoogleSource(sourceOf(a)));
    expect(fingerprintP0BGoogleSource({ ...sourceOf(a), chunk_text: 'changed' })).not.toBe(
      fingerprintP0BGoogleSource(sourceOf(a)),
    );
    expect(() => fingerprintP0BGoogleSource({ ...sourceOf(a), extra: true } as never)).toThrow(/exact keys/i);
  });

  test('accepts only the strict exact limits object', () => {
    expect(parseP0BGoogleReconcilerLimits(limits())).toEqual(limits());
    for (const bad of [
      { ...limits(), extra: 1 },
      { ...limits(), max_rows: 0 },
      { ...limits(), max_batch_rows: 1.5 },
      { ...limits(), max_batch_tokens: Number.NaN },
      { ...limits(), max_total_tokens: 0 },
      { ...limits(), max_cost_usd: -1 },
      { ...limits(), deadline_epoch_ms: Number.POSITIVE_INFINITY },
    ]) expect(() => parseP0BGoogleReconcilerLimits(bad)).toThrow();
  });
});

describe('P0-B Google governed reconciliation', () => {
  test('resumes in keyset order and embeds only NULL, missing, or stale source hashes', async () => {
    const missing = row('b', 2);
    const stale = row('c', 3, { has_embedding: true, stored_source_fingerprint: 'b'.repeat(64) });
    const freshBase = row('d', 4, { has_embedding: true });
    const fresh = { ...freshBase, stored_source_fingerprint: fingerprintP0BGoogleSource(sourceOf(freshBase)) };
    const h = harness({
      initial: checkpoint({ chunk_index: 1, chunk_id: 'a' }),
      reads: [
        { schema_version: 1, rows: [missing, stale, fresh], has_more: false },
        { schema_version: 1, rows: [], has_more: false },
        { schema_version: 1, rows: [], has_more: false },
      ],
    });
    const result = await runP0BGoogleReconciler(h.input);
    expect(h.readRequests[0].after).toEqual({ chunk_index: 1, chunk_id: 'a' });
    expect(h.providerRequests).toHaveLength(1);
    expect(h.providerRequests[0]).toEqual({
      schema_version: 1,
      model: 'google:gemini-embedding-001',
      dimensions: 768,
      inputs: ['text-b', 'text-c'],
      deadline_epoch_ms: NOW + 60_000,
    });
    expect(h.commitRequests[0].kind).toBe('PASS_COMPLETE');
    expect(h.commitRequests[0].updates.map((u: any) => u.chunk_id)).toEqual(['b', 'c']);
    expect(result.outcome).toBe('CONVERGED');
    expect(result.rows_updated).toBe(2);
    expect(result.completed_passes).toBe(3);
  });

  test('rejects non-increasing, pre-cursor, and malformed rows before provider or commit', async () => {
    for (const rows of [
      [row('b', 2), row('a', 1)],
      [row('a', 1)],
      [{ ...row('b', 2), extra: 'forbidden' }],
    ]) {
      const h = harness({ initial: checkpoint({ chunk_index: 1, chunk_id: 'a' }), reads: [
        { schema_version: 1, rows, has_more: false },
      ] });
      await expectCode(runP0BGoogleReconciler(h.input), 'INVALID_READ_BATCH');
      expect(h.providerRequests).toHaveLength(0);
      expect(h.commitRequests).toHaveLength(0);
    }
  });

  test('provider throw makes no commit or checkpoint progress and is sanitized', async () => {
    const h = harness({
      reads: [{ schema_version: 1, rows: [row('secret-key', 1, { chunk_text: 'SECRET-TEXT' })], has_more: false }],
      embed: () => { throw new Error('SECRET-TEXT secret-key'); },
    });
    await expectCode(runP0BGoogleReconciler(h.input), 'PROVIDER_FAILED');
    expect(h.commitRequests).toHaveLength(0);
  });

  test('rejects response count, width 767/769, NaN, and Infinity without commit', async () => {
    const responses = [
      { schema_version: 1, vectors: [] },
      { schema_version: 1, vectors: [vector(767)] },
      { schema_version: 1, vectors: [vector(769)] },
      { schema_version: 1, vectors: [[...vector(767), Number.NaN]] },
      { schema_version: 1, vectors: [[...vector(767), Number.POSITIVE_INFINITY]] },
    ];
    for (const response of responses) {
      const h = harness({
        reads: [{ schema_version: 1, rows: [row('a', 1)], has_more: false }],
        embed: () => response,
      });
      await expectCode(runP0BGoogleReconciler(h.input), 'INVALID_PROVIDER_RESPONSE');
      expect(h.commitRequests).toHaveLength(0);
    }
  });

  test('counts row conflicts and relies on a reset pass to retry behind-cursor mutation', async () => {
    const candidate = row('a', 1);
    let pass = 0;
    const h = harness({
      reads: request => {
        if (request.pass === 1) return { schema_version: 1, rows: [candidate], has_more: false };
        if (request.pass === 2) return { schema_version: 1, rows: [candidate], has_more: false };
        pass += 1;
        return { schema_version: 1, rows: [], has_more: false };
      },
      commit: (request, call) => ({
        schema_version: 1,
        status: 'updated',
        updated_rows: call === 0 ? 0 : request.updates.length,
        conflicted_rows: call === 0 ? 1 : 0,
        checkpoint: request.new_checkpoint,
      }),
    });
    const result = await runP0BGoogleReconciler(h.input);
    expect(result.row_conflicts).toBe(1);
    expect(result.rows_updated).toBe(1);
    expect(pass).toBeGreaterThanOrEqual(2);
  });

  test('fails closed on checkpoint CAS, lost lease, and fence mismatch', async () => {
    for (const reason of ['CHECKPOINT_CAS', 'LOST_LEASE', 'FENCE_MISMATCH'] as const) {
      const h = harness({
        reads: [{ schema_version: 1, rows: [], has_more: false }],
        commit: request => ({
          schema_version: 1,
          status: 'conflicted',
          reason,
          checkpoint: request.expected_checkpoint,
        }),
      });
      await expectCode(runP0BGoogleReconciler(h.input), reason);
      expect(h.commitRequests).toHaveLength(1);
    }
  });

  test('enforces row, batch-token, total-token, cost, and deadline caps before provider', async () => {
    const cases: Array<[Record<string, unknown>, ReturnType<typeof row>]> = [
      [{ max_rows: 1 }, row('a', 1, { chunk_text: 'x'.repeat(40) })],
      [{ max_batch_tokens: 1 }, row('a', 1, { chunk_text: 'x'.repeat(8) })],
      [{ max_total_tokens: 1 }, row('a', 1, { chunk_text: 'x'.repeat(8) })],
      [{ max_cost_usd: 0 }, row('a', 1, { chunk_text: 'x' })],
      [{ deadline_epoch_ms: NOW }, row('a', 1)],
    ];
    for (const [limitOverrides, candidate] of cases) {
      const maxRowsCase = limitOverrides.max_rows === 1;
      const h = harness({
        limitOverrides,
        reads: [{
          schema_version: 1,
          rows: maxRowsCase ? [candidate] : [candidate, row('b', 2)],
          has_more: maxRowsCase,
        }],
      });
      const result = await runP0BGoogleReconciler(h.input);
      if (limitOverrides.max_rows === 1) expect(h.providerRequests[0].inputs).toHaveLength(1);
      else expect(h.providerRequests).toHaveLength(0);
      expect(result.outcome).toBe('LIMIT_REACHED');
    }
  });

  test('max_rows bounds all examined rows, including already-fresh rows', async () => {
    const freshA = row('a', 1, { has_embedding: true });
    const freshB = row('b', 2, { has_embedding: true });
    const fresh = [freshA, freshB].map(value => ({
      ...value,
      stored_source_fingerprint: fingerprintP0BGoogleSource(sourceOf(value)),
    }));
    const h = harness({
      limitOverrides: { max_rows: 2, max_batch_rows: 10 },
      reads: [{ schema_version: 1, rows: fresh, has_more: true }],
    });
    const result = await runP0BGoogleReconciler(h.input);
    expect(h.readRequests).toHaveLength(1);
    expect(h.readRequests[0].max_rows).toBe(2);
    expect(result.rows_read).toBe(2);
    expect(result.outcome).toBe('LIMIT_REACHED');
  });

  test('binds port calls to deadline and supplies exact guarded row-version predicates', async () => {
    const candidate = row('a', 1, {
      page_content_hash: 'c'.repeat(64),
      page_generation: 7,
      chunk_text: 'guarded-text',
      chunk_source: 'body',
    });
    const h = harness({ reads: [
      { schema_version: 1, rows: [candidate], has_more: false },
      { schema_version: 1, rows: [], has_more: false },
      { schema_version: 1, rows: [], has_more: false },
    ] });
    await runP0BGoogleReconciler(h.input);
    expect(h.readRequests[0].deadline_epoch_ms).toBe(NOW + 60_000);
    expect(h.providerRequests[0].deadline_epoch_ms).toBe(NOW + 60_000);
    expect(h.commitRequests[0].deadline_epoch_ms).toBe(NOW + 60_000);
    expect(h.commitRequests[0].updates[0].expected_row).toEqual({
      chunk_id: 'a',
      page_id: 'page-a',
      chunk_index: 1,
      chunk_text: 'guarded-text',
      chunk_source: 'body',
      page_content_hash: 'c'.repeat(64),
      page_generation: 7,
      source_fingerprint: fingerprintP0BGoogleSource(sourceOf(candidate)),
    });
  });

  test('uses deterministic ASCII bytewise cursor ordering, not locale collation', async () => {
    const h = harness({
      initial: checkpoint({ chunk_index: 1, chunk_id: 'Z' }),
      reads: [
        { schema_version: 1, rows: [row('a', 1)], has_more: false },
        { schema_version: 1, rows: [], has_more: false },
        { schema_version: 1, rows: [], has_more: false },
      ],
    });
    expect((await runP0BGoogleReconciler(h.input)).rows_updated).toBe(1);
  });

  test('isolates internal checkpoint, updates, and vectors from malicious port mutation', async () => {
    const candidate = row('b', 2);
    let vectorBeforeMutation = 0;
    const h = harness({
      initial: checkpoint({ chunk_index: 1, chunk_id: 'a' }),
      reads: (request, call) => {
        if (call === 0) {
          try { request.after.chunk_id = 'zzzz'; } catch {}
          return { schema_version: 1, rows: [candidate], has_more: false };
        }
        return { schema_version: 1, rows: [], has_more: false };
      },
      commit: request => {
        if (request.updates.length > 0) vectorBeforeMutation = request.updates[0].vector[0];
        try { request.expected_checkpoint.cursor.chunk_id = 'evil'; } catch {}
        try { request.new_checkpoint.pass = 999; } catch {}
        try { request.updates[0].vector[0] = -999; } catch {}
        return {
          schema_version: 1,
          status: 'updated',
          updated_rows: request.updates.length,
          conflicted_rows: 0,
          checkpoint: request.new_checkpoint,
        };
      },
    });
    const result = await runP0BGoogleReconciler(h.input);
    expect(vectorBeforeMutation).toBe(0.25);
    expect(h.readRequests[1].pass).toBe(2);
    expect(h.readRequests[1].after).toBeNull();
    expect(result.outcome).toBe('CONVERGED');
  });

  test('resume from a mid-pass cursor requires two subsequent complete clean passes', async () => {
    const h = harness({
      initial: checkpoint({ chunk_index: 5, chunk_id: 'm' }),
      reads: [
        { schema_version: 1, rows: [], has_more: false },
        { schema_version: 1, rows: [], has_more: false },
        { schema_version: 1, rows: [], has_more: false },
      ],
    });
    const result = await runP0BGoogleReconciler(h.input);
    expect(h.readRequests).toHaveLength(3);
    expect(result.completed_passes).toBe(3);
    expect(result.outcome).toBe('CONVERGED');
  });

  test('checks cancellation and deadline after reads immediately before every commit', async () => {
    let cancelled = false;
    const cancelledRun = harness({
      reads: () => {
        cancelled = true;
        return { schema_version: 1, rows: [], has_more: false };
      },
      cancelled: () => cancelled,
    });
    expect((await runP0BGoogleReconciler(cancelledRun.input)).outcome).toBe('CANCELLED');
    expect(cancelledRun.commitRequests).toHaveLength(0);

    let now = NOW;
    const deadlineRun = harness({
      reads: () => {
        now = NOW + 60_000;
        return { schema_version: 1, rows: [], has_more: false };
      },
      clock: () => now,
    });
    expect((await runP0BGoogleReconciler(deadlineRun.input)).outcome).toBe('LIMIT_REACHED');
    expect(deadlineRun.commitRequests).toHaveLength(0);
  });

  test('normalizes negative zero before commit and digest accounting', async () => {
    let committed: number | undefined;
    const h = harness({
      reads: [
        { schema_version: 1, rows: [row('a', 1)], has_more: false },
        { schema_version: 1, rows: [], has_more: false },
        { schema_version: 1, rows: [], has_more: false },
      ],
      embed: request => ({
        schema_version: 1,
        vectors: request.inputs.map(() => [-0, ...vector(767)]),
      }),
      commit: request => {
        if (request.updates.length > 0) committed = request.updates[0].vector[0];
        return {
          schema_version: 1,
          status: 'updated',
          updated_rows: request.updates.length,
          conflicted_rows: 0,
          checkpoint: request.new_checkpoint,
        };
      },
    });
    await runP0BGoogleReconciler(h.input);
    expect(Object.is(committed, -0)).toBe(false);
    expect(committed).toBe(0);
  });

  test('cancellation before and during provider prevents commit', async () => {
    let cancelled = true;
    const before = harness({ reads: [{ schema_version: 1, rows: [row('a', 1)], has_more: false }], cancelled: () => cancelled });
    expect((await runP0BGoogleReconciler(before.input)).outcome).toBe('CANCELLED');
    expect(before.providerRequests).toHaveLength(0);
    expect(before.commitRequests).toHaveLength(0);

    cancelled = false;
    const during = harness({
      reads: [{ schema_version: 1, rows: [row('a', 1)], has_more: false }],
      cancelled: () => cancelled,
      embed: request => {
        cancelled = true;
        return { schema_version: 1, vectors: request.inputs.map(() => vector()) };
      },
    });
    const duringReceipt = await runP0BGoogleReconciler(during.input);
    expect(duringReceipt.outcome).toBe('CANCELLED');
    expect(duringReceipt.provider_batches).toBe(1);
    expect(duringReceipt.estimated_tokens).toBeGreaterThan(0);
    expect(duringReceipt.estimated_cost_usd).toBeGreaterThan(0);
    expect(during.providerRequests).toHaveLength(1);
    expect(during.commitRequests).toHaveLength(0);
  });

  test('full-pass reset catches a mutation inserted behind the first cursor', async () => {
    const later = row('z', 9, { has_embedding: true });
    const earlier = row('a', 1);
    const h = harness({
      reads: request => {
        if (request.pass === 1) return { schema_version: 1, rows: [later], has_more: false };
        if (request.pass === 2) return { schema_version: 1, rows: [earlier], has_more: false };
        return { schema_version: 1, rows: [], has_more: false };
      },
    });
    const result = await runP0BGoogleReconciler(h.input);
    expect(h.readRequests.some(request => request.pass === 2 && request.after === null)).toBe(true);
    expect(h.commitRequests.filter(request => request.kind === 'PASS_COMPLETE').length).toBeGreaterThanOrEqual(3);
    expect(result.rows_updated).toBe(2);
  });

  test('does not claim zero backlog from one empty batch', async () => {
    const h = harness();
    const result = await runP0BGoogleReconciler(h.input);
    expect(h.readRequests).toHaveLength(2);
    expect(h.commitRequests).toHaveLength(2);
    expect(result.completed_passes).toBe(2);
    expect(result.outcome).toBe('CONVERGED');
  });

  test('receipt is an exact allowlist of counters and aggregate digests with no row leakage', async () => {
    const sentinel = 'SECRET-TEXT-secret-key';
    const h = harness({ reads: [
      { schema_version: 1, rows: [row('secret-key', 1, { chunk_text: sentinel })], has_more: false },
      { schema_version: 1, rows: [], has_more: false },
      { schema_version: 1, rows: [], has_more: false },
    ] });
    const receipt = await runP0BGoogleReconciler(h.input);
    expect(Object.keys(receipt).sort()).toEqual([
      'checkpoint_digest', 'completed_passes', 'estimated_cost_usd', 'estimated_tokens',
      'outcome', 'provider_batches', 'row_conflicts', 'rows_eligible', 'rows_read',
      'rows_updated', 'schema_version', 'source_fingerprint_digest', 'vector_digest',
    ]);
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain(sentinel);
    expect(encoded).not.toContain('secret-key');
    expect(receipt.source_fingerprint_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.vector_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.checkpoint_digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
