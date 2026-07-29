import { describe, expect, test } from 'bun:test';
import { loadBootstrapSources } from '../admin/src/pages/source-ingest/sourceIngestBootstrap';

const overview = {
  connectors: [],
  profiles: { rows: [], count: 0 },
  status: { rows: [] },
  refresh: { count: 0 },
  sources: [],
};

async function runScenario({ overviewError, schemaError }: { overviewError?: string; schemaError?: string }) {
  const errors: Array<string | null> = [];
  const overviews: Array<typeof overview> = [];
  const schemas: unknown[] = [];

  await loadBootstrapSources({
    fetchOverview: async () => {
      if (overviewError) throw new Error(overviewError);
      return overview;
    },
    fetchSchemaWorkbench: async () => {
      if (schemaError) throw new Error(schemaError);
      return { active_pack: { name: 'default' } };
    },
    onOverview: value => overviews.push(value),
    onSchemaWorkbench: value => schemas.push(value),
    setError: value => errors.push(value),
  });

  return { errors, overviews, schemas };
}

describe('source-ingest bootstrap orchestration', () => {
  test('loads overview and schema while clearing stale errors', async () => {
    const result = await runScenario({});
    expect(result.errors).toEqual([null]);
    expect(result.overviews).toEqual([overview]);
    expect(result.schemas).toHaveLength(1);
  });

  test('keeps an overview failure as the primary error', async () => {
    const result = await runScenario({ overviewError: 'overview_failed' });
    expect(result.errors).toEqual([null, 'overview_failed']);
    expect(result.overviews).toEqual([]);
    expect(result.schemas).toHaveLength(1);
  });

  test('reports a prefixed schema failure when overview succeeds', async () => {
    const result = await runScenario({ schemaError: 'schema_failed' });
    expect(result.errors).toEqual([null, 'schema_view_unavailable: schema_failed']);
    expect(result.overviews).toEqual([overview]);
    expect(result.schemas).toEqual([]);
  });

  test('does not overwrite an overview failure with a schema failure', async () => {
    const result = await runScenario({ overviewError: 'overview_failed', schemaError: 'schema_failed' });
    expect(result.errors).toEqual([null, 'overview_failed']);
    expect(result.overviews).toEqual([]);
    expect(result.schemas).toEqual([]);
  });
});
