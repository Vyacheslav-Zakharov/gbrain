import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresEngine } from './postgres-engine.ts';
import { ConnectionManager } from './connection-manager.ts';
import { PageFileDatabase } from './page-file-db.ts';
import { PageFileSync, type FileReadBaseline } from './page-file-sync.ts';
import type { CheckedPageFields } from './page-checked-store.ts';
import { transitionPageFileRoot, reconcilePageFileRootTransition } from './page-file-root-transition.ts';
import type { PageFileCoordinationHost } from './page-file-writer-gate.ts';

export interface PageFileAuthorityRoot extends PageFileCoordinationHost {
  revalidate?(): Promise<void>;
  withExclusiveRoot<T>(fn: () => Promise<T>): Promise<T>;
}

export interface PageFileAuthorityWrite {
  operation_id: string;
  expected_revision: string;
  raw_markdown: string;
  file_baseline: { binding_id: string; generation: string; raw_sha256: string };
  page: CheckedPageFields;
}
/** Trusted host binding, not request data. Retain source/privacy validation. */
export interface PageFileAuthorityTarget {
  source: string;
  slug: string;
  host: ConstructorParameters<typeof PageFileDatabase>[1];
  validate(row: Record<string, any>): void;
}

/** Internal bootstrap only. This slice cannot activate a production runtime.
 * Credential resolution belongs to a trusted protected-file bootstrap, never
 * operation parameters, DB config, jobs, or a shared config dump.
 */
export interface PageFileAuthorityOptions {
  mode: 'offline-verification' | 'production';
  credentialReference: string;
  resolveCredential(reference: string): Promise<string>;
  expected: { role: string; database: string; ordinaryRole: string };
}
class AuthorityError extends Error {}
const identityFailure = () => new AuthorityError('page_file_authority_identity_mismatch');
const unavailable = () => new AuthorityError('page_file_authority_unavailable');
async function openAuthority(options: PageFileAuthorityOptions) {
  if (options.mode !== 'offline-verification') throw new Error('file_runtime_prerequisites_pending');
  const expected = Object.freeze({ ...options.expected });
  if (!expected.role || !expected.database || !expected.ordinaryRole || expected.role === expected.ordinaryRole) throw identityFailure();
  let pool: ReturnType<typeof postgres>;
  try {
    const url = await options.resolveCredential(options.credentialReference);
    // No createEngine/connect: absent poolSize borrows db.ts's singleton, and
    // instance connect inherits GBRAIN_DIRECT_DATABASE_URL via its manager.
    pool = postgres(url, { max: 1, prepare: false, connect_timeout: 10,
      idle_timeout: 20, types: { bigint: postgres.BigInt }, onnotice: () => {} });
  } catch { throw unavailable(); }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= pool.end({ timeout: 5 });
  const verify = async (session: postgres.ReservedSql) => {
    const rows = await session.unsafe(`SELECT session_user, current_user,
      current_database() AS database_name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
      FROM pg_catalog.pg_roles WHERE rolname = current_user`);
    const row = rows[0];
    if (rows.length !== 1 || row.session_user !== expected.role || row.current_user !== expected.role
      || row.database_name !== expected.database || ['rolsuper','rolcreatedb','rolcreaterole','rolbypassrls'].some(key => row[key] !== false)) throw identityFailure();
  };
  try {
    const session = await pool.reserve();
    try { await verify(session); } finally { session.release(); }
  } catch (error) {
    try { await close(); } catch { /* Do not expose connection strings in driver errors. */ }
    throw error instanceof AuthorityError ? error : unavailable();
  }
  // Each operation owns one reserved physical session. A reconnect/new borrow
  // must pass identity checks before any adapter SQL. No engine connect/retry,
  // worker inheritance, ordinary manager, or environment-derived direct pool.
  const sessions = new AsyncLocalStorage<postgres.ReservedSql>();
  const engine = new PostgresEngine();
  Object.defineProperty(engine, 'sql', { get() {
    const session = sessions.getStore();
    if (!session) throw unavailable();
    return session;
  } });
  // Explicit empty direct route overrides the manager's env/derived URL.
  // The engine remains private; adapters currently use only sql/transaction.
  engine.connectionManager = new ConnectionManager({ url: '', directUrl: '', readPoolOwnedExternally: true });
  // ReservedSql has no .begin(): transaction control must stay on the exact
  // physical session whose login was verified, never on another pool borrow.
  const transactions = new WeakSet<postgres.ReservedSql>();
  engine.transaction = async fn => {
    const session = sessions.getStore();
    if (!session) throw unavailable();
    // BrainEngine does not promise nested transactions. Like postgres.js's
    // transaction-scoped SQL (which has no begin), reject rather than issuing
    // nested BEGIN/COMMIT that could commit the caller's work prematurely.
    if (transactions.has(session)) throw new AuthorityError('page_file_authority_nested_transaction');
    transactions.add(session);
    try {
      await session.unsafe('BEGIN');
      const result = await fn(Object.create(engine));
      const committed = await session.unsafe('COMMIT');
      // PostgreSQL rolls back an aborted transaction on COMMIT (e.g. a query
      // error caught by the callback); do not report an uncommitted result.
      if (committed.command === 'ROLLBACK') throw new AuthorityError('page_file_authority_transaction_aborted');
      return result;
    } catch (error) {
      try { await session.unsafe('ROLLBACK'); }
      catch { try { await close(); } catch { /* Preserve the original failure. */ } }
      throw error;
    } finally { transactions.delete(session); }
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (closing) throw new AuthorityError('page_file_authority_closed');
    let session: postgres.ReservedSql;
    try {
      session = await pool.reserve();
    } catch { throw unavailable(); }
    try {
      if (closing) throw new AuthorityError('page_file_authority_closed');
      try { await verify(session); }
      catch (error) { throw error instanceof AuthorityError ? error : unavailable(); }
      return await sessions.run(session, fn);
    } finally { session.release(); }
  };
  return { close, run, engine };
}

