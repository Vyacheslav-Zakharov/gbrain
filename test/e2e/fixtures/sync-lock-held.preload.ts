// Child-only seam: preserve real acquisition/heartbeat/signal cleanup, pause
// only the sync work callback after withRefreshingLock has acquired its lock.
import { mock } from 'bun:test';
import * as locks from '../../../src/core/db-lock.ts';
const realWithRefreshingLock = locks.withRefreshingLock;
mock.module('../../../src/core/db-lock.ts', () => ({
  ...locks,
  withRefreshingLock: (engine: Parameters<typeof realWithRefreshingLock>[0], lockId: string,
    work: () => Promise<unknown>, opts?: Parameters<typeof realWithRefreshingLock>[3]) =>
    realWithRefreshingLock(engine, lockId, async () => {
      if (lockId !== 'gbrain-sync:default') throw new Error(`Unexpected fixture lock: ${lockId}`);
      process.stdout.write(`E2E_SYNC_LOCK_HELD:${process.pid}\n`);
      // Keep the event loop responsive to the REAL CLI SIGTERM handler.
      // Never run work/release here: timeout is a hard fixture failure.
      await new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Held-lock fixture was not signalled')), 20_000);
      });
      return work();
    }, opts),
}));
