import { test, expect } from 'bun:test';
import { selectedTextEngine } from '../src/core/selected-text-embedding.ts';
import { selectedTextInvalidation } from '../src/core/text-embedding-column.ts';
for (const key of ['search_embedding_column', 'embedding_columns']) {
  test(`selected routing and invalidation refuse failed ${key} read`, async () => {
    const engine: any = { getConfig: async (k: string) => { if (k === key) throw new Error('authority unavailable'); return null; } };
    await expect(selectedTextEngine(engine)).rejects.toThrow('authority unavailable');
    await expect(selectedTextInvalidation(engine)).rejects.toThrow('authority unavailable');
  });
}
