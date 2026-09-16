// Test-only executable. Never imported by production or the test runner.
// Hooks delegate real methods, then stop on IPC; no SQL/result replacement and
// no production instrumentation. SIGKILL is delivered only by the parent.
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { PageFileDatabase } from '../../../src/core/page-file-db.ts';
import { PageFileJournal } from '../../../src/core/page-file-journal.ts';
import { operationsByName, type OperationContext } from '../../../src/core/operations.ts';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1'
  || process.env.REQUIRE_PAGE_FILE_CONNECTED_POSTGRES !== '1' || !process.send) {
  throw new Error('crash child requires hosted disposable IPC harness');
}
const send = (message: unknown) => process.send!(message);
const park = async (boundary: string): Promise<never> => {
  // An unresolved Promise alone does not keep Bun alive. Keep the IPC channel
  // referenced while parked; no timer or graceful exit may substitute for kill.
  process.on('message', () => {});
  send({ boundary, pid: process.pid });
  return new Promise<never>(() => {});
};
process.once('message', async (input: any) => {
  const engine = new PostgresEngine();
  try {
    await engine.connect(input.config); // actual protected fixed-path bootstrap
    await engine.initSchema(); // candidate path must NOT migrate or repair
    if (input.boundary) {
      const prepare = PageFileJournal.prototype.prepare;
      PageFileJournal.prototype.prepare = async function (...args) {
        await prepare.apply(this, args);
        if (input.boundary === 'journal') await park('journal');
      };
      const put = PageFileDatabase.prototype.put;
      PageFileDatabase.prototype.put = async function (...args) {
      // Observe the ACTUAL private authority's instance-owned transaction, not
      // PostgresEngine.prototype (authority intentionally overrides that method).
      const privateEngine = (this as any).engine;
      const transaction = privateEngine.transaction.bind(privateEngine);
      privateEngine.transaction = async (fn: any): Promise<any> => {
        let stage: string | undefined;
        const result = await transaction(async (tx: any) => {
          const execute = tx.executeRaw.bind(tx);
          tx.executeRaw = async (sql: string, parameters: unknown[]) => {
            if (sql.startsWith('INSERT INTO page_file_write_authorizations(')) {
              // Reached only after rename + directory fsync + exact digest checks.
              if (input.boundary === 'rename') await park('rename');
              stage = 'commit';
            }
            if (sql.startsWith('INSERT INTO page_file_operations(')) stage = 'prepared';
            return execute(sql, parameters);
          };
          return fn(tx);
        });
        // The original transaction promise resolves only AFTER real PG COMMIT.
        if (stage && stage === input.boundary) await park(stage);
        return result;
      };
      try { return await put.apply(this, args); }
      finally { privateEngine.transaction = transaction; }
      };
    }
    const ctx = { engine, config: { engine: 'postgres' }, remote: input.remote ?? false,
      sourceId: input.source, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } } as OperationContext;
    const result = await operationsByName[input.operation].handler(ctx, input.request);
    await engine.disconnect();
    send({ result });
  } catch (error: any) {
    await engine.disconnect().catch(() => {});
    send({ error: { message: String(error.message), code: error.code } });
  } finally { process.disconnect?.(); }
});
