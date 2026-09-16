// Hosted-only executable: delegate real methods, park at durable boundaries.
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { PageFileJournal } from '../../../src/core/page-file-journal.ts';
import { operationsByName, type OperationContext } from '../../../src/core/operations.ts';
import { runPull } from '../../../src/commands/sources-harden.ts';
import { installDirtyRootBoundary } from './page-file-dirty-root-boundary.ts';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1'
  || process.env.REQUIRE_PAGE_FILE_CONNECTED_POSTGRES !== '1' || !process.send) {
  throw new Error('dirty-root child requires hosted disposable IPC harness');
}
const park = async (boundary: string): Promise<never> => {
  process.on('message', () => {});
  process.send!({ boundary, pid: process.pid });
  return new Promise<never>(() => {});
};
process.once('message', async (input: any) => {
  const engine = new PostgresEngine();
  try {
    await engine.connect(input.config);
    await engine.initSchema(); // actual fixed anchor, unchanged pins, no repair
    if (input.boundary === 'intent') {
      const prepare = PageFileJournal.prototype.prepare;
      PageFileJournal.prototype.prepare = async function (...args) {
        await prepare.apply(this, args);
        await park('intent');
      };
    }
    if (input.boundary === 'dirty-root') {
      // Root services use a private adapter engine, so intercept the prototype,
      // not only the ordinary connected engine passed to runPull.
      installDirtyRootBoundary(PostgresEngine.prototype, () => park('dirty-root'));
    }
    let result: unknown;
    if (input.action === 'pull' || input.action === 'reconcile') {
      await runPull(engine, [input.source, '--branch', 'incoming',
        ...(input.action === 'reconcile' ? ['--recover-root', ...(input.approved ? ['--yes'] : [])] : [])]);
      result = { ok: true };
    } else {
      const ctx = { engine, config: { engine: 'postgres' }, remote: false,
        sourceId: input.source, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } } as OperationContext;
      result = await operationsByName[input.operation].handler(ctx, input.request);
    }
    await engine.disconnect();
    process.send!({ result });
  } catch (error: any) {
    await engine.disconnect().catch(() => {});
    process.send!({ error: { message: String(error.message), code: error.code } });
  } finally { process.disconnect?.(); }
});
