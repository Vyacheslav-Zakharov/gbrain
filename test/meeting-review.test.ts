import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acceptMeetingReview,
  askMeetingReviewAdvisor,
  createLlmMeetingRevision,
  createManualMeetingRevision,
  getMeetingReviewItem,
  isCanonicalMeetingPersonSlug,
  listMeetingReviewItems,
  MEETING_INTERNAL_SOURCE_OPTIONS,
  rejectMeetingReview,
  saveMeetingReviewResolution,
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
      meeting_status: 'Утверждено',
      route_reason: 'department unresolved', needs_review: [{ kind: 'participant_unresolved', value: 'alice-example' }],
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

  test('finds a meeting by its stable id', async () => {
    const list = await listMeetingReviewItems({ query: 'abcd1234' }, { paths });
    expect(list.total).toBe(1);
    expect(list.rows[0]?.id).toBe('abcd1234');
  });

  test('filters meetings already present in ingest state', async () => {
    await writeFile(paths.ingestStatePath, JSON.stringify({ ingested: ['abcd1234'] }));
    expect((await listMeetingReviewItems({}, { paths })).total).toBe(0);
  });

  test('persists manual revision but refuses unresolved acceptance', async () => {
    const detail = await getMeetingReviewItem('abcd1234', { paths });
    const draft = { ...detail.item.draft!, canonical_markdown: detail.item.draft!.canonical_markdown.replace('Canonical', 'Reviewed') };
    const revision = await createManualMeetingRevision('abcd1234', draft, 'reviewer@example.com', { paths });
    expect(revision.revision_id).toBe(1);
    expect(revision.draft.canonical_markdown).toContain('# Reviewed');
    await expect(acceptMeetingReview('abcd1234', draft, 'reviewer@example.com', { paths }))
      .rejects.toThrow('Direct meeting acceptance is disabled');
    expect((await listMeetingReviewItems({ status: 'pending' }, { paths })).total).toBe(1);
  });

  test('separates clean automatic candidates from actionable exceptions', async () => {
    await writeFile(join(paths.reportsDir, 'run-3.json'), JSON.stringify({
      dry_run: true,
      generated_at: '2026-07-30T01:00:00Z',
      results: [{
        id: 'clean1234', topic: 'Clean meeting', date: '2026-07-30',
        slug: 'meetings/2026-07-30-clean', source: 'shared', split_source: null,
        meeting_status: 'Утверждено',
        route_reason: 'non-sensitive shared content', needs_review: [], created_stubs: [],
      }],
    }));

    const exceptions = await listMeetingReviewItems({ status: 'pending', review_class: 'exception' }, { paths });
    const ready = await listMeetingReviewItems({ status: 'pending', review_class: 'ready' }, { paths });
    expect(exceptions.total).toBe(1);
    expect(exceptions.counts).toEqual({ exception: 1, ready: 1 });
    expect(exceptions.rows[0]?.review_class).toBe('exception');
    expect(exceptions.rows[0]?.attention[0]).toMatchObject({
      kind: 'participant_unresolved',
      title: 'Не найден участник',
      value: 'alice-example',
    });
    expect(ready.total).toBe(1);
    expect(ready.rows[0]?.review_class).toBe('ready');
    expect(ready.rows[0]?.attention).toEqual([]);
  });

  test('classifies nonapproved status as an exception', async () => {
    await writeFile(join(paths.reportsDir, 'run-3.json'), JSON.stringify({
      dry_run: true,
      generated_at: '2026-07-30T01:00:00Z',
      results: [{
        id: 'done1234', topic: 'Finished but not approved', date: '2026-07-30',
        slug: 'meetings/2026-07-30-finished', source: 'shared', split_source: null,
        meeting_status: 'Завершено', route_reason: 'non-sensitive shared content',
        needs_review: [], created_stubs: [],
      }],
    }));
    const detail = await getMeetingReviewItem('done1234', { paths });
    expect(detail.item.review_class).toBe('exception');
    expect(detail.item.attention[0]).toMatchObject({ kind: 'status_not_approved' });
  });

  test('fresh preview safety fields override stale ledger fields', async () => {
    await writeFile(paths.ledgerPath, JSON.stringify({
      schema_version: 1,
      items: {
        clean1234: {
          id: 'clean1234', topic: 'Old row', date: '2026-07-01',
          slug: 'meetings/old', source: 'shared', split_source: null,
          status: 'pending', meeting_status: 'Завершено', route_reason: 'department unresolved',
          needs_review: [{ kind: 'participant_unresolved', value: 'stale' }],
          created_stubs: ['shared:people/stale'], generated_at: '2026-07-01T00:00:00Z',
        },
      },
      revisions: [], events: [], next_revision_id: 1,
    }));
    await writeFile(join(paths.reportsDir, 'run-3.json'), JSON.stringify({
      dry_run: true,
      generated_at: '2026-07-30T01:00:00Z',
      results: [{
        id: 'clean1234', topic: 'Fresh clean row', date: '2026-07-30',
        slug: 'meetings/2026-07-30-clean', source: 'shared', split_source: null,
        meeting_status: 'Утверждено', route_reason: 'non-sensitive shared content',
        needs_review: [], created_stubs: [],
      }],
    }));
    const detail = await getMeetingReviewItem('clean1234', { paths });
    expect(detail.item.status).toBe('pending');
    expect(detail.item.review_class).toBe('ready');
    expect(detail.item.topic).toBe('Fresh clean row');
    expect(detail.item.attention).toEqual([]);
  });

  test('rejects without publishing', async () => {
    await rejectMeetingReview('abcd1234', 'duplicate', 'reviewer@example.com', { paths });
    expect((await listMeetingReviewItems({ status: 'pending' }, { paths })).total).toBe(0);
    expect((await listMeetingReviewItems({ status: 'rejected' }, { paths })).rows[0]?.reject_reason).toBe('duplicate');
  });

  test('rejects an exclusion without an audited reason', async () => {
    await expect(rejectMeetingReview('abcd1234', '   ', 'reviewer@example.com', { paths }))
      .rejects.toThrow('reason is required');
    expect((await listMeetingReviewItems({ status: 'pending' }, { paths })).total).toBe(1);
  });

  test('saves an allowlisted routing resolution with optimistic locking and audit', async () => {
    await writeFile(paths.overridesPath, JSON.stringify({
      abcd1234: { status: 'draft', draft: { canonical_markdown: '# stale' }, unknown_legacy_field: true },
    }));
    const saved = await saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z',
      route_source: 'internal-it',
      note: 'Встреча относится к эксплуатации ИТ-системы',
    }, 'reviewer@example.com', { paths, now: () => new Date('2026-08-05T08:00:00Z') });

    expect(saved.resolution.route_source).toBe('internal-it');
    expect(saved.actor).toBe('reviewer@example.com');
    const overrides = JSON.parse(await Bun.file(paths.overridesPath).text());
    expect(overrides.abcd1234).toMatchObject({
      status: 'resolution',
      actor: 'reviewer@example.com',
      reason: 'Встреча относится к эксплуатации ИТ-системы',
      resolution: {
        expected_generated_at: '2026-07-30T00:00:00Z',
        route_source: 'internal-it',
      },
    });
    expect(Object.keys(overrides.abcd1234).sort()).toEqual(['actor', 'reason', 'resolution', 'status', 'updated_at']);
    const repeated = await saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z',
      route_source: 'internal-it',
      note: 'Встреча относится к эксплуатации ИТ-системы',
    }, 'reviewer@example.com', { paths, now: () => new Date('2026-08-05T09:00:00Z') });
    expect(repeated).toEqual(saved);
    const ledger = JSON.parse(await Bun.file(paths.ledgerPath).text());
    expect(ledger.events.filter((event: { action?: string }) => event.action === 'resolution_saved')).toHaveLength(1);
    const detail = await getMeetingReviewItem('abcd1234', { paths });
    expect(detail.item.review_class).toBe('exception');
    expect(detail.resolution?.resolution.route_source).toBe('internal-it');
    expect(detail.events[0]).toMatchObject({ action: 'resolution_saved', route_source: 'internal-it' });
  });

  test('rejects stale or noncanonical routing resolutions', async () => {
    await expect(saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: 'stale-preview', route_source: 'internal-it', note: '',
    }, 'reviewer@example.com', { paths })).rejects.toThrow('preview changed');
    await expect(saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z', route_source: 'internal-secret', note: '',
    }, 'reviewer@example.com', { paths })).rejects.toThrow('invalid internal source');
  });

  test('offers logistics and motor transport as a canonical meeting route', () => {
    expect(MEETING_INTERNAL_SOURCE_OPTIONS).toContainEqual({
      id: 'internal-logistics',
      label: 'Логистика и автотранспорт',
      description: 'Автотранспорт, рейсы, ремонты, топливо, телематика и логистические процессы.',
    });
  });

  test('uses the exact producer-compatible canonical person slug predicate', () => {
    for (const slug of ['hcm/employees/alice-example', 'counterparties/contacts/bob-2', 'hcm/employees/a-']) {
      expect(isCanonicalMeetingPersonSlug(slug)).toBe(true);
    }
    for (const slug of [
      'hcm/employees/index', 'counterparties/contacts/readme',
      'hcm/employees/Alice', 'hcm/employees/alice.example', 'hcm/employees/alice_example',
      'hcm/employees/team/alice', 'hcm/employees/alice/',
    ]) expect(isCanonicalMeetingPersonSlug(slug)).toBe(false);
  });

  test('fails closed when the overrides root is malformed', async () => {
    await writeFile(paths.overridesPath, JSON.stringify([]));
    await expect(saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z', route_source: 'internal-it', note: '',
    }, 'reviewer@example.com', { paths })).rejects.toThrow('overrides must be a JSON object');
  });

  test('does not overwrite a legacy accepted override through the resolution form', async () => {
    await writeFile(paths.overridesPath, JSON.stringify({
      abcd1234: { status: 'accepted', actor: 'legacy-reviewer', suppress_systems: ['digital/systems/example'] },
    }));
    await expect(saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z', route_source: 'internal-it', note: '',
    }, 'reviewer@example.com', { paths })).rejects.toThrow('audited recovery');
    const overrides = JSON.parse(await Bun.file(paths.overridesPath).text());
    expect(overrides.abcd1234).toMatchObject({ status: 'accepted', actor: 'legacy-reviewer' });
    expect((await getMeetingReviewItem('abcd1234', { paths })).resolution_locked).toBeTrue();
  });

  test('rejects a preview that changes during asynchronous canonical validation', async () => {
    await expect(saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z',
      participant_resolutions: {
        'alice-example': { action: 'map_existing', target_slug: 'hcm/employees/alice-canonical' },
      },
      note: '',
    }, 'reviewer@example.com', {
      paths,
      entityExists: async () => {
        const report = JSON.parse(await Bun.file(join(paths.reportsDir, 'run-2.json')).text());
        report.generated_at = '2026-07-30T00:01:00Z';
        await writeFile(join(paths.reportsDir, 'run-3.json'), JSON.stringify(report));
        return true;
      },
    })).rejects.toThrow('preview changed');
    expect(await Bun.file(paths.overridesPath).exists()).toBeFalse();
  });

  test('rejects markup-capable or missing mention-only labels', async () => {
    const unsafeLabels = [undefined, '[[hcm/employees/admin]]', '[Иван](https://example.test)', 'Иван\n## Раздел', 'https://example.test', '- вложенный пункт', 'name@example.test'];
    for (const label of unsafeLabels) {
      await expect(saveMeetingReviewResolution('abcd1234', {
        expected_generated_at: '2026-07-30T00:00:00Z',
        participant_resolutions: {
          'alice-example': {
            action: 'mention_only',
            ...(label === undefined ? {} : { label }),
          },
        },
      }, 'reviewer@example.com', { paths, entityExists: async () => true })).rejects.toThrow(/label|safe display label/);
    }
  });

  test('validates canonical participant mappings before writing an override', async () => {
    const saved = await saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z',
      participant_resolutions: {
        'alice-example': { action: 'map_existing', target_slug: 'hcm/employees/alice-canonical', label: 'Alice' },
      },
      note: '',
    }, 'reviewer@example.com', { paths, entityExists: async slug => slug === 'hcm/employees/alice-canonical' });
    expect(saved.resolution.participant_resolutions?.['alice-example']).toMatchObject({
      action: 'map_existing', target_slug: 'hcm/employees/alice-canonical',
    });

    await expect(saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z',
      participant_resolutions: {
        'alice-example': { action: 'map_existing', target_slug: 'hcm/employees/missing' },
      }, note: '',
    }, 'reviewer@example.com', { paths, entityExists: async () => false })).rejects.toThrow('participant target not found');
    await expect(saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z',
      participant_resolutions: {
        'alice-example': { action: 'map_existing', target_slug: 'projects/not-a-person' },
      }, note: '',
    }, 'reviewer@example.com', { paths, entityExists: async () => true })).rejects.toThrow('invalid participant target');
    await expect(saveMeetingReviewResolution('abcd1234', {
      expected_generated_at: '2026-07-30T00:00:00Z',
      participant_resolutions: {
        'alice-example': { action: 'mention_only', label: 'Alice\n- [[injected/link]]' },
      }, note: '',
    }, 'reviewer@example.com', { paths })).rejects.toThrow('participant label');
  });

  test('stores LLM advice as audit only and never creates a publication override', async () => {
    const advice = await askMeetingReviewAdvisor('abcd1234', 'Куда отнести эту встречу?', 'reviewer@example.com', {
      paths,
      chat: async () => ({
        text: JSON.stringify({
          answer: 'Основная тема относится к ИТ.',
          recommended_source: 'internal-it',
          confidence: 'medium',
          rationale: 'Обсуждается цифровая система.',
        }),
        blocks: [], stopReason: 'end', model: 'test-model', providerId: 'test-provider',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      }),
      now: () => new Date('2026-08-05T08:10:00Z'),
    });
    expect(advice).toMatchObject({ recommended_source: 'internal-it', confidence: 'medium', actor: 'reviewer@example.com' });
    expect(await Bun.file(paths.overridesPath).exists()).toBe(false);
    const detail = await getMeetingReviewItem('abcd1234', { paths });
    expect(detail.advice).toHaveLength(1);
    expect(detail.advice[0]).toMatchObject({ question: 'Куда отнести эту встречу?', model: 'test-model' });
  });

  test('rejects advisor output without a rationale and writes no audit entry', async () => {
    await expect(askMeetingReviewAdvisor('abcd1234', 'Куда отнести?', 'reviewer@example.com', {
      paths,
      chat: async () => ({
        text: JSON.stringify({ answer: 'В ИТ.', recommended_source: 'internal-it', confidence: 'low', rationale: '' }),
        blocks: [], stopReason: 'end', model: 'test-model', providerId: 'test-provider',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      }),
    })).rejects.toThrow('rationale is invalid');
    expect((await getMeetingReviewItem('abcd1234', { paths })).advice).toHaveLength(0);
  });

  test('discards an LLM answer if the meeting changes while advice is in flight', async () => {
    await expect(askMeetingReviewAdvisor('abcd1234', 'Куда отнести?', 'reviewer@example.com', {
      paths,
      chat: async () => {
        await rejectMeetingReview('abcd1234', 'Исключено во время ответа', 'other-reviewer@example.com', { paths });
        return {
          text: JSON.stringify({ answer: 'Ответ устарел.', recommended_source: 'internal-it', confidence: 'low', rationale: 'Снимок изменился.' }),
          blocks: [], stopReason: 'end', model: 'test-model', providerId: 'test-provider',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        };
      },
    })).rejects.toThrow('meeting no longer requires advice');
    const detail = await getMeetingReviewItem('abcd1234', { paths });
    expect(detail.item.status).toBe('rejected');
    expect(detail.advice).toHaveLength(0);
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
