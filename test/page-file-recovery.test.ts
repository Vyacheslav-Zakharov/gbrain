import { beforeAll, afterAll, test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rawDigest, PageFileJournal, type FileJournalRecord } from '../src/core/page-file-journal.ts';
let db: PGlite;
let databaseRoot: string;
beforeAll(async () => {
  databaseRoot = await mkdtemp(join(tmpdir(), 'recovery-db-'));
  db = new PGlite(databaseRoot);
  await db.exec('CREATE TABLE slice_ops (id text PRIMARY KEY, digest text NOT NULL, state text NOT NULL); CREATE TABLE slice_page (id text PRIMARY KEY, revision text NOT NULL, body text NOT NULL, pending text)');
});
afterAll(async () => { await db.close(); await rm(databaseRoot, { recursive: true, force: true }); });

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

test('authorized resume after install uses durable journal on new service instance and receipt', async () => {
  const recovery = await import('../src/core/page-file-recovery.ts');
  expect(recovery.recoverPageFile).toBeFunction();
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
    await writeFile(f.target, f.after);
    const intent = { action: 'resume-exact' as const, record: f.record };
    const adapter = { ...f.adapter, authorize: async () => {}, abort: async () => {} };
    const journal = new PageFileJournal(f.journal.directory);
    expect(await recovery.recoverPageFile(journal, adapter, intent)).toEqual({ status: 'committed', revision: 'r1' });
    expect(await recovery.recoverPageFile(journal, adapter, intent)).toEqual({ status: 'committed', revision: 'r1' });
    expect(f.commits()).toBe(1);
  });
});

test('authorized before-image resume installs only journal bytes and does not nest locks', async () => {
  const { recoverPageFile } = await import('../src/core/page-file-recovery.ts');
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
    let locks = 0;
    const adapter = { ...f.adapter, authorize: async () => {}, abort: async () => {},
      withLockedBinding: async (fn: any) => { expect(++locks).toBe(1); return fn(); } };
    expect(await recoverPageFile(new PageFileJournal(f.journal.directory), adapter, { action: 'resume-exact', record: f.record })).toEqual({ status: 'committed', revision: 'r1' });
    expect(await readFile(f.target)).toEqual(f.after);
    expect((await stat(f.target)).mode & 0o777).toBe(0o640);
  });
});

test('abort before-image atomically clears pending with durable idempotent abort receipt', async () => {
  const { recoverPageFile } = await import('../src/core/page-file-recovery.ts');
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
    const adapter = { ...f.adapter, authorize: async () => {},
      inspect: async (r: FileJournalRecord) => {
        const op = (await db.query<any>('SELECT state FROM slice_ops WHERE id=$1', [r.operationId])).rows[0];
        return op?.state === 'aborted' ? { state: 'aborted' as const } : f.adapter.inspect(r);
      },
      abort: async (r: FileJournalRecord) => db.transaction(async tx => {
        expect(await readFile(f.target)).toEqual(f.before);
        const result = await tx.query('UPDATE slice_page SET pending=NULL WHERE id=$1 AND revision=$2 AND pending=$3 RETURNING id', [r.bindingId, r.expectedRevision, r.operationId]);
        if (!result.rows.length) throw new Error('db_conflict');
        await tx.query("UPDATE slice_ops SET state='aborted' WHERE id=$1", [r.operationId]);
      }) };
    const intent = { action: 'abort' as const, record: f.record };
    expect(await recoverPageFile(f.journal, adapter, intent)).toEqual({ status: 'aborted' });
    expect(await recoverPageFile(new PageFileJournal(f.journal.directory), adapter, intent)).toEqual({ status: 'aborted' });
    expect((await db.query<any>('SELECT pending FROM slice_page WHERE id=$1', [f.record.bindingId])).rows[0].pending).toBeNull();
    expect(await readFile(f.target)).toEqual(f.before); expect(f.commits()).toBe(0);
  });
});

test('unknown commit acknowledgment remains pending then resolves authoritative receipt once', async () => {
  const { recoverPageFile } = await import('../src/core/page-file-recovery.ts');
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
    const commit = f.adapter.commit;
    const adapter = { ...f.adapter, authorize: async () => {}, abort: async () => {},
      commit: async (...args: any[]) => { await commit(...args); throw new Error('lost_ack'); } };
    const intent = { action: 'resume-exact' as const, record: f.record };
    expect(await recoverPageFile(f.journal, adapter, intent)).toEqual({ status: 'pending_recovery' });
    expect(await recoverPageFile(new PageFileJournal(f.journal.directory), adapter, intent)).toEqual({ status: 'committed', revision: 'r1' });
    expect(f.commits()).toBe(1);
  });
});

test('authorization denial and identity substitution never touch files or DB', async () => {
  const { recoverPageFile } = await import('../src/core/page-file-recovery.ts');
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
    const adapter = { ...f.adapter, authorize: async () => { throw new Error('denied'); }, abort: async () => {} };
    await expect(recoverPageFile(f.journal, adapter, { action: 'resume-exact', record: f.record })).rejects.toThrow('denied');
    adapter.authorize = async () => {};
    await expect(recoverPageFile(f.journal, adapter, { action: 'resume-exact', record: { ...f.record, expectedRevision: 'other' } })).rejects.toThrow('journal_identity_mismatch');
    expect(await readFile(f.target)).toEqual(f.before); expect(f.commits()).toBe(0);
  });
});

