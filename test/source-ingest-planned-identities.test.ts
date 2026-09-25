import { expect, test } from 'bun:test';
import { planSourceIngestIdentities, type PlannedIdentity, type GraphRequirement } from '../src/core/source-ingest/planned-identities.js';

const scope = { sourceId: 'source-a', profileId: 'equipment' };
const identity = (externalId: string, extra: Partial<PlannedIdentity> = {}): PlannedIdentity => ({
  ...scope, externalId, slug: `equipment/${externalId}`, type: 'equipment', mode: 'create', ...extra,
});
const reference = (fromExternalId: string, externalId: string, extra: Partial<GraphRequirement> = {}): GraphRequirement => ({
  fromExternalId, ...scope, externalId, expectedType: 'equipment', ...extra,
});

test('canonical and planned adoption targets coexist, facility is nonwriting', () => {
  const facility = identity('site', { slug: 'facilities/site', type: 'facility', mode: 'binding-only' });
  const adopted = identity('parent', { mode: 'adopt' });
  const result = planSourceIngestIdentities({ ...scope,
    planned: [identity('child'), adopted, facility], existing: [adopted, facility],
    requirements: [reference('child', 'parent'), reference('child', 'site', { expectedType: 'facility' })],
  });
  expect(result.writeOrder.map(x => x.externalId)).toEqual(['parent', 'child']);
  expect(result.targets.map(x => x.origin)).toEqual(['existing', 'existing']);
});

test('preflight refuses invalid whole-batch identities and references', () => {
  const cases = [
    { name: 'duplicate identity', planned: [identity('a'), identity('a')], existing: [], requirements: [] },
    { name: 'duplicate slug', planned: [identity('a'), identity('b', { slug: 'equipment/a' })], existing: [], requirements: [] },
    { name: 'missing target', planned: [identity('a')], existing: [], requirements: [reference('a', 'missing')] },
    { name: 'wrong source', planned: [identity('a')], existing: [identity('parent', { sourceId: 'other' })], requirements: [reference('a', 'parent')] },
    { name: 'type mismatch', planned: [identity('a'), identity('b')], existing: [], requirements: [reference('a', 'b', { expectedType: 'facility' })] },
    { name: 'cycle', planned: [identity('a'), identity('b')], existing: [], requirements: [reference('a', 'b'), reference('b', 'a')] },
    { name: 'cycle', planned: [identity('a')], existing: [], requirements: [reference('a', 'a')] },
    { name: 'canonical required', planned: [identity('site', { mode: 'binding-only', type: 'facility' })], existing: [], requirements: [] },
    { name: 'type mismatch', planned: [identity('site', { mode: 'binding-only', type: 'facility' })], existing: [identity('site')], requirements: [] },
    { name: 'outside batch scope', planned: [identity('a'), identity('b', { profileId: 'other' })], existing: [], requirements: [] },
    { name: 'duplicate canonical', planned: [], existing: [identity('a'), identity('a')], requirements: [] },
    { name: 'canonical conflict', planned: [identity('a')], existing: [identity('a', { slug: 'elsewhere' })], requirements: [] },
  ];
  for (const c of cases) expect(() => planSourceIngestIdentities({ ...scope, ...c })).toThrow(c.name === 'wrong source' ? 'missing target' : c.name);
});

test('mixed existing and planned targets retain source/profile qualification', () => {
  const planned = [identity('child'), identity('parent')];
  const existing = [identity('parent', { sourceId: 'other', slug: 'foreign/parent' }), identity('outside', { profileId: 'facilities', type: 'facility' })];
  const requirements = [reference('child', 'parent'), reference('child', 'outside', { profileId: 'facilities', expectedType: 'facility' })];
  const before = JSON.stringify({ planned, existing, requirements });
  const result = planSourceIngestIdentities({ ...scope, planned, existing, requirements });
  expect(result.targets.map(x => x.slug)).toEqual(['equipment/parent', 'equipment/outside']);
  expect(result.targets.map(x => x.origin)).toEqual(['planned', 'existing']);
  expect(JSON.stringify({ planned, existing, requirements })).toBe(before);
  expect(planSourceIngestIdentities({ ...scope, planned: [...planned].reverse(), existing, requirements })).toEqual(result);
  expect(() => planSourceIngestIdentities({ ...scope, planned, existing: [], requirements })).toThrow('missing target');
});

test('display collection references resolve without reverse ordering cycles', () => {
  const result = planSourceIngestIdentities({ ...scope, planned: [identity('child'), identity('parent')], existing: [], requirements: [reference('child','parent'),reference('parent','child',{ ordering: false })] });
  expect(result.writeOrder.map(x=>x.externalId)).toEqual(['parent','child']);
  expect(result.targets[1].slug).toBe('equipment/child');
  expect(()=>planSourceIngestIdentities({ ...scope, planned: [identity('parent')], existing: [], requirements: [reference('parent','missing',{ordering:false})] })).toThrow('missing target');
});
test('empty database resolves whole batch and orders parent before child', () => {
  const result = planSourceIngestIdentities({ ...scope, planned: [identity('child'), identity('parent')], existing: [], requirements: [reference('child', 'parent')] });
  expect(result.writeOrder.map(x => x.externalId)).toEqual(['parent', 'child']);
  expect(result.targets[0]).toEqual({ slug: 'equipment/parent', sourceId: 'source-a', type: 'equipment', origin: 'planned' });
});
