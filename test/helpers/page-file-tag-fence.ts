import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';

/** Same SQL exercised offline and by the disposable hosted adapter login.
 * Caller owns a transaction and rolls it back; no privilege/trigger changes. */
export async function exerciseTagRevisionFence(
  query: (sql: string, params?: (string | number)[]) => Promise<any[]>, pageId: number,
) {
  const revision = async () => (await query('SELECT write_revision::text FROM pages WHERE id=$1', [pageId]))[0].write_revision;
  const tags = () => query('SELECT tag FROM tags WHERE page_id=$1 ORDER BY tag', [pageId]);
  const insert = (tag: string) => query('INSERT INTO tags(page_id,tag) VALUES($1,$2) ON CONFLICT(page_id,tag) DO NOTHING', [pageId, tag]);
  const rejected = async (action: () => Promise<unknown>) => {
    const before = await revision(), beforeTags = await tags();
    await query('SAVEPOINT tag_denial');
    try { await expect(action()).rejects.toMatchObject({ code: 'P0001' }); }
    finally { await query('ROLLBACK TO SAVEPOINT tag_denial'); await query('RELEASE SAVEPOINT tag_denial'); }
    expect(await revision()).toBe(before); expect(await tags()).toEqual(beforeTags);
  };
  const original = await tags();
  await rejected(() => insert('unauthorized'));
  const op = randomUUID();
  await query(`INSERT INTO page_file_operations(operation_id,binding_id,request_digest,state,record)
    SELECT $1,binding_id,$2,'prepared','{}'::jsonb FROM page_file_bindings WHERE page_id=$3`, [op, 'b'.repeat(64), pageId]);
  await query('UPDATE page_file_bindings SET pending_op_id=$1 WHERE page_id=$2', [op, pageId]);
  const refresh = async () => {
    await query('DELETE FROM page_file_write_authorizations WHERE transaction_id=txid_current() AND page_id=$1', [pageId]);
    await query(`INSERT INTO page_file_write_authorizations(transaction_id,page_id,operation_id,expected_revision)
      SELECT txid_current(),id,$1,write_revision FROM pages WHERE id=$2`, [op, pageId]);
  };
  await refresh();
  const beforePage = await revision();
  await query("UPDATE pages SET compiled_truth=compiled_truth || '\ntag fixture' WHERE id=$1", [pageId]);
  expect(await revision()).not.toBe(beforePage);
  await rejected(() => insert('first-added'));
  await refresh();
  const beforeTag = await revision();
  await insert('first-added');
  expect(await revision()).not.toBe(beforeTag);
  await rejected(() => insert('second-added'));
  await refresh();
  const beforeConflict = await revision();
  await insert('first-added'); // BEFORE trigger advances revision even on conflict.
  expect(await revision()).not.toBe(beforeConflict);
  await rejected(() => insert('second-added'));
  await refresh();
  await insert('second-added');
  expect(await tags()).toEqual([...original, { tag: 'first-added' }, { tag: 'second-added' }].sort((a, b) => a.tag.localeCompare(b.tag)));
  // A fresh token still cannot authorize the wrong operation/binding lifecycle.
  await refresh();
  await query("UPDATE page_file_operations SET state='aborted' WHERE operation_id=$1", [op]);
  await rejected(() => insert('not-prepared'));
}
