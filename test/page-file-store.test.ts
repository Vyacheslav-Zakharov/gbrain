import { beforeAll, afterAll, test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rawDigest, PageFileJournal, type FileJournalRecord } from '../src/core/page-file-journal.ts';
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE slice_ops (id text PRIMARY KEY, digest text NOT NULL, state text NOT NULL); CREATE TABLE slice_page (id text PRIMARY KEY, revision text NOT NULL, body text NOT NULL, pending text)');
});
afterAll(async () => { await db.close(); });

async function fixture(run: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'page-file-store-'));
  try {
    const target = join(root, 'page.md'); const journalDir = join(root, 'journal');
    await mkdir(journalDir, { mode: 0o700 }); await writeFile(target, 'old\r\n', { mode: 0o640 });
    const before = await readFile(target); const after = Buffer.from('approved\r\n');
    const id = crypto.randomUUID();
    const record: FileJournalRecord = { operationId: id, requestDigest: rawDigest(after), target, bindingId: id, expectedRevision: 'r0', beforeDigest: rawDigest(before), afterDigest: rawDigest(after) };
    await db.query('INSERT INTO slice_page VALUES ($1, $2, $3, NULL)', [id, 'r0', before.toString()]);
    let commits = 0;
    const adapter = {
      // Test-only single-owner coordination. NOT a production filesystem lock.
      withLockedBinding: async (fn: () => Promise<any>) => fn(),
      readCurrent: async () => await readFile(target),
      inspect: async (r: FileJournalRecord) => {
        const op = (await db.query<any>('SELECT * FROM slice_ops WHERE id=$1', [r.operationId])).rows[0];
        const page = (await db.query<any>('SELECT * FROM slice_page WHERE id=$1', [id])).rows[0];
        if (op && op.digest !== r.requestDigest) throw new Error('idempotency_mismatch');
        if (op?.state === 'committed') return { state: 'committed', revision: page.revision };
        if (page.revision !== r.expectedRevision || (page.pending && page.pending !== r.operationId)) return { state: 'conflict' };
        return { state: op ? 'prepared' : 'absent' };
      },
      prepare: async (r: FileJournalRecord) => db.transaction(async tx => {
        const updated = await tx.query('UPDATE slice_page SET pending=$1 WHERE id=$2 AND revision=$3 AND pending IS NULL RETURNING id', [r.operationId, id, r.expectedRevision]);
        if (!updated.rows.length) throw new Error('db_conflict');
        await tx.query('INSERT INTO slice_ops VALUES ($1,$2,$3)', [r.operationId,r.requestDigest,'prepared']);
      }),
      commit: async (r: FileJournalRecord, bytes: Uint8Array) => {
        expect(await readFile(target)).toEqual(Buffer.from(bytes));
        await db.transaction(async tx => {
          const updated = await tx.query('UPDATE slice_page SET body=$1, revision=$2, pending=NULL WHERE id=$3 AND revision=$4 AND pending=$5 RETURNING id', [Buffer.from(bytes).toString(), 'r1', id, r.expectedRevision, r.operationId]);
          if (!updated.rows.length) throw new Error('db_conflict');
          await tx.query('UPDATE slice_ops SET state=$1 WHERE id=$2', ['committed',r.operationId]);
        }); commits++;
      },
    };
    await run({ root, target, record, before, after, journal: new PageFileJournal(journalDir), adapter, commits: () => commits, db });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('recovery inspects bytes without publishing prepared intent or overwriting third versions', async () => {
  const { replacePageFile, inspectPageFileRecovery } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    const realCommit = f.adapter.commit;
    f.adapter.commit = async () => { throw new Error('simulated_crash_after_rename'); };
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'pending_recovery' });
    f.adapter.commit = realCommit;
    expect(await inspectPageFileRecovery(f.journal, f.adapter, f.record)).toEqual({ status: 'pending_recovery', file: 'after' });
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'pending_recovery' });
    expect(f.commits()).toBe(0);
    await writeFile(f.target, 'external-edit');
    expect(await inspectPageFileRecovery(f.journal, f.adapter, f.record)).toEqual({ status: 'conflict', file: 'unexpected' });
    expect((await readFile(f.target)).toString()).toBe('external-edit');
    await rm(f.target);
    expect(await inspectPageFileRecovery(f.journal, f.adapter, f.record)).toEqual({ status: 'conflict', file: 'missing' });
  });
});

