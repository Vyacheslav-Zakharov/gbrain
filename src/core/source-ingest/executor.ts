import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'fs';
import { resolve, sep } from 'path';
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import { writePageThrough } from '../write-through.ts';
import { appendCompleted, clearOpCheckpoint, fingerprint, loadOpCheckpoint, type OpCheckpointKey } from '../op-checkpoint.ts';
import { getSourceConnector } from './connectors/fake.ts';
import type { SourceRecord } from './connectors/types.ts';
import { renderManagedBlock, mergeManagedBlock, SOURCE_SYNC_BEGIN, SOURCE_SYNC_END } from './managed-block.ts';
import { renderSlugTemplate } from './dry-run.ts';
import { renderArticleTemplate } from './template-renderer.ts';
import { profileHash, stableJson } from './store.ts';
import { validateSourceIngestProfile, type SourceFilterRule, type SourceIngestProfile, type SourceLinkRule } from './profile-schema.ts';
import { resolveSourceIngestStorageMode, type SourceIngestStorageMode } from './executor-preflight.ts';
import { nextStaleAfter } from './freshness.ts';
import { getSourceConnectorSecretConfig, listSourceConnectorConfigs } from './connector-config.ts';
import { buildProfileAllRecords } from './source-fetch.ts';
import { normalizeTransformConfig } from './transform.ts';
import { LockUnavailableError, withRefreshingLock, syncLockId } from '../db-lock.ts';
import { buildSourceTimelineEntries, changeIntelligenceFetchFields, sourceSnapshot } from './change-intelligence.ts';
import { parseMarkdown } from '../markdown.ts';

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
  timeline_created?: number;
  graph_links_created?: number;
  graph_links_removed?: number;
}

export interface SourceIngestExecutorResult {
  ok: boolean;
  run_id: string;
  profile_id: string;
  source_id?: string;
  storage: SourceIngestStorageMode;
  counts: { sampled: number; written: number; unchanged: number; skipped: number; failed: number };
  results: SourceIngestRecordResult[];
  graph_writes: 'deferred' | { created: number; removed: number };
  git_commit?: { committed: boolean; sha?: string; reason?: string };
  checkpoint: { op: string; fingerprint: string; loaded: number; cleared: boolean };
}

export function sourceIngestLockId(sourceId: string): string {
  return syncLockId(sourceId);
}

function parseLiveConnectorAllowlist(raw: string | null): Set<string> {
  if (!raw || !raw.trim()) return new Set(['fake-source']);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map(String).map(s => s.trim()).filter(Boolean));
  } catch {}
  return new Set(raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean));
}

async function assertAllowedSourceConnectors(engine: BrainEngine, profile: SourceIngestProfile): Promise<void> {
  const allowed = parseLiveConnectorAllowlist(await engine.getConfig('source_ingest.live_connectors'));
  const deny = (connector: string, label: string) => {
    if (!allowed.has(connector)) {
      throw new Error(`source_ingest live connector not enabled: ${label} uses ${connector}. Set source_ingest.live_connectors to include it before running a batch.`);
    }
  };
  deny(profile.source_connector, 'profile');
  const transform = normalizeTransformConfig(profile.transform);
  if (!transform) return;
  for (const source of transform.sources) {
    deny(source.connector || profile.source_connector, `transform source ${source.alias}`);
  }
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

function readGitBackedAdoptionPage(localPath: string, slug: string) {
  const root = resolve(localPath);
  const file = resolve(root, `${slug}.md`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error(`adoption slug escapes source worktree: ${slug}`);
  if (!existsSync(file)) return null;
  const parsed = parseMarkdown(readFileSync(file, 'utf8'), `${slug}.md`);
  return {
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: {
      type: parsed.type,
      title: parsed.title,
      ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
      ...parsed.frontmatter,
    } as Record<string, unknown>,
  };
}

function graphValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw
    .filter(v => v !== undefined && v !== null && v !== '')
    .map(v => String(v).trim())
    .filter(Boolean))];
}

interface GraphTargetResolution {
  slug: string;
  sourceId: string;
}

type GraphTargetResolutionMap = Map<string, GraphTargetResolution>;

function graphResolutionKey(profileId: string, externalId: string): string {
  return `${profileId}\u0000${externalId}`;
}

