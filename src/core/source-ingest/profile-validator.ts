import type { BrainEngine } from '../engine.ts';
import { validateSourceIngestProfile, type SourceIngestProfile, type ValidationIssue } from './profile-schema.ts';

export interface SourceIngestValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  profile?: SourceIngestProfile;
}

export async function validateSourceIngestProfileAgainstBrain(
  engine: BrainEngine,
  raw: unknown,
): Promise<SourceIngestValidationResult> {
  const base = validateSourceIngestProfile(raw);
  const issues = [...base.issues];
  const profile = base.profile;
  if (profile?.target?.approved_source_id) {
    const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1', [profile.target.approved_source_id]);
    if (rows.length === 0) {
      issues.push({
        path: 'target.approved_source_id',
        code: 'source_not_found',
        message: `Source '${profile.target.approved_source_id}' does not exist.`,
        severity: 'error',
      });
    }
  }
  return { ok: issues.every(i => i.severity !== 'error'), issues, profile };
}
