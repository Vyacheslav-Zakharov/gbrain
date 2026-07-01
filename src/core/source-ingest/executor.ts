import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import type { BrainEngine } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import { writePageThrough } from '../write-through.ts';
import { appendCompleted, clearOpCheckpoint, fingerprint, loadOpCheckpoint, type OpCheckpointKey } from '../op-checkpoint.ts';
import { getSourceConnector } from './connectors/fake.ts';
import type { SourceRecord } from './connectors/types.ts';
import { renderManagedBlock, mergeManagedBlock, SOURCE_SYNC_BEGIN, SOURCE_SYNC_END } from './managed-block.ts';
import { renderSlugTemplate } from './dry-run.ts';
import { profileHash, stableJson } from './store.ts';
import { validateSourceIngestProfile, type SourceFilterRule, type SourceIngestProfile } from './profile-schema.ts';
import { resolveSourceIngestStorageMode, type SourceIngestStorageMode } from './executor-preflight.ts';
import { nextStaleAfter } from './freshness.ts';
import { getSourceConnectorSecretConfig, listSourceConnectorConfigs } from './connector-config.ts';
import { LockUnavailableError, withRefreshingLock } from '../db-lock.ts';

export interface SourceIngestExecutorOptions {
  profile_id: string;
  run_id?: string;
  limit?: number;
  require_clean_git?: boolean;
  allow_db_only?: boolean;
  no_embed?: boolean;
  changed_since?: boolean;
}

export interface SourceIngestRecordResult {
  external_id: string;
  slug?: string;
  status: 'written' | 'unchanged' | 'skipped' | 'failed';
  reason?: string;
  warnings?: string[];
  content_hash?: string | null;
  write_through?: { written: boolean; path?: string; skipped?: string; error?: string };
}

export interface SourceIngestExecutorResult {
  ok: boolean;
  run_id: string;
  profile_id: string;
  source_id?: string;
  storage: SourceIngestStorageMode;
  counts: { sampled: number; written: number; unchanged: number; skipped: number; failed: number };
  results: SourceIngestRecordResult[];
  graph_writes: 'deferred';
  git_commit?: { committed: boolean; sha?: string; reason?: string };
  checkpoint: { op: string; fingerprint: string; loaded: number; cleared: boolean };
}

export function sourceIngestLockId(sourceId: string): string {
  return `source-ingest:${sourceId}`;
}

interface ProfileRow {
  profile_id: string;
  profile_json: unknown;
  current_version: number;
  profile_hash: string;
}

