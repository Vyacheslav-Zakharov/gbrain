import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SCHEMA_SQL } from '../src/core/schema-embedded.ts';

const canonical = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
const migrations = readFileSync(new URL('../src/core/migrate.ts', import.meta.url), 'utf8');

// pg_get_functiondef retains the dollar-quoted body verbatim, including its
// leading/trailing whitespace. Token/trimmed equality cannot protect catalog pins.
function bodies(sql: string, name: string): string[] {
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\) RETURNS trigger AS (\\$[a-z]+\\$)([\\s\\S]*?)\\1 LANGUAGE plpgsql;`, 'gi');
  return [...sql.matchAll(pattern)].map(match => match[2]);
}

describe('fresh migration / repeated bootstrap function byte parity', () => {
  for (const [name, definitions] of [
    ['bump_page_generation_fn', 1], // v91 handler columnsAndTrigger literal
    ['bump_page_generation_clock_fn', 2], // v107 table clock superseded by v118 sequence clock
    ['update_chunk_search_vector', 1], // v27
  ] as const) {
    test(`${name}: canonical and emitted bodies equal the final historical migration bytes`, () => {
      const history = bodies(migrations, name);
      expect(history).toHaveLength(definitions);
      const finalBody = history.at(-1)!;
      // These historical TS literals have no escape/interpolation transformations.
      // Fail rather than silently mistaking source bytes for executed SQL if changed.
      expect(finalBody).not.toMatch(/\\|\$\{/);
      expect(bodies(canonical, name)).toEqual([finalBody]);
      expect(bodies(SCHEMA_SQL, name)).toEqual([finalBody]);
    });
  }

  test('generated SQL is exactly the canonical file with the generator leading newline', () => {
    expect(SCHEMA_SQL).toBe('\n' + canonical);
  });
});
