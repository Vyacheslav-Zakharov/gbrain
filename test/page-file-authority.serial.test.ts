import { describe, expect, test, mock, beforeEach, spyOn } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

// No sockets or credentials: postgres.js transport only is replaced. The real
// provider and PostgresEngine methods execute against this scripted transport.
const calls: { url: string; options: Record<string, any> }[] = [];
let identity = { session_user: 'file_adapter', current_user: 'file_adapter', database_name: 'fixture', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false };
let ended = 0;
let released = 0;
let statements: string[] = [];
let failConnect = false;
let nextSession = 0;
let events: { session: number; query: string }[] = [];
let queryFailure: (query: string) => void = () => {};
let commitRolledBack = false;
function reserved() {
  const session = ++nextSession;
  const unsafe = async (query: string) => {
    statements.push(query); events.push({ session, query }); queryFailure(query);
    return query.includes('session_user') ? [identity]
      : Object.assign([], { command: query === 'COMMIT' && commitRolledBack ? 'ROLLBACK' : query });
  };
  return Object.assign(async (parts: TemplateStringsArray) => unsafe(parts.join('?')), {
    unsafe,
    release: () => { released++; events.push({ session, query: 'RELEASE' }); },
  });
}
// ReservedSql deliberately has no begin/reserve/end: those belong to the pool.
const pool = Object.assign(() => { throw new Error('ordinary pool query forbidden'); }, {
  reserve: async () => { if (failConnect) throw new Error('transport contains secret'); return reserved(); },
  end: async () => { ended++; },
});
mock.module('postgres', () => ({ default: Object.assign((url: string, options: Record<string, any>) => {
  calls.push({ url, options }); return pool;
}, { BigInt: {} }) }));
const load = () => import('../src/core/page-file-authority.ts');
const options = () => ({
  mode: 'offline-verification' as const,
  credentialReference: 'fixture-adapter',
  resolveCredential: async (reference: string) => { expect(reference).toBe('fixture-adapter'); return 'postgres://file_adapter:fixture@invalid/fixture'; },
  expected: { role: 'file_adapter', database: 'fixture', ordinaryRole: 'ordinary' },
});
beforeEach(() => {
  calls.length = 0; statements = []; ended = 0; released = 0; failConnect = false;
  nextSession = 0; events = []; queryFailure = () => {}; commitRolledBack = false;
  identity = { session_user: 'file_adapter', current_user: 'file_adapter', database_name: 'fixture', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false };
});

// Probe only the private transaction seam; the normal enrollment test below
// still executes the real PageFileDatabase implementation.
async function probeTransactions(fn: (tx: BrainEngine, parent: BrainEngine) => Promise<void>,
  check: (run: () => Promise<void>) => Promise<void>) {
  const { PageFileDatabase } = await import('../src/core/page-file-db.ts');
  const method = spyOn(PageFileDatabase.prototype, 'enroll').mockImplementation(async function(this: { engine?: unknown }) {
    const parent = (this as unknown as { engine: BrainEngine }).engine;
    return parent.transaction(tx => fn(tx, parent));
  });
  const authority = await (await load()).createPageFileEnrollmentAuthority({ ...options(), adapterRole: 'other_adapter' });
  const service = authority.forPage({ source: 'fixture', slug: 'page',
    host: { brainId: 'fixture-brain', journalDirectory: '/unused', withExclusiveRoot: async fn => fn() } });
  try { await check(() => service.enroll()); }
  finally { method.mockRestore(); await authority.close(); }
}

