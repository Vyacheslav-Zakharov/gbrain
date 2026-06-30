import { existsSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import type { BrainEngine } from '../engine.ts';

export type SourceIngestStorageMode =
  | { mode: 'git-backed'; source_id: string; local_path: string; git_clean: true }
  | { mode: 'db-only'; source_id: string; explicitly_allowed: true }
  | { mode: 'blocked'; source_id: string; reason: string; local_path?: string; git_clean?: boolean; dirty_paths?: string[] };

export interface SourceIngestPreflightOptions {
  /** Fail closed for git-backed sources with uncommitted/untracked changes. Default true. */
  requireCleanGit?: boolean;
  /** Allow DB-only writes for sources without local_path only when explicitly enabled. Default false. */
  allowDbOnly?: boolean;
}

interface SourceRow {
  id: string;
  local_path: string | null;
  config: unknown;
}

function configAllowsDbOnly(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const cfg = config as Record<string, unknown>;
  const ingest = cfg.source_ingest;
  if (ingest && typeof ingest === 'object' && (ingest as Record<string, unknown>).db_only === true) return true;
  return cfg.source_ingest_db_only === true;
}

function gitStatus(localPath: string): { clean: boolean; dirty_paths: string[] } {
  const out = execFileSync('git', ['-C', localPath, 'status', '--porcelain'], { encoding: 'utf8' });
  const dirty_paths = out.split('\n').map(s => s.trim()).filter(Boolean);
  return { clean: dirty_paths.length === 0, dirty_paths };
}

export async function resolveSourceIngestStorageMode(
  engine: BrainEngine,
  sourceId: string,
  opts: SourceIngestPreflightOptions = {},
): Promise<SourceIngestStorageMode> {
  const rows = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path, config FROM sources WHERE id = $1`,
    [sourceId],
  );
  const source = rows[0];
  if (!source) return { mode: 'blocked', source_id: sourceId, reason: 'source_not_found' };

  if (source.local_path) {
    const localPath = source.local_path;
    if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
      return { mode: 'blocked', source_id: sourceId, reason: 'repo_not_found', local_path: localPath };
    }
    let status: { clean: boolean; dirty_paths: string[] };
    try {
      status = gitStatus(localPath);
    } catch (e) {
      return {
        mode: 'blocked',
        source_id: sourceId,
        reason: 'git_status_failed',
        local_path: localPath,
        git_clean: false,
        dirty_paths: [e instanceof Error ? e.message : String(e)],
      };
    }
    if ((opts.requireCleanGit ?? true) && !status.clean) {
      return {
        mode: 'blocked',
        source_id: sourceId,
        reason: 'dirty_git_tree',
        local_path: localPath,
        git_clean: false,
        dirty_paths: status.dirty_paths,
      };
    }
    return { mode: 'git-backed', source_id: sourceId, local_path: localPath, git_clean: true };
  }

  const explicitlyAllowed = opts.allowDbOnly === true || configAllowsDbOnly(source.config);
  if (explicitlyAllowed) return { mode: 'db-only', source_id: sourceId, explicitly_allowed: true };
  return { mode: 'blocked', source_id: sourceId, reason: 'db_only_not_explicitly_allowed' };
}
