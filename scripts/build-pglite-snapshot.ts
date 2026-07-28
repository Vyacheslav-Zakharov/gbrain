#!/usr/bin/env bun
// scripts/build-pglite-snapshot.ts
//
// Tier 3 fast-restore: boot a fresh PGLite, run the full initSchema (forward
// bootstrap + PGLITE_SCHEMA_SQL + every migration), dump the post-init state
// to a tar fixture. Test files that read GBRAIN_PGLITE_SNAPSHOT can skip the
// 1-3 seconds of cold init and load the post-schema state directly.
//
// Output: test/fixtures/pglite-snapshot.tar (binary, gitignored)
//         test/fixtures/pglite-snapshot.version (hex SHA256 of rendered schema + migrations)
//
// The version file lets the engine detect snapshot staleness — if the tar's
// recorded version doesn't match the current rendered-schema/migrations hash, the engine
// ignores the snapshot and runs a normal initSchema.
//
// Run: bun run scripts/build-pglite-snapshot.ts
//      (or: bun run build:pglite-snapshot)
//
// Re-run whenever you touch migrations, PGLite schema rendering, or embedding dimensions/model.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as crypto from "node:crypto";

import { PGLiteEngine, computeSnapshotSchemaHash } from "../src/core/pglite-engine.ts";
import { MIGRATIONS } from "../src/core/migrate.ts";
import { getPGLiteSchema } from "../src/core/pglite-schema.ts";
import { configureGateway, getEmbeddingDimensions, getEmbeddingModel } from "../src/core/ai/gateway.ts";
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from "../src/core/ai/defaults.ts";

// bunfig.toml preloads this legacy shape for the unit suite. The snapshot is a
// test fixture, so build it against the same schema instead of the production
// gateway default (currently ZeroEntropy/1280). Otherwise every `bun test`
// process correctly rejects the freshly-built snapshot as incompatible.
const TEST_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
const TEST_EMBEDDING_DIMENSIONS = 1536;

function computeSchemaHash(): string {
  let dims = DEFAULT_EMBEDDING_DIMENSIONS;
  let model = DEFAULT_EMBEDDING_MODEL;
  try {
    dims = getEmbeddingDimensions();
    model = getEmbeddingModel() || model;
  } catch { /* gateway not configured — same defaults as initSchema() */ }
  const renderedSchema = getPGLiteSchema(dims, model);
  return computeSnapshotSchemaHash(MIGRATIONS, renderedSchema, crypto);
}

async function main() {
  const fixturePath = "test/fixtures/pglite-snapshot.tar";
  const versionPath = "test/fixtures/pglite-snapshot.version";
  mkdirSync(dirname(fixturePath), { recursive: true });

  configureGateway({
    embedding_model: TEST_EMBEDDING_MODEL,
    embedding_dimensions: TEST_EMBEDDING_DIMENSIONS,
    env: { ...process.env },
  });
  const schemaHash = computeSchemaHash();
  console.log(`[build-pglite-snapshot] schema hash: ${schemaHash.slice(0, 16)}...`);
  console.log(`[build-pglite-snapshot] booting PGLite (in-memory)...`);
  const engine = new PGLiteEngine();

  // Bypass the env-aware short-circuit: we WANT a real init here.
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;

  await engine.connect({});
  console.log(`[build-pglite-snapshot] running initSchema (forward bootstrap + ${MIGRATIONS.length} migrations)...`);
  const t0 = Date.now();
  await engine.initSchema();
  console.log(`[build-pglite-snapshot] initSchema completed in ${Date.now() - t0}ms`);

  console.log(`[build-pglite-snapshot] dumping data dir...`);
  const dump = await engine.db.dumpDataDir("none");
  const buffer = Buffer.from(await dump.arrayBuffer());

  writeFileSync(fixturePath, buffer);
  writeFileSync(versionPath, schemaHash + "\n");
  await engine.disconnect();

  console.log(`[build-pglite-snapshot] wrote ${fixturePath} (${buffer.length} bytes)`);
  console.log(`[build-pglite-snapshot] wrote ${versionPath}`);
}

await main();
