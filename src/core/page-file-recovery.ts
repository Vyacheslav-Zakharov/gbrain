import { isDeepStrictEqual } from 'node:util';
import { open, rename, stat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncDirectory } from './page-file-journal.ts';
import { PageFileJournal, rawDigest, type FileJournalRecord } from './page-file-journal.ts';
import type { PageFileStoreAdapter, FileOperationState, FileOperationResult } from './page-file-store.ts';

export interface PageFileRecoveryIntent { action: 'resume-exact' | 'abort'; record: FileJournalRecord }
export interface PageFileRecoveryAdapter extends Omit<PageFileStoreAdapter, 'inspect'> {
  /** Trusted host checks authenticated caller, source/binding and exact operation/action.
   * Must reject by throwing. Never expose an unchecked caller-supplied callback remotely. */
  authorize(intent: Readonly<PageFileRecoveryIntent>): Promise<void>;
  /** Authoritative exact identity AND current DB baseline/pending checks, including terminal receipts. */
  inspect(record: FileJournalRecord): Promise<FileOperationState | { state: 'aborted' }>;
  /** Transactionally CAS exact before baseline + pending op, clear pending and persist aborted receipt.
   * Revalidate canonical file/binding inside transaction. No projection or file mutation. */
  abort(record: FileJournalRecord): Promise<unknown>;
}
export type PageFileRecoveryResult = FileOperationResult | { status: 'aborted' };

/** Explicit resolution only; never called by reads/retries. Acquires coordination exactly once.
 * Adapter commit/abort must fence original revision, pending operation, binding incarnation,
 * generation, exact record and current canonical bytes transactionally, as for normal writes.
 */
export async function recoverPageFile(journal: PageFileJournal, adapter: PageFileRecoveryAdapter,
  input: PageFileRecoveryIntent): Promise<PageFileRecoveryResult> {
  const intent = Object.freeze({ action: input.action, record: Object.freeze({ ...input.record }) });
  if (intent.action !== 'resume-exact' && intent.action !== 'abort') throw new Error('invalid_recovery_intent');
  await adapter.authorize(intent);
  return adapter.withLockedBinding(async () => {
    const { record } = intent;
    const evidence = await journal.read(record.operationId);
    if (!isDeepStrictEqual(record, evidence.record)) throw new Error('journal_identity_mismatch');
    try {
      let state = await adapter.inspect(record);
      const digest = rawDigest(await adapter.readCurrent());
      if (state.state === 'absent' && intent.action === 'resume-exact' && digest === record.beforeDigest) {
        await adapter.prepare(record);
        state = await adapter.inspect(record);
      }
      if (state.state === 'committed') return digest === record.afterDigest
        ? { status: 'committed', revision: state.revision } : { status: 'conflict' };
      if (state.state === 'aborted') return digest === record.beforeDigest ? { status: 'aborted' } : { status: 'conflict' };
      if (state.state !== 'prepared' || (digest !== record.afterDigest && digest !== record.beforeDigest)) return { status: 'conflict' };
      if (intent.action === 'abort') {
        if (digest !== record.beforeDigest) return { status: 'conflict' };
        await adapter.abort(record);
        const receipt = await adapter.inspect(record);
        if (rawDigest(await adapter.readCurrent()) !== record.beforeDigest) return { status: 'conflict' };
        return receipt.state === 'aborted' ? { status: 'aborted' } : { status: 'pending_recovery' };
      }
      if (digest !== record.afterDigest) {
        const mode = (await stat(record.target)).mode & 0o777;
        const temp = join(dirname(record.target), `.page-cas-${randomUUID()}.tmp`);
        try {
          const fd = await open(temp, 'wx', mode);
          try { await fd.writeFile(evidence.after); await fd.chmod(mode); await fd.sync(); } finally { await fd.close(); }
          if ((await adapter.inspect(record)).state !== 'prepared' || rawDigest(await adapter.readCurrent()) !== record.beforeDigest) return { status: 'conflict' };
          await rename(temp, record.target);
          await syncDirectory(dirname(record.target));
        } finally { await rm(temp, { force: true }); }
      }
      if (rawDigest(await adapter.readCurrent()) !== record.afterDigest) return { status: 'conflict' };
      await adapter.commit(record, evidence.after);
      const receipt = await adapter.inspect(record);
      if (rawDigest(await adapter.readCurrent()) !== record.afterDigest) return { status: 'conflict' };
      return receipt.state === 'committed' ? { status: 'committed', revision: receipt.revision } : { status: 'pending_recovery' };
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'conflict' : 'pending_recovery' };
    }
  });
}
