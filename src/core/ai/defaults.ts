/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// Avers R1 ZeroEntropy exit: owner-approved target and fresh/configless
// fallback. The live corpus is migrated under the governed runner; these
// constants prevent fresh init or a missing config plane from reactivating
// hosted ZeroEntropy after its 2026-09-04 shutdown.
export const DEFAULT_EMBEDDING_MODEL = 'google:gemini-embedding-001';
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
