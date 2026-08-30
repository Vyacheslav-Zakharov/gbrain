import { describe, expect, test } from 'bun:test';
import {
  P0B_AUTHENTICITY,
  P0B_AUTHORIZATION_MAX_WINDOW_MS,
  P0B_CONTRACT,
  P0B_CREDENTIAL_CONTRACT,
  P0B_MAX_CONSUMED_NONCES,
  P0B_MAX_ORDINARY_NONCES,
  P0B_NONCE_MAX_BYTES,
  P0B_NONCE_MIN_BYTES,
  P0B_OWNER_GO,
  P0B_SHUTDOWN_CUTOFF_ISO,
  P0B_STATES,
  createP0BState,
  fingerprintP0BState,
  parseP0BAuthorization,
  parseP0BState,
  selectP0BRollbackTarget,
  transitionP0BState,
  validateP0BConfigAuthority,
  validateP0BCredentialMetadata,
} from '../src/core/p0b-additive-bridge.ts';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const nonce = (label: string): string => `${label}-${'x'.repeat(32)}`;

function authorization(
  state: { state: string; fingerprint: string },
  to: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    action: 'P0B_STATE_TRANSITION',
    transition: `${state.state}->${to}`,
    expected_state_fingerprint: state.fingerprint,
    p0b_artifact_digest: DIGEST_A,
    p0b_root_digest: DIGEST_B,
    actor: 'owner@example.test',
    issued_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(),
    nonce: nonce(`transition-${to.toLowerCase()}`),
    owner_go: P0B_OWNER_GO,
    ...overrides,
  };
}

const authority = (now: Date | number = NOW) => ({
  authenticity: P0B_AUTHENTICITY,
  now,
  expected_artifact_digest: DIGEST_A,
  expected_root_digest: DIGEST_B,
  allowed_actors: ['owner@example.test'],
}) as const;

function transition(
  state: ReturnType<typeof createP0BState>,
  to: string,
  overrides: Record<string, unknown> = {},
  policy?: { live_ze_probe: boolean; last_good_google_available: boolean },
) {
  return transitionP0BState(state, {
    authorization: authorization(state, to, overrides),
    authorization_authority: authority(),
    ...(policy === undefined ? {} : { rollback_policy: policy }),
  });
}

function statePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    state: 'DRAFT',
    previous_search_column: 'embedding',
    consumed_nonces: [],
    rollback_target: null,
    ...overrides,
  };
}

function sealedState(overrides: Record<string, unknown> = {}) {
  const payload = statePayload(overrides) as Parameters<typeof fingerprintP0BState>[0];
  return { ...payload, fingerprint: fingerprintP0BState(payload) };
}

