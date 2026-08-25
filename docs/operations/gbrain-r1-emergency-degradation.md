# GBrain R1 emergency degradation runbook

Status: candidate/runbook only — no production activation authorized
Deadline: hosted ZeroEntropy shutdown `2026-09-04`
Checkpoint: if the R1 candidate is not frozen by `2026-08-28` EOD, invoke owner Decision 8 immediately.

## Trigger

Use this runbook when any of the following is observed:

- hosted ZeroEntropy timeout, HTTP 429, authentication failure, malformed response, or connection failure;
- vector arm repeatedly reports `embedding_timeout`, `embedding_rate_limit`, or `embedding_provider`;
- the R1 schedule can no longer preserve the pre-shutdown 24–48 hour observation window.

## Proven floor: FTS/keyword-only

The exact fork already falls open to keyword/FTS results when embedding fails. The R1 candidate adds explicit metadata for a failed single vector arm.

Required caller-visible shape:

```json
{
  "vector_enabled": false,
  "arms": {
    "status": "degraded",
    "used": 0,
    "total": 1,
    "failed": 1,
    "failure_reasons": {
      "embedding_timeout": 1
    }
  }
}
```

Allowed failure reasons are bounded classes only; never include provider messages, credentials, or raw query text.

Verified candidate test:

```bash
bun test test/r1-provider-degradation.serial.test.ts
```

Coverage: timeout, 429, authentication, malformed payload, and connection refusal. Every case must return the lexical canary, set `vector_enabled=false`, and expose one sanitized reason.

Dispatch-level tests additionally require both MCP-facing `search` and `query` handlers to publish:

```json
{
  "search": {
    "status": "degraded",
    "fallback": "fts",
    "reason": "embedding_rate_limit",
    "failure_reasons": { "embedding_rate_limit": 1 },
    "arms": { "used": 0, "total": 1, "failed": 1 }
  }
}
```

## Operator checks

1. Confirm the degradation class from caller `_meta` and the structured warning.
2. Confirm critical FTS canaries still return their must-have slugs.
3. Confirm there is no HTTP 500 and no query text/credential leakage.
4. Record search P50/P95, empty-result rate, degradation count, and critical-query pass rate.
5. Keep Autopilot HOLD and do not start provider-capable background work.
6. Do not run ordinary CLI diagnostics against production during a migration fence; normal CLI connection paths may auto-run pending migrations in this fork.

## Primary emergency semantic mode: additive column

Owner Decision 8 selects the rehearsed additive-column bridge as the primary emergency semantic mode; FTS-only remains the floor.

The bridge is not production-ready until its disposable-clone receipt proves:

- a separate Google 768d content-chunk column;
- declaration through the existing `embedding_columns` registry;
- a bounded custom-column writer;
- complete coverage census;
- non-default-column cache-disabled behavior;
- query routing and retrieval canaries;
- config flip rollback to the untouched primary ZE column while ZE is alive;
- explicit degraded status for facts/query-cache/takes rather than a false migration claim.

Production activation still requires the governed release gate and owner GO. This decision sets preference; it does not bypass production authorization.

## Recovery targets

- Before `2026-09-04`: rollback to R0/ZE is allowed only after a live ZE query probe succeeds.
- After `2026-09-04`: never restore R0 as an operational target. Recover to the last known-good new-provider artifact/DB or operate FTS-only.
- Full DB restore remains the default posture while full re-embed cost remains approximately USD 1; if estimate exceeds USD 5, stop and re-confirm with the owner.

## Known limitations

- FTS-only cannot recover semantic synonym/paraphrase recall.
- The proven floor is for text hybrid search when the embedding/vector arm fails. A failure in `searchKeyword()` itself, an invalid/unknown embedding-column registry entry, or an image-only direct path can still fail the whole call and requires separate handling.
- Additive-column search disables semantic query cache in the current fork.
- Additive content search does not migrate `facts.embedding`, `query_cache.embedding`, or the currently empty `takes.embedding` plane.
- `takes.embedding` must remain unpopulated until separately re-dispositioned.
