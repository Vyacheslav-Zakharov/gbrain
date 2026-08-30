import { describe, expect, test } from 'bun:test';
import type { ReservedConnection } from '../src/core/engine.ts';
import {
  P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT,
  P0BGoogleReconcilerPostgresError,
  createP0BGoogleReconcilerPostgresPorts,
  runP0BGoogleReconcilerPostgres,
} from '../src/core/p0b-google-reconciler-postgres.ts';

const NOW = 1_800_000_000_000;
const REVISION = 'a'.repeat(64);
const NEXT_REVISION = 'c'.repeat(64);
const checkpoint = { schema_version: 1 as const, pass: 1, cursor: null, revision: REVISION };
const authority = { lease_id: 'lease-12345678', fence_token: 'fence-12345678' };
const vector = (width = 768, value = 0.25) => Array.from({ length: width }, () => value);
const limits = {
  max_rows: 100,
  max_batch_rows: 10,
  max_batch_tokens: 10_000,
  max_total_tokens: 100_000,
  max_cost_usd: 1,
  deadline_epoch_ms: NOW + 60_000,
};

type Call = { text: string; params: unknown[] | undefined; inTransaction: boolean };

type Handler = (call: Call, index: number) => unknown[] | Promise<unknown[]>;

function reservedSession(handler: Handler) {
  const calls: Call[] = [];
  let txDepth = 0;
  let transactions = 0;
  let rollbacks = 0;
  const make = (nested: boolean): ReservedConnection => ({
    executeRaw: async <T>(text: string, params?: unknown[]) => {
      const call = { text, params, inTransaction: txDepth > 0 };
      calls.push(call);
      return await handler(call, calls.length - 1) as T[];
    },
    transactionRaw: async <T>(work: (tx: ReservedConnection) => Promise<T>) => {
      if (nested) throw new Error('Nested transactionRaw is not supported');
      transactions += 1;
      txDepth += 1;
      try {
        return await work(make(true));
      } catch (error) {
        rollbacks += 1;
        throw error;
      } finally {
        txDepth -= 1;
      }
    },
  });
  return { value: make(false), calls, inTransaction: () => txDepth > 0, counts: () => ({ transactions, rollbacks }) };
}

function checkpointRow(overrides: Record<string, unknown> = {}) {
  return {
    revision: REVISION,
    pass: 1,
    cursor_chunk_index: null,
    cursor_chunk_id: null,
    lease_id: authority.lease_id,
    fence_token: authority.fence_token,
    lease_expires_at_epoch_ms_text: String(NOW + 30_000),
    db_now_epoch_ms_text: String(NOW),
    ...overrides,
  };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    chunk_id: 'chunk-a',
    page_id: 'page-a',
    chunk_index: 1,
    chunk_text: 'candidate text',
    chunk_source: 'body',
    page_content_hash: 'b'.repeat(64),
    page_generation_text: '7',
    has_embedding: false,
    stored_source_fingerprint: null,
    ...overrides,
  };
}

function commitRequest(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    kind: 'BATCH',
    authority,
    expected_checkpoint: checkpoint,
    new_checkpoint: { ...checkpoint, revision: NEXT_REVISION },
    updates: [{
      chunk_id: 'chunk-a',
      expected_row: {
        chunk_id: 'chunk-a', page_id: 'page-a', chunk_index: 1, chunk_text: 'candidate text', chunk_source: 'body',
        page_content_hash: 'b'.repeat(64), page_generation: 7, source_fingerprint: 'd'.repeat(64),
      },
      vector: vector(),
    }],
    deadline_epoch_ms: NOW + 10_000,
    ...overrides,
  };
}