describe('P0-B fixed contract and strict persisted-state parser', () => {
  test('pins the exact Google identity, states, shutdown cutoff, and nonce bounds', () => {
    expect(P0B_CONTRACT).toEqual({
      embedding_column: 'embedding_g768',
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      embedding_provider: 'google',
      embedding_base_url: 'https://generativelanguage.googleapis.com',
      registry_embedding_column: 'embedding_g768',
      registry_embedding_type: 'vector',
    });
    expect(P0B_STATES).toEqual([
      'DRAFT', 'PREPARING', 'RECONCILING', 'PREPARED', 'ACTIVE',
      'COMPENSATING', 'ROLLED_BACK', 'ABORTED', 'BLOCKED',
    ]);
    expect(P0B_SHUTDOWN_CUTOFF_ISO).toBe('2026-09-04T00:00:00Z');
    expect(P0B_NONCE_MIN_BYTES).toBe(32);
    expect(P0B_NONCE_MAX_BYTES).toBe(128);
    expect(P0B_MAX_ORDINARY_NONCES).toBeLessThan(P0B_MAX_CONSUMED_NONCES);
    expect(P0B_OWNER_GO).toBe('AUTHORIZE_GBRAIN_P0B_STATE_TRANSITION');
  });

  test('uses fixed-schema serialization and verifies a persisted fingerprint', () => {
    const state = createP0BState({ previous_search_column: 'embedding' });
    const reordered = {
      fingerprint: state.fingerprint,
      rollback_target: null,
      consumed_nonces: [],
      previous_search_column: 'embedding',
      state: 'DRAFT',
      schema_version: 1,
    };
    expect(parseP0BState(reordered)).toEqual(state);
    expect(fingerprintP0BState(statePayload() as Parameters<typeof fingerprintP0BState>[0]))
      .toBe(state.fingerprint);
  });

  test('rejects non-plain objects, extra/undefined/non-JSON fields, and forged fingerprints', () => {
    const valid = sealedState();
    expect(() => parseP0BState({ ...valid, extra: true })).toThrow(/exact keys/i);
    expect(() => parseP0BState({ ...valid, rollback_target: undefined })).toThrow(/rollback_target/i);
    expect(() => parseP0BState(Object.assign(new (class PersistedState {})(), valid)))
      .toThrow(/plain object/i);
    expect(() => parseP0BState(Object.assign(Object.create(null), valid)))
      .toThrow(/plain object/i);
    expect(() => parseP0BState({ ...valid, consumed_nonces: [Number.NaN] }))
      .toThrow(/nonce/i);
    expect(() => parseP0BState({ ...valid, fingerprint: '0'.repeat(64) }))
      .toThrow(/fingerprint integrity/i);
  });

  test('enforces semantic rollback invariants and durable nonce uniqueness', () => {
    expect(() => parseP0BState(sealedState({ state: 'ACTIVE', rollback_target: null })))
      .toThrow(/ACTIVE.*rollback_target/i);
    expect(() => parseP0BState(sealedState({ state: 'PREPARED', rollback_target: 'ZE' })))
      .toThrow(/PREPARED.*rollback_target/i);
    const repeated = nonce('repeated');
    expect(() => parseP0BState(sealedState({ consumed_nonces: [repeated, repeated] })))
      .toThrow(/unique/i);
    expect(() => parseP0BState(sealedState({
      consumed_nonces: Array.from({ length: P0B_MAX_CONSUMED_NONCES + 1 }, (_, i) => nonce(`n${i}`)),
    }))).toThrow(/ledger cap/i);
  });

  test('rejects sparse, decorated, or subclassed nonce arrays as non-JSON state', () => {
    const sparse = Array(P0B_NONCE_MIN_BYTES);
    sparse[0] = nonce('present');
    expect(() => parseP0BState(sealedState({ consumed_nonces: sparse })))
      .toThrow(/dense plain array/i);

    const decorated = [nonce('decorated')];
    Object.assign(decorated, { extra: true });
    expect(() => parseP0BState(sealedState({ consumed_nonces: decorated })))
      .toThrow(/dense plain array/i);

    class NonceArray extends Array<string> {}
    expect(() => parseP0BState(sealedState({ consumed_nonces: new NonceArray(nonce('subclass')) })))
      .toThrow(/dense plain array/i);
  });

  test('rejects persisted lifecycle states that have spent reserved safety capacity', () => {
    const tooManyForActive = Array.from(
      { length: P0B_MAX_ORDINARY_NONCES + 1 }, (_, i) => nonce(`active-${i}`),
    );
    expect(() => parseP0BState(sealedState({
      state: 'ACTIVE',
      rollback_target: 'FTS_ONLY',
      consumed_nonces: tooManyForActive,
    }))).toThrow(/reserved safety capacity/i);

    const tooManyForCompensating = Array.from(
      { length: P0B_MAX_CONSUMED_NONCES }, (_, i) => nonce(`compensating-${i}`),
    );
    expect(() => parseP0BState(sealedState({
      state: 'COMPENSATING',
      rollback_target: 'FTS_ONLY',
      consumed_nonces: tooManyForCompensating,
    }))).toThrow(/reserved safety capacity/i);
  });

  test('requires canonical prior-column equality, identifier grammar, and the allowed prior set', () => {
    expect(() => createP0BState({ previous_search_column: ' embedding ' }))
      .toThrow(/canonical.*trim/i);
    expect(() => createP0BState({ previous_search_column: 'embedding;drop' }))
      .toThrow(/identifier/i);
    expect(() => createP0BState({ previous_search_column: 'embedding_unknown' }))
      .toThrow(/allowed prior/i);
    expect(createP0BState({ previous_search_column: 'embedding_voyage' }).previous_search_column)
      .toBe('embedding_voyage');
  });
});

