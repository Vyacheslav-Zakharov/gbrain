import { open, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const rawDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function validateId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('invalid_operation_id');
}
function validateImages(record: FileJournalRecord, before: Uint8Array, after: Uint8Array): void {
  validateId(record.operationId);
  if (rawDigest(before) !== record.beforeDigest || rawDigest(after) !== record.afterDigest) throw new Error('journal_digest_mismatch');
}

/** Internal only. Directory provisioned privately outside indexed content, on target filesystem. */
export interface FileJournalRecord {
  operationId: string;
  requestDigest: string;
  target: string;
  bindingId: string;
  expectedRevision: string;
  beforeDigest: string;
  afterDigest: string;
}

export async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, 'r');
  try { await fd.sync(); } finally { await fd.close(); }
}

export async function writeDurableExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
}

export class PageFileJournal {
  constructor(readonly directory: string) {}

  async prepare(record: FileJournalRecord, before: Uint8Array, after: Uint8Array): Promise<void> {
    validateImages(record, before, after);
    const dir = join(this.directory, record.operationId);
    await mkdir(dir, { mode: 0o700 });
    await writeDurableExclusive(join(dir, 'before'), before);
    await writeDurableExclusive(join(dir, 'after'), after);
    await writeDurableExclusive(join(dir, 'record.json'), Buffer.from(JSON.stringify(record)));
    await syncDirectory(dir);
    await syncDirectory(this.directory);
  }

  async read(operationId: string): Promise<{ record: FileJournalRecord; before: Buffer; after: Buffer }> {
    validateId(operationId);
    const dir = join(this.directory, operationId);
    const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')) as FileJournalRecord;
    const before = await readFile(join(dir, 'before'));
    const after = await readFile(join(dir, 'after'));
    validateImages(record, before, after);
    if (record.operationId !== operationId) throw new Error('journal_identity_mismatch');
    return { record, before, after };
  }
}