for (const action of ['resume-exact', 'abort'] as const) {
  test(`${action} preserves third bytes and rejects missing or stale DB evidence`, async () => {
    const { recoverPageFile } = await import('../src/core/page-file-recovery.ts');
    await fixture(async f => {
      await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
      const adapter = { ...f.adapter, authorize: async () => {}, abort: async () => { throw new Error('must_not_abort'); } };
      await writeFile(f.target, 'third');
      expect(await recoverPageFile(f.journal, adapter, { action, record: f.record })).toEqual({ status: 'conflict' });
      expect(await readFile(f.target, 'utf8')).toBe('third');
      await rm(f.target);
      expect(await recoverPageFile(f.journal, adapter, { action, record: f.record })).toEqual({ status: 'conflict' });
      await writeFile(f.target, f.before);
      await db.query('UPDATE slice_page SET revision=$1 WHERE id=$2', ['third-db', f.record.bindingId]);
      expect(await recoverPageFile(f.journal, adapter, { action, record: f.record })).toEqual({ status: 'conflict' });
      expect(await readFile(f.target)).toEqual(f.before); expect(f.commits()).toBe(0);
    });
  });
}

test('after-install fault can resume but abort never rolls back installed bytes', async () => {
  const { recoverPageFile } = await import('../src/core/page-file-recovery.ts');
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
    const adapter = { ...f.adapter, authorize: async () => {}, abort: async () => { throw new Error('must_not_abort'); },
      commit: async () => { throw new Error('crash_after_install'); } };
    expect(await recoverPageFile(f.journal, adapter, { action: 'resume-exact', record: f.record })).toEqual({ status: 'pending_recovery' });
    expect(await readFile(f.target)).toEqual(f.after);
    expect(await recoverPageFile(f.journal, adapter, { action: 'abort', record: f.record })).toEqual({ status: 'conflict' });
    adapter.commit = f.adapter.commit;
    expect(await recoverPageFile(new PageFileJournal(f.journal.directory), adapter, { action: 'resume-exact', record: f.record })).toEqual({ status: 'committed', revision: 'r1' });
  });
});

test('durable journal with absent prepare acknowledgment can explicitly resume exact operation', async () => {
  const { recoverPageFile } = await import('../src/core/page-file-recovery.ts');
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after);
    const adapter = { ...f.adapter, authorize: async () => {}, abort: async () => {} };
    expect(await recoverPageFile(f.journal, adapter, { action: 'resume-exact', record: f.record })).toEqual({ status: 'committed', revision: 'r1' });
  });
});

test('fresh process recovers durable prepared operation after database reopen', async () => {
  await fixture(async f => {
    await f.journal.prepare(f.record, f.before, f.after); await f.adapter.prepare(f.record);
    await db.close();
    try {
      const script = `
        import { PGlite } from '@electric-sql/pglite';
        import { readFile } from 'node:fs/promises';
        import { recoverPageFile } from './src/core/page-file-recovery.ts';
        import { PageFileJournal } from './src/core/page-file-journal.ts';
        const db = new PGlite(${JSON.stringify(databaseRoot)});
        const record = ${JSON.stringify(f.record)};
        const adapter = {
          authorize: async () => {}, withLockedBinding: async fn => fn(),
          readCurrent: () => readFile(record.target),
          inspect: async () => {
            const op = (await db.query('SELECT * FROM slice_ops WHERE id=$1', [record.operationId])).rows[0];
            const page = (await db.query('SELECT * FROM slice_page WHERE id=$1', [record.bindingId])).rows[0];
            if (op.digest !== record.requestDigest) return {state:'conflict'};
            if (op.state === 'committed') return {state:'committed',revision:page.revision};
            return {state:page.pending === record.operationId && page.revision === record.expectedRevision ? 'prepared':'conflict'};
          }, prepare: async () => { throw Error('already_prepared'); }, abort: async () => { throw Error('not_authorized'); },
          commit: async (r, bytes) => db.transaction(async tx => {
            const changed = await tx.query('UPDATE slice_page SET body=$1,revision=$2,pending=NULL WHERE id=$3 AND revision=$4 AND pending=$5 RETURNING id', [Buffer.from(bytes).toString(),'r1',r.bindingId,r.expectedRevision,r.operationId]);
            if (!changed.rows.length) throw Error('conflict');
            await tx.query("UPDATE slice_ops SET state='committed' WHERE id=$1", [r.operationId]);
          })
        };
        try { console.log(JSON.stringify(await recoverPageFile(new PageFileJournal(${JSON.stringify(f.journal.directory)}),adapter,{action:'resume-exact',record}))); }
        finally { await db.close(); }
      `;
      const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe(''); expect(exit).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ status: 'committed', revision: 'r1' });
    } finally { db = new PGlite(databaseRoot); }
    expect(await readFile(f.target)).toEqual(f.after);
    expect((await db.query<any>('SELECT pending,body FROM slice_page WHERE id=$1', [f.record.bindingId])).rows[0]).toEqual({pending:null,body:f.after.toString()});
  });
}, 30000);