describe('P0-B strict authorization and authenticity boundary', () => {
  test('parses only an exact, active, bounded owner-GO authorization envelope', () => {
    const state = createP0BState({ previous_search_column: 'embedding' });
    const parsed = parseP0BAuthorization(authorization(state, 'PREPARING'), authority());
    expect(parsed.transition).toBe('DRAFT->PREPARING');
    expect(parsed.owner_go).toBe('AUTHORIZE_GBRAIN_P0B_STATE_TRANSITION');
  });

  test('does not pretend hashes authenticate and requires preverified envelope authority', () => {
    const state = createP0BState({ previous_search_column: 'embedding' });
    expect(() => parseP0BAuthorization(authorization(state, 'PREPARING'), {
      ...authority(),
      authenticity: 'UNVERIFIED_HASH_ONLY',
    } as never)).toThrow(/preverified.*signed|access-controlled/i);
  });

  test('binds artifact, root, and actor to trusted authority expectations', () => {
    const state = createP0BState({ previous_search_column: 'embedding' });
    for (const [override, authorityOverride] of [
      [{ p0b_artifact_digest: 'c'.repeat(64) }, {}],
      [{ p0b_root_digest: 'd'.repeat(64) }, {}],
      [{ actor: 'other@example.test' }, {}],
      [{}, { expected_artifact_digest: 'c'.repeat(64) }],
      [{}, { expected_root_digest: 'd'.repeat(64) }],
      [{}, { allowed_actors: ['other@example.test'] }],
    ] as const) {
      expect(() => parseP0BAuthorization(
        authorization(state, 'PREPARING', override),
        { ...authority(), ...authorityOverride },
      )).toThrow(/artifact|root|actor/i);
    }
  });

  test('rejects authorization extras, wrong literals, malformed digests, and transition injection', () => {
    const state = createP0BState({ previous_search_column: 'embedding' });
    for (const overrides of [
      { extra: true },
      { schema_version: '1' },
      { action: 'P0B_STATE_TRANSITION ' },
      { owner_go: 'go' },
      { p0b_artifact_digest: `${DIGEST_A} ` },
      { p0b_root_digest: 'A'.repeat(64) },
      { actor: 'øwner' },
      { transition: 'DRAFT->PREPARING\nACTIVE->BLOCKED' },
    ]) {
      expect(() => parseP0BAuthorization(authorization(state, 'PREPARING', overrides), authority()))
        .toThrow();
    }
  });

  test('rejects expired, future-issued, noncanonical, or overlong authorization windows', () => {
    const state = createP0BState({ previous_search_column: 'embedding' });
    const cases = [
      { expires_at: new Date(NOW).toISOString() },
      { issued_at: new Date(NOW + 1).toISOString() },
      { issued_at: '2026-09-03T12:00:00Z' },
      { expires_at: new Date(NOW + P0B_AUTHORIZATION_MAX_WINDOW_MS + 1).toISOString() },
    ];
    for (const overrides of cases) {
      expect(() => parseP0BAuthorization(authorization(state, 'PREPARING', overrides), authority()))
        .toThrow(/time|issued|expires|window/i);
    }
  });

  test('enforces exact ASCII nonce grammar and UTF-8 byte length without trim/coercion', () => {
    const state = createP0BState({ previous_search_column: 'embedding' });
    const badNonces: unknown[] = [
      'x'.repeat(P0B_NONCE_MIN_BYTES - 1),
      'x'.repeat(P0B_NONCE_MAX_BYTES + 1),
      ` ${'x'.repeat(P0B_NONCE_MIN_BYTES)}`,
      `${'x'.repeat(P0B_NONCE_MIN_BYTES)}\n`,
      `${'x'.repeat(P0B_NONCE_MIN_BYTES - 1)}é`,
      123,
    ];
    for (const bad of badNonces) {
      expect(() => parseP0BAuthorization(
        authorization(state, 'PREPARING', { nonce: bad }), authority(),
      )).toThrow(/nonce/i);
    }
  });

  test('validates trusted now as Date or epoch and rejects invalid time objects', () => {
    const state = createP0BState({ previous_search_column: 'embedding' });
    expect(parseP0BAuthorization(authorization(state, 'PREPARING'), authority(new Date(NOW))))
      .toBeDefined();
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, '2026-09-03', new Date('bad')]) {
      expect(() => parseP0BAuthorization(
        authorization(state, 'PREPARING'), authority(now as never),
      )).toThrow(/trusted now/i);
    }
  });
});

