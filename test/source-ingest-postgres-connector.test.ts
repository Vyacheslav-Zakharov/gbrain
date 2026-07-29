import { describe, expect, test } from 'bun:test';
import { PostgresSourceConnector } from '../src/core/source-ingest/connectors/postgres.ts';

function connectorWithRows(count: number) {
  const connector = new PostgresSourceConnector({
    allowed_objects: ['employees'],
    batch_size: 500,
  });
  const rows = Array.from({ length: count }, (_, index) => ({
    employment_id: `employment-${String(index).padStart(4, '0')}`,
    updated_at: '2026-07-29T00:00:00.000Z',
  }));
  (connector as any).fetchPage = async (_object: string, opts: { offset: number }) =>
    rows.slice(opts.offset, opts.offset + 500);
  return connector;
}

async function collect(connector: PostgresSourceConnector, cursor?: string) {
  const batches = [];
  for await (const batch of connector.fetchAll('employees', cursor)) batches.push(batch);
  return batches;
}

describe('PostgresSourceConnector.fetchAll', () => {
  test('walks every page and supports cursor resume', async () => {
    const connector = connectorWithRows(660);

    const all = await collect(connector);
    expect(all.map(batch => batch.records.length)).toEqual([500, 160]);
    expect(all.map(batch => batch.cursor)).toEqual(['500', null]);
    expect(all.flatMap(batch => batch.records)).toHaveLength(660);

    const resumed = await collect(connector, '500');
    expect(resumed.map(batch => batch.records.length)).toEqual([160]);
    expect(resumed[0]?.records[0]?.external_id).toBe('employment-0500');
  });

  test('does not emit an empty terminal batch for an exact page multiple', async () => {
    const batches = await collect(connectorWithRows(1000));
    expect(batches.map(batch => batch.records.length)).toEqual([500, 500]);
    expect(batches.flatMap(batch => batch.records)).toHaveLength(1000);
  });
});
