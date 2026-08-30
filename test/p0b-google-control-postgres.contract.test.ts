import { describe, expect, test } from 'bun:test';
import type { ReservedConnection } from '../src/core/engine.ts';
import {
  createP0BState,
  fingerprintP0BState,
  parseP0BState,
  transitionP0BState,
  type P0BTransitionInput,
  type P0BStateName,
} from '../src/core/p0b-additive-bridge.ts';
import {
  P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT,
  P0BGoogleControlPostgresError,
  createP0BGoogleControlPostgres,
} from '../src/core/p0b-google-control-postgres.ts';

const NOW = 1_800_000_000_000;
const DEADLINE = NOW + 10_000;
const NONCE = 'n'.repeat(32);
const initial = createP0BState({ previous_search_column: 'embedding_ze' });
const preparingTransitionInput: P0BTransitionInput = {
  authorization: {
    schema_version: 1,
    action: 'P0B_STATE_TRANSITION',
    transition: 'DRAFT->PREPARING',
    expected_state_fingerprint: initial.fingerprint,
    p0b_artifact_digest: 'a'.repeat(64),
    p0b_root_digest: 'b'.repeat(64),
    actor: 'owner@example.test',
    issued_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(),
    nonce: NONCE,
    owner_go: 'AUTHORIZE_GBRAIN_P0B_STATE_TRANSITION',
  },
  authorization_authority: {
    authenticity: 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED',
    now: NOW,
    expected_artifact_digest: 'a'.repeat(64),
    expected_root_digest: 'b'.repeat(64),
    allowed_actors: ['owner@example.test'],
  },
};
const preparing = transitionP0BState(initial, preparingTransitionInput).state;
const trustedTransitionAuthority = Object.freeze({
  authenticity: 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED' as const,
  expected_artifact_digest: 'a'.repeat(64),
  expected_root_digest: 'b'.repeat(64),
  allowed_actors: Object.freeze(['owner@example.test']),
});

interface Call { text: string; params?: unknown[]; inTransaction: boolean }
type Handler = (call: Call) => unknown[] | Promise<unknown[]>;

function session(handler: Handler, rollbackFailure = false) {
  const calls: Call[] = [];
  let depth = 0;
  let transactions = 0;
  let rollbacks = 0;
  const make = (nested: boolean): ReservedConnection => ({
    executeRaw: async <T>(text: string, params?: unknown[]) => {
      const call = { text, params, inTransaction: depth > 0 };
      calls.push(call);
      return await handler(call) as T[];
    },
    transactionRaw: async <T>(work: (tx: ReservedConnection) => Promise<T>) => {
      if (nested) throw new Error('nested');
      transactions += 1;
      depth += 1;
      try {
        return await work(make(true));
      } catch (error) {
        rollbacks += 1;
        if (rollbackFailure) throw new Error('rollback failed SECRET');
        throw error;
      } finally {
        depth -= 1;
      }
    },
  });
  return { connection: make(false), calls, counts: () => ({ transactions, rollbacks }) };
}

function canonicalStateJson(state = initial): string {
  return JSON.stringify({
    schema_version: state.schema_version,
    state: state.state,
    previous_search_column: state.previous_search_column,
    consumed_nonces: state.consumed_nonces,
    rollback_target: state.rollback_target,
    fingerprint: state.fingerprint,
  });
}

function success(call: Call): unknown[] {
  if (call.text.includes("set_config('statement_timeout'")) return [{ statement_timeout: call.params?.[0] }];
  if (call.text.includes("set_config('lock_timeout'")) return [{ lock_timeout: call.params?.[0] }];
  if (call.text.includes('FOR UPDATE OF state, checkpoint')) return [{
    state_json: canonicalStateJson(), state_fingerprint: initial.fingerprint,
    revision: checkpointRevision, fence_epoch_text: '41', lease_id: 'inactive', lease_nonce: 'inactive',
    fence_token: 'fence-00000000000000000041', lease_expires_at_epoch_ms_text: null,
    db_now_epoch_ms_text: String(NOW),
  }];
  if (call.text.includes('SELECT state_json')) return [{ state_json: canonicalStateJson(), state_fingerprint: initial.fingerprint }];
  if (call.text.includes('UPDATE p0b_google_bridge_state')) return [{ state_json: canonicalStateJson(preparing), state_fingerprint: preparing.fingerprint }];
  throw new Error(`unexpected SQL: ${call.text}`);
}

