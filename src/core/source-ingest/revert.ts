import { execFileSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import { writePageThrough } from '../write-through.ts';

export interface SourceRevertReportRow {
  connector_id: string;
  source_object: string;
  external_id: string;
  slug: string;
  approved_source_id: string;
  profile_id: string;
  profile_version: number;
  last_result: string | null;
  last_error: string | null;
  last_synced_at: string | null;
  action: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';
  prior_version_id: number | null;
}

export type SourceRevertAction = 'would-review' | 'would-soft-delete' | 'would-revert-version' | 'noop' | 'blocked' | 'soft-deleted' | 'reverted-version';

export interface SourceRevertPageResult {
  slug: string;
  source_id: string;
  external_id: string;
  profile_id: string;
  last_result: string | null;
  revert_action: SourceRevertAction;
  version_id?: number;
  reason?: string;
  warnings?: string[];
}

export interface SourceRevertReport {
  mode: 'report-only' | 'apply';
  run_id: string;
  counts: { affected: number; success_or_unchanged: number; failed: number; reverted?: number; blocked?: number; noop?: number };
  pages: SourceRevertPageResult[];
  warnings: string[];
  git_commit?: { committed: boolean; sha?: string; reason?: string };
}

export interface SourceRevertOptions {
  apply?: boolean;
  force?: boolean;
  no_embed?: boolean;
}

function yamlScalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v ?? '');
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function markdownFromVersion(frontmatter: Record<string, unknown>, body: string): string {
  const fm = ['---', ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${yamlScalar(v)}`), '---', ''].join('\n');
  return `${fm}\n${body}`;
}

function gitStatusForPaths(localPath: string, paths: string[]): string {
  if (paths.length === 0) return '';
  return execFileSync('git', ['-C', localPath, 'status', '--porcelain', '--', ...paths], { encoding: 'utf8' });
}

function commitRevert(localPath: string, paths: string[], runId: string) {
  const unique = [...new Set(paths)].filter(Boolean);
  if (unique.length === 0) return { committed: false, reason: 'no_files' };
  execFileSync('git', ['-C', localPath, 'add', '--', ...unique], { encoding: 'utf8' });
  const status = gitStatusForPaths(localPath, unique);
  if (!status.trim()) return { committed: false, reason: 'no_changes' };
  execFileSync('git', ['-C', localPath, 'commit', '-m', `source-ingest revert run_id=${runId}`, '--', ...unique], { encoding: 'utf8' });
  const sha = execFileSync('git', ['-C', localPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  return { committed: true, sha };
}

async function loadRows(engine: BrainEngine, runId: string): Promise<SourceRevertReportRow[]> {
  return await engine.executeRaw<SourceRevertReportRow>(
    `SELECT connector_id, source_object, external_id, slug, approved_source_id, profile_id, profile_version,
            last_result, last_error, created_at::text AS last_synced_at, action, prior_version_id
       FROM source_ingest_run_items
      WHERE run_id = $1
      ORDER BY slug, external_id`,
    [runId],
  );
}

async function localPathForSource(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ local_path: string | null }>(`SELECT local_path FROM sources WHERE id = $1`, [sourceId]);
  return rows[0]?.local_path ?? null;
}

function wasEditedAfterRun(page: { updated_at: Date | string }, lastSyncedAt: string | Date | null): boolean {
  if (!lastSyncedAt) return false;
  // last_synced_at is stamped after the page write. A later manual edit will be after it.
  return new Date(page.updated_at).getTime() > new Date(lastSyncedAt).getTime() + 1000;
}

export async function buildSourceRevertReport(engine: BrainEngine, runId: string, opts: SourceRevertOptions = {}): Promise<SourceRevertReport> {
  const rows = await loadRows(engine, runId);
  const apply = opts.apply === true;
  const pages: SourceRevertPageResult[] = [];
  const touchedPaths: string[] = [];
  const warnings = apply ? ['apply_stage3e_guarded'] : ['report_only_stage3b_no_mutation'];
  let commonLocalPath: string | null = null;

  for (const r of rows) {
    const externalRef = `${r.connector_id}:${r.source_object}:${r.external_id}`;
    const page = await engine.getPage(r.slug, { sourceId: r.approved_source_id });
    const versions = page ? await engine.getVersions(r.slug, { sourceId: r.approved_source_id }) : [];
    const priorVersion = r.prior_version_id ? versions.find(v => Number(v.id) === Number(r.prior_version_id)) : versions[0];
    const base: SourceRevertPageResult = {
      slug: r.slug,
      source_id: r.approved_source_id,
      external_id: externalRef,
      profile_id: r.profile_id,
      last_result: r.last_result,
      revert_action: 'would-review',
    };
    if (r.action === 'unchanged' || r.last_result === 'unchanged') {
      pages.push({ ...base, revert_action: apply ? 'noop' : 'noop', reason: 'run_did_not_change_page' });
      continue;
    }
    if (r.action === 'failed' || r.last_result === 'failed') {
      pages.push({ ...base, revert_action: apply ? 'blocked' : 'blocked', reason: 'failed_run_row_not_revertible' });
      continue;
    }
    if (!page) {
      pages.push({ ...base, revert_action: apply ? 'noop' : 'noop', reason: 'page_not_found' });
      continue;
    }
    if (!opts.force && wasEditedAfterRun(page, r.last_synced_at)) {
      pages.push({ ...base, revert_action: apply ? 'blocked' : 'blocked', reason: 'page_updated_after_run' });
      continue;
    }

    const localPath = await localPathForSource(engine, r.approved_source_id);
    if (localPath) commonLocalPath = commonLocalPath ?? localPath;
    const relPath = `${r.slug}.md`;
    const absPath = localPath ? join(localPath, relPath) : null;

    if (r.action === 'created') {
      if (!apply) {
        pages.push({ ...base, revert_action: 'would-soft-delete', reason: 'created_by_run_no_prior_version' });
        continue;
      }
      await engine.softDeletePage(r.slug, { sourceId: r.approved_source_id });
      if (absPath && existsSync(absPath)) {
        unlinkSync(absPath);
        touchedPaths.push(relPath);
      }
      pages.push({ ...base, revert_action: 'soft-deleted', reason: 'created_by_run_no_prior_version' });
      continue;
    }

    if (!priorVersion) {
      pages.push({ ...base, revert_action: apply ? 'blocked' : 'blocked', reason: 'prior_version_not_found' });
      continue;
    }
    if (!apply) {
      pages.push({ ...base, revert_action: 'would-revert-version', version_id: priorVersion.id });
      continue;
    }
    const md = markdownFromVersion(priorVersion.frontmatter, priorVersion.compiled_truth);
    const imported = await importFromContent(engine, r.slug, md, {
      sourceId: r.approved_source_id,
      sourcePath: relPath,
      noEmbed: opts.no_embed ?? true,
      source_kind: 'source_ingest_revert',
      source_uri: `source-ingest:revert:${runId}`,
      ingested_via: 'source_ingest_revert',
      remote: false,
    });
    if (imported.status === 'error') {
      pages.push({ ...base, revert_action: 'blocked', version_id: priorVersion.id, reason: imported.error ?? 'import_error' });
      continue;
    }
    const wt = await writePageThrough(engine, r.slug, { sourceId: r.approved_source_id });
    if (wt.error || wt.skipped) {
      pages.push({ ...base, revert_action: 'blocked', version_id: priorVersion.id, reason: wt.error ?? wt.skipped });
      continue;
    }
    if (wt.path) touchedPaths.push(relPath);
    pages.push({ ...base, revert_action: 'reverted-version', version_id: priorVersion.id });
  }

  let git_commit: SourceRevertReport['git_commit'];
  if (apply) {
    git_commit = commonLocalPath ? commitRevert(commonLocalPath, touchedPaths, runId) : { committed: false, reason: 'no_git_path' };
  }

  return {
    mode: apply ? 'apply' : 'report-only',
    run_id: runId,
    counts: {
      affected: rows.length,
      success_or_unchanged: rows.filter(r => r.last_result === 'success' || r.last_result === 'unchanged').length,
      failed: rows.filter(r => r.last_result === 'failed').length,
      reverted: pages.filter(p => p.revert_action === 'soft-deleted' || p.revert_action === 'reverted-version').length,
      blocked: pages.filter(p => p.revert_action === 'blocked').length,
      noop: pages.filter(p => p.revert_action === 'noop').length,
    },
    pages,
    warnings,
    ...(git_commit ? { git_commit } : {}),
  };
}
