import type { Link } from './types.ts';

export type CrossSourceEdgePolicy = 'locked-stub' | 'hidden';

export type CrossSourceEdgeDirection = 'out' | 'in';

export interface CrossSourceEdgePolicyConfig {
  /** Fail-closed default for sources without an explicit policy. */
  defaultPolicy?: CrossSourceEdgePolicy;
  /** Per-source visibility policy. Keys are source_id values. */
  bySource?: Record<string, CrossSourceEdgePolicy | undefined>;
}

export type RedactableLink = Omit<Link,
  'from_slug' | 'to_slug' | 'context' | 'link_source' | 'origin_slug' | 'origin_field'
> & {
  from_slug: string | null;
  to_slug: string | null;
  context: string | null;
  link_source?: string | null;
  origin_slug?: string | null;
  origin_field?: string | null;
  from_source_id?: string | null;
  to_source_id?: string | null;
  origin_source_id?: string | null;
  /** True only when the far endpoint was deliberately redacted. */
  locked?: true;
};

function isAccessible(sourceId: string | null | undefined, accessibleSources?: ReadonlySet<string>): boolean {
  // Legacy rows without source metadata are only safe to show when no remote
  // access set was provided (trusted/local path). Remote/federated readers pass
  // accessibleSources and should fail closed on missing source ids.
  if (!accessibleSources) return true;
  if (!sourceId) return false;
  return accessibleSources.has(sourceId);
}

export function policyForSource(
  sourceId: string | null | undefined,
  config: CrossSourceEdgePolicyConfig = {},
): CrossSourceEdgePolicy {
  if (sourceId && config.bySource?.[sourceId]) return config.bySource[sourceId]!;
  return config.defaultPolicy ?? 'hidden';
}

/**
 * Redact one link row at the engine boundary for remote/federated callers.
 *
 * Contract:
 * - trusted/local callers pass no accessibleSources -> full row, no redaction;
 * - endpoint policy controls whether a row with an inaccessible FAR endpoint is
 *   returned as a locked stub or dropped entirely;
 * - origin policy only controls provenance visibility. An inaccessible origin
 *   never hides an otherwise visible endpoint row; it only clears origin fields.
 */
export function redactLink(
  row: RedactableLink,
  accessibleSources?: Iterable<string>,
  config: CrossSourceEdgePolicyConfig = {},
  direction: CrossSourceEdgeDirection = 'out',
): RedactableLink | null {
  const accessible = accessibleSources ? new Set(accessibleSources) : undefined;
  if (!accessible) return { ...row };

  const farField = direction === 'out' ? 'to_slug' : 'from_slug';
  const farSourceField = direction === 'out' ? 'to_source_id' : 'from_source_id';
  const farSourceId = row[farSourceField];
  const farAccessible = isAccessible(farSourceId, accessible);

  let out: RedactableLink = { ...row };

  if (!farAccessible) {
    const endpointPolicy = policyForSource(farSourceId, config);
    if (endpointPolicy === 'hidden') return null;

    out = {
      ...out,
      locked: true,
      [farField]: null,
      [farSourceField]: null,
      context: null,
      link_source: null,
      origin_slug: null,
      origin_field: null,
      origin_source_id: null,
    } as RedactableLink;
  }

  // Only redact origin provenance when an origin page actually exists and is
  // outside the grant. Manual/custom edges commonly have no origin page; their
  // link_source is provenance for the edge itself and must survive a normal
  // visible-endpoint read. A missing/null origin_source_id is therefore not an
  // inaccessible origin — it is the absence of origin provenance.
  if (out.origin_source_id && !isAccessible(out.origin_source_id, accessible)) {
    out = {
      ...out,
      link_source: null,
      origin_slug: null,
      origin_field: null,
      origin_source_id: null,
    };
  }

  return out;
}

export function redactLinks(
  rows: RedactableLink[],
  accessibleSources?: Iterable<string>,
  config: CrossSourceEdgePolicyConfig = {},
  direction: CrossSourceEdgeDirection = 'out',
): RedactableLink[] {
  const out: RedactableLink[] = [];
  for (const row of rows) {
    const redacted = redactLink(row, accessibleSources, config, direction);
    if (redacted) out.push(redacted);
  }
  return out;
}
