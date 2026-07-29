import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveSourceIngestStorageMode } from '../src/core/source-ingest/executor-preflight.ts';

const tempDirs: string[] = [];

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'source-ingest-preflight-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function engineWithSource(row: { id: string; local_path: string | null; config?: unknown } | null): BrainEngine {
  return {
    executeRaw: async () => row ? [{ id: row.id, local_path: row.local_path, config: row.config ?? {} }] : [],
  } as unknown as BrainEngine;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('source-ingest executor preflight', () => {
  test('allows clean git-backed source', async () => {
    const repo = tempGitRepo();
    const out = await resolveSourceIngestStorageMode(engineWithSource({ id: 'shared', local_path: repo }), 'shared');
    expect(out.mode).toBe('git-backed');
    if (out.mode === 'git-backed') {
      expect(out.local_path).toBe(repo);
      expect(out.git_clean).toBe(true);
    }
  });

  test('blocks dirty git-backed source by default', async () => {
    const repo = tempGitRepo();
    writeFileSync(join(repo, 'dirty.md'), 'dirty\n');
    const out = await resolveSourceIngestStorageMode(engineWithSource({ id: 'shared', local_path: repo }), 'shared');
    expect(out.mode).toBe('blocked');
    if (out.mode === 'blocked') {
      expect(out.reason).toBe('dirty_git_tree');
      expect(out.git_clean).toBe(false);
      expect(out.dirty_paths?.join('\n')).toContain('dirty.md');
    }
  });

  test('allows dirty git-backed source when explicitly requested but reports dirty paths', async () => {
    const repo = tempGitRepo();
    writeFileSync(join(repo, 'dirty.md'), 'dirty\n');
    const out = await resolveSourceIngestStorageMode(engineWithSource({ id: 'shared', local_path: repo }), 'shared', { requireCleanGit: false });
    expect(out.mode).toBe('git-backed');
    if (out.mode === 'git-backed') {
      expect(out.git_clean).toBe(false);
      expect(out.dirty_paths?.join('\n')).toContain('dirty.md');
    }
  });

  test('blocks DB-only source unless explicitly allowed by config or opts', async () => {
    const blocked = await resolveSourceIngestStorageMode(engineWithSource({ id: 'default', local_path: null, config: {} }), 'default');
    expect(blocked.mode).toBe('blocked');
    if (blocked.mode === 'blocked') expect(blocked.reason).toBe('db_only_not_explicitly_allowed');

    const viaConfig = await resolveSourceIngestStorageMode(engineWithSource({ id: 'default', local_path: null, config: { source_ingest: { db_only: true } } }), 'default');
    expect(viaConfig.mode).toBe('db-only');

    const viaOpts = await resolveSourceIngestStorageMode(engineWithSource({ id: 'default', local_path: null, config: {} }), 'default', { allowDbOnly: true });
    expect(viaOpts.mode).toBe('db-only');
  });

  test('blocks missing source', async () => {
    const out = await resolveSourceIngestStorageMode(engineWithSource(null), 'missing');
    expect(out.mode).toBe('blocked');
    if (out.mode === 'blocked') expect(out.reason).toBe('source_not_found');
  });
});