describe('P0-B governed transitions, rollback policy, and persistence CAS', () => {
  test('binds authorization to the exact current fingerprint and transition', () => {
    const draft = createP0BState({ previous_search_column: 'embedding' });
    const preparing = transition(draft, 'PREPARING').state;
    expect(() => transitionP0BState(preparing, {
      authorization: authorization(draft, 'PREPARING', { nonce: nonce('fresh') }),
      authorization_authority: authority(),
    })).toThrow(/expected state fingerprint|transition.*current state/i);
  });

  test('returns state plus the exact persistence CAS tuple', () => {
    const draft = createP0BState({ previous_search_column: 'embedding' });
    const result = transition(draft, 'PREPARING');
    expect(result.persistence_cas).toEqual({
      expected_fingerprint: draft.fingerprint,
      new_fingerprint: result.state.fingerprint,
    });
    expect(result.state.consumed_nonces).toEqual([nonce('transition-preparing')]);
  });

  test('reserves two nonce slots so compensation and rollback remain possible at ordinary cap', () => {
    const consumed_nonces = Array.from(
      { length: P0B_MAX_ORDINARY_NONCES }, (_, index) => nonce(`used-${index}`),
    );
    const active = parseP0BState(sealedState({
      state: 'ACTIVE',
      rollback_target: 'FTS_ONLY',
      consumed_nonces,
    }));
    expect(() => transitionP0BState(active, {
      authorization: authorization(active, 'ACTIVE', { nonce: nonce('ordinary-over-cap') }),
      authorization_authority: authority(),
      rollback_policy: { live_ze_probe: false, last_good_google_available: false },
    })).toThrow(/ordinary nonce ledger cap/i);

    const compensating = transitionP0BState(active, {
      authorization: authorization(active, 'COMPENSATING', { nonce: nonce('compensate') }),
      authorization_authority: authority(),
    }).state;
    const rolledBack = transitionP0BState(compensating, {
      authorization: authorization(compensating, 'ROLLED_BACK', { nonce: nonce('rolled-back') }),
      authorization_authority: authority(),
    }).state;
    expect(rolledBack.consumed_nonces).toHaveLength(P0B_MAX_CONSUMED_NONCES);
  });

  test('derives rollback from trusted now and forbids ZE exactly at or after cutoff', () => {
    expect(selectP0BRollbackTarget({
      now: Date.parse('2026-09-03T23:59:59.999Z'),
      live_ze_probe: true,
      last_good_google_available: false,
    })).toBe('ZE');
    for (const now of [Date.parse(P0B_SHUTDOWN_CUTOFF_ISO), Date.parse('2026-09-04T00:00:00.001Z')]) {
      expect(selectP0BRollbackTarget({
        now,
        live_ze_probe: true,
        last_good_google_available: true,
      })).toBe('LAST_GOOD_GOOGLE');
    }
  });

  test('activation derives policy result and rejects caller-selected rollback data', () => {
    let state = createP0BState({ previous_search_column: 'embedding' });
    state = transition(state, 'PREPARING').state;
    state = transition(state, 'RECONCILING').state;
    state = transition(state, 'PREPARED').state;
    const active = transition(state, 'ACTIVE', {}, {
      live_ze_probe: true,
      last_good_google_available: false,
    }).state;
    expect(active.rollback_target).toBe('ZE');
    expect(() => transitionP0BState(state, {
      authorization: authorization(state, 'ACTIVE', { rollback_target: 'FTS_ONLY' }),
      authorization_authority: authority(),
      rollback_policy: { live_ze_probe: true, last_good_google_available: false },
    })).toThrow(/exact keys/i);
  });

  test('activation at cutoff cannot choose ZE even when the live probe passes', () => {
    let state = createP0BState({ previous_search_column: 'embedding' });
    state = transition(state, 'PREPARING').state;
    state = transition(state, 'RECONCILING').state;
    state = transition(state, 'PREPARED').state;
    const cutoff = Date.parse(P0B_SHUTDOWN_CUTOFF_ISO);
    const result = transitionP0BState(state, {
      authorization: authorization(state, 'ACTIVE', {
        issued_at: new Date(cutoff - 1_000).toISOString(),
        expires_at: new Date(cutoff + 60_000).toISOString(),
      }),
      authorization_authority: authority(cutoff),
      rollback_policy: { live_ze_probe: true, last_good_google_available: false },
    });
    expect(result.state.rollback_target).toBe('FTS_ONLY');
  });

  test('snapshots trusted now once for authorization and activation policy', () => {
    let state = createP0BState({ previous_search_column: 'embedding' });
    state = transition(state, 'PREPARING').state;
    state = transition(state, 'RECONCILING').state;
    state = transition(state, 'PREPARED').state;
    let reads = 0;
    const changingAuthority = {
      authenticity: P0B_AUTHENTICITY,
      get now() {
        reads += 1;
        return reads === 1 ? NOW : Date.parse(P0B_SHUTDOWN_CUTOFF_ISO);
      },
      expected_artifact_digest: DIGEST_A,
      expected_root_digest: DIGEST_B,
      allowed_actors: ['owner@example.test'],
    } as const;
    const result = transitionP0BState(state, {
      authorization: authorization(state, 'ACTIVE'),
      authorization_authority: changingAuthority,
      rollback_policy: { live_ze_probe: true, last_good_google_available: false },
    });
    expect(reads).toBe(1);
    expect(result.state.rollback_target).toBe('ZE');
  });
});