function valueAt(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = data;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function filterMatches(rule: SourceFilterRule, data: Record<string, unknown>): boolean {
  const v = valueAt(data, rule.field);
  switch (rule.op) {
    case 'exists': return v !== undefined && v !== null && v !== '';
    case 'not_exists': return v === undefined || v === null || v === '';
    case 'eq': return v === rule.value;
    case 'neq': return v !== rule.value;
    case 'in': return Array.isArray(rule.value) && rule.value.includes(v);
    case 'not_in': return Array.isArray(rule.value) && !rule.value.includes(v);
    case 'lte': return Number(v) <= Number(rule.value);
    case 'gte': return Number(v) >= Number(rule.value);
    case 'lt': return Number(v) < Number(rule.value);
    case 'gt': return Number(v) > Number(rule.value);
    default: return false;
  }
}

function includeRecord(profile: SourceIngestProfile, record: SourceRecord): { include: boolean; reason?: string } {
  const includes = profile.selection?.include || [];
  const excludes = profile.selection?.exclude || [];
  if (includes.length > 0 && !includes.every(r => filterMatches(r, record.data))) return { include: false, reason: 'include_filter_not_matched' };
  const exclude = excludes.find(r => filterMatches(r, record.data));
  if (exclude) return { include: false, reason: `exclude_filter:${exclude.field}:${exclude.op}` };
  return { include: true };
}

function hashText(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function managedBody(profile: SourceIngestProfile, record: SourceRecord): string {
  const title = String(valueAt(record.data, profile.identity.display_name_field) ?? record.external_id);
  const lines = [`## Source data`, ``, `- Name: ${title}`, `- External ID: ${record.external_id}`];
  for (const field of profile.update_policy.field_allowlist || []) {
    const v = valueAt(record.data, field);
    if (v !== undefined && v !== null && v !== '') lines.push(`- ${field}: ${String(v)}`);
  }
  return lines.join('\n');
}

function existingManagedBlock(content: string): string | null {
  const s = content.indexOf(SOURCE_SYNC_BEGIN);
  if (s < 0) return null;
  const e = content.indexOf(SOURCE_SYNC_END, s);
  if (e < 0) return null;
  return content.slice(s, e + SOURCE_SYNC_END.length);
}

function yamlScalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v ?? '');
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function renderMarkdown(profile: SourceIngestProfile, record: SourceRecord, existingBody: string | null, runIdForFrontmatter: string) {
  const slug = renderSlugTemplate(profile.target.slug_template, record.data);
  const externalRef = `${profile.source_connector}:${profile.source_object}:${record.external_id}`;
  const title = String(valueAt(record.data, profile.identity.display_name_field) ?? record.external_id);
  const generatedBlock = renderManagedBlock(profile.profile_id, externalRef, managedBody(profile, record));
  const mergedBody = existingBody
    ? mergeManagedBlock(existingBody, profile.profile_id, externalRef, managedBody(profile, record)).content
    : `# ${title}\n\n${generatedBlock}\n\n## Notes\n\nПилотная запись source-ingest. Ручной текст вне managed block сохраняется при refresh.\n`;
  const frontmatter: Record<string, unknown> = {
    type: profile.target.gbrain_type,
    title,
    status: 'draft',
    source_id: profile.target.approved_source_id,
    ...(profile.mapping?.frontmatter || {}),
  };
  const fm = [
    '---',
    ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${yamlScalar(v)}`),
    'source_ingest:',
    `  profile_id: ${yamlScalar(profile.profile_id)}`,
    `  external_ref: ${yamlScalar(externalRef)}`,
    `  run_id: ${yamlScalar(runIdForFrontmatter)}`,
    '---',
    '',
  ].join('\n');
  return { slug, externalRef, title, generatedBlock, managedBlockHash: hashText(generatedBlock), markdown: fm + mergedBody };
}

async function loadProfile(engine: BrainEngine, profileId: string): Promise<{ profile: SourceIngestProfile; version: number; hash: string }> {
  const rows = await engine.executeRaw<ProfileRow>(
    `SELECT profile_id, profile_json, current_version, profile_hash FROM source_ingest_profiles WHERE profile_id = $1`,
    [profileId],
  );
  const row = rows[0];
  if (!row) throw new Error(`source_ingest profile not found: ${profileId}`);
  const raw = typeof row.profile_json === 'string' ? JSON.parse(row.profile_json) : row.profile_json;
  const validation = validateSourceIngestProfile(raw);
  if (!validation.ok || !validation.profile) throw new Error(`invalid source_ingest profile: ${validation.issues.map(i => i.code).join(', ')}`);
  if (validation.profile.status !== 'reviewed' && validation.profile.status !== 'active') throw new Error(`profile must be reviewed/active, got ${validation.profile.status}`);
  return { profile: validation.profile, version: Number(row.current_version || 1), hash: row.profile_hash || profileHash(validation.profile) };
}

async function writeSyncState(engine: BrainEngine, args: {
  profile: SourceIngestProfile;
  profileVersion: number;
  record: SourceRecord;
  slug: string;
  runId: string;
  managedBlockHash: string;
  sourceHash: string;
  result: string;
  error?: string | null;
}) {
  const staleAfter = nextStaleAfter(args.profile.freshness?.policy ?? null);
  await engine.executeRaw(
    `INSERT INTO source_sync_state
       (connector_id, source_object, external_id, slug, approved_source_id, profile_id, profile_version,
        content_fingerprint, last_source_hash, source_updated_at, last_synced_at, stale_after, freshness_policy, run_id, last_result, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,$14,$15,now())
     ON CONFLICT (connector_id, source_object, external_id) DO UPDATE SET
       slug = EXCLUDED.slug,
       approved_source_id = EXCLUDED.approved_source_id,
       profile_id = EXCLUDED.profile_id,
       profile_version = EXCLUDED.profile_version,
       content_fingerprint = EXCLUDED.content_fingerprint,
       last_source_hash = EXCLUDED.last_source_hash,
       source_updated_at = EXCLUDED.source_updated_at,
       last_synced_at = EXCLUDED.last_synced_at,
       stale_after = EXCLUDED.stale_after,
       freshness_policy = EXCLUDED.freshness_policy,
       run_id = EXCLUDED.run_id,
       last_result = EXCLUDED.last_result,
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      args.profile.source_connector,
      args.profile.source_object,
      args.record.external_id,
      args.slug,
      args.profile.target.approved_source_id,
      args.profile.profile_id,
      args.profileVersion,
      args.managedBlockHash,
      hashText(stableJson(args.record.data)),
      args.record.source_updated_at ?? null,
      staleAfter?.toISOString() ?? null,
      args.profile.freshness?.policy ?? null,
      args.runId,
      args.result,
      args.error ?? null,
    ],
  );
}