function successfulSql(call: Call): unknown[] {
  const { text, params } = call;
  if (text.includes("set_config('statement_timeout'")) return [{ statement_timeout: params?.[0] }];
  if (text.includes("set_config('lock_timeout'")) return [{ lock_timeout: params?.[0] }];
  if (text.includes('SELECT schema_identity')) return [{ schema_identity: P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT.schema_identity }];
  if (text.includes('lease_expires_at_epoch_ms_text') && !text.includes('FOR UPDATE')) return [{
    pass: 1,
    cursor_chunk_index: null,
    cursor_chunk_id: null,
    lease_id: authority.lease_id,
    fence_token: authority.fence_token,
    lease_expires_at_epoch_ms_text: String(NOW + 30_000),
    db_now_epoch_ms_text: String(NOW),
  }];
  if (text.includes('FOR UPDATE')) return [checkpointRow()];
  if (text.includes('UPDATE content_chunks')) return [{ chunk_id: 'chunk-a' }];
  if (text.includes('INSERT INTO p0b_google_embedding_provenance')) return [{
    chunk_id: params?.[0],
    source_hash: params?.[3],
    embedding_model: params?.[1],
    embedding_dimensions: params?.[2],
  }];
  if (text.includes('UPDATE p0b_google_reconciler_checkpoint')) return [{ revision: NEXT_REVISION }];
  if (text.includes('clock_timestamp()') && !text.includes('FOR UPDATE')) return [{ db_now_epoch_ms_text: String(NOW + 1) }];
  throw new Error(`unexpected SQL: ${text}`);
}

function runInput(session: ReservedConnection, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'postgres' as const,
    withReservedConnection: async <T>(work: (connection: ReservedConnection) => Promise<T>) => work(session),
    initial_checkpoint: checkpoint,
    limits,
    authority,
    clock: { now_epoch_ms: () => NOW },
    provider: { embed: async (request: any) => ({ schema_version: 1, vectors: request.inputs.map(() => vector()) }) },
    cancellation: { is_cancelled: () => false },
    ...overrides,
  };
}