describe('private page-file authority', () => {
  test('rejects nested transactions before SQL without committing the outer transaction early', async () => {
    await probeTransactions(async (tx, parent) => {
      for (const engine of [tx, parent]) {
        await expect(engine.transaction(async () => { throw new Error('must not execute'); }))
          .rejects.toThrow('page_file_authority_nested_transaction');
      }
      await tx.executeRaw('SELECT outer_work');
    }, async run => { await run(); });
    expect(statements.filter(q => !q.includes('session_user'))).toEqual(['BEGIN', 'SELECT outer_work', 'COMMIT']);
  });
  test('commits only after work and releases the same identity-verified session', async () => {
    await probeTransactions(async (tx, parent) => {
      expect(tx).not.toBe(parent);
      await tx.executeRaw('SELECT fixture_work');
      expect(statements).not.toContain('COMMIT');
    }, async run => { await run(); });
    const operation = events.filter(e => e.session === 2).map(e => e.query);
    expect(operation[0]).toContain('session_user');
    expect(operation.slice(1)).toEqual(['BEGIN', 'SELECT fixture_work', 'COMMIT', 'RELEASE']);
    expect(nextSession).toBe(2);
  });
  test('rolls back callback failure and preserves the original error', async () => {
    const failure = new Error('fixture_callback_failure');
    await probeTransactions(async tx => {
      await tx.executeRaw('SELECT fixture_work');
      throw failure;
    }, async run => { await expect(run()).rejects.toBe(failure); });
    expect(events.filter(e => e.session === 2).map(e => e.query).slice(1))
      .toEqual(['BEGIN', 'SELECT fixture_work', 'ROLLBACK', 'RELEASE']);
  });
  test.each(['BEGIN', 'COMMIT'])('preserves %s failure and rolls back before releasing', async command => {
    const failure = new Error('fixture_control_failure');
    queryFailure = query => { if (query === command) throw failure; };
    let ran = false;
    await probeTransactions(async () => { ran = true; }, async run => { await expect(run()).rejects.toBe(failure); });
    expect(ran).toBe(command === 'COMMIT');
    expect(events.filter(e => e.session === 2).map(e => e.query).slice(-2)).toEqual(['ROLLBACK', 'RELEASE']);
  });
  test('never reports success when PostgreSQL answers COMMIT with ROLLBACK', async () => {
    commitRolledBack = true;
    await probeTransactions(async () => {}, async run => {
      await expect(run()).rejects.toThrow('page_file_authority_transaction_aborted');
    });
  });
  test('rollback failure closes authority without masking callback failure or borrowing again', async () => {
    const failure = new Error('fixture_callback_failure');
    queryFailure = query => { if (query === 'ROLLBACK') throw new Error('fixture_rollback_failure'); };
    await probeTransactions(async () => { throw failure; }, async run => {
      await expect(run()).rejects.toBe(failure);
      expect(ended).toBe(1);
      const before = nextSession;
      await expect(run()).rejects.toThrow('page_file_authority_closed');
      expect(nextSession).toBe(before);
    });
    expect(ended).toBe(1);
    expect(released).toBe(2);
  });
  test('overlapping operation contexts keep transaction state and SQL sessions independent', async () => {
    let entered = 0;
    let unblock!: () => void;
    const both = new Promise<void>(resolve => { unblock = resolve; });
    await probeTransactions(async tx => {
      if (++entered === 2) unblock();
      await both;
      await tx.executeRaw('SELECT independent_work');
    }, async run => { await Promise.all([run(), run()]); });
    // The transport permits overlap to stress ALS isolation; a real max:1 pool
    // queues these borrows instead. Neither may reuse transaction state.
    expect(nextSession).toBe(3);
    for (const session of [2, 3]) {
      const queries = events.filter(e => e.session === session).map(e => e.query);
      expect(queries[0]).toContain('session_user');
      expect(queries.slice(1)).toEqual(['BEGIN', 'SELECT independent_work', 'COMMIT', 'RELEASE']);
    }
  });
  test('owns an explicit bounded pool and closes it once without exposing SQL', async () => {
    const authority = await (await load()).createPageFileAuthority(options());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('postgres://file_adapter:fixture@invalid/fixture');
    expect(calls[0].options.max).toBe(1);
    expect(calls[0].options.prepare).toBe(false);
    expect(statements.some(q => q.includes('session_user') && q.includes('current_user'))).toBe(true);
    expect(released).toBe(1);
    expect(Object.keys(authority).sort()).toEqual(['close', 'forPage', 'forRoot']);
    await authority.close();
    await authority.close();
    expect(ended).toBe(1);
  });
  test('bounded page services recheck every borrowed session and stop after close', async () => {
    const authority = await (await load()).createPageFileAuthority(options());
    const service = authority.forPage({ source: 'fixture', slug: 'page',
      host: { brainId: 'fixture-brain', journalDirectory: '/unused', withLockedBinding: async fn => fn() },
      validate: () => {},
    });
    expect(Object.keys(service).sort()).toEqual(['pages', 'sync']);
    expect(Object.keys(service.pages).sort()).toEqual(['get', 'put', 'recover']);
    expect(Object.keys(service.sync).sort()).toEqual(['capture', 'commit']);
    expect(Object.isFrozen(service.pages)).toBe(true);
    // Real PageFileDatabase observes no binding on the scripted transport.
    await expect(service.pages.get()).rejects.toThrow('not_enrolled');
    const reads = statements.filter(q => q.includes('SELECT * FROM page_file_bindings')).length;
    identity.current_user = 'ordinary';
    await expect(service.pages.get()).rejects.toThrow('page_file_authority_identity_mismatch');
    expect(statements.filter(q => q.includes('SELECT * FROM page_file_bindings'))).toHaveLength(reads);
    await authority.close();
    const before = statements.length;
    await expect(service.sync.capture()).rejects.toThrow('page_file_authority_closed');
    expect(statements).toHaveLength(before);
  });
  test('root transition binds private authority inside the supplied exclusive gate', async () => {
    const authority = await (await load()).createPageFileAuthority(options());
    let gate = 0;
    const root = authority.forRoot({ root: '/unused', lockDirectory: '/unused-locks', topology: 'single-host-local',
      withExclusiveRoot: async () => { gate++; throw new Error('fixture_gate_refusal'); },
    });
    expect(Object.keys(root).sort()).toEqual(['reconcile', 'transition']);
    const before = statements.length;
    let mutation = false;
    await expect(root.transition(async () => { mutation = true; })).rejects.toThrow('fixture_gate_refusal');
    expect(gate).toBe(1);
    expect(mutation).toBe(false);
    expect(statements).toHaveLength(before);
    await authority.close();
  });
  test('offline enrollment owns a different login and exports no write adapter', async () => {
    const module = await load();
    expect(typeof module.createPageFileEnrollmentAuthority).toBe('function');
    await expect(module.createPageFileEnrollmentAuthority({ ...options(), adapterRole: 'file_adapter' })).rejects.toThrow('page_file_authority_identity_mismatch');
    expect(calls).toHaveLength(0);
    identity.session_user = identity.current_user = 'file_enrollment';
    const lifecycle = await module.createPageFileEnrollmentAuthority({ ...options(), adapterRole: 'file_adapter',
      expected: { ...options().expected, role: 'file_enrollment' },
      resolveCredential: async () => 'postgres://file_enrollment:fixture@invalid/fixture',
    });
    expect(Object.keys(lifecycle).sort()).toEqual(['close', 'forPage']);
    let locked = 0;
    const service = lifecycle.forPage({ source: 'fixture', slug: 'page',
      host: { brainId: 'fixture-brain', journalDirectory: '/unused', withExclusiveRoot: async fn => { locked++; return fn(); } },
    });
    expect(Object.keys(service)).toEqual(['enroll']);
    await expect(service.enroll()).rejects.toThrow('ineligible_page');
    expect(locked).toBe(1);
    expect(statements.some(q => q.includes('INSERT INTO page_file_bindings'))).toBe(false);
    await lifecycle.close();
  });
  test.each(['session_user', 'current_user', 'database_name'] as const)('rejects mismatched %s and closes the failed pool', async field => {
    identity[field] = 'unexpected';
    await expect((await load()).createPageFileAuthority(options())).rejects.toThrow('page_file_authority_identity_mismatch');
    expect(ended).toBe(1);
    expect(released).toBe(1);
  });
  test.each(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolbypassrls'] as const)('refuses elevated %s', async field => {
    identity[field] = true;
    await expect((await load()).createPageFileAuthority(options())).rejects.toThrow('page_file_authority_identity_mismatch');
    expect(ended).toBe(1);
  });
  test('transport failure is sanitized and never falls back', async () => {
    failConnect = true;
    await expect((await load()).createPageFileAuthority(options())).rejects.toThrow('page_file_authority_unavailable');
    expect(calls).toHaveLength(1);
    expect(ended).toBe(1);
  });
  test('same ordinary role is refused before credential access', async () => {
    await expect((await load()).createPageFileAuthority({ ...options(), expected: { ...options().expected, ordinaryRole: 'file_adapter' } })).rejects.toThrow('page_file_authority_identity_mismatch');
    expect(calls).toHaveLength(0);
  });
  test('production refuses before resolving credentials or opening a pool', async () => {
    const module = await load().catch(() => ({} as Awaited<ReturnType<typeof load>>));
    expect(typeof module.createPageFileAuthority).toBe('function');
    let resolved = false;
    await expect(module.createPageFileAuthority({ ...options(), mode: 'production', resolveCredential: async () => { resolved = true; throw new Error('must not resolve'); } })).rejects.toThrow('file_runtime_prerequisites_pending');
    expect(resolved).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