function adapter(mock: ReturnType<typeof session>, now = NOW) {
  return createP0BGoogleControlPostgres(
    mock.connection,
    { now_epoch_ms: () => now },
    trustedTransitionAuthority,
  );
}

describe('P0-B lifecycle PostgreSQL control adapter', () => {
  test('declares the exact dedicated singleton schema outline without executing DDL', async () => {
    expect(P0B_GOOGLE_CONTROL_POSTGRES_CONTRACT).toEqual({
      schema_version: 1,
      schema_identity: 'gbrain:p0b:google-g768-control-postgres:v1',
      singleton_key: 'google-g768',
      state_table: 'p0b_google_bridge_state',
      checkpoint_table: 'p0b_google_reconciler_checkpoint',
      nonce_ledger_table: 'p0b_google_control_nonce_ledger',
      migration_required: true,
      migration_execution: 'FORBIDDEN_IN_ADAPTER',
      schema_gate: 'INCOMPLETE_MOCK_ONLY',
    });
    const source = await Bun.file(new URL('../src/core/p0b-google-control-postgres.ts', import.meta.url)).text();
    expect(source).not.toMatch(/pg_(try_)?advisory_(lock|unlock)/i);
    expect(source).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TYPE)\b/i);
    expect(source).not.toMatch(/['"](?:BEGIN|COMMIT|ROLLBACK)['"]/);
    expect(source).not.toMatch(/secret|api[_-]?key/i);
  });

  test('reads exactly one canonical strict state in transactionRaw and verifies both fingerprints', async () => {
    const mock = session(success);
    const result = await adapter(mock).read_state({ schema_version: 1, deadline_epoch_ms: DEADLINE });
    expect(result).toEqual(initial);
    expect(Object.isFrozen(result)).toBe(true);
    expect(mock.counts()).toEqual({ transactions: 1, rollbacks: 0 });
    expect(mock.calls.every(call => call.inTransaction)).toBe(true);
    const read = mock.calls.find(call => call.text.includes('SELECT state_json'))!;
    expect(read.text).toContain('FROM p0b_google_bridge_state');
    expect(read.text).toContain('singleton_key = $1');
    expect(read.text).toContain('schema_identity = $2');
    expect(read.params).toEqual(['google-g768', 'gbrain:p0b:google-g768-control-postgres:v1']);
    expect(mock.calls[mock.calls.indexOf(read) - 2].text).toContain("set_config('statement_timeout'");
    expect(mock.calls[mock.calls.indexOf(read) - 1].text).toContain("set_config('lock_timeout'");
  });

  test('fails closed on forged JSON/fingerprint and zero or many lifecycle rows', async () => {
    for (const rows of [
      [],
      [
        { state_json: canonicalStateJson(), state_fingerprint: initial.fingerprint },
        { state_json: canonicalStateJson(), state_fingerprint: initial.fingerprint },
      ],
      [{ state_json: canonicalStateJson(), state_fingerprint: 'f'.repeat(64) }],
      [{ state_json: canonicalStateJson().replace('DRAFT', 'PREPARING'), state_fingerprint: initial.fingerprint }],
    ]) {
      const mock = session(call => call.text.includes('SELECT state_json') ? rows : success(call));
      await expect(adapter(mock).read_state({ schema_version: 1, deadline_epoch_ms: DEADLINE }))
        .rejects.toEqual(new P0BGoogleControlPostgresError('LIFECYCLE_READ_FAILED'));
      expect(mock.counts().rollbacks).toBe(1);
    }
  });

  test('CAS derives the authorized edge from locked state and DB time, then writes the exact state/checkpoint tuple', async () => {
    const mock = session(success);
    const result = await adapter(mock).cas_state({
      schema_version: 1,
      transition: { authorization: preparingTransitionInput.authorization },
      expected_checkpoint_revision: checkpointRevision,
      deadline_epoch_ms: DEADLINE,
    });
    expect(result).toEqual(preparing);
    const write = mock.calls.find(call => call.text.includes('UPDATE p0b_google_bridge_state'))!;
    expect(write.text).toContain('state_json = $1::text::jsonb');
    expect(write.text).toContain('state_fingerprint = $2');
    expect(write.text).toContain('state_fingerprint = $5');
    expect(write.text).toContain('checkpoint.revision = $6');
    expect(write.text).toContain('RETURNING state_json, state_fingerprint');
    expect(write.params).toEqual([
      canonicalStateJson(preparing), preparing.fingerprint,
      'google-g768', 'gbrain:p0b:google-g768-control-postgres:v1', initial.fingerprint, checkpointRevision,
    ]);
  });

  test('CAS mismatch is typed only after rollback and rollback uncertainty is sanitized', async () => {
    const request = {
      schema_version: 1, transition: { authorization: preparingTransitionInput.authorization },
      expected_checkpoint_revision: checkpointRevision, deadline_epoch_ms: DEADLINE,
    };
    const conflict = session(call => call.text.includes('UPDATE p0b_google_bridge_state') ? [] : success(call));
    await expect(adapter(conflict).cas_state(request)).rejects.toEqual(new P0BGoogleControlPostgresError('STATE_CAS_CONFLICT'));
    expect(conflict.counts()).toEqual({ transactions: 1, rollbacks: 1 });

    const uncertain = session(call => call.text.includes('UPDATE p0b_google_bridge_state') ? [] : success(call), true);
    await expect(adapter(uncertain).cas_state(request)).rejects.toEqual(new P0BGoogleControlPostgresError('TRANSACTION_FAILED'));
  });

  test('rejects unknown/accessor requests and expired deadlines before SQL', async () => {
    const mock = session(() => { throw new Error('must not query'); });
    await expect(adapter(mock).read_state({ schema_version: 1, deadline_epoch_ms: DEADLINE, extra: true }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const poisoned: Record<string, unknown> = { schema_version: 1 };
    Object.defineProperty(poisoned, 'deadline_epoch_ms', { enumerable: true, get: () => DEADLINE });
    await expect(adapter(mock).read_state(poisoned)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(adapter(mock, DEADLINE).read_state({ schema_version: 1, deadline_epoch_ms: DEADLINE }))
      .rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(mock.calls).toHaveLength(0);
  });

  test('rejects forged state authority, skipped edges, and recursive accessor/symbol/non-enumerable input', async () => {
    const noSql = session(() => { throw new Error('must not query'); });
    await expect(adapter(noSql).cas_state({
      schema_version: 1,
      expected_fingerprint: initial.fingerprint,
      new_state: preparing,
      deadline_epoch_ms: DEADLINE,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(noSql.calls).toHaveLength(0);

    const skipped = structuredClone(preparingTransitionInput) as any;
    skipped.authorization.transition = 'DRAFT->RECONCILING';
    const skippedMock = session(success);
    await expect(adapter(skippedMock).cas_state({
      schema_version: 1, transition: { authorization: skipped.authorization },
      expected_checkpoint_revision: checkpointRevision, deadline_epoch_ms: DEADLINE,
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    await expect(adapter(noSql).cas_state({
      schema_version: 1,
      transition: {
        authorization: preparingTransitionInput.authorization,
        authorization_authority: preparingTransitionInput.authorization_authority,
      },
      expected_checkpoint_revision: checkpointRevision,
      deadline_epoch_ms: DEADLINE,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    for (const poison of ['accessor', 'symbol', 'non-enumerable'] as const) {
      const transition = { authorization: structuredClone(preparingTransitionInput.authorization) } as any;
      if (poison === 'accessor') Object.defineProperty(transition.authorization, 'actor', { enumerable: true, get: () => 'owner@example.test' });
      if (poison === 'symbol') transition.authorization[Symbol('poison')] = true;
      if (poison === 'non-enumerable') Object.defineProperty(transition.authorization, 'poison', { enumerable: false, value: true });
      await expect(adapter(noSql).cas_state({
        schema_version: 1, transition: transition,
        expected_checkpoint_revision: checkpointRevision, deadline_epoch_ms: DEADLINE,
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }

    const wrongAuthority = {
      ...trustedTransitionAuthority,
      expected_artifact_digest: 'f'.repeat(64),
    };
    const wrongAuthorityAdapter = createP0BGoogleControlPostgres(
      skippedMock.connection,
      { now_epoch_ms: () => NOW },
      wrongAuthority,
    );
    await expect(wrongAuthorityAdapter.cas_state({
      schema_version: 1,
      transition: { authorization: preparingTransitionInput.authorization },
      expected_checkpoint_revision: checkpointRevision,
      deadline_epoch_ms: DEADLINE,
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });

  test('leaving RECONCILING atomically revokes lease and increments fence before state CAS', async () => {
    const transitionInput: P0BTransitionInput = {
      authorization: {
        schema_version: 1,
        action: 'P0B_STATE_TRANSITION',
        transition: 'RECONCILING->PREPARED',
        expected_state_fingerprint: reconciling.fingerprint,
        p0b_artifact_digest: 'a'.repeat(64),
        p0b_root_digest: 'b'.repeat(64),
        actor: 'owner@example.test',
        issued_at: new Date(NOW - 1000).toISOString(),
        expires_at: new Date(NOW + 60_000).toISOString(),
        nonce: 'r'.repeat(32),
        owner_go: 'AUTHORIZE_GBRAIN_P0B_STATE_TRANSITION',
      },
      authorization_authority: {
        authenticity: 'PREVERIFIED_SIGNED_OR_ACCESS_CONTROLLED',
        now: NOW,
        expected_artifact_digest: 'a'.repeat(64),
        expected_root_digest: 'b'.repeat(64),
        allowed_actors: ['owner@example.test'],
      },
    };
    const prepared = transitionP0BState(reconciling, transitionInput).state;
    const held = leaseRow({
      fence_epoch_text: '42', lease_id: leaseId, lease_nonce: leaseNonce,
      fence_token: fenceToken, lease_expires_at_epoch_ms_text: String(NOW + 1000),
    });
    const mock = session(call => {
      if (call.text.includes('FOR UPDATE OF state, checkpoint')) return [held];
      if (call.text.includes("lease_id = 'inactive'") && call.text.includes('fence_epoch = fence_epoch + 1')) return [{
        revision: checkpointRevision,
        fence_epoch_text: '43',
        lease_id: 'inactive',
        lease_nonce: 'inactive',
        fence_token: 'fence-00000000000000000043',
        lease_expires_at_epoch_ms_text: null,
      }];
      if (call.text.includes('UPDATE p0b_google_bridge_state')) return [{
        state_json: canonicalStateJson(prepared), state_fingerprint: prepared.fingerprint,
      }];
      return success(call);
    });
    const result = await adapter(mock).cas_state({
      schema_version: 1,
      transition: { authorization: transitionInput.authorization },
      expected_checkpoint_revision: checkpointRevision,
      deadline_epoch_ms: DEADLINE,
    });
    expect(result).toEqual(prepared);
    const revokeIndex = mock.calls.findIndex(call => call.text.includes("lease_id = 'inactive'")
      && call.text.includes('fence_epoch = fence_epoch + 1'));
    const stateIndex = mock.calls.findIndex(call => call.text.includes('UPDATE p0b_google_bridge_state'));
    expect(revokeIndex).toBeGreaterThan(-1);
    expect(revokeIndex).toBeLessThan(stateIndex);
  });
});

function lifecycleState(state: P0BStateName) {
  const payload = {
    schema_version: 1 as const,
    state,
    previous_search_column: 'embedding_ze',
    consumed_nonces: [] as string[],
    rollback_target: null,
  };
  return parseP0BState({ ...payload, fingerprint: fingerprintP0BState(payload) });
}

const reconciling = lifecycleState('RECONCILING');
const checkpointRevision = 'c'.repeat(64);
const leaseId = 'lease-runtime-0001';
const leaseNonce = 'z'.repeat(32);
const fenceToken = 'fence-00000000000000000042';

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    state_json: canonicalStateJson(reconciling),
    state_fingerprint: reconciling.fingerprint,
    revision: checkpointRevision,
    fence_epoch_text: '41',
    lease_id: 'inactive',
    lease_nonce: 'inactive',
    fence_token: 'fence-00000000000000000041',
    lease_expires_at_epoch_ms_text: null,
    db_now_epoch_ms_text: String(NOW),
    ...overrides,
  };
}

function leaseReturning(status: 'active' | 'inactive' = 'active', fenceEpoch = '42') {
  return {
    state_fingerprint: reconciling.fingerprint,
    revision: checkpointRevision,
    fence_epoch_text: fenceEpoch,
    lease_id: status === 'active' ? leaseId : 'inactive',
    fence_token: `fence-${fenceEpoch.padStart(20, '0')}`,
    lease_expires_at_epoch_ms_text: status === 'active' ? String(NOW + 5000) : null,
  };
}

function leaseSuccess(call: Call): unknown[] {
  if (call.text.includes("set_config('statement_timeout'")) return [{ statement_timeout: call.params?.[0] }];
  if (call.text.includes("set_config('lock_timeout'")) return [{ lock_timeout: call.params?.[0] }];
  if (call.text.includes('FOR UPDATE')) return [leaseRow()];
  if (call.text.includes('INSERT INTO p0b_google_control_nonce_ledger')) return [{ nonce: leaseNonce }];
  if (call.text.includes('fence_epoch = fence_epoch + 1')) return [leaseReturning()];
  if (call.text.includes("lease_expires_at = '-infinity'")) return [leaseReturning('inactive')];
  if (call.text.includes('lease_expires_at = clock_timestamp()')) return [leaseReturning()];
  throw new Error(`unexpected lease SQL: ${call.text}`);
}

const issueRequest = {
  schema_version: 1,
  expected_state_fingerprint: reconciling.fingerprint,
  expected_checkpoint_revision: checkpointRevision,
  lease_id: leaseId,
  nonce: leaseNonce,
  duration_ms: 5000,
  deadline_epoch_ms: DEADLINE,
};
const heldAuthority = { lease_id: leaseId, fence_token: fenceToken };
const renewRequest = {
  schema_version: 1,
  expected_state_fingerprint: reconciling.fingerprint,
  expected_checkpoint_revision: checkpointRevision,
  authority: heldAuthority,
  duration_ms: 5000,
  deadline_epoch_ms: DEADLINE,
};
const releaseRequest = {
  schema_version: 1,
  expected_state_fingerprint: reconciling.fingerprint,
  expected_checkpoint_revision: checkpointRevision,
  authority: heldAuthority,
  deadline_epoch_ms: DEADLINE,
};

describe('P0-B guarded lease control', () => {
  test('issues from DB time, increments bigint fence in SQL, and returns exact reconciler authority', async () => {
    const mock = session(leaseSuccess);
    const receipt = await adapter(mock).issue_lease(issueRequest) as any;
    expect(receipt).toEqual({
      schema_version: 1,
      status: 'issued',
      authority: heldAuthority,
      fence_epoch: '42',
      checkpoint_revision: checkpointRevision,
      state_fingerprint: reconciling.fingerprint,
      lease_expires_at_epoch_ms: String(NOW + 5000),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.authority)).toBe(true);
    const lock = mock.calls.find(call => call.text.includes('FOR UPDATE'))!;
    expect(lock.text).toContain('clock_timestamp()');
    expect(lock.text).toContain('fence_epoch::text AS fence_epoch_text');
    const write = mock.calls.find(call => call.text.includes('fence_epoch = fence_epoch + 1'))!;
    expect(write.text).toContain("'fence-' || lpad((fence_epoch + 1)::text, 20, '0')");
    expect(write.text).toContain("clock_timestamp() + ($3::bigint * interval '1 millisecond')");
    expect(write.text).toContain('RETURNING');
    expect(write.params).toEqual([
      leaseId, leaseNonce, 5000, 'google-g768',
      'gbrain:p0b:google-g768-reconciler-postgres:v1',
      'gbrain:p0b:google-g768-control-postgres:v1', reconciling.fingerprint, checkpointRevision,
    ]);
    expect(mock.calls.every(call => call.inTransaction)).toBe(true);
  });

  test('preserves full bigint fence text and refuses live/phase/state/checkpoint conflicts after rollback', async () => {
    const huge = '9223372036854775807';
    const hugeMock = session(call => {
      if (call.text.includes('FOR UPDATE')) return [leaseRow({
        fence_epoch_text: '9223372036854775806', fence_token: 'fence-09223372036854775806',
      })];
      if (call.text.includes('fence_epoch = fence_epoch + 1')) {
        return [{ ...leaseReturning(), fence_epoch_text: huge, fence_token: 'fence-09223372036854775807' }];
      }
      return leaseSuccess(call);
    });
    const hugeReceipt = await adapter(hugeMock).issue_lease(issueRequest) as any;
    expect(hugeReceipt.fence_epoch).toBe(huge);

    const cases = [
      [leaseRow({ lease_id: 'other-lease', lease_nonce: leaseNonce, lease_expires_at_epoch_ms_text: String(NOW + 1) }), 'LOST_LEASE'],
      [leaseRow({ state_json: canonicalStateJson(initial), state_fingerprint: initial.fingerprint }), 'STATE_CONFLICT'],
      [leaseRow({ state_fingerprint: 'd'.repeat(64) }), 'TRANSACTION_FAILED'],
      [leaseRow({ revision: 'd'.repeat(64) }), 'CHECKPOINT_CAS'],
    ] as const;
    for (const [row, code] of cases) {
      const mock = session(call => call.text.includes('FOR UPDATE') ? [row] : leaseSuccess(call));
      await expect(adapter(mock).issue_lease(issueRequest)).rejects.toEqual(new P0BGoogleControlPostgresError(code));
      expect(mock.counts()).toEqual({ transactions: 1, rollbacks: 1 });
      expect(mock.calls.some(call => call.text.includes('fence_epoch = fence_epoch + 1'))).toBe(false);
    }
  });

  test('renews exact live authority without fence increment and releases to inactive sentinels', async () => {
    const held = leaseRow({
      fence_epoch_text: '42', lease_id: leaseId, lease_nonce: leaseNonce,
      fence_token: fenceToken, lease_expires_at_epoch_ms_text: String(NOW + 1000),
    });
    const renewMock = session(call => call.text.includes('FOR UPDATE') ? [held] : leaseSuccess(call));
    const renewed = await adapter(renewMock).renew_lease(renewRequest) as any;
    expect(renewed.status).toBe('renewed');
    expect(renewed.authority).toEqual(heldAuthority);
    const renew = renewMock.calls.find(call => call.text.includes('lease_expires_at = clock_timestamp()'))!;
    expect(renew.text).not.toContain('fence_epoch =');
    expect(renew.text).toContain('lease_expires_at > clock_timestamp()');

    const releaseMock = session(call => call.text.includes('FOR UPDATE') ? [held] : leaseSuccess(call));
    const released = await adapter(releaseMock).release_lease(releaseRequest) as any;
    expect(released).toMatchObject({
      status: 'released', authority: { lease_id: 'inactive', fence_token: fenceToken },
      fence_epoch: '42', lease_expires_at_epoch_ms: null,
    });
    const release = releaseMock.calls.find(call => call.text.includes('UPDATE p0b_google_reconciler_checkpoint')
      && call.text.includes("lease_expires_at = '-infinity'"))!;
    expect(release.text).toContain("lease_id = 'inactive'");
    expect(release.text).toContain("lease_nonce = 'inactive'");
    expect(release.text).not.toContain('fence_epoch =');
  });

  test('durably rejects replayed issue nonce and reserved inactive lease id', async () => {
    const replay = session(call => {
      if (call.text.includes('INSERT INTO p0b_google_control_nonce_ledger')) return [];
      return leaseSuccess(call);
    });
    await expect(adapter(replay).issue_lease(issueRequest))
      .rejects.toEqual(new P0BGoogleControlPostgresError('NONCE_REPLAY'));
    expect(replay.counts().rollbacks).toBe(1);
    expect(replay.calls.some(call => call.text.includes('fence_epoch = fence_epoch + 1'))).toBe(false);

    const noSql = session(() => { throw new Error('must not query'); });
    await expect(adapter(noSql).issue_lease({ ...issueRequest, lease_id: 'inactive' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(noSql.calls).toHaveLength(0);
  });

  test('issue and renew are forbidden outside RECONCILING and fence exhaustion is explicit', async () => {
    const prepared = lifecycleState('PREPARED');
    const inactivePrepared = leaseRow({
      state_json: canonicalStateJson(prepared), state_fingerprint: prepared.fingerprint,
    });
    const preparedIssue = session(call => call.text.includes('FOR UPDATE') ? [inactivePrepared] : leaseSuccess(call));
    await expect(adapter(preparedIssue).issue_lease({ ...issueRequest, expected_state_fingerprint: prepared.fingerprint }))
      .rejects.toEqual(new P0BGoogleControlPostgresError('STATE_CONFLICT'));

    const activePrepared = leaseRow({
      state_json: canonicalStateJson(prepared), state_fingerprint: prepared.fingerprint,
      fence_epoch_text: '42', lease_id: leaseId, lease_nonce: leaseNonce,
      fence_token: fenceToken, lease_expires_at_epoch_ms_text: String(NOW + 1000),
    });
    const preparedRenew = session(call => call.text.includes('FOR UPDATE') ? [activePrepared] : leaseSuccess(call));
    await expect(adapter(preparedRenew).renew_lease({ ...renewRequest, expected_state_fingerprint: prepared.fingerprint }))
      .rejects.toEqual(new P0BGoogleControlPostgresError('STATE_CONFLICT'));

    const exhausted = session(call => call.text.includes('FOR UPDATE')
      ? [leaseRow({ fence_epoch_text: '9223372036854775807', fence_token: 'fence-09223372036854775807' })]
      : leaseSuccess(call));
    await expect(adapter(exhausted).issue_lease(issueRequest))
      .rejects.toEqual(new P0BGoogleControlPostgresError('FENCE_EXHAUSTED'));
    expect(exhausted.calls.some(call => call.text.includes('INSERT INTO p0b_google_control_nonce_ledger'))).toBe(false);
  });

  test('returns distinct stale lease/fence conflicts and sanitizes deadlines, cardinality, and rollback uncertainty', async () => {
    const held = leaseRow({
      fence_epoch_text: '42', lease_id: leaseId, lease_nonce: leaseNonce,
      fence_token: fenceToken, lease_expires_at_epoch_ms_text: String(NOW + 1000),
    });
    for (const [overrides, code] of [
      [{ lease_id: 'other-lease' }, 'LOST_LEASE'],
      [{ fence_epoch_text: '41', fence_token: 'fence-00000000000000000041' }, 'FENCE_MISMATCH'],
      [{ lease_expires_at_epoch_ms_text: String(NOW) }, 'LOST_LEASE'],
    ] as const) {
      const mock = session(call => call.text.includes('FOR UPDATE') ? [{ ...held, ...overrides }] : leaseSuccess(call));
      await expect(adapter(mock).renew_lease(renewRequest)).rejects.toEqual(new P0BGoogleControlPostgresError(code));
      expect(mock.counts().rollbacks).toBe(1);
    }

    const noSql = session(() => { throw new Error('must not query'); });
    await expect(adapter(noSql).issue_lease({ ...issueRequest, duration_ms: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(adapter(noSql).issue_lease({ ...issueRequest, duration_ms: 300_001 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(adapter(noSql).issue_lease({ ...issueRequest, extra: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(adapter(noSql, DEADLINE).issue_lease({ ...issueRequest, deadline_epoch_ms: DEADLINE }))
      .rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(noSql.calls).toHaveLength(0);

    const zero = session(call => call.text.includes('fence_epoch = fence_epoch + 1') ? [] : leaseSuccess(call));
    await expect(adapter(zero).issue_lease(issueRequest)).rejects.toMatchObject({ code: 'LOST_LEASE' });
    expect(zero.counts().rollbacks).toBe(1);
    const many = session(call => call.text.includes('fence_epoch = fence_epoch + 1')
      ? [leaseReturning(), leaseReturning()] : leaseSuccess(call));
    await expect(adapter(many).issue_lease(issueRequest)).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });

    const uncertain = session(call => call.text.includes('FOR UPDATE')
      ? [leaseRow({ revision: 'd'.repeat(64) })] : leaseSuccess(call), true);
    await expect(adapter(uncertain).issue_lease(issueRequest))
      .rejects.toEqual(new P0BGoogleControlPostgresError('TRANSACTION_FAILED'));
  });
});