async function appendRunItem(engine: BrainEngine, args: {
  profile: SourceIngestProfile;
  profileVersion: number;
  record: SourceRecord;
  slug: string;
  runId: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';
  priorVersionId?: number | null;
  result: 'success' | 'unchanged' | 'skipped' | 'failed';
  error?: string | null;
}) {
  await engine.executeRaw(
    `INSERT INTO source_ingest_run_items
       (run_id, connector_id, source_object, external_id, slug, approved_source_id, profile_id, profile_version,
        action, prior_version_id, last_result, last_error, source_updated_at, source_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (run_id, connector_id, source_object, external_id) DO UPDATE SET
       slug = EXCLUDED.slug,
       approved_source_id = EXCLUDED.approved_source_id,
       profile_id = EXCLUDED.profile_id,
       profile_version = EXCLUDED.profile_version,
       action = EXCLUDED.action,
       prior_version_id = EXCLUDED.prior_version_id,
       last_result = EXCLUDED.last_result,
       last_error = EXCLUDED.last_error,
       source_updated_at = EXCLUDED.source_updated_at,
       source_hash = EXCLUDED.source_hash,
       created_at = now()`,
    [
      args.runId,
      args.profile.source_connector,
      args.profile.source_object,
      args.record.external_id,
      args.slug,
      args.profile.target.approved_source_id,
      args.profile.profile_id,
      args.profileVersion,
      args.action,
      args.priorVersionId ?? null,
      args.result,
      args.error ?? null,
      args.record.source_updated_at ?? null,
      hashText(stableJson(args.record.data)),
    ],
  );
}

function cleanupUncommittedPath(localPath: string, relPath: string) {
  if (!relPath) return;
  let tracked = false;
  try {
    execFileSync('git', ['-C', localPath, 'ls-files', '--error-unmatch', relPath], { encoding: 'utf8', stdio: 'pipe' });
    tracked = true;
  } catch {}
  try {
    execFileSync('git', ['-C', localPath, 'restore', '--staged', '--worktree', '--', relPath], { encoding: 'utf8' });
  } catch {}
  if (!tracked) {
    const abs = `${localPath.replace(/\/$/, '')}/${relPath}`;
    if (existsSync(abs)) rmSync(abs, { force: true });
  }
}

