import type { BrainEngine } from './engine.ts';
import { acquirePageFileLock, type PageFileLockOptions } from './page-file-lock.ts';
import { resolveExistingPageFileBinding } from './page-file-binding.ts';
import { randomUUID } from 'node:crypto';
import { rawDigest } from './page-file-journal.ts';
import { parseMarkdown } from './markdown.ts';
import { updateCheckedPage } from './page-checked-store.ts';

/** Internal only. Safety conflicts must never complete checkpoints or failure ledgers. */
export class PageFileSyncConflict extends Error {
  readonly acknowledgeable = false;
  constructor(public readonly code: string) { super(code); this.name = 'PageFileSyncConflict'; }
}
/** Supply this SAME host to PageFileDatabase and sync, for one fixed canonical path.
 * Root retargeting and writer activation remain separate, mandatory rollout gates. */
export function pageFileSyncHost(options: PageFileLockOptions) {
  options = structuredClone(options);
  return { async withLockedBinding<T>(fn: () => Promise<T>): Promise<T> {
    const lock = await acquirePageFileLock(options);
    if (!lock) throw new PageFileSyncConflict('file_lock_unavailable');
    try { return await fn(); } finally { await lock.release(); }
  } };
}
export interface FileReadBaseline {
  readonly source: string; readonly slug: string; readonly raw: string;
  readonly identity: string;
}
type Host = { brainId: string; withLockedBinding<T>(fn: () => Promise<T>): Promise<T> };
/** File -> DB ONLY. capture must precede provider/render work. Never accept a
 * caller string as a fresh file snapshot. Tokens are instance-owned capabilities. */
export class PageFileSync {
  private baselines = new WeakSet<FileReadBaseline>();
  constructor(private engine: BrainEngine, private host: Host) {}
  private async observe(tx: BrainEngine, source: string, slug: string) {
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR SHARE', [source]);
    const [b] = await tx.executeRaw<Record<string, any>>('SELECT * FROM page_file_bindings WHERE source_id=$1 AND slug=$2 FOR UPDATE', [source,slug]);
    if (!b) throw new PageFileSyncConflict('not_enrolled');
    if (b.pending_op_id) throw new PageFileSyncConflict('pending_recovery');
    const [row] = await tx.executeRaw<Record<string, any>>('SELECT * FROM pages WHERE id=$1 AND source_id=$2 AND slug=$3 AND deleted_at IS NULL FOR UPDATE', [b.page_id,source,slug]);
    if (!row || row.page_kind !== 'markdown') throw new PageFileSyncConflict('binding_changed');
    const sources = await tx.executeRaw<{id:string;local_path:string|null}>('SELECT id, local_path FROM sources');
    const paths = await tx.executeRaw<{pageId:string;sourceId:string;sourcePath:string}>(`SELECT id::text AS "pageId", source_id AS "sourceId", COALESCE(source_path, slug || '.md') AS "sourcePath" FROM pages WHERE deleted_at IS NULL`);
    const globalRepoPath = await tx.getConfig('sync.repo_path');
    const file = await resolveExistingPageFileBinding({brainId:this.host.brainId,sourceId:source,slug,pageId:String(row.id),sourcePath:row.source_path,sources,otherPagePaths:paths,globalRepoPath,configGeneration:rawDigest(Buffer.from(JSON.stringify([sources,globalRepoPath])))});
    if (file.bindingKey !== b.binding_key) throw new PageFileSyncConflict('binding_changed');
    const identity = JSON.stringify([b.binding_id,b.page_id,b.binding_key,String(b.file_generation),b.indexed_raw_sha256,row.write_revision,file.rawSha256]);
    return { b,row,file,identity };
  }
  async capture(source: string, slug: string): Promise<FileReadBaseline> {
    return this.host.withLockedBinding(() => this.engine.transaction(async tx => {
      const state = await this.observe(tx,source,slug);
      const token = Object.freeze({source,slug,raw:state.file.rawBytes.toString('utf8'),identity:state.identity});
      this.baselines.add(token); return token;
    }));
  }
  async commit(baseline: FileReadBaseline) {
    if (!this.baselines.has(baseline)) throw new PageFileSyncConflict('invalid_file_baseline');
    return this.host.withLockedBinding(() => this.engine.transaction(async tx => {
      const state = await this.observe(tx,baseline.source,baseline.slug);
      if (state.identity !== baseline.identity) throw new PageFileSyncConflict('stale_file_baseline');
      if (state.b.indexed_raw_sha256 === state.file.rawSha256) return { status: 'unchanged', revision: state.row.write_revision };
      const parsed = parseMarkdown(baseline.raw, baseline.slug + '.md', { validate: true, expectedSlug: baseline.slug });
      if (parsed.errors?.some(e => e.code !== 'MISSING_OPEN' && e.code !== 'EMPTY_FRONTMATTER'
        && !(e.code === 'MISSING_CLOSE' && e.message.startsWith('Heading at ')))) throw new PageFileSyncConflict('unsupported_sync_projection');
      const page = { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: JSON.parse(JSON.stringify(parsed.frontmatter)) };
      const tags = await tx.getTags(baseline.slug,{sourceId:baseline.source});
      if (parsed.tags.some(tag => !tags.includes(tag))) throw new PageFileSyncConflict('unsupported_sync_tags');
      // File-led sync never installs bytes. Intent, capability, projection and
      // receipt commit together; rollback leaves the authored file untouched.
      const operationId = randomUUID();
      await tx.executeRaw(`INSERT INTO page_file_operations(operation_id,binding_id,request_digest,record,state) VALUES($1,$2,$3,$4::text::jsonb,'prepared')`, [operationId,state.b.binding_id,rawDigest(Buffer.from(baseline.identity)),JSON.stringify({kind:'file_sync',baseline:baseline.identity})]);
      await tx.executeRaw('UPDATE page_file_bindings SET pending_op_id=$2 WHERE binding_id=$1', [state.b.binding_id,operationId]);
      await tx.executeRaw('INSERT INTO page_file_write_authorizations(transaction_id,page_id,operation_id,expected_revision) VALUES(txid_current(),$1,$2,$3)', [state.row.id,operationId,state.row.write_revision]);
      const updated = await updateCheckedPage(tx, {source:baseline.source,slug:baseline.slug,expectedRevision:state.row.write_revision,page}, async () => {}, true);
      if (!updated) throw new PageFileSyncConflict('stale_file_baseline');
      await tx.executeRaw('DELETE FROM page_file_write_authorizations WHERE transaction_id=txid_current() AND page_id=$1', [state.row.id]);
      await tx.executeRaw('UPDATE page_file_bindings SET pending_op_id=NULL, indexed_raw_sha256=$2, file_generation=file_generation+1 WHERE binding_id=$1', [state.b.binding_id,state.file.rawSha256]);
      await tx.executeRaw("UPDATE page_file_operations SET state='committed',revision=$2 WHERE operation_id=$1", [operationId,updated.write_revision]);
      return { status: 'committed', revision: updated.write_revision };
    }));
  }
}
