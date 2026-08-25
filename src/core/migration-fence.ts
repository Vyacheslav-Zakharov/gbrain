import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MIGRATION_FENCE_BYPASS_TOKEN = 'avers-r1-approved-runner';
export const MIGRATION_FENCE_MARKER = join(homedir(), '.gbrain', 'MIGRATION_FENCE.json');

export interface MigrationFenceStatus {
  active: boolean;
  source: 'env' | 'file' | null;
  markerPath: string | null;
}

export function resolveMigrationFence(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): MigrationFenceStatus {
  if (env.GBRAIN_MIGRATION_FENCE === '1') return { active: true, source: 'env', markerPath: null };
  if (fileExists(MIGRATION_FENCE_MARKER)) return { active: true, source: 'file', markerPath: MIGRATION_FENCE_MARKER };
  return { active: false, source: null, markerPath: null };
}

export function assertSchemaMutationAllowed(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): void {
  const status = resolveMigrationFence(env, fileExists);
  if (!status.active) return;
  if (env.GBRAIN_MIGRATION_FENCE_BYPASS === MIGRATION_FENCE_BYPASS_TOKEN) return;
  throw new Error(`MIGRATION_FENCE_ACTIVE (${status.source}); ordinary initSchema/apply-migrations is disabled`);
}
