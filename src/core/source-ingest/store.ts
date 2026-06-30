import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type { SourceIngestProfile } from './profile-schema.ts';

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

export function profileHash(profile: SourceIngestProfile): string {
  return createHash('sha256').update(stableJson(profile)).digest('hex');
}

export async function listSourceIngestProfiles(engine: BrainEngine, profileId?: string) {
  const params: unknown[] = [];
  const where = profileId ? 'WHERE profile_id = $1' : '';
  if (profileId) params.push(profileId);
  return engine.executeRaw(
    `SELECT profile_id, connector_id, source_object, status, approved_source_id, target_type,
            profile_hash, current_version, approved_by, approved_at::text, created_at::text, updated_at::text,
            profile_json
       FROM source_ingest_profiles
       ${where}
       ORDER BY updated_at DESC`,
    params,
  );
}

export async function putSourceIngestProfile(
  engine: BrainEngine,
  profile: SourceIngestProfile,
  opts: { createdBy?: string; changeNote?: string } = {},
) {
  const hash = profileHash(profile);
  const existing = await engine.executeRaw<{ current_version: number }>('SELECT current_version FROM source_ingest_profiles WHERE profile_id = $1', [profile.profile_id]);
  const nextVersion = existing.length > 0 ? Number(existing[0].current_version) + 1 : 1;
  await engine.executeRaw(
    `INSERT INTO source_ingest_profiles
       (profile_id, connector_id, source_object, status, approved_source_id, target_type, profile_json, profile_hash, current_version, approved_by, approved_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,now())
     ON CONFLICT (profile_id) DO UPDATE SET
       connector_id = EXCLUDED.connector_id,
       source_object = EXCLUDED.source_object,
       status = EXCLUDED.status,
       approved_source_id = EXCLUDED.approved_source_id,
       target_type = EXCLUDED.target_type,
       profile_json = EXCLUDED.profile_json,
       profile_hash = EXCLUDED.profile_hash,
       current_version = EXCLUDED.current_version,
       approved_by = EXCLUDED.approved_by,
       approved_at = EXCLUDED.approved_at,
       updated_at = now()`,
    [
      profile.profile_id,
      profile.source_connector,
      profile.source_object,
      profile.status,
      profile.target.approved_source_id ?? null,
      profile.target.gbrain_type,
      stableJson(profile),
      hash,
      nextVersion,
      profile.review?.approved_by ?? null,
      profile.review?.approved_at ?? null,
    ],
  );
  await engine.executeRaw(
    `INSERT INTO source_ingest_profile_versions
       (profile_id, version, profile_json, profile_hash, created_by, change_note)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6)
     ON CONFLICT (profile_id, version) DO NOTHING`,
    [profile.profile_id, nextVersion, stableJson(profile), hash, opts.createdBy ?? null, opts.changeNote ?? null],
  );
  return { profile_id: profile.profile_id, version: nextVersion, profile_hash: hash };
}
