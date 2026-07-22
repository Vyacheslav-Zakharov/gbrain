import { createHash } from 'crypto';
import type { TimelineBatchInput } from '../engine.ts';
import type { SourceRecord } from './connectors/types.ts';
import type { SourceChangeIntelligencePolicy, SourceIngestProfile } from './profile-schema.ts';
import { stableJson } from './store.ts';

export interface SourceFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export function changeIntelligenceFetchFields(profile: SourceIngestProfile): string[] {
  const policy = profile.change_intelligence;
  if (!policy?.enabled) return [];
  const fields = [
    ...policy.current_state_fields,
    ...policy.timeline_fields,
    ...(policy.baseline_timeline_fields || []),
    ...(policy.effective_at_field ? [policy.effective_at_field] : []),
  ];
  return Array.from(new Set(fields.map(field => field.split('.')[0]!).filter(Boolean)));
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

function comparable(value: unknown): string {
  return stableJson(value === undefined ? null : value);
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return stableJson(value);
  return String(value).replace(/[\r\n]+/g, ' ').trim() || '—';
}

function cap(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function effectiveTimestamp(policy: SourceChangeIntelligencePolicy, record: SourceRecord): string | null {
  const raw = policy.effective_at_field ? valueAt(record.data, policy.effective_at_field) : record.source_updated_at;
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dateFromValue(value: unknown, fallback: string | null): string | null {
  if (value !== null && value !== undefined && value !== '') {
    const parsed = new Date(String(value));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return fallback;
}

function baselineSummary(field: string, value: unknown): string {
  if (field === 'hire_date') return 'Принят(а) на работу';
  if (field === 'fire_date') return 'Трудовые отношения завершены';
  return `Зафиксировано source-поле «${field}»: ${cap(displayValue(value))}`;
}

export function sourceSnapshot(profile: SourceIngestProfile, record: SourceRecord): Record<string, unknown> | null {
  const policy = profile.change_intelligence;
  if (!policy?.enabled) return null;
  // v1 intentionally supports only full_record. Keep a JSON-safe canonical copy so
  // the next run compares values rather than driver-specific objects/Date instances.
  return JSON.parse(stableJson(record.data)) as Record<string, unknown>;
}

export function diffTimelineFields(
  policy: SourceChangeIntelligencePolicy,
  previous: Record<string, unknown> | null,
  current: Record<string, unknown>,
): SourceFieldChange[] {
  if (!previous) return [];
  return policy.timeline_fields.flatMap(field => {
    const before = valueAt(previous, field);
    const after = valueAt(current, field);
    return comparable(before) === comparable(after) ? [] : [{ field, before, after }];
  });
}

export function buildSourceTimelineEntries(args: {
  profile: SourceIngestProfile;
  record: SourceRecord;
  slug: string;
  sourceId: string;
  previousSnapshot: Record<string, unknown> | null;
}): TimelineBatchInput[] {
  const policy = args.profile.change_intelligence;
  if (!policy?.enabled || policy.mode !== 'hybrid') return [];
  const current = sourceSnapshot(args.profile, args.record);
  if (!current) return [];
  const effectiveAt = effectiveTimestamp(policy, args.record);
  const date = effectiveAt?.slice(0, 10) ?? null;
  if (!args.previousSnapshot) {
    return (policy.baseline_timeline_fields || []).flatMap(field => {
      const value = valueAt(current, field);
      if (value === null || value === undefined || value === '') return [];
      const eventDate = dateFromValue(value, date);
      if (!eventDate) return [];
      const payload = stableJson({
        profile_id: args.profile.profile_id,
        external_id: args.record.external_id,
        field,
        baseline: value,
        effective_date: eventDate,
      });
      const eventId = createHash('sha256').update(payload).digest('hex').slice(0, 16);
      return [{
        slug: args.slug,
        source_id: args.sourceId,
        date: eventDate,
        source: `source-ingest:${args.profile.profile_id}:${eventId}`,
        summary: baselineSummary(field, value),
        detail: `Исходное событие из source-ingest; поле ${field}=${cap(displayValue(value))}.`,
      }];
    });
  }
  if (!date || !effectiveAt) return [];
  return diffTimelineFields(policy, args.previousSnapshot, current).map(change => {
    const before = cap(displayValue(change.before));
    const after = cap(displayValue(change.after));
    const payload = stableJson({
      profile_id: args.profile.profile_id,
      external_id: args.record.external_id,
      field: change.field,
      before: change.before ?? null,
      after: change.after ?? null,
      effective_date: date,
      effective_at: effectiveAt,
    });
    const eventId = createHash('sha256').update(payload).digest('hex').slice(0, 16);
    return {
      slug: args.slug,
      source_id: args.sourceId,
      date,
      source: `source-ingest:${args.profile.profile_id}:${eventId}`,
      summary: `Изменено поле «${change.field}»: ${before} → ${after}`,
      detail: `Детерминированное изменение source record ${args.record.external_id}.`,
    };
  });
}
