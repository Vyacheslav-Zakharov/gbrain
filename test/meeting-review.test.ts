import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acceptMeetingReview,
  attachMeetingReviewJob,
  createLlmMeetingRevision,
  createManualMeetingRevision,
  getMeetingReviewItem,
  listMeetingReviewItems,
  rejectMeetingReview,
  type MeetingReviewPaths,
} from '../src/core/meeting-review.ts';

let root = '';
let previewRoot = '';
let paths: MeetingReviewPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gbrain-meeting-review-test-'));
  previewRoot = await mkdtemp('/tmp/meeting-ingest/test-review-');
  paths = {
    reportsDir: join(root, 'reports'),
    ledgerPath: join(root, 'ledger.json'),
    overridesPath: join(root, 'overrides.json'),
    ingestStatePath: join(root, 'ingest-state.json'),
  };
  await mkdir(paths.reportsDir, { recursive: true });
  const canonical = join(previewRoot, 'canonical.md');
  const shared = join(previewRoot, 'shared.md');
  await writeFile(canonical, '---\ntype: meeting\n---\n# Canonical\n');
  await writeFile(shared, '---\ntype: meeting\n---\n# Shared\n');
  await writeFile(join(paths.reportsDir, 'run-2.json'), JSON.stringify({
    dry_run: true,
    generated_at: '2026-07-30T00:00:00Z',
    results: [{
      id: 'abcd1234', topic: 'Example meeting', date: '2026-07-29',
      slug: 'meetings/2026-07-29-example', source: 'internal-example', split_source: null,
      route_reason: 'example route', needs_review: [{ kind: 'participant_unresolved', value: 'alice-example' }],
      created_stubs: ['shared:people/alice-example'], canonical_preview: canonical, shared_preview: shared,
    }],
  }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(previewRoot, { recursive: true, force: true });
});

describe('meeting review queue', () => {
  test('loads pending preview and Markdown detail', async () => {
    const list = await listMeetingReviewItems({}, { paths });
    expect(list.total).toBe(1);
    const detail = await getMeetingReviewItem('abcd1234', { paths });
    expect(detail.item.draft?.canonical_markdown).toContain('# Canonical');
    expect(detail.item.created_stubs).toEqual(['shared:people/alice-example']);
  });

  test('retains unresolved candidates from older preview snapshots', async () => {
    await writeFile(join(paths.reportsDir, 'run-3.json'), JSON.stringify({ dry_run: true, generated_at: '2026-07-30T01:00:00Z', results: [] }));
    expect((await listMeetingReviewItems({}, { paths })).total).toBe(1);
  });

  test('filters meetings already present in ingest state', async () => {
    await writeFile(paths.ingestStatePath, JSON.stringify({ ingested: ['abcd1234'] }));
    expect((await listMeetingReviewItems({}, { paths })).total).toBe(0);
  });

  test('persists manual revision and accepted override with minion receipt', async () => {
    const detail = await getMeetingReviewItem('abcd1234', { paths });
    const draft = { ...detail.item.draft!, canonical_markdown: detail.item.draft!.canonical_markdown.replace('Canonical', 'Reviewed') };
    const revision = await createManualMeetingRevision('abcd1234', draft, 'reviewer@example.com', { paths });
    expect(revision.revision_id).toBe(1);
    await acceptMeetingReview('abcd1234', draft, 'reviewer@example.com', { paths });
    const accepted = await attachMeetingReviewJob('abcd1234', 42, 'reviewer@example.com', { paths });
    expect(accepted.status).toBe('accepted');
    expect(accepted.job_id).toBe(42);
    const overrides = JSON.parse(await readFile(paths.overridesPath, 'utf8'));
    expect(overrides.abcd1234.draft.canonical_markdown).toContain('# Reviewed');
    expect((await listMeetingReviewItems({ status: 'accepted' }, { paths })).total).toBe(1);
  });

  test('rejects without publishing', async () => {
    await rejectMeetingReview('abcd1234', 'duplicate', 'reviewer@example.com', { paths });
    expect((await listMeetingReviewItems({ status: 'pending' }, { paths })).total).toBe(0);
    expect((await listMeetingReviewItems({ status: 'rejected' }, { paths })).rows[0]?.reject_reason).toBe('duplicate');
  });

  test('creates an LLM revision for one selected document only', async () => {
    const revision = await createLlmMeetingRevision(
      'abcd1234',
      'canonical_markdown',
      'Fix heading',
      'reviewer@example.com',
      {
        paths,
        chat: async () => ({
          text: JSON.stringify({ markdown: '---\ntype: meeting\n---\n# Revised\n' }),
          blocks: [],
          stopReason: 'end',
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'test',
          providerId: 'test',
        }),
      },
    );
    expect(revision.draft.canonical_markdown).toContain('# Revised');
    expect(revision.draft.shared_markdown).toContain('# Shared');
  });
});