describe('P0-B PostgreSQL adapter transaction contract', () => {
  test('declares persisted lease/fence + checkpoint CAS coordination and no advisory locking', async () => {
    expect(P0B_GOOGLE_RECONCILER_POSTGRES_CONTRACT).toEqual({
      schema_version: 1,
      schema_identity: 'gbrain:p0b:google-g768-reconciler-postgres:v1',
      coordination: 'PERSISTED_LEASE_FENCE_AND_CHECKPOINT_CAS',
      checkpoint_singleton_key: 'google-g768',
      checkpoint_table: 'p0b_google_reconciler_checkpoint',
      provenance_table: 'p0b_google_embedding_provenance',
      migration_required: true,
      migration_execution: 'FORBIDDEN_IN_ADAPTER',
      schema_gate: 'INCOMPLETE_MOCK_ONLY',
    });
    const source = await Bun.file(new URL('../src/core/p0b-google-reconciler-postgres.ts', import.meta.url)).text();
    expect(source).not.toMatch(/pg_(try_)?advisory_(lock|unlock)/i);
    expect(source).not.toMatch(/['"](?:BEGIN|COMMIT|ROLLBACK)['"]/);
    expect(source).not.toContain('rowCount');
  });

  test('runs every read in transactionRaw, sets bounded LOCAL-equivalent timeouts first, excludes deleted pages, and maps bigint text', async () => {
    let candidateReads = 0;
    let providerInTransaction: boolean | undefined;
    let state = checkpointRow();
    const mock = reservedSession(call => {
      if (call.text.includes('FROM content_chunks')) return candidateReads++ === 0 ? [candidateRow()] : [];
      if (call.text.includes('lease_expires_at_epoch_ms_text') && !call.text.includes('FOR UPDATE')) return [{
        pass: state.pass,
        cursor_chunk_index: state.cursor_chunk_index,
        cursor_chunk_id: state.cursor_chunk_id,
        lease_id: state.lease_id,
        fence_token: state.fence_token,
        lease_expires_at_epoch_ms_text: state.lease_expires_at_epoch_ms_text,
        db_now_epoch_ms_text: String(NOW),
      }];
      if (call.text.includes('FOR UPDATE')) return [state];
      if (call.text.includes('UPDATE p0b_google_reconciler_checkpoint')) {
        state = checkpointRow({
          revision: call.params?.[0],
          pass: call.params?.[1],
          cursor_chunk_index: call.params?.[2],
          cursor_chunk_id: call.params?.[3],
        });
        return [{ revision: call.params?.[0] }];
      }
      return successfulSql(call);
    });
    const receipt = await runP0BGoogleReconcilerPostgres(runInput(mock.value, {
      provider: { embed: async (request: any) => {
        providerInTransaction = mock.inTransaction();
        return { schema_version: 1, vectors: request.inputs.map(() => vector()) };
      } },
    }));

    expect(receipt.rows_updated).toBe(1);
    expect(providerInTransaction).toBe(false);
    expect(mock.calls.every(call => call.inTransaction)).toBe(true);
    const firstRead = mock.calls.findIndex(call => call.text.includes('FROM content_chunks'));
    expect(mock.calls[firstRead - 2].text).toContain("set_config('statement_timeout'");
    expect(mock.calls[firstRead - 1].text).toContain("set_config('lock_timeout'");
    expect(mock.calls.some(call => call.text.includes('SELECT schema_identity'))).toBe(true);
    expect(mock.calls.some(call => call.text.includes('lease_expires_at_epoch_ms_text') && !call.text.includes('FOR UPDATE'))).toBe(true);
    expect(mock.calls[firstRead].text).toContain('p.deleted_at IS NULL');
    expect(mock.calls[firstRead].text).toContain('p.generation::text AS page_generation_text');
    expect(mock.calls[firstRead].text).toContain('ORDER BY cc.chunk_index ASC, cc.id::text COLLATE "C" ASC');
    for (const predicate of [
      'control.pass = $8',
      'control.cursor_chunk_index IS NOT DISTINCT FROM $9',
      'control.cursor_chunk_id IS NOT DISTINCT FROM $10',
      'control.lease_id = $11',
      'control.fence_token = $12',
      'control.lease_expires_at > clock_timestamp()',
    ]) expect(mock.calls[firstRead].text).toContain(predicate);
    expect(mock.calls[firstRead].params).toEqual([
      null, null, 10, 'google:gemini-embedding-001', 768,
      'google-g768', 'gbrain:p0b:google-g768-reconciler-postgres:v1',
      1, null, null, authority.lease_id, authority.fence_token,
    ]);
    expect(mock.calls[firstRead - 2].params).toEqual(['30000ms']);
    expect(mock.calls[firstRead - 1].params).toEqual(['5000ms']);
  });

  test('read rejects expired deadlines before SQL and unsafe or noncanonical bigint text', async () => {
    const noSql = reservedSession(() => { throw new Error('must not query'); });
    const ports = createP0BGoogleReconcilerPostgresPorts(noSql.value, { now_epoch_ms: () => NOW });
    await expect(ports.read_batch({ schema_version: 1, pass: 1, after: null, max_rows: 1, deadline_epoch_ms: NOW, authority }))
      .rejects.toMatchObject({ code: 'SESSION_FAILED' });
    expect(noSql.calls).toHaveLength(0);

    for (const page_generation_text of ['01', '-1', '9007199254740992', 7]) {
      const mock = reservedSession(call => call.text.includes('FROM content_chunks')
        ? [candidateRow({ page_generation_text })]
        : successfulSql(call));
      const localPorts = createP0BGoogleReconcilerPostgresPorts(mock.value, { now_epoch_ms: () => NOW });
      await expect(localPorts.read_batch({ schema_version: 1, pass: 1, after: null, max_rows: 1, deadline_epoch_ms: NOW + 1000, authority }))
        .rejects.toMatchObject({ code: 'SESSION_FAILED' });
    }

    let getterReads = 0;
    const accessorRow = candidateRow();
    Object.defineProperty(accessorRow, 'chunk_text', {
      enumerable: true,
      get: () => { getterReads += 1; return 'must-not-read'; },
    });
    const accessorMock = reservedSession(call => call.text.includes('FROM content_chunks')
      ? [accessorRow]
      : successfulSql(call));
    await expect(createP0BGoogleReconcilerPostgresPorts(accessorMock.value, { now_epoch_ms: () => NOW }).read_batch({
      schema_version: 1, pass: 1, after: null, max_rows: 1, deadline_epoch_ms: NOW + 1000, authority,
    })).rejects.toMatchObject({ code: 'SESSION_FAILED' });
    expect(getterReads).toBe(0);
  });

  test('read rejects stale lease/fence before exposing chunk text to provider work', async () => {
    const mock = reservedSession(call => {
      if (call.text.includes('lease_expires_at_epoch_ms_text') && !call.text.includes('FOR UPDATE')) return [{
        pass: 1,
        cursor_chunk_index: null,
        cursor_chunk_id: null,
        lease_id: 'stale-lease',
        fence_token: authority.fence_token,
        lease_expires_at_epoch_ms_text: String(NOW + 30_000),
        db_now_epoch_ms_text: String(NOW),
      }];
      if (call.text.includes('FROM content_chunks')) throw new Error('text query must not run');
      return successfulSql(call);
    });
    await expect(createP0BGoogleReconcilerPostgresPorts(mock.value, { now_epoch_ms: () => NOW }).read_batch({
      schema_version: 1, pass: 1, after: null, max_rows: 1, deadline_epoch_ms: NOW + 10_000, authority,
    })).rejects.toMatchObject({ code: 'SESSION_FAILED' });
    expect(mock.calls.some(call => call.text.includes('FROM content_chunks'))).toBe(false);
  });

  test('recomputes remaining deadline between SQL statements', async () => {
    let now = NOW;
    const clock = { now_epoch_ms: () => {
      const value = now;
      now += 4_000;
      return value;
    } };
    const mock = reservedSession(successfulSql);
    await expect(createP0BGoogleReconcilerPostgresPorts(mock.value, clock).read_batch({
      schema_version: 1, pass: 1, after: null, max_rows: 1, deadline_epoch_ms: NOW + 10_000, authority,
    })).rejects.toMatchObject({ code: 'SESSION_FAILED' });
    expect(mock.calls.some(call => call.text.includes('FROM content_chunks'))).toBe(false);
    expect(mock.counts().rollbacks).toBe(1);
  });

  test('commit uses tx-bound executeRaw, authoritative DB time, guarded RETURNING identities, and exact provenance result', async () => {
    const mock = reservedSession(successfulSql);
    const ports = createP0BGoogleReconcilerPostgresPorts(mock.value, { now_epoch_ms: () => NOW });
    const result = await ports.commit(commitRequest());
    expect(result).toEqual({
      schema_version: 1, status: 'updated', updated_rows: 1, conflicted_rows: 0,
      checkpoint: { ...checkpoint, revision: NEXT_REVISION },
    });
    expect(mock.counts()).toEqual({ transactions: 1, rollbacks: 0 });
    expect(mock.calls[0].text).toContain("set_config('statement_timeout'");
    expect(mock.calls[1].text).toContain("set_config('lock_timeout'");
    const lock = mock.calls.find(call => call.text.includes('FOR UPDATE'))!;
    expect(lock.text).toContain('clock_timestamp()');
    expect(lock.text).toContain('lease_expires_at_epoch_ms_text');
    const vectorWrite = mock.calls.find(call => call.text.includes('UPDATE content_chunks'))!;
    expect(vectorWrite.text).toContain('p.deleted_at IS NULL');
    expect(vectorWrite.text).toContain('RETURNING cc.id::text AS chunk_id');
    const provenance = mock.calls.find(call => call.text.includes('INSERT INTO p0b_google_embedding_provenance'))!;
    for (const identity of ['chunk_id', 'source_hash', 'embedding_model', 'embedding_dimensions']) {
      expect(provenance.text).toContain(identity);
    }
    expect(provenance.text).toContain('RETURNING');
    const checkpointWrite = mock.calls.find(call => call.text.includes('UPDATE p0b_google_reconciler_checkpoint'))!;
    expect(checkpointWrite.text).toContain('lease_expires_at > clock_timestamp()');
    expect(checkpointWrite.text).toContain('RETURNING revision');
    const dbNowIndex = mock.calls.findIndex(call => call.text.includes('clock_timestamp()') && !call.text.includes('FOR UPDATE'));
    expect(dbNowIndex).toBeGreaterThan(mock.calls.indexOf(provenance));
    expect(dbNowIndex).toBeLessThan(mock.calls.indexOf(checkpointWrite));
  });

  test('checkpoint CAS sentinel rolls back tentative writes before becoming an orchestrator conflict', async () => {
    const mock = reservedSession(call => {
      if (call.text.includes('UPDATE p0b_google_reconciler_checkpoint')) return [];
      return successfulSql(call);
    });
    const ports = createP0BGoogleReconcilerPostgresPorts(mock.value, { now_epoch_ms: () => NOW });
    const result = await ports.commit(commitRequest());
    expect(result).toEqual({ schema_version: 1, status: 'conflicted', reason: 'CHECKPOINT_CAS', checkpoint });
    expect(mock.counts()).toEqual({ transactions: 1, rollbacks: 1 });
  });

  test('does not convert a conflict when the transaction wrapper reports rollback failure', async () => {
    const base = reservedSession(call => {
      if (call.text.includes('UPDATE p0b_google_reconciler_checkpoint')) return [];
      return successfulSql(call);
    });
    const rollbackFailure: ReservedConnection = {
      executeRaw: base.value.executeRaw,
      transactionRaw: async work => {
        try {
          return await work(base.value);
        } catch {
          throw new Error('rollback failed SECRET');
        }
      },
    };
    await expect(createP0BGoogleReconcilerPostgresPorts(rollbackFailure, { now_epoch_ms: () => NOW }).commit(commitRequest()))
      .rejects.toEqual(new P0BGoogleReconcilerPostgresError('TRANSACTION_FAILED'));
  });

  test('lease/fence conflicts roll back and non-sentinel transaction failures are sanitized', async () => {
    for (const [overrides, reason] of [
      [{ lease_id: 'other-lease' }, 'LOST_LEASE'],
      [{ fence_token: 'other-fence' }, 'FENCE_MISMATCH'],
      [{ lease_expires_at_epoch_ms_text: String(NOW) }, 'LOST_LEASE'],
    ] as const) {
      const mock = reservedSession(call => call.text.includes('FOR UPDATE') ? [checkpointRow(overrides)] : successfulSql(call));
      const result = await createP0BGoogleReconcilerPostgresPorts(mock.value, { now_epoch_ms: () => NOW }).commit(commitRequest({ updates: [] }));
      expect(result).toEqual({ schema_version: 1, status: 'conflicted', reason, checkpoint });
      expect(mock.counts().rollbacks).toBe(1);
    }

    const failure = reservedSession(call => {
      if (call.text.includes('FOR UPDATE')) throw new Error('SECRET SQL receipt');
      return successfulSql(call);
    });
    await expect(createP0BGoogleReconcilerPostgresPorts(failure.value, { now_epoch_ms: () => NOW }).commit(commitRequest({ updates: [] })))
      .rejects.toEqual(new P0BGoogleReconcilerPostgresError('TRANSACTION_FAILED'));
    expect(failure.counts().rollbacks).toBe(1);
  });

  test('zero/one/many RETURNING cardinality and identities fail closed without rowCount', async () => {
    for (const rows of [
      [{ chunk_id: 'wrong' }],
      [{ chunk_id: 'chunk-a' }, { chunk_id: 'chunk-a' }],
    ]) {
      const mock = reservedSession(call => call.text.includes('UPDATE content_chunks') ? rows : successfulSql(call));
      await expect(createP0BGoogleReconcilerPostgresPorts(mock.value, { now_epoch_ms: () => NOW }).commit(commitRequest()))
        .rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
      expect(mock.counts().rollbacks).toBe(1);
    }
  });

  test('rejects extra keys, sparse arrays, and nested accessors before SQL', async () => {
    const mock = reservedSession(() => { throw new Error('must not query'); });
    const ports = createP0BGoogleReconcilerPostgresPorts(mock.value, { now_epoch_ms: () => NOW });
    await expect(ports.read_batch({
      schema_version: 1, pass: 1, after: null, max_rows: 1, deadline_epoch_ms: NOW + 1000, authority, extra: true,
    })).rejects.toMatchObject({ code: 'SESSION_FAILED' });

    const sparse: unknown[] = [];
    sparse.length = 1;
    await expect(ports.commit(commitRequest({ updates: sparse }))).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });

    const poisonedAuthority = { fence_token: authority.fence_token } as Record<string, unknown>;
    Object.defineProperty(poisonedAuthority, 'lease_id', { enumerable: true, get: () => authority.lease_id });
    await expect(ports.commit(commitRequest({ authority: poisonedAuthority }))).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(mock.calls).toHaveLength(0);
  });

  test('fails closed before reserving unless engine kind is postgres', async () => {
    let reservations = 0;
    await expect(runP0BGoogleReconcilerPostgres({
      ...runInput(reservedSession(successfulSql).value),
      kind: 'pglite',
      withReservedConnection: async () => { reservations += 1; throw new Error('must not reserve'); },
    } as never)).rejects.toMatchObject({ code: 'POSTGRES_REQUIRED' });
    expect(reservations).toBe(0);
  });
});
