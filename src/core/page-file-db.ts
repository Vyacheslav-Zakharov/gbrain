import { parseMarkdown } from './markdown.ts';
import type { BrainEngine } from './engine.ts';
import { isDeepStrictEqual } from 'node:util';
import { resolveExistingPageFileBinding } from './page-file-binding.ts';
import { PageFileJournal, rawDigest, type FileJournalRecord } from './page-file-journal.ts';
import { replacePageFile, type FileOperationState } from './page-file-store.ts';
import { recoverPageFile, type PageFileRecoveryAdapter } from './page-file-recovery.ts';
import { updateCheckedPage, type CheckedPageFields } from './page-checked-store.ts';

type Row = Record<string, any>;
/** INTERNAL adapter only. Not registered in operations.ts. Production enrollment must
 * remain disabled until ALL source/root/path writers are gated. The callback is a
 * required host capability, not evidence that such a capability exists in production.
 * Uses the canonical parser only: no serializer, providers, extraction, timeline
 * edits, or implicit import on read. Exact caller-approved raw bytes are installed.
 */
export class PageFileDatabase {
  constructor(private engine: BrainEngine, private host: {
    brainId: string; journalDirectory: string;
    withLockedBinding<T>(fn: () => Promise<T>): Promise<T>;
  }) {}
  private async observe(source: string, slug: string, tx = this.engine) {
    const [row] = await tx.executeRaw<Row>('SELECT * FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [source, slug]);
    if (!row || row.page_kind !== 'markdown') throw new Error('ineligible_page');
    const sources = await tx.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources');
    const paths = await tx.executeRaw<{ pageId: string; sourceId: string; sourcePath: string }>(`SELECT id::text AS "pageId", source_id AS "sourceId", COALESCE(source_path, slug || '.md') AS "sourcePath" FROM pages WHERE deleted_at IS NULL`);
    const globalRepoPath = await tx.getConfig('sync.repo_path');
    const binding = await resolveExistingPageFileBinding({ brainId: this.host.brainId, sourceId: source, slug,
      pageId: String(row.id), sourcePath: row.source_path, sources, otherPagePaths: paths,
      globalRepoPath, configGeneration: rawDigest(Buffer.from(JSON.stringify([sources, globalRepoPath]))) });
    return { row, binding };
  }
  private projection(raw: string, slug: string) {
    // Same logical path as importFromContent, without its enrichment side effects.
    const parsed = parseMarkdown(raw, slug + '.md', { validate: true, expectedSlug: slug });
    // The lint validator mistakes YAML comments for headings before a real closing
    // delimiter. This diagnostic is not a parse failure; YAML_PARSE remains fatal.
    if (parsed.errors?.some(e => e.code !== 'MISSING_OPEN' && e.code !== 'EMPTY_FRONTMATTER'
      && !(e.code === 'MISSING_CLOSE' && e.message.startsWith('Heading at ')))) throw new Error('unsupported_file_edit');
    return { page: { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline, frontmatter: JSON.parse(JSON.stringify(parsed.frontmatter)) }, tags: parsed.tags };
  }
  private async prove(raw: string, row: Row, source: string, slug: string, tx = this.engine) {
    try {
      const parsed = this.projection(raw, slug);
      if (!isDeepStrictEqual(parsed.page, { type: row.type, title: row.title, compiled_truth: row.compiled_truth,
        timeline: row.timeline, frontmatter: row.frontmatter })) throw new Error('mismatch');
      const tags = await tx.getTags(slug, { sourceId: source });
      if (parsed.tags.some(tag => !tags.includes(tag))) throw new Error('tags_mismatch');
    } catch { throw new Error('sync_required'); }
  }
  async enroll(source: string, slug: string, reviewed?: {
    pageId: string; revision: string; canonicalRoot: string; relativePath: string; rawSha256: string;
  }, revalidate?: () => Promise<void>) {
    return this.host.withLockedBinding(() => this.engine.transaction(async tx => {
      await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR SHARE', [source]);
      await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE', [source, slug]);
      const { row, binding } = await this.observe(source, slug, tx);
      await revalidate?.();
      if (reviewed && (reviewed.pageId !== String(row.id) || reviewed.revision !== row.write_revision
        || reviewed.canonicalRoot !== binding.canonicalRoot || reviewed.relativePath !== binding.relativePath
        || reviewed.rawSha256 !== binding.rawSha256)) throw new Error('page_file_enrollment_stale');
      await this.prove(binding.rawBytes.toString('utf8'), row, source, slug, tx);
      if (reviewed) {
        // Enrollment already owns the exclusive root gate through COMMIT and
        // the parent page row lock above. Supported binding writers (put/recovery,
        // sync, root transitions and enrollment) all take that same root gate;
        // ordinary page/tag writers are fenced by the parent row. A binding row
        // lock adds no exclusion here, but requires UPDATE denied to enrollment.
        // Keep mutation-path binding locks: this is a read-only repeat check.
        const [existing] = await tx.executeRaw<Row>('SELECT * FROM page_file_bindings WHERE source_id=$1 AND slug=$2', [source, slug]);
        if (existing) {
          if (existing.pending_op_id || String(existing.page_id) !== reviewed.pageId
            || existing.binding_key !== binding.bindingKey || existing.canonical_root !== reviewed.canonicalRoot
            || existing.relative_path !== reviewed.relativePath || existing.indexed_raw_sha256 !== reviewed.rawSha256
            || String(existing.file_generation) !== '0') throw new Error('page_file_enrollment_stale');
          await revalidate?.();
          return { status: 'already_enrolled', binding_id: existing.binding_id, generation: String(existing.file_generation), raw_sha256: existing.indexed_raw_sha256 };
        }
      }
      await tx.executeRaw(`INSERT INTO page_file_bindings(source_id,slug,page_id,binding_key,canonical_root,relative_path,indexed_raw_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [source,slug,row.id,binding.bindingKey,binding.canonicalRoot,binding.relativePath,binding.rawSha256]);
      const [enrolled] = await tx.executeRaw<Row>('SELECT * FROM page_file_bindings WHERE source_id=$1 AND slug=$2', [source, slug]);
      await revalidate?.();
      return { status: 'enrolled', binding_id: enrolled.binding_id, generation: String(enrolled.file_generation), raw_sha256: enrolled.indexed_raw_sha256 };
    }));
  }
  private async binding(source: string, slug: string, tx = this.engine, lock = false) {
    if (lock) await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR SHARE', [source]);
    const [b] = await tx.executeRaw<Row>(`SELECT * FROM page_file_bindings WHERE source_id=$1 AND slug=$2${lock ? ' FOR UPDATE' : ''}`, [source,slug]);
    if (!b) throw new Error('not_enrolled');
    // Tag revision triggers acquire the parent page before changing a tag.
    // Hold that page lock before reading tags (prove), never acquire tag locks
    // first. Unadapted tag writes then fail at the page fence rather than
    // silently changing the authored baseline; no callback runs with capability.
    if (lock) await tx.executeRaw('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [b.page_id]);
    const observed = await this.observe(source, slug, tx);
    if (b.binding_key !== observed.binding.bindingKey || b.page_id !== observed.row.id) throw new Error('binding_changed');
    return { b, ...observed };
  }
  async get(source: string, slug: string, validate: (row: Row) => void) {
    return this.host.withLockedBinding(async () => {
      const { b, row, binding } = await this.binding(source, slug);
      validate(row);
      if (b.pending_op_id) throw new Error('pending_recovery');
      if (b.indexed_raw_sha256 !== binding.rawSha256) throw new Error('sync_required');
      await this.prove(binding.rawBytes.toString('utf8'), row, source, slug);
      return { source_id: source, slug, revision: row.write_revision,
        page: { type: row.type,title: row.title,compiled_truth: row.compiled_truth,timeline: row.timeline,frontmatter: row.frontmatter },
        persistence: 'file_and_database', file: { raw_markdown: binding.rawBytes.toString('utf8'), baseline: {
          binding_id: b.binding_id, generation: String(b.file_generation), raw_sha256: b.indexed_raw_sha256 } } };
    });
  }
  async recover(source: string, slug: string, p: Row, validate: (row: Row) => void) {
    if (p.action !== 'resume-exact' && p.action !== 'abort') throw new Error('invalid_recovery_intent');
    return this.put(source, slug, p, validate, p.action);
  }
  async put(source: string, slug: string, p: Row, validate: (row: Row) => void, recovery?: 'resume-exact' | 'abort') {
    // Capture all nested caller-owned values before the first async boundary.
    p = structuredClone(p);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.operation_id ?? '')
      || typeof p.raw_markdown !== 'string' || !p.file_baseline) throw new Error('invalid_file_request');
    const page = p.page as CheckedPageFields;
    const requestDigest = rawDigest(Buffer.from(JSON.stringify([source,slug,p.expected_revision,p.file_baseline,page,p.raw_markdown])));
    const initial = await this.binding(source, slug);
    validate(initial.row);
    const proposed = this.projection(p.raw_markdown, slug);
    const journal = new PageFileJournal(this.host.journalDirectory);
    const evidence = recovery ? await journal.read(p.operation_id) : undefined;
    const original = this.projection((evidence?.before ?? initial.binding.rawBytes).toString('utf8'), slug);
    if (!isDeepStrictEqual(proposed.page, page) || !isDeepStrictEqual(proposed.tags, original.tags)
      || !isDeepStrictEqual(page.frontmatter, initial.row.frontmatter) || page.timeline !== initial.row.timeline
      || page.type !== initial.row.type || page.title !== initial.row.title || Buffer.byteLength(p.raw_markdown) > 8 * 1024 * 1024) throw new Error('unsupported_file_edit');
    const record: FileJournalRecord = { operationId: p.operation_id, requestDigest, target: initial.binding.absolutePath,
      bindingId: p.file_baseline.binding_id, expectedRevision: p.expected_revision,
      beforeDigest: p.file_baseline.raw_sha256, afterDigest: rawDigest(Buffer.from(p.raw_markdown)) };
    const check = async (tx: BrainEngine, pending: boolean) => {
      const state = await this.binding(source, slug, tx, true); validate(state.row);
      if (state.b.binding_id !== record.bindingId || state.row.write_revision !== record.expectedRevision
        || String(state.b.file_generation) !== p.file_baseline.generation || state.b.indexed_raw_sha256 !== record.beforeDigest
        || state.b.pending_op_id !== (pending ? record.operationId : null)) throw new Error('precondition_failed');
      return state;
    };
    const inspectRecovery = async (tx = this.engine): Promise<Awaited<ReturnType<PageFileRecoveryAdapter['inspect']>>> => {
      const [op] = await tx.executeRaw<Row>('SELECT * FROM page_file_operations WHERE operation_id=$1', [record.operationId]);
      if (!op) { await check(tx,false); return { state: 'absent' }; }
      if (op.request_digest !== requestDigest || !isDeepStrictEqual(op.record, record)) throw new Error('operation_id_reused');
      const state = await this.binding(source,slug,tx,true); validate(state.row);
      const terminal = op.state === 'committed' || op.state === 'aborted';
      if (state.b.binding_id !== record.bindingId || state.binding.absolutePath !== record.target
        || state.row.write_revision !== (terminal ? op.revision : record.expectedRevision)
        || BigInt(state.b.file_generation) !== BigInt(p.file_baseline.generation) + (op.state === 'committed' ? 1n : 0n)
        || state.b.indexed_raw_sha256 !== (op.state === 'committed' ? record.afterDigest : record.beforeDigest)
        || state.b.pending_op_id !== (terminal ? null : record.operationId)) throw new Error('precondition_failed');
      return op.state === 'committed' ? { state: 'committed', revision: op.revision } : { state: op.state };
    };
    const inspect = async (): Promise<FileOperationState> => {
      const state = await inspectRecovery();
      return state.state === 'aborted' ? { state:'conflict' } : state;
    };
    const prior = await inspect();
    const before = prior.state === 'absent' ? initial.binding.rawBytes : (await journal.read(record.operationId)).before;
    const adapter: PageFileRecoveryAdapter = {
      authorize: async intent => {
        if (intent.action !== recovery || !isDeepStrictEqual(intent.record, record)) throw new Error('invalid_recovery_intent');
        validate((await this.binding(source,slug)).row);
      },
      abort: () => this.engine.transaction(async tx => {
        if ((await inspectRecovery(tx)).state !== 'prepared') throw new Error('precondition_failed');
        const state = await check(tx,true);
        if (state.binding.rawSha256 !== record.beforeDigest) throw new Error('file_changed');
        await this.prove(before.toString('utf8'),state.row,source,slug,tx);
        await tx.executeRaw('UPDATE page_file_bindings SET pending_op_id=NULL WHERE binding_id=$1',[record.bindingId]);
        await tx.executeRaw("UPDATE page_file_operations SET state='aborted',revision=$2 WHERE operation_id=$1",[record.operationId,record.expectedRevision]);
      }),
      withLockedBinding: fn => this.host.withLockedBinding(fn),
      readCurrent: async () => (await this.binding(source,slug)).binding.rawBytes,
      inspect: () => inspectRecovery(),
      prepare: () => this.engine.transaction(async tx => {
        const state = await check(tx,false);
        if (state.binding.rawSha256 !== record.beforeDigest) throw new Error('precondition_failed');
        await this.prove(state.binding.rawBytes.toString('utf8'), state.row, source, slug, tx);
        await tx.executeRaw(`INSERT INTO page_file_operations(operation_id,binding_id,request_digest,record,state) VALUES($1,$2,$3,$4::text::jsonb,'prepared')`,
          [record.operationId,record.bindingId,requestDigest,JSON.stringify(record)]);
        await tx.executeRaw('UPDATE page_file_bindings SET pending_op_id=$2 WHERE binding_id=$1', [record.bindingId,record.operationId]);
      }),
      commit: () => this.engine.transaction(async tx => {
        if ((await inspectRecovery(tx)).state !== 'prepared') throw new Error('precondition_failed');
        const state = await check(tx,true);
        await this.prove(before.toString('utf8'), state.row, source, slug, tx);
        if (state.binding.rawSha256 !== record.afterDigest) throw new Error('file_changed');
        // Capability is issued only after all file/DB checks; no external callback
        // runs while it exists. It is page-, operation-, revision- and tx-bound.
        await tx.executeRaw(`INSERT INTO page_file_write_authorizations(transaction_id,page_id,operation_id,expected_revision)
          VALUES(txid_current(),$1,$2,$3)`, [state.row.id, record.operationId, record.expectedRevision]);
        const row = await updateCheckedPage(tx, { source,slug,expectedRevision: record.expectedRevision,page }, async () => {}, true);
        await tx.executeRaw('DELETE FROM page_file_write_authorizations WHERE transaction_id=txid_current() AND page_id=$1', [state.row.id]);
        if (!row) throw new Error('precondition_failed');
        await tx.executeRaw('UPDATE page_file_bindings SET pending_op_id=NULL, indexed_raw_sha256=$2, file_generation=file_generation+1 WHERE binding_id=$1', [record.bindingId,record.afterDigest]);
        await tx.executeRaw("UPDATE page_file_operations SET state='committed',revision=$2 WHERE operation_id=$1", [record.operationId,row.write_revision]);
      }),
    };
    const result = recovery
      ? await recoverPageFile(journal,adapter,{action:recovery,record})
      : await replacePageFile(journal,{...adapter,inspect},record,before,Buffer.from(p.raw_markdown));
    return { ...result, operation_id: record.operationId, persistence: 'file_and_database' };
  }
}