describe('P0-B explicit config and credential authority', () => {
  const cleanConfig = () => ({
    file_config: { unrelated: true },
    env: { PATH: '/usr/bin' },
    db_runtime: { ...P0B_CONTRACT },
    per_call: {},
  });

  test('requires authoritative DB/runtime values to match the fixed contract exactly', () => {
    expect(validateP0BConfigAuthority(cleanConfig())).toEqual(P0B_CONTRACT);
    for (const [key, value] of [
      ['embedding_model', 'google:text-embedding-004'],
      ['embedding_dimensions', 1536],
      ['embedding_column', 'embedding'],
      ['registry_embedding_column', 'embedding_voyage'],
      ['embedding_provider', 'openai'],
      ['embedding_base_url', 'https://proxy.invalid'],
    ] as const) {
      expect(() => validateP0BConfigAuthority({
        ...cleanConfig(),
        db_runtime: { ...P0B_CONTRACT, [key]: value },
      })).toThrow(new RegExp(key, 'i'));
    }
    expect(() => validateP0BConfigAuthority({
      ...cleanConfig(),
      db_runtime: { ...P0B_CONTRACT, extra: true } as never,
    })).toThrow(/exact keys/i);
  });

  test('rejects governed model/dims/column/registry/provider/base URL in every lower authority plane', () => {
    const conflicts = [
      ['file_config', { nested: { embedding_model: P0B_CONTRACT.embedding_model } }],
      ['env', { GBRAIN_EMBEDDING_DIMENSIONS: '768' }],
      ['env', { GOOGLE_GENERATIVE_AI_BASE_URL: P0B_CONTRACT.embedding_base_url }],
      ['per_call', { provider: 'google' }],
      ['per_call', { selected_embedding_column: 'embedding_g768' }],
      ['per_call', { embeddingColumn: 'embedding_g768' }],
      ['per_call', { embeddingModel: P0B_CONTRACT.embedding_model }],
      ['file_config', { embedding_columns: { embedding_g768: {} } }],
      ['file_config', { provider_base_urls: { google: 'https://proxy.invalid' } }],
      ['per_call', { base_urls: { google: 'https://proxy.invalid' } }],
    ] as const;
    for (const [plane, conflict] of conflicts) {
      expect(() => validateP0BConfigAuthority({
        ...cleanConfig(),
        [plane]: conflict,
      })).toThrow(new RegExp(plane.replace('_', '[ _]'), 'i'));
    }
  });

  test('forbids every Google secret env fallback even when empty', () => {
    for (const key of ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
      expect(() => validateP0BConfigAuthority({
        ...cleanConfig(),
        env: { [key]: '' },
      })).toThrow(/secret.*environment|environment.*secret/i);
    }
  });

  test('validates exact value-free systemd credential metadata without I/O', () => {
    expect(validateP0BCredentialMetadata(P0B_CREDENTIAL_CONTRACT))
      .toEqual(P0B_CREDENTIAL_CONTRACT);
    for (const mutation of [
      { extra: true },
      { schema_version: '1' },
      { unit: 'other.service' },
      { credential_id: 'other' },
      { directory: '/tmp' },
      { filename: 'other' },
      { resolved_path: '/tmp/key' },
      { load_credential_directive: 'LoadCredential=key:/tmp/key' },
      { source_policy: 'ENV_FALLBACK_ALLOWED' },
      { env_fallback: 'ALLOWED' },
    ]) {
      expect(() => validateP0BCredentialMetadata({
        ...P0B_CREDENTIAL_CONTRACT,
        ...mutation,
      })).toThrow();
    }
  });
});
