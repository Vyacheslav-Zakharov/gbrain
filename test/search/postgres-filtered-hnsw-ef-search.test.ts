import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

function mockSql(statements: string[]) {
  const tx = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      let rendered = '';
      for (let i = 0; i < parts.length; i++) rendered += parts[i] + (i < values.length ? String(values[i]) : '');
      statements.push(rendered.trim());
      return [];
    },
    {
      unsafe: async (query: string) => {
        statements.push(query.trim());
        return [];
      },
    },
  );
  return {
    begin: async <T>(fn: (sql: typeof tx) => Promise<T>) => fn(tx),
  };
}

describe('Postgres filtered HNSW search breadth', () => {
  test('ordinary unscoped search keeps the connection default ef_search', async () => {
    const statements: string[] = [];
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = mockSql(statements);

    // Default hard-exclude prefixes are present internally, but they are broad
    // hygiene guards rather than a caller-selected source/type/date slice.
    await engine.searchVector(new Float32Array(1536), { limit: 20 });

    expect(statements.some((sql) => /set_config\('hnsw\.ef_search'/i.test(sql))).toBe(false);
  });

  test('source-scoped vector search raises ef_search inside the query transaction', async () => {
    const statements: string[] = [];
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = mockSql(statements);

    await engine.searchVector(new Float32Array(1536), { sourceId: 'shared', limit: 20 });

    expect(statements.some((sql) => /set_config\('hnsw\.ef_search',\s*200,\s*true\)/i.test(sql))).toBe(true);
    expect(statements.findIndex((sql) => /set_config\('hnsw\.ef_search'/i.test(sql)))
      .toBeLessThan(statements.findIndex((sql) => /WITH hnsw_candidates/i.test(sql)));
  });

  test('bounded breadth caps ef_search at pgvector maximum', async () => {
    const statements: string[] = [];
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = mockSql(statements);

    await engine.searchVector(new Float32Array(1536), { sourceIds: ['shared', 'internal-it'], limit: 100 });

    expect(statements.some((sql) => /set_config\('hnsw\.ef_search',\s*1000,\s*true\)/i.test(sql))).toBe(true);
  });
});