function graphTargets(
  rule: SourceLinkRule,
  data: Record<string, unknown>,
  sourceId: string,
  resolutions?: GraphTargetResolutionMap,
): GraphTargetResolution[] {
  const valueField = rule.target.value_field;
  if (!valueField) return [];
  const values = graphValues(valueAt(data, valueField));
  if (rule.target.lookup === 'external_id') {
    if (!rule.target.profile_id) return [];
    return values.map(value => {
      const resolved = resolutions?.get(graphResolutionKey(rule.target.profile_id!, value));
      if (!resolved) throw new Error(`external_id graph target unresolved for rule ${rule.id}`);
      return resolved;
    });
  }
  if (rule.target.lookup === 'slug' && !rule.target.slug_template) {
    return values.map(slug => ({ slug, sourceId: rule.target.source_id || sourceId }));
  }
  if (!rule.target.slug_template) return [];
  return values.map(value => ({
    slug: renderSlugTemplate(rule.target.slug_template!, { ...data, value }),
    sourceId: rule.target.source_id || sourceId,
  }));
}

async function prefetchGraphTargetResolutions(
  engine: BrainEngine,
  profile: SourceIngestProfile,
  records: SourceRecord[],
): Promise<GraphTargetResolutionMap> {
  const out: GraphTargetResolutionMap = new Map();
  for (const rule of profile.links || []) {
    if (rule.target.lookup !== 'external_id') continue;
    const targetProfileId = rule.target.profile_id;
    const valueField = rule.target.value_field;
    if (!targetProfileId) continue;
    if (!valueField) throw new Error(`external_id graph rule requires target.value_field: ${rule.id}`);
    const externalIds = [...new Set(records.flatMap(record => graphValues(valueAt(record.data, valueField))))];
    if (externalIds.length === 0) continue;
    const rows = await engine.executeRaw<{ external_id: string; slug: string; approved_source_id: string }>(
      `SELECT external_id, slug, approved_source_id
         FROM source_sync_state
        WHERE profile_id = $1
          AND external_id = ANY($2::text[])
          AND last_result IN ('success', 'unchanged')`,
      [targetProfileId, externalIds],
    );
    for (const row of rows) out.set(graphResolutionKey(targetProfileId, row.external_id), { slug: row.slug, sourceId: row.approved_source_id });
    if (rows.length !== externalIds.length) {
      throw new Error(`external_id graph target resolution incomplete for rule ${rule.id}: resolved ${rows.length} of ${externalIds.length}`);
    }
  }
  return out;
}

/** Deterministic graph projection for one source record. Array-valued fields
 * intentionally fan out so one person can hold multiple simultaneous
 * company/department/position assignments. */
