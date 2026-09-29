import type { SourceLinkRule } from './profile-schema.js';

export interface IdentityKey { sourceId: string; profileId: string; externalId: string }
/** Verified binding to a live canonical page, including owner-approved adoption bindings. */
export interface CanonicalBinding extends IdentityKey { slug: string; type: string }
export interface PlannedIdentity extends CanonicalBinding { mode: 'create' | 'adopt' | 'existing' | 'binding-only' }
/** Caller evaluates selection/conditions and extracts values; identifiers are preserved verbatim. */
export interface GraphRequirement extends IdentityKey {
  fromExternalId: string;
  /** False for display-only references; still requires a verified typed target. */
  ordering?: boolean;
  expectedType: SourceLinkRule['target']['type'];
}
export interface IdentityPlanInput {
  sourceId: string;
  profileId: string;
  planned: readonly PlannedIdentity[];
  existing: readonly CanonicalBinding[];
  requirements: readonly GraphRequirement[];
}
export interface PlannedGraphTarget { slug: string; sourceId: string; type: string; origin: 'existing' | 'planned' }
export interface IdentityPlan {
  writeOrder: PlannedIdentity[];
  /** Positional correspondence with input.requirements; never a sync-state success receipt. */
  targets: PlannedGraphTarget[];
}
const key = (x: IdentityKey): string => JSON.stringify([x.sourceId, x.profileId, x.externalId]);
const pageKey = (x: CanonicalBinding): string => JSON.stringify([x.sourceId, x.slug]);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Pure complete-plan preflight. Throws before returning any plan if an invariant fails. */
export function planSourceIngestIdentities(input: IdentityPlanInput): IdentityPlan {
  const existing = new Map<string, CanonicalBinding>();
  const pageTypes = new Map<string, string>();
  for (const binding of input.existing) {
    if (existing.has(key(binding))) throw new Error(`duplicate canonical: ${key(binding)}`);
    const priorType = pageTypes.get(pageKey(binding));
    if (priorType !== undefined && priorType !== binding.type) throw new Error(`type mismatch: ${binding.slug}`);
    existing.set(key(binding), binding);
    pageTypes.set(pageKey(binding), binding.type);
  }
  const planned = new Map<string, PlannedIdentity>();
  const claimed = new Set<string>();
  for (const candidate of input.planned) {
    if (candidate.sourceId !== input.sourceId || candidate.profileId !== input.profileId) throw new Error('outside batch scope');
    if (planned.has(candidate.externalId)) throw new Error(`duplicate identity: ${candidate.externalId}`);
    if (claimed.has(pageKey(candidate))) throw new Error(`duplicate slug: ${candidate.slug}`);
    const canonical = existing.get(key(candidate));
    if (canonical && canonical.slug !== candidate.slug) throw new Error(`canonical conflict: ${candidate.externalId}`);
    const canonicalType = pageTypes.get(pageKey(candidate));
    if ((canonical && canonical.type !== candidate.type) || (canonicalType !== undefined && canonicalType !== candidate.type)) throw new Error(`type mismatch: ${candidate.slug}`);
    if (candidate.mode !== 'create' && !canonical) throw new Error(`canonical required: ${candidate.externalId}`);
    planned.set(candidate.externalId, candidate);
    claimed.add(pageKey(candidate));
  }
  const dependencies = new Map(input.planned.map(x => [x.externalId, new Set<string>()]));
  const targets: PlannedGraphTarget[] = input.requirements.map(ref => {
    const from = planned.get(ref.fromExternalId);
    if (!from || from.mode === 'binding-only') throw new Error(`missing writable origin: ${ref.fromExternalId}`);
    const candidate = ref.sourceId === input.sourceId && ref.profileId === input.profileId ? planned.get(ref.externalId) : undefined;
    const canonical = existing.get(key(ref));
    const target = canonical || candidate;
    if (!target) throw new Error(`missing target: ${key(ref)}`);
    if (target.type !== ref.expectedType) throw new Error(`type mismatch: ${key(ref)}`);
    if (ref.ordering !== false && candidate && candidate.mode !== 'binding-only') dependencies.get(ref.fromExternalId)!.add(candidate.externalId);
    return { slug: target.slug, sourceId: target.sourceId, type: target.type, origin: canonical ? 'existing' : 'planned' };
  });
  // Iterative Kahn ordering avoids recursion limits on large parent chains.
  const remaining = new Map([...dependencies].map(([id, deps]) => [id, deps.size]));
  const children = new Map<string, string[]>();
  for (const [child, parents] of dependencies) for (const parent of parents) {
    const list = children.get(parent) || [];
    list.push(child);
    children.set(parent, list);
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id).sort(compare);
  const writeOrder: PlannedIdentity[] = [];
  let visited = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const candidate = planned.get(id)!;
    visited++;
    if (candidate.mode !== 'binding-only') writeOrder.push({ ...candidate });
    for (const child of children.get(id) || []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
    ready.sort(compare);
  }
  if (visited !== planned.size) throw new Error('cycle in planned graph targets');
  return { writeOrder, targets };
}
