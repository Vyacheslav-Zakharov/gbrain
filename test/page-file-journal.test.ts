import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('durable journal preserves exact before/after bytes and private immutable evidence', async () => {
  const { PageFileJournal } = await import('../src/core/page-file-journal.ts');
  const root = await mkdtemp(join(tmpdir(), 'page-file-journal-'));
  try {
    const dir = join(root, 'journal'); await mkdir(dir, { mode: 0o700 });
    const journal = new PageFileJournal(dir);
    const before = Buffer.from('\uFEFF---\r\n# comment\r\nold\r\n');
    const after = Buffer.from('new\r\n');
    const record = { operationId: '11111111-1111-4111-8111-111111111111', requestDigest: hash(after), target: join(root, 'page.md'), expectedRevision: 'revision-a', bindingId: 'binding-a', beforeDigest: hash(before), afterDigest: hash(after) };
    await journal.prepare(record, before, after);
    const reopened = await new PageFileJournal(dir).read(record.operationId);
    expect(reopened.record).toEqual(record);
    expect(reopened.before).toEqual(before); expect(reopened.after).toEqual(after);
    expect((await stat(join(dir, record.operationId, 'before'))).mode & 0o777).toBe(0o600);
    await expect(journal.prepare(record, before, after)).rejects.toThrow();
    expect(await readFile(join(dir, record.operationId, 'before'))).toEqual(before);
    await writeFile(join(dir, record.operationId, 'after'), 'tampered');
    await expect(journal.read(record.operationId)).rejects.toThrow('journal_digest_mismatch');
    await expect(journal.read('../escape')).rejects.toThrow('invalid_operation_id');
    await expect(journal.prepare({ ...record, operationId: '22222222-2222-4222-8222-222222222222', beforeDigest: hash(after) }, before, after)).rejects.toThrow('journal_digest_mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});
