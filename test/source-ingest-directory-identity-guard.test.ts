import { expect, test } from 'bun:test';
import { prepareDirectorySnapshot, type DirectoryGuardPolicy } from '../src/core/source-ingest/directory-identity-guard';
const policy: DirectoryGuardPolicy = {
  fields: { id: 'ID', key: 'Key', name: 'Name', type: 'Type', created: 'Created', parent: 'Parent', site: 'Site' },
  dateFormat: 'MM/DD/YYYY HH:mm:ss', timezone: '+05:00',
  passportFields: ['Active'], anchors: [], typeAllowlist: ['unit', 'group'],
  scope: { sites: ['A'] },
};
const rows = (): Array<{ ID: string; Key: string; Name: string; Type: string; Created: string | null; Parent: string | null; Site: string; Active: boolean }> => [
  { ID: '1', Key: 'root', Name: 'Root', Type: 'group', Created: '06/01/2026 10:00:00', Parent: null, Site: 'A', Active: true },
  { ID: '2', Key: 'child', Name: 'Child', Type: 'unit', Created: null, Parent: '1', Site: 'A', Active: true },
];
const input = (records = rows()) => ({ upstreamBinding: { connectorInstanceId: 'fake-source', objectName: 'directory', alias: 'source', sourceTableId: null, resolvedCatalogId: null }, sourceId: 'source-a', profileId: 'profile-a', policy, records, complete: true as const });
test('explicit empty roots preserve raw projection; UTC range and reserved text stop', () => {
  const raw = rows(); raw[0].Parent = '';
  const out = prepareDirectorySnapshot({ ...input(raw), policy: { ...policy, rootParentValues: [''] }, mode: 'preview' });
  expect(out.status).toBe('review');
  if (out.status !== 'stopped') expect(out.records[0].Parent).toBe('');
  for (const text of ['[[injected]]', '<!-- gbrain-source-sync:start -->', 'bad\u0001text']) {
    const bad = rows(); bad[0].Name = text;
    expect(prepareDirectorySnapshot({ ...input(bad), mode: 'preview' }).status).toBe('stopped');
  }
  const bad = rows(); bad[0].Created = '01/01/0001 00:00:00';
  expect(prepareDirectorySnapshot({ ...input(bad), mode: 'preview' }).status).toBe('stopped');
});
test('bootstrap requires explicit matching reviewed snapshot hash', () => {
  const preview = prepareDirectorySnapshot({ ...input(), mode: 'preview' });
  expect(preview.status).toBe('review');
  if (preview.status !== 'review') throw Error('review expected');
  expect(prepareDirectorySnapshot({ ...input(), mode: 'run' }).status).toBe('stopped');
  expect(prepareDirectorySnapshot({ ...input(), mode: 'run', bootstrapSnapshotHash: 'wrong' }).status).toBe('stopped');
  const run = prepareDirectorySnapshot({ ...input(), mode: 'run', bootstrapSnapshotHash: preview.snapshotHash });
  expect(run.status).toBe('prepared');
});


test('out-of-scope empty types remain comparable identity values', () => {
  const outside = { ...rows()[0], ID: 'outside', Key: 'outside', Site: 'B', Type: '' };
  expect(prepareDirectorySnapshot({ ...input([...rows(), outside]), mode: 'preview' }).status).toBe('review');
});
test('whole raw input rejects invalid rows before any scope or canary selection', () => {
  for (const extra of [
    { ...rows()[1], Site: 'B' },
    { ...rows()[1], ID: '' }, { ...rows()[1], ID: ' 3' },
    { ...rows()[1], ID: '3', Parent: 'missing' },
    { ...rows()[1], ID: '3', Site: 'B' },
    { ...rows()[1], ID: '3', Parent: '3' },
    { ...rows()[1], ID: '3', Created: '02/30/2026 10:00:00' },
    { ...rows()[1], ID: '3', Type: 'unknown' },
  ]) expect(prepareDirectorySnapshot({ ...input([...rows(), extra]), mode: 'preview' }).status).toBe('stopped');
  expect(prepareDirectorySnapshot({ ...input(), complete: false, mode: 'preview' }).status).toBe('stopped');
});