export function buildSourceGraphLinks(
  profile: SourceIngestProfile,
  data: Record<string, unknown>,
  fromSlug: string,
  sourceId: string,
  resolutions?: GraphTargetResolutionMap,
): LinkBatchInput[] {
  const links: LinkBatchInput[] = [];
  const seen = new Set<string>();
  for (const rule of profile.links || []) {
    if ((rule.when || []).some(filter => !filterMatches(filter, data))) continue;
    for (const target of graphTargets(rule, data, sourceId, resolutions)) {
      const key = `${rule.type}\u0000${target.sourceId}\u0000${target.slug}\u0000${rule.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        from_slug: fromSlug,
        to_slug: target.slug,
        link_type: rule.type,
        context: `source-ingest rule ${rule.id}`,
        link_source: 'source-ingest',
        origin_slug: fromSlug,
        origin_field: rule.id,
        from_source_id: sourceId,
        to_source_id: target.sourceId,
        origin_source_id: sourceId,
      });
    }
  }
  return links;
}

function hashText(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function managedBody(profile: SourceIngestProfile, record: SourceRecord): string {
  const title = String(valueAt(record.data, profile.identity.display_name_field) ?? record.external_id);
  const lines = [`## Source data`, ``, `- Name: ${title}`];
  if (profile.update_policy.include_external_id_in_content !== false) lines.push(`- External ID: ${record.external_id}`);
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

const SOURCE_ARTICLE_BEGIN = '<!-- gbrain-source-article:start';
const SOURCE_ARTICLE_END = '<!-- gbrain-source-article:end -->';

function escapeManagedRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function articleBlockRe(profileId: string, externalRef?: string): RegExp {
  const ref = externalRef === undefined ? '[^\"]*' : escapeManagedRe(externalRef);
  return new RegExp(`<!-- gbrain-source-article:start\\s+profile="${escapeManagedRe(profileId)}"\\s+external_ref="${ref}"\\s+-->[\\s\\S]*?<!-- gbrain-source-article:end -->`, 'm');
}

function renderArticleManagedBlock(profileId: string, externalRef: string, body: string): string {
  return `${SOURCE_ARTICLE_BEGIN} profile="${profileId}" external_ref="${externalRef}" -->\n${body.trim()}\n${SOURCE_ARTICLE_END}`;
}

function mergeGeneratedArticle(
  existingContent: string,
  profileId: string,
  externalRef: string,
  articleBody: string,
  sourceBody: string,
): string {
  const articleBlock = renderArticleManagedBlock(profileId, externalRef, articleBody);
  const sourceMerged = mergeManagedBlock(existingContent, profileId, externalRef, sourceBody).content;
  const match = sourceMerged.match(articleBlockRe(profileId, externalRef))
    ?? sourceMerged.match(articleBlockRe(profileId));
  if (match) return sourceMerged.replace(match[0], articleBlock);

  // One-time migration for a page already owned by this source identity. The legacy
  // generated article occupied everything before the source-data block.
  const sourceStart = sourceMerged.indexOf(SOURCE_SYNC_BEGIN);
  if (sourceStart < 0) return `${articleBlock}\n\n${sourceMerged.trimStart()}`;
  return `${articleBlock}\n\n${sourceMerged.slice(sourceStart).trimStart()}`;
}

function mergeAdoptedGeneratedArticle(
  existingContent: string,
  profileId: string,
  externalRef: string,
  articleBody: string,
  sourceBody: string,
): string {
  const articleBlock = renderArticleManagedBlock(profileId, externalRef, articleBody);
  const sourceMerged = mergeManagedBlock(existingContent, profileId, externalRef, sourceBody).content;
  const match = sourceMerged.match(articleBlockRe(profileId, externalRef))
    ?? sourceMerged.match(articleBlockRe(profileId));
  if (match) return sourceMerged.replace(match[0], articleBlock);
  const sourceStart = sourceMerged.indexOf(SOURCE_SYNC_BEGIN);
  if (sourceStart < 0) return `${sourceMerged.trimEnd()}\n\n${articleBlock}\n`;
  return `${sourceMerged.slice(0, sourceStart).trimEnd()}\n\n${articleBlock}\n\n${sourceMerged.slice(sourceStart).trimStart()}`;
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function renderMarkdown(
  profile: SourceIngestProfile,
  record: SourceRecord,
  existingBody: string | null,
  existingTimeline: string | null,
  existingFrontmatter: Record<string, unknown> | null,
  targetSlug?: string,
  explicitAdoption = false,
) {
  const slug = targetSlug || renderSlugTemplate(profile.target.slug_template, record.data);
  const externalRef = profile.update_policy.include_external_id_in_content === false
    ? 'hidden'
    : `${profile.source_connector}:${profile.source_object}:${record.external_id}`;
  const article = renderArticleTemplate(profile, record);
  const generatedBlock = renderManagedBlock(profile.profile_id, externalRef, managedBody(profile, record));
  const manageGeneratedArticle = profile.update_policy.manage_generated_article === true
    && (!explicitAdoption || profile.update_policy.manage_adopted_article === true);
  const articleBody = manageGeneratedArticle
    ? renderArticleManagedBlock(profile.profile_id, externalRef, article.body)
    : article.body.trimEnd();
  const articleBodyWithBlock = `${articleBody}\n\n${generatedBlock}\n`;
  const mergedCore = existingBody
    ? manageGeneratedArticle
      ? explicitAdoption
        ? mergeAdoptedGeneratedArticle(existingBody, profile.profile_id, externalRef, article.body, managedBody(profile, record))
        : mergeGeneratedArticle(existingBody, profile.profile_id, externalRef, article.body, managedBody(profile, record))
      : mergeManagedBlock(existingBody, profile.profile_id, externalRef, managedBody(profile, record)).content
    : articleBodyWithBlock;
  // Engine parsing separates timeline content from compiled_truth. Reattach it after the
  // managed block so adoption never drops curated timeline entries or places source data
  // inside the timeline parser's section.
  const mergedBody = existingTimeline?.trim()
    ? `${mergedCore.trimEnd()}\n\n<!-- timeline -->\n\n${existingTimeline.trim()}\n`
    : mergedCore;
  const preservedFrontmatter = { ...(existingFrontmatter || {}) };
  delete preservedFrontmatter.source_ingest;
  const managedArticleFrontmatter = explicitAdoption
    ? Object.fromEntries(
        (profile.update_policy.frontmatter_allowlist || [])
          .filter(key => Object.prototype.hasOwnProperty.call(article.frontmatter, key))
          .map(key => [key, article.frontmatter[key]]),
      )
    : article.frontmatter;
  const frontmatter: Record<string, unknown> = {
    ...preservedFrontmatter,
    ...managedArticleFrontmatter,
    type: explicitAdoption && typeof preservedFrontmatter.type === 'string' ? preservedFrontmatter.type : profile.target.gbrain_type,
    title: explicitAdoption && typeof preservedFrontmatter.title === 'string' ? preservedFrontmatter.title : article.title,
    source_id: profile.target.approved_source_id,
  };
  const fm = [
    '---',
    ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${yamlScalar(v)}`),
    'source_ingest:',
    `  profile_id: ${yamlScalar(profile.profile_id)}`,
    `  external_ref: ${yamlScalar(externalRef)}`,
    '---',
    '',
  ].join('\n');
  return { slug, externalRef, title: article.title, generatedBlock, managedBlockHash: hashText(generatedBlock), markdown: fm + mergedBody };
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
  sourceSnapshot: Record<string, unknown> | null;
  result: string;
  error?: string | null;
}) {
  const staleAfter = nextStaleAfter(args.profile.freshness?.policy ?? null);
  await engine.executeRaw(
    `INSERT INTO source_sync_state
       (connector_id, source_object, external_id, slug, approved_source_id, profile_id, profile_version,
        content_fingerprint, managed_block_hash, last_source_hash, last_source_snapshot, source_updated_at, last_synced_at, stale_after, freshness_policy, run_id, last_result, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,now(),$12,$13,$14,$15,$16,now())
     ON CONFLICT (profile_id, connector_id, source_object, external_id) DO UPDATE SET
       slug = EXCLUDED.slug,
       approved_source_id = EXCLUDED.approved_source_id,
       profile_id = EXCLUDED.profile_id,
       profile_version = EXCLUDED.profile_version,
       content_fingerprint = EXCLUDED.content_fingerprint,
       managed_block_hash = EXCLUDED.managed_block_hash,
       last_source_hash = EXCLUDED.last_source_hash,
       last_source_snapshot = COALESCE(EXCLUDED.last_source_snapshot, source_sync_state.last_source_snapshot),
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
      args.sourceSnapshot,
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
    const root = localPath.replace(/\/$/, '');
    const abs = `${root}/${relPath}`;
    if (existsSync(abs) && (!tracked || lstatSync(abs).isDirectory())) rmSync(abs, { recursive: true, force: true });
    const slash = relPath.lastIndexOf('/');
    const relDir = slash >= 0 ? relPath.slice(0, slash) : '';
    const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
    const absDir = relDir ? `${root}/${relDir}` : root;
    if (existsSync(absDir)) {
      for (const entry of readdirSync(absDir)) {
        if (entry.startsWith(`${base}.tmp.`)) rmSync(`${absDir}/${entry}`, { recursive: true, force: true });
      }
    }
  }
}

async function commitGitBackedRun(localPath: string, filePaths: string[], runId: string, profileId: string) {
  const unique = [...new Set(filePaths)].filter(Boolean);
  if (unique.length === 0) return { committed: false, reason: 'no_files' };
  execFileSync('git', ['-C', localPath, 'add', '--', ...unique], { encoding: 'utf8' });
  const status = execFileSync('git', ['-C', localPath, 'status', '--porcelain', '--', ...unique], { encoding: 'utf8' });
  if (!status.trim()) return { committed: false, reason: 'no_changes' };
  execFileSync('git', ['-C', localPath, 'commit', '-m', `source-ingest run_id=${runId} profile=${profileId}`], { encoding: 'utf8' });
  const sha = execFileSync('git', ['-C', localPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  return { committed: true, sha };
}

export async function runSourceIngestExecutor(
  engine: BrainEngine,
  opts: SourceIngestExecutorOptions,
  logger: { warn(msg: string): void } = console,
): Promise<SourceIngestExecutorResult> {
  const { profile, version, hash } = await loadProfile(engine, opts.profile_id);
  await assertAllowedSourceConnectors(engine, profile);
  const sourceId = profile.target.approved_source_id;
  if (!sourceId) throw new Error('profile target approved_source_id is required');
  let storage = await resolveSourceIngestStorageMode(engine, sourceId, {
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
      storage = await resolveSourceIngestStorageMode(engine, sourceId, {
        requireCleanGit: opts.require_clean_git ?? true,
        allowDbOnly: opts.allow_db_only ?? false,
      });
      if (storage.mode === 'blocked') {
        return { ok: false, run_id: opts.run_id ?? `source-ingest-${new Date().toISOString()}`, profile_id: profile.profile_id, source_id: sourceId, storage, counts: { sampled: 0, written: 0, unchanged: 0, skipped: 0, failed: 0 }, results: [], graph_writes: 'deferred', checkpoint: { op: 'source_ingest', fingerprint: '', loaded: 0, cleared: false } };
      }
      if (storage.mode !== 'git-backed') throw new Error('Stage 3A executor requires git-backed source');

  const runId = opts.run_id ?? `source-ingest-${new Date().toISOString().replace(/[:.]/g, '')}`;
  const configId = `${profile.source_connector}:${profile.source_object}`;
  const [savedConfig] = await listSourceConnectorConfigs(engine, configId);
  const secretConfig = await getSourceConnectorSecretConfig(engine, profile.source_connector, profile.source_object);
  const connectorConfig = { ...(savedConfig?.config_json || {}), ...secretConfig };
  const connector = getSourceConnector(profile.source_connector, connectorConfig);
  if (!connector) throw new Error(`connector not found: ${profile.source_connector}`);
  const records: SourceRecord[] = [];
  const transformedRecords = await buildProfileAllRecords(profile, {
    engine,
    connectorConfigOverride: connectorConfig,
    defaultConnector: profile.source_connector,
    defaultObject: profile.source_object,
  });
  if (transformedRecords) records.push(...transformedRecords);
  const seenExternalIds = new Set(records.map(r => r.external_id));
  let iterable: AsyncIterable<{ records: SourceRecord[]; cursor?: string | null }> | undefined;
  let forceFullScanForFailedRetry = false;
  const configuredFetchFields = Array.isArray(profile.mapping?.source_fields) ? profile.mapping.source_fields : profile.update_policy.field_allowlist;
  const fetchFields = Array.from(new Set([
    ...(configuredFetchFields || []),
    profile.identity.external_id_field,
    profile.identity.display_name_field,
    ...changeIntelligenceFetchFields(profile),
  ].filter(Boolean)));
  const fetchOpts = fetchFields.length ? { fields: fetchFields } : {};
  if (!transformedRecords && opts.changed_since) {
    const failedRows = await engine.executeRaw<{ external_id: string }>(
      `SELECT external_id
         FROM source_sync_state
        WHERE profile_id = $1 AND connector_id = $2 AND source_object = $3 AND last_result = 'failed'
        ORDER BY updated_at ASC, external_id ASC`,
      [profile.profile_id, profile.source_connector, profile.source_object],
    );
    if (failedRows.length > 0) {
      if (connector.fetchById) {
        for (const row of failedRows) {
          const failedRecord = await connector.fetchById(profile.source_object, row.external_id, fetchOpts);
          if (failedRecord && !seenExternalIds.has(failedRecord.external_id)) {
            records.push(failedRecord);
            seenExternalIds.add(failedRecord.external_id);
          }
        }
      } else {
        // Without point lookup support, a changed-since cursor can skip older
        // failed rows forever. Fall back to a full scan so failed records get
        // another attempt rather than becoming invisible.
        forceFullScanForFailedRetry = true;
      }
    }
  }
  if (!transformedRecords && opts.changed_since && connector.fetchChangedSince && !forceFullScanForFailedRetry) {
    const sinceRows = await engine.executeRaw<{ since: string | null }>(
      `SELECT max(source_updated_at)::text AS since
         FROM source_sync_state
        WHERE profile_id = $1 AND connector_id = $2 AND source_object = $3 AND last_result <> 'failed'`,
      [profile.profile_id, profile.source_connector, profile.source_object],
    );
    const since = sinceRows[0]?.since;
    if (since) iterable = connector.fetchChangedSince(profile.source_object, since, fetchOpts);
  }
  if (!transformedRecords && !iterable) {
    if (!connector.fetchAll) throw new Error(`connector does not support fetchAll: ${profile.source_connector}`);
    iterable = connector.fetchAll(profile.source_object, fetchOpts);
  }
  if (iterable) {
    for await (const batch of iterable) {
      for (const r of batch.records) {
        if (seenExternalIds.has(r.external_id)) continue;
        records.push(r);
        seenExternalIds.add(r.external_id);
      }
      if (opts.limit && records.length >= opts.limit) break;
    }
  }
  const limited = opts.limit ? records.slice(0, opts.limit) : records;
  const graphTargetResolutions = await prefetchGraphTargetResolutions(engine, profile, limited);
  const resolvedTargets = new Map<string, { identitySlug?: string; adoptionSlug?: string; explicitCreate: boolean; targetSlug: string }>();
  const claimedTargets = new Map<string, string>();
  for (const record of limited) {
    if (!includeRecord(profile, record).include) continue;
    const priorIdentityRows = await engine.executeRaw<{ slug: string }>(
      `SELECT s.slug
         FROM source_sync_state s
         JOIN pages p ON p.slug = s.slug AND p.source_id = $4 AND p.deleted_at IS NULL
        WHERE s.profile_id = $1 AND s.connector_id = $2 AND s.source_object = $3 AND s.external_id = $5
          AND s.last_result <> 'failed'
        LIMIT 1`,
      [profile.profile_id, profile.source_connector, profile.source_object, sourceId, record.external_id],
    );
    const identitySlug = priorIdentityRows[0]?.slug;
    const adoptionSlug = profile.identity.existing_slug_map?.[record.external_id];
    const explicitCreate = profile.identity.explicit_create_ids?.includes(record.external_id) === true;
    const targetSlug = identitySlug || adoptionSlug || renderSlugTemplate(profile.target.slug_template, record.data);
    if (profile.identity.require_explicit_resolution && !identitySlug && !adoptionSlug && !explicitCreate) {
      throw new Error(`explicit identity resolution required before source ingest for ${record.external_id}`);
    }
    if (profile.identity.require_explicit_resolution) {
      const existing = await engine.getPage(targetSlug, { sourceId });
      const deleted = explicitCreate && !existing
        ? await engine.getPage(targetSlug, { sourceId, includeDeleted: true })
        : null;
      if (explicitCreate && existing && !identitySlug) {
        throw new Error(`explicit create target already exists and requires adoption: ${record.external_id} -> ${targetSlug}`);
      }
      if (deleted?.deleted_at) {
        const deletedOwner = deleted.frontmatter?.source_ingest as Record<string, unknown> | undefined;
        const expectedExternalRef = `${profile.source_connector}:${profile.source_object}:${record.external_id}`;
        if (deletedOwner?.external_ref !== expectedExternalRef) {
          throw new Error(`explicit create target is occupied by an unrelated soft-deleted page: ${record.external_id} -> ${targetSlug}`);
        }
      }
      if (!explicitCreate && !existing) throw new Error(`required existing binding target not found for ${record.external_id}: ${targetSlug}`);
      if (existing?.type && existing.type !== profile.target.gbrain_type) {
        throw new Error(`existing page type is incompatible with binding: ${targetSlug} (${existing.type} != ${profile.target.gbrain_type})`);
      }
    }
    const priorClaim = claimedTargets.get(targetSlug);
    if (priorClaim && priorClaim !== record.external_id) {
      throw new Error(`multiple source records resolve to the same target slug: ${priorClaim}, ${record.external_id} -> ${targetSlug}`);
    }
    claimedTargets.set(targetSlug, record.external_id);
    resolvedTargets.set(record.external_id, { identitySlug, adoptionSlug, explicitCreate, targetSlug });
  }
  const key: OpCheckpointKey = {
    op: 'source_ingest',
    fingerprint: fingerprint({ profile_id: profile.profile_id, profile_hash: hash, source_id: sourceId, connector: profile.source_connector, object: profile.source_object, mode: 'stage3a' }),
  };
  const completed = new Set(await loadOpCheckpoint(engine, key));
  const results: SourceIngestRecordResult[] = [];
  const writtenPaths: string[] = [];
  let graphLinksCreated = 0;
  let graphLinksRemoved = 0;
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
    const templateSlug = renderSlugTemplate(profile.target.slug_template, record.data);
    let renderedSlug = templateSlug;
    let renderedPath = `${renderedSlug}.md`;
    let createdThisRecord = false;
    let pageDurable = false;
    try {
      const resolvedTarget = resolvedTargets.get(record.external_id);
      const identitySlug = resolvedTarget?.identitySlug;
      const adoptionSlug = resolvedTarget?.adoptionSlug;
      const targetSlug = resolvedTarget?.targetSlug || templateSlug;
      let existing = await engine.getPage(targetSlug, { sourceId });
      if (!existing && resolvedTarget?.explicitCreate) {
        const deleted = await engine.getPage(targetSlug, { sourceId, includeDeleted: true });
        if (deleted?.deleted_at) {
          const restored = await engine.restorePage(targetSlug, { sourceId });
          if (!restored) throw new Error(`failed to restore explicit create target after rollback: ${targetSlug}`);
          existing = await engine.getPage(targetSlug, { sourceId });
        }
      }
      if (adoptionSlug && !identitySlug && !existing) {
        throw new Error(`explicit adoption target not found for ${record.external_id}: ${adoptionSlug}`);
      }
      if (existing && !identitySlug && !adoptionSlug && !resolvedTarget?.explicitCreate) {
        throw new Error(`existing page requires explicit adoption mapping for ${record.external_id}: ${targetSlug}`);
      }
      if (existing && adoptionSlug && !identitySlug) {
        if (existing.type && existing.type !== profile.target.gbrain_type) {
          throw new Error(`existing page type is incompatible with adoption: ${targetSlug} (${existing.type} != ${profile.target.gbrain_type})`);
        }
        const expectedExternalRef = `${profile.source_connector}:${profile.source_object}:${record.external_id}`;
        const currentOwner = existing.frontmatter && typeof existing.frontmatter.source_ingest === 'object'
          ? existing.frontmatter.source_ingest as Record<string, unknown>
          : null;
        if (currentOwner?.external_ref && currentOwner.external_ref !== expectedExternalRef) {
          throw new Error(`existing page is owned by another source identity: ${targetSlug}`);
        }
      }
      createdThisRecord = !existing;
      const priorVersions = existing ? await engine.getVersions(targetSlug, { sourceId }) : [];
      const priorVersionId = priorVersions[0]?.id ?? null;
      const rawAdoptionPage = existing && adoptionSlug
        ? readGitBackedAdoptionPage(storage.local_path, targetSlug)
        : null;
      const existingContent = rawAdoptionPage?.compiled_truth ?? existing?.compiled_truth ?? null;
      const existingTimeline = rawAdoptionPage?.timeline ?? existing?.timeline ?? null;
      const existingFrontmatter = rawAdoptionPage?.frontmatter
        ?? (existing ? { type: existing.type, title: existing.title, ...(existing.frontmatter as Record<string, unknown>) } : null);
      const rendered = renderMarkdown(
        profile,
        record,
        existingContent,
        existingTimeline,
        existingFrontmatter,
        targetSlug,
        Boolean(adoptionSlug),
      );
      renderedSlug = rendered.slug;
      renderedPath = `${rendered.slug}.md`;
      const existingBlock = existingContent ? existingManagedBlock(existingContent) : null;
      const warnings: string[] = [];
      const oldState = await engine.executeRaw<{ managed_block_hash: string | null; content_fingerprint: string | null; last_source_snapshot: unknown }>(
        `SELECT managed_block_hash, content_fingerprint, last_source_snapshot
           FROM source_sync_state
          WHERE profile_id = $1 AND connector_id = $2 AND source_object = $3 AND external_id = $4`,
        [profile.profile_id, profile.source_connector, profile.source_object, record.external_id],
      );
      const priorManagedHash = oldState[0]?.managed_block_hash ?? oldState[0]?.content_fingerprint;
      if (existingBlock && priorManagedHash && hashText(existingBlock) !== priorManagedHash) {
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
        ...(adoptionSlug ? {} : { frontmatterOverrides: { ingested_via: 'source_ingest', source_kind: 'source_ingest' } }),
        logger,
      });
      if (!writeThrough.written) throw new Error(`write-through failed: ${writeThrough.skipped || writeThrough.error || 'unknown'}`);
      const after = await engine.getPage(rendered.slug, { sourceId });
      let status: 'unchanged' | 'written' = beforeHash && after?.content_hash === beforeHash ? 'unchanged' : 'written';
      const rawPreviousSnapshot = oldState[0]?.last_source_snapshot;
      let previousSnapshot: Record<string, unknown> | null = null;
      if (rawPreviousSnapshot && typeof rawPreviousSnapshot === 'object' && !Array.isArray(rawPreviousSnapshot)) {
        previousSnapshot = rawPreviousSnapshot as Record<string, unknown>;
      } else if (typeof rawPreviousSnapshot === 'string') {
        try {
          const parsed = JSON.parse(rawPreviousSnapshot) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previousSnapshot = parsed as Record<string, unknown>;
          else warnings.push('change_intelligence_snapshot_invalid');
        } catch {
          warnings.push('change_intelligence_snapshot_invalid');
        }
      }
      const timelineEntries = buildSourceTimelineEntries({
        profile,
        record,
        slug: rendered.slug,
        sourceId,
        previousSnapshot,
      });
      const writePathDirty = writeThrough.path
        ? Boolean(execFileSync('git', ['-C', storage.local_path, 'status', '--porcelain', '--', writeThrough.path], { encoding: 'utf8' }).trim())
        : false;
      if (writeThrough.path) status = writePathDirty ? 'written' : 'unchanged';
      if (writeThrough.path && writePathDirty) writtenPaths.push(writeThrough.path);
      if (writePathDirty && writeThrough.path) {
        lastRecordCommit = await commitGitBackedRun(storage.local_path, [writeThrough.path], runId, profile.profile_id);
      }
      pageDurable = true;
      const currentGraphLinks = buildSourceGraphLinks(profile, record.data, rendered.slug, sourceId, graphTargetResolutions);
      // Physical source-ingest edges are add-only until profile-scoped ownership
      // reconciliation is available. Deleting by from/to/type/source alone can
      // remove an edge still owned by another Article View.
      const graphCreatedForRecord = await engine.addLinksBatch(currentGraphLinks, { auditSite: 'source-ingest.change-intelligence' });
      const graphRemovedForRecord = 0;
      graphLinksCreated += graphCreatedForRecord;
      graphLinksRemoved += graphRemovedForRecord;
      const timelineCreated = await engine.addTimelineEntriesBatch(timelineEntries, { auditSite: 'source-ingest.change-intelligence' });
      await writeSyncState(engine, {
        profile,
        profileVersion: version,
        record,
        slug: rendered.slug,
        runId,
        managedBlockHash: rendered.managedBlockHash,
        sourceHash: hashText(stableJson(record.data)),
        sourceSnapshot: sourceSnapshot(profile, record),
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
      await appendCompleted(engine, key, [checkpointKey]);
      completed.add(checkpointKey);
      results.push({ external_id: record.external_id, slug: rendered.slug, status, warnings, content_hash: after?.content_hash ?? null, write_through: writeThrough, timeline_created: timelineCreated, graph_links_created: graphCreatedForRecord, graph_links_removed: graphRemovedForRecord });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!pageDurable && createdThisRecord) {
        try { await engine.deletePage(renderedSlug, { sourceId }); } catch {}
      }
      if (!pageDurable && storage.mode === 'git-backed') cleanupUncommittedPath(storage.local_path, renderedPath);
      results.push({ external_id: record.external_id, slug: renderedSlug, status: 'failed', reason: msg });
      await writeSyncState(engine, { profile, profileVersion: version, record, slug: renderedSlug, runId, managedBlockHash: '', sourceHash: hashText(stableJson(record.data)), sourceSnapshot: null, result: 'failed', error: msg });
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
    graph_writes: { created: graphLinksCreated, removed: graphLinksRemoved },
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