async function commitGitBackedRun(localPath: string, filePaths: string[], runId: string, profileId: string) {
  const unique = [...new Set(filePaths)].filter(Boolean);
  if (unique.length === 0) return { committed: false, reason: 'no_files' };
  execFileSync('git', ['-C', localPath, 'add', '--', ...unique], { encoding: 'utf8' });
  const status = execFileSync('git', ['-C', localPath, 'status', '--porcelain', '--', ...unique], { encoding: 'utf8' });
  if (!status.trim()) return { committed: false, reason: 'no_changes' };
  execFileSync('git', ['-C', localPath, 'commit', '-m', `source-ingest run_id=${runId} profile=${profileId}`, '--', ...unique], { encoding: 'utf8' });
  const sha = execFileSync('git', ['-C', localPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  return { committed: true, sha };
}

export async function runSourceIngestExecutor(
  engine: BrainEngine,
  opts: SourceIngestExecutorOptions,
  logger: { warn(msg: string): void } = console,
): Promise<SourceIngestExecutorResult> {
  const { profile, version, hash } = await loadProfile(engine, opts.profile_id);
  if (profile.source_connector !== 'fake-source') throw new Error('Stage 3A executor only allows fake-source');
  const sourceId = profile.target.approved_source_id;
  if (!sourceId) throw new Error('profile target approved_source_id is required');
  const storage = await resolveSourceIngestStorageMode(engine, sourceId, {
    requireCleanGit: opts.require_clean_git ?? true,
    allowDbOnly: opts.allow_db_only ?? false,
  });
  if (storage.mode === 'blocked') {
    return { ok: false, run_id: opts.run_id ?? `source-ingest-${new Date().toISOString()}`, profile_id: profile.profile_id, source_id: sourceId, storage, counts: { sampled: 0, written: 0, unchanged: 0, skipped: 0, failed: 0 }, results: [], graph_writes: 'deferred', checkpoint: { op: 'source_ingest', fingerprint: '', loaded: 0, cleared: false } };
  }
  if (storage.mode !== 'git-backed') throw new Error('Stage 3A executor requires git-backed source');

  const lockId = sourceIngestLockId(sourceId);
  try {
    return await withRefreshingLock(engine, lockId, async () => {

  const runId = opts.run_id ?? `source-ingest-${new Date().toISOString().replace(/[:.]/g, '')}`;
  const configId = `${profile.source_connector}:${profile.source_object}`;
  const [savedConfig] = await listSourceConnectorConfigs(engine, configId);
  const secretConfig = await getSourceConnectorSecretConfig(engine, profile.source_connector, profile.source_object);
  const connectorConfig = { ...(savedConfig?.config_json || {}), ...secretConfig };
  const connector = getSourceConnector(profile.source_connector, connectorConfig);
  if (!connector) throw new Error(`connector not found: ${profile.source_connector}`);
  const records: SourceRecord[] = [];
  let iterable: AsyncIterable<{ records: SourceRecord[]; cursor?: string | null }> | undefined;
  if (opts.changed_since && connector.fetchChangedSince) {
    const sinceRows = await engine.executeRaw<{ since: string | null }>(
      `SELECT max(source_updated_at)::text AS since
         FROM source_sync_state
        WHERE profile_id = $1 AND connector_id = $2 AND source_object = $3 AND last_result <> 'failed'`,
      [profile.profile_id, profile.source_connector, profile.source_object],
    );
    const since = sinceRows[0]?.since;
    if (since) iterable = connector.fetchChangedSince(profile.source_object, since);
  }
  if (!iterable) {
    if (!connector.fetchAll) throw new Error(`connector does not support fetchAll: ${profile.source_connector}`);
    iterable = connector.fetchAll(profile.source_object);
  }
  for await (const batch of iterable) {
    for (const r of batch.records) records.push(r);
    if (opts.limit && records.length >= opts.limit) break;
  }
  const limited = opts.limit ? records.slice(0, opts.limit) : records;
  const key: OpCheckpointKey = {
    op: 'source_ingest',
    fingerprint: fingerprint({ profile_id: profile.profile_id, profile_hash: hash, source_id: sourceId, connector: profile.source_connector, object: profile.source_object, mode: 'stage3a' }),
  };
  const completed = new Set(await loadOpCheckpoint(engine, key));
  const results: SourceIngestRecordResult[] = [];
  const writtenPaths: string[] = [];
  let lastRecordCommit: SourceIngestExecutorResult['git_commit'];

  for (const record of limited) {
    const checkpointKey = `${profile.source_connector}:${profile.source_object}:${record.external_id}`;
    const decision = includeRecord(profile, record);
    if (!decision.include) {
      results.push({ external_id: record.external_id, status: 'skipped', reason: decision.reason });
      continue;
    }
    if (completed.has(checkpointKey)) {
      results.push({ external_id: record.external_id, status: 'skipped', reason: 'checkpoint_completed' });
      continue;
    }
    let renderedSlug = renderSlugTemplate(profile.target.slug_template, record.data);
    let renderedPath = `${renderedSlug}.md`;
    let createdThisRecord = false;
    try {
      const existing = await engine.getPage(renderedSlug, { sourceId });
      createdThisRecord = !existing;
      const priorVersions = existing ? await engine.getVersions(renderedSlug, { sourceId }) : [];
      const priorVersionId = priorVersions[0]?.id ?? null;
      const existingRunId = existing?.frontmatter && typeof existing.frontmatter.source_ingest === 'object'
        ? (existing.frontmatter.source_ingest as Record<string, unknown>).run_id
        : undefined;
      const rendered = renderMarkdown(profile, record, existing?.compiled_truth ?? null, typeof existingRunId === 'string' ? existingRunId : runId);
      renderedSlug = rendered.slug;
      renderedPath = `${rendered.slug}.md`;
      const existingBlock = existing ? existingManagedBlock(existing.compiled_truth) : null;
      const warnings: string[] = [];
      const oldState = await engine.executeRaw<{ content_fingerprint: string | null }>(
        `SELECT content_fingerprint FROM source_sync_state WHERE connector_id = $1 AND source_object = $2 AND external_id = $3`,
        [profile.source_connector, profile.source_object, record.external_id],
      );
      if (existingBlock && oldState[0]?.content_fingerprint && hashText(existingBlock) !== oldState[0].content_fingerprint) {
        warnings.push('managed_block_user_edit_overwritten');
      }
      const beforeHash = existing?.content_hash ?? null;
      const imported = await importFromContent(engine, rendered.slug, rendered.markdown, {
        noEmbed: opts.no_embed ?? true,
        sourceId,
        sourcePath: `${rendered.slug}.md`,
        source_kind: 'source_ingest',
        source_uri: rendered.externalRef,
        ingested_via: 'source_ingest',
        remote: false,
      });
      if (imported.status === 'error') throw new Error(imported.error || 'import failed');
      const writeThrough = await writePageThrough(engine, rendered.slug, {
        sourceId,
        frontmatterOverrides: { ingested_via: 'source_ingest', source_kind: 'source_ingest' },
        logger,
      });
      if (!writeThrough.written) throw new Error(`write-through failed: ${writeThrough.skipped || writeThrough.error || 'unknown'}`);
      const after = await engine.getPage(rendered.slug, { sourceId });
      const status = beforeHash && after?.content_hash === beforeHash ? 'unchanged' : 'written';
      if (writeThrough.path && status !== 'unchanged') writtenPaths.push(writeThrough.path);
      await writeSyncState(engine, {
        profile,
        profileVersion: version,
        record,
        slug: rendered.slug,
        runId,
        managedBlockHash: rendered.managedBlockHash,
        sourceHash: hashText(stableJson(record.data)),
        result: status === 'unchanged' ? 'unchanged' : 'success',
      });
      await appendRunItem(engine, {
        profile,
        profileVersion: version,
        record,
        slug: rendered.slug,
        runId,
        action: status === 'unchanged' ? 'unchanged' : (createdThisRecord ? 'created' : 'updated'),
        priorVersionId,
        result: status === 'unchanged' ? 'unchanged' : 'success',
      });
      if (status !== 'unchanged' && writeThrough.path) {
        lastRecordCommit = await commitGitBackedRun(storage.local_path, [writeThrough.path], runId, profile.profile_id);
      }
      await appendCompleted(engine, key, [checkpointKey]);
      completed.add(checkpointKey);
      results.push({ external_id: record.external_id, slug: rendered.slug, status, warnings, content_hash: after?.content_hash ?? null, write_through: writeThrough });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (createdThisRecord) {
        try { await engine.softDeletePage(renderedSlug, { sourceId }); } catch {}
      }
      if (storage.mode === 'git-backed') cleanupUncommittedPath(storage.local_path, renderedPath);
      results.push({ external_id: record.external_id, slug: renderedSlug, status: 'failed', reason: msg });
      await writeSyncState(engine, { profile, profileVersion: version, record, slug: renderedSlug, runId, managedBlockHash: '', sourceHash: hashText(stableJson(record.data)), result: 'failed', error: msg });
      await appendRunItem(engine, { profile, profileVersion: version, record, slug: renderedSlug, runId, action: 'failed', result: 'failed', error: msg });
    }
  }
  const failed = results.filter(r => r.status === 'failed').length;
  let gitCommit: SourceIngestExecutorResult['git_commit'] = { committed: false, reason: failed === 0 ? 'no_changes' : 'failed_records' };
  if (failed === 0) {
    const status = execFileSync('git', ['-C', storage.local_path, 'status', '--porcelain', '--', ...[...new Set(writtenPaths)]], { encoding: 'utf8' });
    if (status.trim()) gitCommit = await commitGitBackedRun(storage.local_path, writtenPaths, runId, profile.profile_id);
    else if (lastRecordCommit) gitCommit = lastRecordCommit;
    else if (writtenPaths.length > 0 || results.some(r => r.status === 'unchanged')) gitCommit = { committed: false, reason: 'no_changes' };
    else gitCommit = { committed: false, reason: 'no_files' };
    await clearOpCheckpoint(engine, key);
  }
  return {
    ok: failed === 0,
    run_id: runId,
    profile_id: profile.profile_id,
    source_id: sourceId,
    storage,
    counts: {
      sampled: limited.length,
      written: results.filter(r => r.status === 'written').length,
      unchanged: results.filter(r => r.status === 'unchanged').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed,
    },
    results,
    graph_writes: 'deferred',
    git_commit: gitCommit,
    checkpoint: { op: key.op, fingerprint: key.fingerprint, loaded: completed.size, cleared: failed === 0 },
  };
    });
  } catch (e) {
    if (e instanceof LockUnavailableError) {
      return {
        ok: false,
        run_id: opts.run_id ?? `source-ingest-${new Date().toISOString()}`,
        profile_id: profile.profile_id,
        source_id: sourceId,
        storage: { mode: 'blocked', source_id: sourceId, reason: 'source_ingest_lock_busy' },
        counts: { sampled: 0, written: 0, unchanged: 0, skipped: 0, failed: 0 },
        results: [],
        graph_writes: 'deferred',
        checkpoint: { op: 'source_ingest', fingerprint: '', loaded: 0, cleared: false },
      };
    }
    throw e;
  }
}