test('immutable reordered snapshot and pinned anchors', () => {
  const records = rows();
  const a = prepareDirectorySnapshot({ ...input(records), mode: 'preview' });
  const b = prepareDirectorySnapshot({ ...input([...records].reverse()), mode: 'preview' });
  if (a.status === 'stopped' || b.status === 'stopped') throw Error('valid');
  expect(a.snapshotHash).toBe(b.snapshotHash);
  expect(a.identities[0].created).toBe('2026-06-01T05:00:00.000Z');
  records[0].Name = 'mutated';
  expect(a.records[0].Name).toBe('Root');
  expect(Object.isFrozen(a.records)).toBe(true);
  expect(Object.isFrozen(a.candidateBaseline.knownIdentityRecords)).toBe(true);
  const virtual = rows().map(r => ({ ...r, VirtualChildren: [{ secret: 'excluded' }] }));
  const c = prepareDirectorySnapshot({ ...input(virtual), mode: 'preview' });
  if (c.status === 'stopped') throw Error('valid');
  expect(c.snapshotHash).toBe(a.snapshotHash);
  expect(c.records[0]).not.toHaveProperty('VirtualChildren');
  expect(prepareDirectorySnapshot({ ...input(virtual), mode: 'preview', policy: { ...policy, passportFields: ['VirtualChildren'] } }).status).toBe('stopped');
  const cycle = rows(); cycle[0].Parent = '2';
  expect(prepareDirectorySnapshot({ ...input(cycle), mode: 'preview' }).status).toBe('stopped');
  for (const badDate of ['02/29/2025 00:00:00', '01/01/2026 24:00:00', '13/01/2026 00:00:00']) {
    const invalid = rows(); invalid[0].Created = badDate;
    expect(prepareDirectorySnapshot({ ...input(invalid), mode: 'preview' }).status).toBe('stopped');
  }
  const anchor = { id: '1', key: 'root', name: 'Root', type: 'group', created: '2026-06-01T05:00:00.000Z', parent: null, site: 'A' };
  for (const change of [{ key: 'different' }, { id: 'absent' }, { name: 'different' }])
    expect(prepareDirectorySnapshot({ ...input(), mode: 'preview', policy: { ...policy, anchors: [{ ...anchor, ...change }] } }).status).toBe('stopped');
});
test('accepted baseline blocks reuse, disappearance and binding drift but permits independent edits', () => {
  const initial = prepareDirectorySnapshot({ ...input(), mode: 'preview' });
  if (initial.status === 'stopped') throw Error('initial');
  const baseline = initial.candidateBaseline;
  for (const change of [
    { Created: '06/02/2026 10:00:00' }, { Created: null }, { Created: 'bad' },
    { Name: 'Changed', Type: 'unit' },
  ]) {
    const records = rows(); Object.assign(records[0], change);
    expect(prepareDirectorySnapshot({ ...input(records), baseline, mode: 'run' }).status).toBe('stopped');
  }
  expect(prepareDirectorySnapshot({ ...input(rows().slice(0, 1)), baseline, mode: 'run' }).status).toBe('stopped');
  for (const change of [{ Name: 'Changed' }, { Type: 'unit' }, { Active: false }]) {
    const records = rows(); Object.assign(records[0], change);
    expect(prepareDirectorySnapshot({ ...input(records), baseline, mode: 'run' }).status).toBe('prepared');
  }
  for (const change of [{ sourceId: 'other' }, { profileId: 'other' }, { policyHash: 'other' }])
    expect(prepareDirectorySnapshot({ ...input(), baseline: { ...baseline, ...change }, mode: 'run' }).status).toBe('stopped');
});
