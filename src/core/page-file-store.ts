import { rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { PageFileJournal, rawDigest, syncDirectory, type FileJournalRecord } from './page-file-journal.ts';

export type FileOperationState = { state: 'absent' | 'prepared' | 'conflict' } | { state: 'committed'; revision: string };
export type FileOperationResult = { status: 'committed'; revision: string } | { status: 'pending_recovery' | 'conflict' };
/** INTERNAL integration seam, not an authorization surface.
 * Host must hold non-stealable root/path coordination throughout callback, revalidate
 * canonical binding/config/incarnation/generation on EVERY readCurrent/DB operation.
 * prepare must atomically fence original DB baseline + pending; commit must atomically
 * update projection/version/chunks/binding and receipt, clearing pending. inspect reads
 * authoritative receipt and checks exact request AND binding identity, never a replica.
 * No production adapter is supplied: checked file eligibility MUST remain closed.
 */
export interface PageFileStoreAdapter {
  withLockedBinding<T>(fn: () => Promise<T>): Promise<T>;
  readCurrent(): Promise<Uint8Array>;
  inspect(record: FileJournalRecord): Promise<FileOperationState>;
  prepare(record: FileJournalRecord): Promise<unknown>;
  commit(record: FileJournalRecord, after: Uint8Array): Promise<unknown>;
}

/** File-first is NOT cross-store atomicity. No automatic rollback is ever attempted. */
export async function replacePageFile(journal: PageFileJournal, adapter: PageFileStoreAdapter,
  record: FileJournalRecord, before: Uint8Array, after: Uint8Array): Promise<FileOperationResult> {
  record = { ...record };
  before = Buffer.from(before);
  after = Buffer.from(after);
  if (rawDigest(before) !== record.beforeDigest || rawDigest(after) !== record.afterDigest) throw new Error('journal_digest_mismatch');
  return adapter.withLockedBinding(async () => {
    const state = await adapter.inspect(record);
    if (state.state === 'committed' || state.state === 'prepared') {
      const evidence = await journal.read(record.operationId);
      if (Object.keys(record).some(key => record[key as keyof FileJournalRecord] !== evidence.record[key as keyof FileJournalRecord])) throw new Error('journal_identity_mismatch');
      if (state.state === 'committed') {
        if (rawDigest(await adapter.readCurrent()) !== record.afterDigest) return { status: 'conflict' };
        return { status: 'committed', revision: state.revision };
      }
      return { status: 'pending_recovery' };
    }
    if (state.state === 'conflict') return { status: 'conflict' };
    if (rawDigest(await adapter.readCurrent()) !== record.beforeDigest) return { status: 'conflict' };
    await journal.prepare(record, before, after);
    try {
    await adapter.prepare(record);
    if (rawDigest(await adapter.readCurrent()) !== record.beforeDigest) return { status: 'conflict' };
    const mode = (await stat(record.target)).mode & 0o777;
    const temp = join(dirname(record.target), `.page-cas-${randomUUID()}.tmp`);
    const fd = await open(temp, 'wx', mode);
    try { await fd.writeFile(after); await fd.chmod(mode); await fd.sync(); } finally { await fd.close(); }
    if (rawDigest(await adapter.readCurrent()) !== record.beforeDigest) return { status: 'conflict' };
    await rename(temp, record.target);
    await syncDirectory(dirname(record.target));
    if (rawDigest(await adapter.readCurrent()) !== record.afterDigest) return { status: 'conflict' };
    await adapter.commit(record, after);
    const receipt = await adapter.inspect(record);
    if (receipt.state !== 'committed') return { status: 'pending_recovery' };
    if (rawDigest(await adapter.readCurrent()) !== record.afterDigest) return { status: 'conflict' };
    return { status: 'committed', revision: receipt.revision };
    } catch {
      // Includes unknown PREPARE/COMMIT acknowledgments and post-rename I/O failure.
      // Never infer rollback from a thrown transport/filesystem error.
      return { status: 'pending_recovery' };
    }
  });
}

export type FileRecoveryResult = { status: 'pending_recovery' | 'conflict' | 'committed'; file: 'before' | 'after' | 'unexpected' | 'missing' };

/** Read-only recovery classification. Authorization to resume/abort is deliberately NOT implemented. */
export async function inspectPageFileRecovery(journal: PageFileJournal, adapter: PageFileStoreAdapter,
  record: FileJournalRecord): Promise<FileRecoveryResult> {
  return adapter.withLockedBinding(async () => {
    const evidence = await journal.read(record.operationId);
    if (Object.keys(record).some(key => record[key as keyof FileJournalRecord] !== evidence.record[key as keyof FileJournalRecord])) throw new Error('journal_identity_mismatch');
    const state = await adapter.inspect(record);
    let digest: string;
    try { digest = rawDigest(await adapter.readCurrent()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'conflict', file: 'missing' };
      throw error;
    }
    const file = digest === record.afterDigest ? 'after' : digest === record.beforeDigest ? 'before' : 'unexpected';
    if (file === 'unexpected' || state.state === 'conflict' || state.state === 'absent' || (state.state === 'committed' && file !== 'after')) return { status: 'conflict', file };
    return { status: state.state === 'committed' ? 'committed' : 'pending_recovery', file };
  });
}