export interface PageFileEnrollmentTarget {
  source: string;
  slug: string;
  reviewed?: Parameters<PageFileDatabase['enroll']>[2];
  host: { brainId: string; journalDirectory: string; mappingGeneration?: string; revalidate?(): Promise<void>; withExclusiveRoot<T>(fn: () => Promise<T>): Promise<T> };
}

/** Separate offline lifecycle bootstrap; never registered in request context.
 * This is not enrollment readiness or operator authorization. The final host
 * must revalidate the reviewed manifest under its exclusive root through commit.
 */
export async function createPageFileEnrollmentAuthority(options: PageFileAuthorityOptions & { adapterRole: string }) {
  if (options.mode !== 'offline-verification') throw new Error('file_runtime_prerequisites_pending');
  if (!options.adapterRole || options.expected.role === options.adapterRole) throw identityFailure();
  const { close, run, engine } = await openAuthority(options);
  return Object.freeze({ close, forPage(target: PageFileEnrollmentTarget) {
    const { source, slug } = target;
    const host = Object.freeze({ ...target.host });
    // Exclusive gate encloses identity verification, DB locks, and COMMIT.
    // Database's required host callback is already inside that gate: no flock
    // reacquisition, and no engine passed to host/operator code.
    const pages = new PageFileDatabase(engine, { brainId: host.brainId, mappingGeneration: host.mappingGeneration, journalDirectory: host.journalDirectory,
      withLockedBinding: fn => fn() });
    const reviewed = target.reviewed && structuredClone(target.reviewed);
    return Object.freeze({ enroll: () => host.withExclusiveRoot(() => run(async () => {
      await host.revalidate?.();
      return pages.enroll(source, slug, reviewed, host.revalidate);
    })) });
  } });
}

/** Trusted host bootstrap handle: pass only the bound services to request code. */
export async function createPageFileAuthority(options: PageFileAuthorityOptions) {
  const { close, run, engine } = await openAuthority(options);
  return Object.freeze({ close, forPage(target: PageFileAuthorityTarget) {
    const { source, slug, validate } = target;
    const host = Object.freeze({ ...target.host });
    const pages = new PageFileDatabase(engine, host);
    const sync = new PageFileSync(engine, host);
    return Object.freeze({
      pages: Object.freeze({
        get: () => run(() => pages.get(source, slug, validate)),
        put: (request: PageFileAuthorityWrite) => {
          const captured = structuredClone(request);
          return run(() => pages.put(source, slug, captured, validate));
        },
        recover: (request: PageFileAuthorityWrite & { action: 'resume-exact' | 'abort' }) => {
          const captured = structuredClone(request);
          return run(() => pages.recover(source, slug, captured, validate));
        },
      }),
      sync: Object.freeze({
        capture: () => run(() => sync.capture(source, slug)),
        commit: (baseline: FileReadBaseline) => run(() => sync.commit(baseline)),
      }),
    });
  }, forRoot(target: PageFileAuthorityRoot) {
    const host = Object.freeze({ ...target });
    return Object.freeze({
      // Host acquires exclusive root exactly once. The existing transition seam
      // is already locked; ordinary Git/import callbacks never receive engine.
      transition: <T>(mutate: () => Promise<T>) => host.withExclusiveRoot(() =>
        run(() => transitionPageFileRoot(engine, host, mutate))),
      // Existing reconciliation owns its own exclusive lock; do not nest it.
      reconcile: () => run(() => reconcilePageFileRootTransition(engine, host)),
    });
  } });
}