test('committed replay refuses external divergence and changed bytes under reused operation id', async () => {
  const { replacePageFile } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after);
    await expect(replacePageFile(f.journal, f.adapter, f.record, f.before, Buffer.from('different'))).rejects.toThrow('journal_digest_mismatch');
    await expect(replacePageFile(f.journal, f.adapter, { ...f.record, target: join(f.root, 'other.md') }, f.before, f.after)).rejects.toThrow('journal_identity_mismatch');
    await writeFile(f.target, 'external');
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'conflict' });
    expect((await readFile(f.target)).toString()).toBe('external');
  });
});

test('last pre-install check refuses an external edit without updating projection', async () => {
  const { replacePageFile } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    let reads = 0;
    f.adapter.readCurrent = async () => {
      if (++reads === 3) await writeFile(f.target, 'intervening');
      return readFile(f.target);
    };
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'conflict' });
    expect(f.commits()).toBe(0);
    expect((await readFile(f.target)).toString()).toBe('intervening');
  });
});

test('post-install revalidation blocks DB projection of bytes no longer canonical', async () => {
  const { replacePageFile } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    let reads = 0;
    f.adapter.readCurrent = async () => {
      if (++reads === 4) await writeFile(f.target, 'edited-after-install');
      return readFile(f.target);
    };
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'conflict' });
    expect(f.commits()).toBe(0);
  });
});

test('lost commit acknowledgment resolves from authoritative PGLite receipt without duplicate commit', async () => {
  const { replacePageFile, inspectPageFileRecovery } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    const commit = f.adapter.commit;
    f.adapter.commit = async (...args: any[]) => { await commit(...args); throw new Error('lost_ack'); };
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'pending_recovery' });
    expect(await inspectPageFileRecovery(f.journal, f.adapter, f.record)).toEqual({ status: 'committed', file: 'after' });
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'committed', revision: 'r1' });
    expect(f.commits()).toBe(1);
  });
});

test('prepared before-image is classified pending with no implicit publish', async () => {
  const { replacePageFile, inspectPageFileRecovery } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
    expect(await inspectPageFileRecovery(f.journal, f.adapter, f.record)).toEqual({ status: 'pending_recovery', file: 'before' });
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'pending_recovery' });
    expect(await readFile(f.target)).toEqual(f.before); expect(f.commits()).toBe(0);
  });
});

test('independent original file digest and DB revision each fence stale input', async () => {
  const { replacePageFile } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    await writeFile(f.target, 'external-before-preview');
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'conflict' });
    await writeFile(f.target, f.before);
    await db.query('UPDATE slice_page SET revision=$1 WHERE id=$2', ['changed-db-only', f.record.bindingId]);
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'conflict' });
    expect(await readFile(f.target)).toEqual(f.before); expect(f.commits()).toBe(0);
  });
});

test('approved replacement is snapshotted before awaited adapter work', async () => {
  const { replacePageFile } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    const approved = Buffer.from(f.after);
    const prepare = f.adapter.prepare;
    f.adapter.prepare = async (r: FileJournalRecord) => { await prepare(r); f.after.fill(120); };
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'committed', revision: 'r1' });
    expect(await readFile(f.target)).toEqual(approved);
  });
});

test('file-first commit has durable images, PGLite projection and idempotent receipt', async () => {
  const { replacePageFile } = await import('../src/core/page-file-store.ts');
  await fixture(async f => {
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'committed', revision: 'r1' });
    expect(await readFile(f.target)).toEqual(f.after);
    expect((await stat(f.target)).mode & 0o777).toBe(0o640);
    expect((await f.journal.read(f.record.operationId)).before).toEqual(f.before);
    expect(await replacePageFile(f.journal, f.adapter, f.record, f.before, f.after)).toEqual({ status: 'committed', revision: 'r1' });
    expect(f.commits()).toBe(1);
  });
});
