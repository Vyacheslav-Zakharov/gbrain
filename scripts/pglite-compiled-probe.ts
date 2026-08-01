#!/usr/bin/env bun
/** Internal build-check entrypoint; compiled by check-pglite-compiled.sh. */
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('usage: pglite-compiled-probe <database-path>');

const engine = new PGLiteEngine();
try {
  await engine.connect({ database_path: databasePath });
  const rows = await engine.executeRaw<{ trigram: number; dimensions: number }>(
    `SELECT similarity('hello', 'hallo')::float AS trigram,
            vector_dims('[1,2,3]'::vector) AS dimensions`,
  );
  const row = rows[0];
  if (!row || Number(row.trigram) <= 0 || Number(row.dimensions) !== 3) {
    throw new Error(`compiled PGLite extension probe failed: ${JSON.stringify(row ?? null)}`);
  }
  process.stdout.write(JSON.stringify({ trigram: Number(row.trigram), dimensions: Number(row.dimensions) }) + '\n');
} finally {
  await engine.disconnect();
}
