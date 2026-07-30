/**
 * GBrain HTTP MCP server with OAuth 2.1.
 *
 * Combines:
 * - MCP SDK's mcpAuthRouter (OAuth endpoints: /authorize, /token, /register, /revoke)
 * - Custom client_credentials handler (SDK doesn't support CC grant)
 * - MCP tool calls at /mcp with bearer auth + scope enforcement
 * - Admin dashboard at /admin with cookie auth
 * - SSE live activity feed at /admin/events
 * - Health check at /health
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomInt, createHash } from 'crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeHexEqual } from '../core/timing-safe.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, operationsByName, OperationError } from '../core/operations.ts';
import type { OperationContext, AuthInfo } from '../core/operations.ts';
import { GBrainOAuthProvider, validateTokenEndpointAuthMethod } from '../core/oauth-provider.ts';
import type { SqlQuery } from '../core/oauth-provider.ts';
import { hasScope, ALLOWED_SCOPES_LIST, normalizeScopesInput } from '../core/scope.ts';
import { summarizeMcpParams, dispatchToolCall } from '../mcp/dispatch.ts';
import { paramDefToSchema } from '../mcp/tool-defs.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { loadConfig } from '../core/config.ts';
import { buildError, serializeError } from '../core/errors.ts';
import { VERSION } from '../version.ts';
import * as db from '../core/db.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../core/sql-query.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { validateShellJobParams } from '../core/minions/handlers/shell-validate.ts';
import {
  computeContentHash,
  validateIngestionEvent,
  type IngestionContentType,
  type IngestionEvent,
} from '../core/ingestion/types.ts';
import { connectorSecretConfigId, defaultSourceConnectorConfigId, getSourceConnectorSecretConfig, sourceConnectorSecretStatus, sourceTableSummariesFromConfigs } from '../core/source-ingest/connector-config.ts';
import { buildProfileSampleRecords } from '../core/source-ingest/source-fetch.ts';
import { profileHash } from '../core/source-ingest/store.ts';
import { validateSourceIngestProfile } from '../core/source-ingest/profile-schema.ts';
import { sourceIngestConnectorDescriptors } from '../core/source-ingest/connector-registry.ts';
import { getSourceConnector } from '../core/source-ingest/connectors/fake.ts';
import { recordSourceConnectorTest } from '../core/source-ingest/catalog.ts';
import {
  PortalSessionStore,
  isPortalFileAllowed,
  portalSessionCookieName,
  resolvePortalPathSecure,
} from '../core/portal-security.ts';
import {
  classifyPortalSearchMatch,
  cleanPortalSearchSnippet,
  comparePortalSearchResults,
  isPortalCountedDocument,
  isPortalTitlePrefixMatch,
  isPortalVisibleDirectory,
  type PortalSearchRank,
} from '../portal-usability.ts';
import { normalizeAlias } from '../core/search/alias-normalize.ts';
import {
  acceptTakeProposal,
  createLlmTakeRevision,
  createManualTakeRevision,
  getTakeProposalReview,
  listTakeProposals,
  rejectTakeProposal,
  ReviewConflictError,
  type TakeProposalStatus,
} from '../core/ai-review.ts';
import {
  acceptConceptProposal,
  createManualConceptRevision,
  createLlmConceptRevision,
  getConceptProposalReview,
  listConceptProposals,
  rejectConceptProposal,
} from '../core/concept-review.ts';
import {
  acceptMeetingReview,
  attachMeetingReviewJob,
  createLlmMeetingRevision,
  createManualMeetingRevision,
  getMeetingReviewItem,
  listMeetingReviewItems,
  rejectMeetingReview,
  reopenMeetingReviewAfterQueueFailure,
  type MeetingReviewStatus,
} from '../core/meeting-review.ts';

/**
 * /health endpoint timeout. 3s rather than 5s: Fly.io's default
 * health-check timeout is 5s, so returning 503 right at the orchestrator
 * deadline races with the orchestrator recording the request as a timeout.
 * 3s leaves 2s of headroom for TCP, response framing, and clock skew.
 */
export const HEALTH_TIMEOUT_MS = 3000;

/**
 * Express delegates JSON responses to JSON.stringify, which throws on native
 * bigint values returned by postgres.js for BIGINT columns. Preserve the
 * numeric API contract for ordinary ids and avoid precision loss for values
 * outside JavaScript's safe integer range.
 */
export function jsonBigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== 'bigint') return value;
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value);
  }
  return value.toString();
}

/**
 * v0.36.1.x #1024: bootstrap token resolution.
 *
 * Pure helper (no side effects, no process.exit) so the rule is unit-testable.
 * Two outcomes:
 *   - `ok`: caller proceeds with `{token, fromEnv}`. When the env value is
 *     undefined, a fresh 32-byte hex token is generated.
 *   - `error`: caller refuses to start. We require 32+ chars matching
 *     `[A-Za-z0-9_-]+` for env-supplied tokens — fail-closed beats silently
 *     accepting a weak admin secret.
 *
 * `randomBytesHex` is parameterized so tests can inject a deterministic
 * fallback without monkey-patching `crypto.randomBytes`.
 */
export type BootstrapTokenResolution =
  | { kind: 'ok'; token: string; fromEnv: boolean }
  | { kind: 'error'; message: string };

export function resolveBootstrapToken(
  envValue: string | undefined,
  randomBytesHex: () => string = () => randomBytes(32).toString('hex'),
): BootstrapTokenResolution {
  if (envValue === undefined) {
    return { kind: 'ok', token: randomBytesHex(), fromEnv: false };
  }
  const trimmed = envValue.trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(trimmed)) {
    return {
      kind: 'error',
      message:
        'GBRAIN_ADMIN_BOOTSTRAP_TOKEN must be at least 32 chars and match [A-Za-z0-9_-]+.\n' +
        '  Refusing to start with a weak admin bootstrap token. Generate one with:\n' +
        '    head -c 32 /dev/urandom | base64 | tr -d "+/=" | head -c 48',
    };
  }
  return { kind: 'ok', token: trimmed, fromEnv: true };
}

export type ProbeHealthResult =
  | { ok: true; status: 200; body: { status: 'ok'; version: string; engine: string; [k: string]: unknown } }
  | { ok: false; status: 503; body: { error: 'service_unavailable'; error_description: string } };

/**
 * Pure async health probe. Races `engine.getStats()` against a timeout,
 * returns a tagged result. No Express coupling — easy to unit-test with a
 * mock engine. The /health route handler is a thin wrapper around this.
 */
export async function probeHealth(
  engine: BrainEngine,
  engineName: string,
  version: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<ProbeHealthResult> {
  // Capture the handle so we can clearTimeout when getStats() wins. Without
  // this, every fast /health request leaves a 3s pending timer in the event
  // loop until it fires — under high probe rates this builds up a rolling
  // backlog of timers and avoidable wakeups. Both adversarial reviewers
  // (Claude + Codex) flagged this independently.
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const stats = await Promise.race([
      engine.getStats(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('health_timeout')), timeoutMs);
      }),
    ]);
    return {
      ok: true,
      status: 200,
      body: { status: 'ok', version, engine: engineName, ...stats },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return {
      ok: false,
      status: 503,
      body: {
        error: 'service_unavailable',
        error_description: msg === 'health_timeout'
          ? 'Health check timed out (database pool may be saturated)'
          : 'Database connection failed',
      },
    };
  } finally {
    // Clear the timer regardless of which branch won the race. No-op when
    // the timer already fired (we're in the timeout-rejection catch block).
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Lightweight liveness probe. Races `SELECT 1` against the same timeout
 * `probeHealth` uses, returns the same tagged-union result type, but the
 * 200 body is intentionally bare: `{status, version, engine}` — no engine
 * stats. Stats moved to `/admin/api/full-stats` (admin auth) in v0.28.10
 * because `getStats()`'s six count(*) queries exceeded HEALTH_TIMEOUT_MS
 * on production brains through PgBouncer, producing false 503s that
 * triggered orchestrator restart cascades and advisory-lock pile-ups.
 */
export async function probeLiveness(
  sql: SqlQuery,
  engineName: string,
  version: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<ProbeHealthResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('health_timeout')), timeoutMs);
      }),
    ]);
    return {
      ok: true,
      status: 200,
      body: { status: 'ok', version, engine: engineName },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return {
      ok: false,
      status: 503,
      body: {
        error: 'service_unavailable',
        error_description: msg === 'health_timeout'
          ? 'Health check timed out (database pool may be saturated)'
          : 'Database connection failed',
      },
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Resolve `GBRAIN_HTTP_TRUST_PROXY` into a value Express's `app.set('trust
 * proxy', ...)` accepts. Pure function so the test surface is one place,
 * not the whole Express stack.
 *
 * Mapping:
 *   - unset / empty → 'loopback' (pre-v0.41.3 default; trusts only
 *     127.0.0.1, ::1, ::ffff:127.0.0.1, fc00::/7)
 *   - '0' / 'false' → false (trust nothing; req.ip is socket peer regardless
 *     of X-Forwarded-For)
 *   - '1' / 'true' → 1 (trust exactly one hop; safe for Fly.io / Render /
 *     single-layer reverse proxy; matches the legacy transport's '==1' check)
 *   - other numeric → parseInt (trust N hops)
 *   - any other string → pass through verbatim (Express accepts named modes
 *     like 'uniquelocal', 'linklocal', and CIDR/IP lists)
 *
 * SECURITY: only set GBRAIN_HTTP_TRUST_PROXY when BOTH (a) gbrain is
 * reachable only via a trusted reverse proxy, AND (b) the proxy strips
 * client-supplied X-Forwarded-For headers before re-emitting its own.
 * Otherwise clients can spoof their IP and defeat the pre-auth IP rate
 * limit. See SECURITY.md "Reverse-proxy trust" for the full contract.
 */
export function resolveTrustProxy(env: string | undefined): string | number | boolean {
  if (env === undefined || env === '') return 'loopback';
  if (env === '0' || env === 'false') return false;
  if (env === '1' || env === 'true') return 1;
  if (/^\d+$/.test(env)) return parseInt(env, 10);
  return env;
}

/**
 * Parse `GBRAIN_HTTP_CORS_ORIGIN` into a Set of allowed origins for OAuth
 * endpoints. Mirrors `src/mcp/http-transport.ts:parseCorsAllowlist`. Single
 * env var so operators don't need to maintain two allowlists.
 *
 * Returns null when unset, empty, or whitespace-only — caller MUST treat
 * null as "deny all cross-origin" (the same posture the legacy transport
 * already takes).
 */
export function parseCorsAllowlistOAuth(): Set<string> | null {
  const v = process.env.GBRAIN_HTTP_CORS_ORIGIN;
  if (!v) return null;
  const origins = v.split(',').map(s => s.trim()).filter(Boolean);
  return origins.length === 0 ? null : new Set(origins);
}

/**
 * Build a `cors.CorsOptions['origin']` value from the allowlist. The cors
 * package accepts:
 *   - `false` → reject everything (no Allow-Origin header sent)
 *   - `(origin, cb) => cb(null, boolean)` → dynamic per-request check
 * We use the function form when an allowlist is set so the value of the
 * Allow-Origin header echoes the request Origin (RFC 6454) instead of a
 * hardcoded string, and so the same options object covers all listed
 * origins without enumeration in the response.
 *
 * Same-origin requests (no Origin header) get `cb(null, true)` which the
 * cors package translates to "no CORS headers needed" — they're not
 * cross-origin so they don't trigger the gate.
 */
export function resolveCorsOrigin(allowlist: Set<string> | null): cors.CorsOptions['origin'] {
  if (allowlist === null) return false;
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    cb(null, allowlist.has(origin));
  };
}

interface ServeHttpOptions {
  port: number;
  tokenTtl: number;
  enableDcr: boolean;
  /**
   * Public URL the server is reachable at (e.g., https://brain.example.com).
   * Used as the OAuth issuer in discovery metadata. Defaults to
   * http://localhost:{port} when unset. Required for production deployments
   * behind reverse proxies, ngrok tunnels, or any non-loopback URL — the
   * issuer claim in tokens MUST match the discovery URL clients hit.
   */
  publicUrl?: string;
  /**
   * When true, write raw request payloads to mcp_request_log + the admin SSE
   * feed. Default false: payloads are summarized via dispatch.summarizeMcpParams
   * (declared keys only, no values, no attacker-controlled key names).
   *
   * Operators running gbrain on their own laptop and debugging agent behavior
   * can flip this on with `--log-full-params`. The flag prints a loud warning
   * at startup so the privacy posture change is visible.
   */
  logFullParams?: boolean;
  /**
   * Network interface(s) to bind. Defaults to `127.0.0.1` (loopback only) in
   * v0.34.1+ — gbrain's primary use case is a personal-knowledge brain on a
   * laptop, and the pre-v0.34 default of `0.0.0.0` made it one accidental
   * `--http` invocation away from publishing the brain to a LAN.
   *
   * Server operators who DO want to accept remote connections pass
   * `--bind 0.0.0.0` (or a specific interface IP). When `--public-url` is
   * set but `--bind` is unset, a stderr WARN fires at startup recommending
   * the explicit flag — defaulting to loopback while declaring a public URL
   * is almost always a misconfiguration.
   */
  bind?: string;
  /**
   * v0.36.x #1024: suppress the printed admin bootstrap token line on
   * startup. Combined with `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, lets long-lived
   * production deployments avoid leaking the token into log aggregators on
   * every supervisor-managed restart. When the env var is NOT set, this
   * flag still suppresses the print — operators take responsibility for
   * tracking the regenerated value through other means.
   */
  suppressBootstrapToken?: boolean;
}

/**
 * v0.38 Slice 4 — per-OAuth-client agent spend snapshot. Exported so the
 * admin endpoint and `test/admin-agents-spend.test.ts` share the same SQL
 * (single source of truth for the spend query shape).
 *
 * Returns one row per OAuth client that EITHER has the `agent` scope OR
 * has at least one `bound_*` column set (the legacy admin client could
 * also have bindings without scope='agent' on a partially-migrated brain;
 * we want it visible in the viewer).
 *
 * Fields:
 *   - client_id, client_name
 *   - cap_usd_per_day: number | null  (daily budget cap; NULL = no cap)
 *   - spent_cents_today: number  (sum from mcp_spend_log, UTC-day-aligned)
 *   - pending_cents: number  (sum of in-flight reservations, non-expired)
 *   - inflight_count: number  (active subagent jobs owned by this client)
 *
 * Falls back to `[]` on any SQL error (pre-v0.38 brains where the v82-v84
 * tables/columns don't yet exist).
 */
export interface AgentClientSpend {
  client_id: string;
  client_name: string;
  cap_usd_per_day: number | null;
  spent_cents_today: number;
  pending_cents: number;
  inflight_count: number;
}

export async function queryAgentClientSpend(engine: BrainEngine): Promise<AgentClientSpend[]> {
  const sql = sqlQueryForEngine(engine);
  const rows = await sql`
    SELECT
      c.client_id,
      c.client_name,
      COALESCE(c.budget_usd_per_day, NULL) AS cap_usd_per_day,
      COALESCE((
        SELECT SUM(spend_cents)::text
          FROM mcp_spend_log
         WHERE client_id = c.client_id
           AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      ), '0') AS spent_cents_today,
      COALESCE((
        SELECT SUM(estimated_cents)::text
          FROM mcp_spend_reservations
         WHERE client_id = c.client_id
           AND status = 'pending'
           AND expires_at > now()
      ), '0') AS pending_cents,
      COALESCE((
        SELECT COUNT(*)::int
          FROM minion_jobs
         WHERE name = 'subagent'
           AND status IN ('waiting', 'active', 'waiting-children')
           AND data->>'__owner_client_id' = c.client_id
      ), 0) AS inflight_count
    FROM oauth_clients c
    WHERE c.deleted_at IS NULL
      AND ('agent' = ANY (string_to_array(c.scope, ' ')) OR c.bound_tools IS NOT NULL)
    ORDER BY c.client_name ASC
  `;
  return rows.map(r => ({
    client_id: String(r.client_id),
    client_name: String(r.client_name ?? r.client_id),
    cap_usd_per_day: r.cap_usd_per_day !== null && r.cap_usd_per_day !== undefined
      ? parseFloat(String(r.cap_usd_per_day))
      : null,
    spent_cents_today: parseFloat(String(r.spent_cents_today ?? '0')),
    pending_cents: parseFloat(String(r.pending_cents ?? '0')),
    inflight_count: Number(r.inflight_count ?? 0),
  }));
}

/**
 * Skill-publishing status for the startup banner + operator nudge. When OFF,
 * connected agents (Codex / Claude Code / Perplexity / Cowork) cannot call
 * `list_skills` / `get_skill`, so the host's skill catalog is INVISIBLE to them
 * — the core tools (search / query / get_page / put_page / capture / think /
 * find_experts) still work. Pure so the banner value + nudge copy are
 * unit-tested without standing up a server. See `readMcpPublishSkills`
 * (skill-catalog.ts) for the config resolution this status reflects.
 */
export function skillPublishStatus(publishSkills: boolean): { bannerValue: string; nudge: string | null } {
  if (publishSkills) return { bannerValue: 'published', nudge: null };
  return {
    bannerValue: 'not published',
    nudge:
      "[serve-http] NOTE: skill publishing is OFF — connected agents can't call " +
      'list_skills / get_skill, so this brain’s skill catalog is invisible to them ' +
      '(core tools like search / query / think still work). Enable it with: ' +
      'gbrain config set mcp.publish_skills true',
  };
}

export async function runServeHttp(engine: BrainEngine, options: ServeHttpOptions) {
  const { port, tokenTtl, enableDcr, publicUrl, logFullParams } = options;
  // v0.34.1 (#864, D11): default bind flipped from 0.0.0.0 to 127.0.0.1.
  // gbrain's primary use case is a personal-knowledge brain on a laptop;
  // the pre-v0.34 default exposed brains on every interface. Server
  // operators who need remote access pass `--bind 0.0.0.0` (or a specific
  // interface). Declaring `--public-url` without `--bind` is almost always
  // a misconfiguration; we WARN to stderr at startup in that case rather
  // than silently binding loopback only.
  const bind = options.bind ?? '127.0.0.1';
  const config = loadConfig() || { engine: 'pglite' as const };

  if (logFullParams) {
    console.error(
      '[serve-http] WARNING: --log-full-params writes raw request payloads to mcp_request_log + SSE feed. Disable for shared dashboards or production.',
    );
  }

  if (publicUrl && options.bind === undefined) {
    console.error(
      '[serve-http] WARNING: --public-url is set but --bind is not. Default bind changed to 127.0.0.1 in v0.34.1; remote clients reaching the public URL will be refused. Pass --bind 0.0.0.0 to accept all interfaces.',
    );
  }

  // Skill-publishing status for the banner + nudge. Mirrors readMcpPublishSkills
  // (skill-catalog.ts): the DB plane (`gbrain config set`) wins over the file
  // plane. When OFF, a connected coding agent can't see the host's skill
  // catalog — surface that to the operator at startup rather than letting them
  // discover it via an empty list_skills on the agent side.
  let publishSkills = false;
  try {
    const dbVal = await engine.getConfig('mcp.publish_skills');
    publishSkills = dbVal != null ? dbVal === 'true' : config?.mcp?.publish_skills === true;
  } catch {
    publishSkills = config?.mcp?.publish_skills === true;
  }
  const skillStatus = skillPublishStatus(publishSkills);
  if (skillStatus.nudge) console.error(skillStatus.nudge);

  // Note when this brain ships a brain-resident pack so the operator knows
  // connecting harnesses will be offered it (only meaningful when publishing
  // is on — list_brain_skillpack is gated by the same flag). Fail-open.
  if (publishSkills) {
    try {
      const { loadAllSources } = await import('../core/sources-load.ts');
      const { loadSkillpackManifest } = await import('../core/skillpack/manifest-v1.ts');
      const { existsSync } = await import('fs');
      const { join } = await import('path');
      const srcs = await loadAllSources(engine);
      let n = 0;
      for (const s of srcs) {
        if (!s.local_path || !existsSync(join(s.local_path, 'skillpack.json'))) continue;
        try {
          if (loadSkillpackManifest(s.local_path).brain_resident === true) n++;
        } catch {
          /* malformed pack → ignore */
        }
      }
      if (n > 0) {
        console.error(
          `[serve-http] NOTE: ${n} source${n === 1 ? '' : 's'} ship a brain-resident skillpack — ` +
            'connecting harnesses can discover it via list_brain_skillpack and will be offered to install it.',
        );
      }
    } catch {
      /* fail-open: banner is cosmetic */
    }
  }

  // Engine-aware SQL adapter. Routes through engine.executeRaw on both
  // Postgres and PGLite — the OAuth/admin/auth surface no longer requires
  // a postgres.js singleton, so `gbrain serve --http` works against PGLite
  // brains too. The narrow SqlQuery contract is scalar-binds-only; JSONB
  // writes use executeRawJsonb (see mcp_request_log INSERT sites below).
  const sql = sqlQueryForEngine(engine);

  // Initialize OAuth provider. F12 cleanup: DCR-disable now flips a
  // constructor option instead of monkey-patching `_clientsStore` after
  // construction. Same outcome (no /register endpoint when --enable-dcr
  // is not passed); cleaner shape for tests and future maintainers.
  const oauthProvider = new GBrainOAuthProvider({
    sql,
    tokenTtl,
    dcrDisabled: !enableDcr,
  });

  // Sweep expired tokens on startup (non-blocking)
  try {
    const swept = await oauthProvider.sweepExpiredTokens();
    if (swept > 0) console.error(`Swept ${swept} expired tokens`);
  } catch (e) {
    console.error('Token sweep failed (non-blocking):', e instanceof Error ? e.message : e);
  }

  // v0.36.x #1024: bootstrap token sourcing.
  //
  // Default: regenerate per process start, print to stderr so the operator
  // can paste into /admin login. Stable across restarts only when env var
  // is set. The env override must be a strong secret — `[A-Za-z0-9_-]{32+}`
  // — otherwise refuse to start. Logging the bootstrap-token value every
  // restart is the original gripe; with `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` set
  // and `--suppress-bootstrap-token`, no value reaches the log.
  const resolved = resolveBootstrapToken(process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN);
  if (resolved.kind === 'error') {
    console.error(resolved.message);
    process.exit(1);
  }
  let bootstrapToken: string = resolved.token;
  let bootstrapFromEnv: boolean = resolved.fromEnv;
  const bootstrapHash = createHash('sha256').update(bootstrapToken).digest('hex');
  const suppressBootstrapPrint = options.suppressBootstrapToken === true;
  const adminSessions = new Map<string, number>(); // sessionId → expiresAt

  // SSE clients for live activity feed
  const sseClients = new Set<express.Response>();

  // Broadcast MCP request event to all SSE clients
  function broadcastEvent(event: Record<string, unknown>) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch { sseClients.delete(client); }
    }
  }

  // Express 5 app
  const app = express();
  app.set('json replacer', jsonBigIntReplacer);

  const portalSessionTtlMs = 30 * 24 * 60 * 60 * 1000;
  const portalSessions = new PortalSessionStore(
    process.env.GBRAIN_PORTAL_SESSION_FILE || require('path').join(process.env.HOME || '/home/avers', '.gbrain', 'portal_sessions.json'),
    portalSessionTtlMs,
  );
  const isSecurePortalRequest = (req: express.Request): boolean => req.secure || issuerUrl.protocol === 'https:';
  const portalCookieOptions = (req: express.Request, maxAge = portalSessionTtlMs) => ({
    httpOnly: true,
    secure: isSecurePortalRequest(req),
    sameSite: 'lax' as const,
    maxAge,
    path: '/',
  });
  const portalSessionToken = (req: express.Request): string => {
    const cookies = (req.cookies as Record<string, string> | undefined) || {};
    return cookies.__Host_gbrain_portal || cookies['__Host-gbrain_portal'] || cookies.gbrain_portal || '';
  };
  const clearPortalSessionCookies = (req: express.Request, res: express.Response): void => {
    res.clearCookie('__Host-gbrain_portal', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    res.clearCookie('gbrain_portal', { httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
    // Remove the legacy unsigned identity cookie during the migration release.
    res.clearCookie('session_user', { httpOnly: true, secure: isSecurePortalRequest(req), sameSite: 'lax', path: '/' });
  };
  const resolvePortalUser = (req: express.Request, res?: express.Response): string | null => {
    const token = portalSessionToken(req);
    const email = portalSessions.resolve(token);
    if (!email && res && (token || (req.cookies as Record<string, string> | undefined)?.session_user)) {
      clearPortalSessionCookies(req, res);
    }
    return email;
  };
  const issuePortalSession = (req: express.Request, res: express.Response, email: string): void => {
    const oldToken = portalSessionToken(req);
    if (oldToken) portalSessions.revoke(oldToken);
    clearPortalSessionCookies(req, res);
    const token = portalSessions.issue(email);
    res.cookie(portalSessionCookieName(isSecurePortalRequest(req)), token, portalCookieOptions(req));
  };

// === CUSTOM PORTAL AND LOGIN WORKFLOWS ===

const adminEmails = (() => {
  const envStr = process.env.GBRAIN_ADMIN_EMAILS;
  if (!envStr) return new Set<string>();
  return new Set(String(envStr).toLowerCase().split(',').map(x => x.trim()).filter(Boolean));
})();
function isAdminEmail(email: string | undefined): boolean {
  if (!email) return false;
  return adminEmails.has(String(email).toLowerCase().trim());
}

const otpPepper = randomBytes(32).toString('hex');
const pendingOtps = new Map<string, { codeHash: string; expiresAt: number; attempts: number }>();
const hashPortalOtp = (email: string, code: string) => createHash('sha256').update(otpPepper).update('\0').update(email).update('\0').update(code).digest('hex');

const userPermissionsPath = () => require('path').join(process.env.HOME || '/home/avers', '.gbrain', 'user_permissions.json');
const accessRequestsPath = () => require('path').join(process.env.HOME || '/home/avers', '.gbrain', 'access_requests.json');
const onboardingSeenPath = () => require('path').join(process.env.HOME || '/home/avers', '.gbrain', 'portal_onboarding_seen.json');
const readOnboardingSeen = () => {
  const fs = require('fs');
  try {
    const p = onboardingSeenPath();
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e3) {
    console.error('[Portal] Failed to read portal_onboarding_seen.json:', e3);
    return {};
  }
};
const hasSeenPortalOnboarding = (email: string) => !!readOnboardingSeen()[String(email || '').trim().toLowerCase()];
const markPortalOnboardingSeen = (email: string) => {
  const seen = readOnboardingSeen();
  seen[String(email || '').trim().toLowerCase()] = new Date().toISOString();
  const fs = require('fs');
  fs.writeFileSync(onboardingSeenPath(), JSON.stringify(seen, null, 2), 'utf8');
};

const sharedAccessArea = { id: "shared", sourceId: "shared", label: "Shared / Общая база", hint: "общие справочники, инструкции и корпоративная архитектура" };
const internalAccessAreas = [
  { id: "бухгалтерия", sourceId: "internal-accounting", label: "Бухгалтерия и финансы", hint: "финансы, сверки, платежи, налоги, управленческий учет" },
  { id: "юридическая-служба", sourceId: "internal-legal", label: "Юридическая служба", hint: "договоры, претензии, суды, корпоративные документы" },
  { id: "производство", sourceId: "internal-production", label: "Производство", hint: "внутренние показатели, сменные регламенты, технологические карты" },
  { id: "ит", sourceId: "internal-it", label: "ИТ", hint: "интеграции, API, схемы данных, эксплуатация систем" },
  { id: "кадры", sourceId: "internal-hr", label: "Кадры и HR", hint: "адаптация, роли, должностные требования, HR-процессы" },
  { id: "снабжение-и-закупки", sourceId: "internal-procurement", label: "Снабжение и закупки", hint: "поставщики, условия закупок, заявки, контроль остатков" },
  { id: "продажи-и-маркетинг", sourceId: "internal-sales-marketing", label: "Продажи и маркетинг", hint: "коммерческие правила, каналы спроса, аналитика продаж" },
  { id: "охрана-труда-и-безопасность", sourceId: "internal-safety", label: "Охрана труда и безопасность", hint: "ОТиТБ, инциденты, инструктажи, чек-листы" },
  { id: "руководство", sourceId: "internal-management", label: "Руководство и стратегия", hint: "закрытые планы, стратегические инициативы, протоколы" }
];
const managedAccessAreas = [sharedAccessArea, ...internalAccessAreas];
const getUserPermissions = async (email: string) => {
  const configPath = require('path').join(process.env.HOME || '/home/avers', '.gbrain', 'user_permissions.json');
  try {
    let data: any = {};
    if (require('fs').existsSync(configPath)) {
      data = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
    }
    if (data[email]) {
      return {
        source_id: data[email].source_id || 'shared',
        federated_read: data[email].federated_read || ['shared'],
        federated_write: data[email].federated_write || [data[email].source_id].filter(Boolean)
      };
    } else {
      const emailPrefix = email.split('@')[0].trim().toLowerCase();
      const sourceId = emailPrefix.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
      return {
        source_id: sourceId,
        federated_read: ['shared'],
        federated_write: [sourceId].filter(Boolean)
      };
    }
  } catch (err) {
    console.error(`[GBrain] Failed to read ${configPath}:`, err);
    return {
      source_id: 'shared',
      federated_read: ['shared'],
      federated_write: []
    };
  }
};
const managedAreaById = (areaId: string) => managedAccessAreas.find((a) => a.id === areaId);
const managedSourceIdForArea = (areaId: string) => managedAreaById(areaId)?.sourceId || null;

const escapeHtmlLocal = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[ch] || ch));

const requirePortalUser = (req: express.Request, res: express.Response): string | null => {
    const userEmail = resolvePortalUser(req, res);
    if (!userEmail) {
      res.status(401).json({ error: "Unauthorized: login through GBrain first" });
      return null;
    }
    return userEmail;
  }

const resolvePortalPath = (root: string, relativePathRaw: unknown, allowRoot = false): string | null =>
  resolvePortalPathSecure(root, relativePathRaw, allowRoot);
type PortalSourceRow = { id: string; name: string; local_path: string };
type PortalAccessRow = {
  area: string;
  source_id: string;
  read: boolean;
  write: boolean;
  requested_read?: boolean;
  requested_write?: boolean;
};
type PortalAccessRequest = {
  id: string;
  email: string;
  requested_at: string;
  requests: PortalAccessRow[];
  reason: string;
  status: string;
  approved_by?: string | null;
  approved_at?: string | null;
  decided_by?: string;
  decided_at?: string;
  approved_requests?: PortalAccessRow[];
  denied_requests?: PortalAccessRow[];
  rejection_reason?: string;
};
type PortalUserPermissions = {
  source_id?: string;
  federated_read?: string[];
  federated_write?: string[];
};

const saveInternalAccessRequest = async (userEmail: string, rawValues: unknown, reasonRaw: unknown): Promise<void> => {
    const selected = normalizeAccessRequestValues(rawValues);
    if (selected.length === 0)
      return;
    const perms = await getUserPermissions(userEmail);
    const existingRead = new Set(Array.isArray(perms.federated_read) ? perms.federated_read : []);
    const existingWrite = new Set(Array.isArray(perms.federated_write) ? perms.federated_write : []);
    if (perms.source_id) {
      existingRead.add(perms.source_id);
      existingWrite.add(perms.source_id);
    }
    const byArea = new Map<string, PortalAccessRow>();
    for (const item of selected) {
      const [area, level] = item.split(":");
      if (!managedAccessAreas.some((a) => a.id === area))
        continue;
      const sourceId = managedSourceIdForArea(area);
      if (!sourceId)
        continue;
      const current = byArea.get(area) || { area, source_id: sourceId, read: false, write: false };
      if (level === "read")
        current.read = true;
      if (level === "write") {
        current.write = true;
        current.read = true;
      }
      byArea.set(area, current);
    }
    const requests = Array.from(byArea.values()).map((r4): PortalAccessRow | null => {
      const sourceId = r4.source_id || managedSourceIdForArea(r4.area);
      if (!sourceId)
        return null;
      const missingWrite = !!r4.write && !existingWrite.has(sourceId);
      const missingRead = (!!r4.read || !!r4.write) && !existingRead.has(sourceId) && !missingWrite;
      if (!missingRead && !missingWrite)
        return null;
      return { ...r4, source_id: sourceId, read: missingRead || missingWrite, write: missingWrite };
    }).filter((row): row is PortalAccessRow => row !== null);
    if (requests.length === 0)
      return;
    const fs = require("fs");
    const path = require("path");
    const requestPath = path.join(process.env.HOME || "/home/avers", ".gbrain", "access_requests.json");
    let data: PortalAccessRequest[] = [];
    try {
      if (fs.existsSync(requestPath)) {
        const parsed = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        if (Array.isArray(parsed))
          data = parsed;
      }
    } catch (e3) {
      console.error("[Auth] Error reading access_requests.json:", e3);
    }
    const request2 = {
      id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      email: userEmail,
      requested_at: new Date().toISOString(),
      requests,
      reason: String(reasonRaw || "").trim().slice(0, 2000),
      status: "pending",
      approved_by: null,
      approved_at: null
    };
    data.push(request2);
    fs.writeFileSync(requestPath, JSON.stringify(data, null, 2), "utf8");
    console.log(`[Auth] Saved access request ${request2.id} for ${userEmail}`);
    try {
      const body2 = [
        `Новая заявка GBrain на доступ`,
        ``,
        `Сотрудник: ${userEmail}`,
        `ID заявки: ${request2.id}`,
        `Время: ${request2.requested_at}`,
        ``,
        `Запрошенные области:`,
        ...requests.map((r4) => `- ${r4.area} (${r4.source_id}): ${r4.write ? "чтение + запись" : "чтение"}`),
        ``,
        `Причина:`,
        request2.reason || "(не указана)",
        ``,
        `Админка заявок: ${publicUrl || "http://127.0.0.1:" + port}/admin/access-requests`,
        ``,
        `Файл заявок: ${requestPath}`
      ].join(`
`);
      const { spawn: spawn5 } = require("child_process");
      const proc = spawn5("/home/avers/.gbrain/send_access_request.py", [userEmail, body2], { detached: true, stdio: "ignore" });
      proc.unref();
    } catch (e3) {
      console.error("[Auth] Failed to send access request notification:", e3);
    }
  }

const normalizeAccessRequestValues = (raw: unknown): string[] => {
    if (!raw)
      return [];
    const values2: unknown[] = Array.isArray(raw) ? raw : [raw];
    return values2.map((v7) => String(v7)).filter(Boolean);
  }

const getAllowedSourceIdsForUser = async (email: string): Promise<string[]> => {
    const perms = await getUserPermissions(email);
    const ids = new Set<string>();
    if (perms.source_id)
      ids.add(perms.source_id);
    for (const id of perms.federated_read || [])
      ids.add(id);
    return Array.from(ids).filter(Boolean);
  }

const getSourceRowsForUser = async (email: string): Promise<PortalSourceRow[]> => {
    const allowed = await getAllowedSourceIdsForUser(email);
    const rows: PortalSourceRow[] = [];
    for (const id of allowed) {
      try {
        const found = await sql`SELECT id, name, local_path FROM sources WHERE id = ${id} LIMIT 1`;
        if (found[0]?.local_path)
          rows.push(found[0] as unknown as PortalSourceRow);
      } catch (e3) {
        console.error(`[Portal] Failed to read source ${id}:`, e3);
      }
    }
    return rows;
  }

const loadJsonFileLocal = <T>(filePath: string, fallback: T): T => {
    const fs = require("fs");
    try {
      if (!fs.existsSync(filePath))
        return fallback;
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch (e3) {
      console.error(`[GBrain] Failed to read ${filePath}:`, e3);
      return fallback;
    }
  }

const writeJsonFileLocal = (filePath: string, value: unknown): void => {
    const fs = require("fs");
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  }

const personalSourceIdFromEmail = (email: string): string => {
    const prefix = String(email || "").split("@")[0].trim().toLowerCase();
    return prefix.replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "user";
  }

const personalDirNameFromEmail = (email: string): string => {
    const prefix = String(email || "").split("@")[0].trim().toLowerCase();
    return prefix.replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "user";
  }

const writeIfMissingLocal = (filePath: string, content: string) => {
    const fs = require("fs");
    const path = require("path");
    if (fs.existsSync(filePath))
      return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return true;
  }

const createPersonalSourceSkeleton = (root: string) => {
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(root, { recursive: true });
    writeIfMissingLocal(path.join(root, "README.md"), `# Добро пожаловать в вашу личную базу знаний GBrain!\n\nЭто ваше персональное цифровое рабочее пространство. Всё, что вы здесь запишете, будет известно вашему ИИ-ассистенту и поможет ему эффективнее отвечать на ваши вопросы, писать отчеты и автоматизировать задачи.\n\n## Как этим пользоваться\n\n1. Ведите заметки в Obsidian или любом другом markdown-редакторе.\n2. Просите ИИ-ассистента добавлять заметки, проекты и ежедневные отчеты.\n3. Личные данные хранятся в вашей персональной области и не публикуются в общую базу без явного решения.\n`);
    writeIfMissingLocal(path.join(root, "AGENTS.md"), `# AGENTS.md — правила ведения личной базы знаний\n\n## Структура\n\n- \`notes/\` — личные заметки, идеи, шпаргалки, профессиональные знания.\n- \`projects/\` — проекты, задачи, планы и вехи.\n- \`daily/\` — ежедневные отчеты и планы.\n- \`_templates/\` — шаблоны заметок.\n- \`_attachments/\` — документы и медиа-файлы.\n\n## Правила\n\n1. Перед созданием новой заметки проверь, нет ли похожей.\n2. Перекрестные ссылки оформляй в стиле Obsidian: \`[[имя-заметки]]\`.\n3. Личные заметки не записывай в \`shared\` или \`internal-*\` без явного указания пользователя.\n4. Если пользователь явно просит записать документ в закрытую область ИТ, используй \`source_id: internal-it\` и \`access_area: ит\`.\n`);
    writeIfMissingLocal(path.join(root, "index.md"), `# Навигация по Базе Знаний\n\nДобро пожаловать в ваш личный навигатор знаний.\n\n## Разделы\n\n- [[notes/index|Личные заметки]] — профессиональные знания, памятки и шпаргалки.\n- [[projects/index|Проекты]] — рабочие задачи и вехи.\n- [[daily/index|Ежедневный лог]] — хронология работы, планы и отчеты.\n`);
    writeIfMissingLocal(path.join(root, "notes", "index.md"), `---\ntitle: Личные заметки\nstatus: active\ntags: [личная-база, заметки]\n---\n\n# Личные заметки\n\nЗдесь хранятся личные рабочие заметки и справочные материалы.\n`);
    writeIfMissingLocal(path.join(root, "projects", "index.md"), `---\ntitle: Проекты\nstatus: active\ntags: [личная-база, проекты]\n---\n\n# Проекты\n\nЗдесь хранятся проекты, задачи, планы и вехи.\n`);
    writeIfMissingLocal(path.join(root, "daily", "index.md"), `---\ntitle: Ежедневный лог\nstatus: active\ntags: [личная-база, daily]\n---\n\n# Ежедневный лог\n\nЗдесь можно вести ежедневные отчеты и планы.\n`);
    writeIfMissingLocal(path.join(root, "_templates", "note.md"), `---\ntitle: <Название заметки>\ncreated: YYYY-MM-DD\nupdated: YYYY-MM-DD\ntags: [личная-база]\nstatus: draft\n---\n\n# <Название заметки>\n`);
    writeIfMissingLocal(path.join(root, "_templates", "project.md"), `---\ntitle: <Название проекта>\ncreated: YYYY-MM-DD\nupdated: YYYY-MM-DD\ntags: [личная-база, проект]\nstatus: draft\n---\n\n# <Название проекта>\n`);
    writeIfMissingLocal(path.join(root, "_templates", "daily.md"), `---\ntitle: Ежедневный отчет YYYY-MM-DD\ncreated: YYYY-MM-DD\nupdated: YYYY-MM-DD\ntags: [личная-база, daily]\nstatus: draft\n---\n\n# Ежедневный отчет YYYY-MM-DD\n`);
  }

const ensurePersonalGitRepo = (root: string) => {
    const fs = require("fs");
    const { spawnSync } = require("child_process");
    if (!fs.existsSync(`${root}/.git`)) {
      spawnSync("git", ["init", "-q"], { cwd: root });
    }
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    if (String(status.stdout || "").trim()) {
      spawnSync("git", ["add", "."], { cwd: root });
      spawnSync("git", ["-c", "user.name=GBrain Admin", "-c", "user.email=vyacheslav.zakharov@avers.kz", "commit", "-q", "-m", "Initialize personal GBrain source"], { cwd: root });
    }
  }

const schedulePersonalSourceSync = (sourceId: string) => {
    try {
      const { spawn } = require("child_process");
      const script = `set -e; source "$HOME/.gbrain/env.sh" 2>/dev/null || true; source "$HOME/.gbrain/pg.sh" 2>/dev/null || true; export PATH="$HOME/.bun/bin:$PATH"; gbrain sync --source ${JSON.stringify(sourceId)} --no-pull --yes; gbrain extract --stale --source-id ${JSON.stringify(sourceId)} --yes`;
      const proc = spawn("bash", ["-lc", script], { detached: true, stdio: "ignore" });
      proc.unref();
    } catch (e3) {
      console.error(`[Provision] Failed to schedule sync for ${sourceId}:`, e3);
    }
  }

const ensurePortalUserProvisioned = async (emailRaw: string) => {
    const fs = require("fs");
    const path = require("path");
    const email = String(emailRaw || "").trim().toLowerCase();
    if (!email.endsWith("@avers.kz"))
      throw new Error("Only @avers.kz users can be provisioned");
    const sourceId = personalSourceIdFromEmail(email);
    const dirName = personalDirNameFromEmail(email);
    const personalRoot = path.join(process.env.HOME || "/home/avers", "brain-repos", "personal", dirName);
    const displayName = `Личная база (${dirName})`;
    let shouldSync = false;

    if (!fs.existsSync(personalRoot)) {
      createPersonalSourceSkeleton(personalRoot);
      ensurePersonalGitRepo(personalRoot);
      shouldSync = true;
      console.log(`[Provision] Created personal source directory for ${email}: ${personalRoot}`);
    } else {
      ensurePersonalGitRepo(personalRoot);
    }

    const existingSource = await sql`SELECT id FROM sources WHERE id = ${sourceId} LIMIT 1`;
    if (!existingSource[0]) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $2, $3, $4::text::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [sourceId, displayName, personalRoot, JSON.stringify({ federated: false, contextual_retrieval_mode: "balanced" })],
      );
      shouldSync = true;
      console.log(`[Provision] Registered personal source ${sourceId} for ${email}`);
    }

    const permsPath = userPermissionsPath();
    const perms = loadJsonFileLocal<Record<string, PortalUserPermissions>>(permsPath, {});
    const existing = perms[email] || { source_id: sourceId, federated_read: [], federated_write: [] };
    existing.source_id = existing.source_id || sourceId;
    const read = new Set(Array.isArray(existing.federated_read) ? existing.federated_read : []);
    const write = new Set(Array.isArray(existing.federated_write) ? existing.federated_write : []);
    read.add(sourceId);
    read.add("shared");
    write.add(sourceId);
    existing.federated_read = Array.from(read).filter(Boolean);
    existing.federated_write = Array.from(write).filter(Boolean);
    if (JSON.stringify(perms[email]) !== JSON.stringify(existing)) {
      perms[email] = existing;
      writeJsonFileLocal(permsPath, perms);
      console.log(`[Provision] Updated permissions for ${email}`);
    }

    if (shouldSync)
      schedulePersonalSourceSync(sourceId);
  }

const readAccessRequests = (): PortalAccessRequest[] => {
    const data = loadJsonFileLocal<PortalAccessRequest[]>(accessRequestsPath(), []);
    return Array.isArray(data) ? data : [];
  }

const writeAccessRequests = (items: PortalAccessRequest[]): void => writeJsonFileLocal(accessRequestsPath(), items);




  // v0.41.3 (T8): configurable trust-proxy via GBRAIN_HTTP_TRUST_PROXY env.
  // Default 'loopback' (trust Caddy/Tailscale on the same host) preserves
  // pre-v0.41.3 behavior. Operators behind Fly.io / Render / Vercel / nginx
  // set GBRAIN_HTTP_TRUST_PROXY=1 (one hop) so X-Forwarded-For lands as the
  // real client IP for rate-limiting and req.secure detection. The legacy
  // transport already reads this env var (src/mcp/http-transport.ts:111)
  // for the same purpose; T8 makes the Express path agree.
  app.set('trust proxy', resolveTrustProxy(process.env.GBRAIN_HTTP_TRUST_PROXY));


  // v0.41.3 (T8): configurable trust-proxy via GBRAIN_HTTP_TRUST_PROXY env.
  // Default 'loopback' (trust Caddy/Tailscale on the same host) preserves
  // pre-v0.41.3 behavior. Operators behind Fly.io / Render / Vercel / nginx
  // set GBRAIN_HTTP_TRUST_PROXY=1 (one hop) so X-Forwarded-For lands as the
  // real client IP for rate-limiting and req.secure detection. The legacy
  // transport already reads this env var (src/mcp/http-transport.ts:111)
  // for the same purpose; T8 makes the Express path agree.
  app.set('trust proxy', resolveTrustProxy(process.env.GBRAIN_HTTP_TRUST_PROXY));

  // ---------------------------------------------------------------------------
  // Cookie parsing — required for /admin auth (express 5 has no built-in)
  // ---------------------------------------------------------------------------
  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // CORS (v0.41.3, T7 — default-deny on every OAuth endpoint)
  // ---------------------------------------------------------------------------
  // Pre-v0.41.3 every OAuth endpoint used bare `cors()` which defaults to
  // `Access-Control-Allow-Origin: *` — any web origin could complete a token
  // exchange from a logged-in operator's browser. The fix parses
  // GBRAIN_HTTP_CORS_ORIGIN the same way the legacy transport already does
  // (src/mcp/http-transport.ts:parseCorsAllowlist) and gates every OAuth
  // surface behind the allowlist. When the env var is unset the OAuth
  // endpoints reject all cross-origin requests (default deny). Same-origin
  // requests are unaffected because browsers send no Origin header for them.
  //
  // The /admin SPA is the one cross-origin caller we expect on a personal
  // laptop install; it ships co-located with the brain and uses
  // same-origin XHR, so the lockdown doesn't break it.
  const corsAllowlistOAuth = parseCorsAllowlistOAuth();
  if (!corsAllowlistOAuth && bind === '0.0.0.0') {
    console.error(
      '[serve-http] WARNING: --bind 0.0.0.0 is set but GBRAIN_HTTP_CORS_ORIGIN is unset. OAuth endpoints will reject ALL cross-origin requests until you set the env var (comma-separated origins).',
    );
  }
  const corsOAuthOptions: cors.CorsOptions = {
    origin: resolveCorsOrigin(corsAllowlistOAuth),
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  };
  app.use('/mcp', cors(corsOAuthOptions));
  app.use('/token', cors(corsOAuthOptions));
  app.use('/authorize', cors(corsOAuthOptions));
  app.use('/register', cors(corsOAuthOptions));
  app.use('/revoke', cors(corsOAuthOptions));

  // ---------------------------------------------------------------------------
  // Custom client_credentials handler (before mcpAuthRouter)
  // SDK's token handler only supports authorization_code and refresh_token
  // ---------------------------------------------------------------------------
  const ccRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again in 15 minutes.' },
  });

  // Magic-link rate limiter: 10 requests/min/IP. The bootstrap token is
  // 64-char hex (unguessable) so brute-forcing is computationally
  // infeasible — but a misconfigured client looping on /admin/auth/:bad
  // could DoS the server's CPU on sha256 + the inline HTML response.
  // Defense-in-depth on the highest-privileged URL the server exposes.
  const adminAuthRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many magic-link attempts. Wait a minute before trying again.',
  });

  const portalOtpSendRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Слишком много запросов кода. Повторите позже.',
  });
  const portalOtpVerifyRateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Слишком много попыток входа. Повторите позже.',
  });

  const mcpRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { jsonrpc: '2.0', error: { code: -32000, message: 'Too many MCP requests. Try again in a minute.' }, id: null },
  });

  app.post('/token', ccRateLimiter, express.urlencoded({ extended: false }), async (req, res, next) => {
    if (req.body?.grant_type !== 'client_credentials') {
      return next(); // Fall through to confidential-client handler or SDK
    }

    try {
      const { client_id, client_secret, scope } = req.body;
      if (!client_id || !client_secret) {
        res.status(400).json({ error: 'invalid_request', error_description: 'client_id and client_secret required' });
        return;
      }

      const tokens = await oauthProvider.exchangeClientCredentials(client_id, client_secret, scope);
      res.json(tokens);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      res.status(400).json({ error: 'invalid_grant', error_description: msg });
    }
  });

  // ---------------------------------------------------------------------------
  // v0.37.7.0 #1166: Custom authorization_code + refresh_token handler for
  // CONFIDENTIAL clients. The MCP SDK's clientAuth middleware does plaintext
  // `client.client_secret !== presented_secret` compare; we store
  // SHA-256 hashes, so the SDK's compare always fails for confidential
  // clients. This middleware verifies the secret hash ourselves before
  // calling the provider's exchange methods directly.
  //
  // Public clients (token_endpoint_auth_method='none') fall through to
  // the SDK's handler — the v0.34.1.0 PKCE path stays canonical.
  // ---------------------------------------------------------------------------
  app.post('/token', ccRateLimiter, async (req, res, next) => {
    const grantType = req.body?.grant_type;
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return next();
    }

    // Detect confidential auth: either client_secret in body
    // (client_secret_post) OR Authorization: Basic header
    // (client_secret_basic). Public PKCE clients omit both.
    const bodySecret: string | undefined = req.body?.client_secret;
    let clientId: string | undefined = req.body?.client_id;
    let presentedSecret: string | undefined = bodySecret;
    const authHeader = (req.headers.authorization ?? '').toString();
    if (!presentedSecret && authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx > -1) {
          clientId ||= decodeURIComponent(decoded.slice(0, idx));
          presentedSecret = decodeURIComponent(decoded.slice(idx + 1));
        }
      } catch {
        // Malformed Basic header → falls through; SDK will reject
      }
    }
    if (!clientId || !presentedSecret) {
      return next(); // Public client path; SDK handles.
    }

    try {
      const client = await oauthProvider.verifyConfidentialClientSecret(clientId, presentedSecret);
      let tokens;
      if (grantType === 'authorization_code') {
        const code = req.body.code;
        const redirectUri = req.body.redirect_uri;
        const codeVerifier = req.body.code_verifier;
        if (!code) {
          res.status(400).json({ error: 'invalid_request', error_description: 'code required' });
          return;
        }
        tokens = await oauthProvider.exchangeAuthorizationCode(client, code, codeVerifier, redirectUri);
      } else {
        const refreshToken = req.body.refresh_token;
        const scopeParam = typeof req.body.scope === 'string' ? req.body.scope.split(/\s+/) : undefined;
        if (!refreshToken) {
          res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
          return;
        }
        tokens = await oauthProvider.exchangeRefreshToken(client, refreshToken, scopeParam);
      }
      res.json(tokens);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      // RFC 6749: invalid_client for auth failures, invalid_grant for
      // code/token problems. "Invalid client" → 401; everything else 400.
      if (msg === 'Invalid client' || msg === 'Client has been revoked') {
        res.status(401).json({ error: 'invalid_client', error_description: msg });
      } else {
        res.status(400).json({ error: 'invalid_grant', error_description: msg });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // MCP SDK Auth Router (OAuth endpoints)
  // ---------------------------------------------------------------------------
  // The issuer URL goes into discovery metadata + token iss claims. It MUST
  // match the URL clients actually hit, or strict OAuth clients reject tokens
  // (RFC 8414 §3.3). Honor --public-url for production deployments behind
  // reverse proxies / tunnels; default to localhost for dev.
  const issuerUrl = new URL(publicUrl || `http://localhost:${port}`);

  // F9: cookie `secure` flag honors both the request's TLS state (req.secure
  // is set when express trust-proxy lands an X-Forwarded-Proto: https) AND
  // the operator's declared issuer protocol (so a Cloudflare-tunnel deploy
  // where the connection inside the tunnel looks like http but the public
  // URL is https still tags cookies Secure). Without this, an attacker on
  // the network path could MITM the admin cookie over plaintext.
  const adminCookie = (req: Request, maxAge: number) => ({
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: req.secure || issuerUrl.protocol === 'https:',
    maxAge,
    path: '/admin',
  });

  const authRouterOptions: any = {
    provider: oauthProvider,
    issuerUrl,
    // v0.28: scopesSupported sourced from ALLOWED_SCOPES_LIST so MCP clients
    // (Claude Desktop, ChatGPT, Perplexity) can discover sources_admin and
    // users_admin via /.well-known/oauth-authorization-server. The legacy
    // ['read','write','admin'] list left those new scopes invisible.
    scopesSupported: [...ALLOWED_SCOPES_LIST],
    resourceName: 'GBrain MCP Server',
  };

  // F12: DCR disable lives on the provider's constructor option above. The
  // SDK's mcpAuthRouter reads provider.clientsStore once and only wires up
  // /register when the store exposes registerClient — so passing dcrDisabled
  // to the constructor is sufficient. No monkey-patching here.

  const authRouter = mcpAuthRouter(authRouterOptions);

  // Patch the SDK's OAuth metadata to include client_credentials grant type.
  // The SDK hardcodes ['authorization_code', 'refresh_token'] — we intercept
  // the response and add client_credentials before it reaches the client.
  app.use((req, res, next) => {
    if (req.path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      const origJson = res.json.bind(res);
      (res as any).json = (body: any) => {
        if (body?.grant_types_supported && !body.grant_types_supported.includes('client_credentials')) {
          body.grant_types_supported.push('client_credentials');
        }
        return origJson(body);
      };
    }
    next();
  });

const escapePortalHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
const portalLoginHtml = (title: string, body: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapePortalHtml(title)}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#151515;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(420px,calc(100vw - 32px));padding:28px;background:#242424;border:1px solid #3b3b3b;border-radius:12px}h1{font-size:22px;margin:0 0 10px}.muted{color:#aaa;font-size:14px;line-height:1.45}label{display:block;margin:18px 0 7px}input{width:100%;padding:12px;background:#181818;color:#fff;border:1px solid #555;border-radius:7px;font-size:16px}button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:7px;background:#1677ff;color:#fff;font-weight:700;cursor:pointer}</style></head><body><main class="card">${body}</main></body></html>`;

app.get("/login", (req: any, res: any) => {
    if (resolvePortalUser(req, res)) return res.redirect("/portal");
    const oauthQuery = new URLSearchParams(req.query as Record<string, string>).toString();
    res.type("html").send(portalLoginHtml("Вход в GBrain", `<h1>Вход в GBrain</h1><p class="muted">Введите корпоративный email. Одноразовый код действует 10 минут.</p><form action="/login/send-code" method="POST"><input type="hidden" name="oauth_query" value="${escapePortalHtml(oauthQuery)}"><label for="email">Рабочий email</label><input type="email" id="email" name="email" placeholder="user@avers.kz" autocomplete="email" required><button type="submit">Получить код</button></form>`));
  });

  app.post("/login/send-code", portalOtpSendRateLimiter, express.urlencoded({ extended: false }), async (req: any, res: any) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const oauthQuery = String(req.body?.oauth_query || "");
    if (!/^[^@\s]+@avers\.kz$/.test(email)) return res.status(400).send("Допускаются только корпоративные адреса @avers.kz");
    const code = randomInt(100000, 1000000).toString();
    pendingOtps.set(email, { codeHash: hashPortalOtp(email, code), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });
    const { spawnSync } = require("child_process");
    const sent = spawnSync("/home/avers/.gbrain/send_otp.py", [email, code], { encoding: "utf8", timeout: 15000 });
    if (sent.error || sent.status !== 0) {
      pendingOtps.delete(email);
      console.error(`[OTP] Delivery failed for ${email}:`, sent.error?.message || String(sent.stderr || "sender failed").trim());
      return res.status(500).send("Ошибка при отправке письма с кодом подтверждения.");
    }
    res.type("html").send(portalLoginHtml("Подтверждение входа", `<h1>Введите код</h1><p class="muted">Код отправлен на ${escapePortalHtml(email)}.</p><form action="/login/verify-code" method="POST"><input type="hidden" name="email" value="${escapePortalHtml(email)}"><input type="hidden" name="oauth_query" value="${escapePortalHtml(oauthQuery)}"><label for="code">6-значный код</label><input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus><button type="submit">Войти</button></form>`));
  });

  app.post("/login/verify-code", portalOtpVerifyRateLimiter, express.urlencoded({ extended: false }), async (req: any, res: any) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const oauthQuery = String(req.body?.oauth_query || "");
    const saved = pendingOtps.get(email);
    if (!saved || saved.expiresAt < Date.now()) {
      pendingOtps.delete(email);
      return res.status(400).send("Код истёк или не запрашивался. Запросите новый код.");
    }
    saved.attempts += 1;
    if (saved.attempts > 5) {
      pendingOtps.delete(email);
      return res.status(429).send("Превышено число попыток. Запросите новый код.");
    }
    if (!/^\d{6}$/.test(code) || !safeHexEqual(saved.codeHash, hashPortalOtp(email, code))) {
      return res.status(400).send("Неверный код подтверждения.");
    }
    pendingOtps.delete(email);
    try {
      await ensurePortalUserProvisioned(email);
    } catch (e) {
      console.error(`[Provision] Failed to provision ${email}:`, e);
      return res.status(500).send("Не удалось подготовить личную базу GBrain. Обратитесь к администратору.");
    }
    issuePortalSession(req, res, email);
    const oauthParams = new URLSearchParams(oauthQuery);
    return res.redirect(oauthParams.get("client_id") ? `/authorize?${oauthParams.toString()}` : "/portal");
  });

  app.post('/logout', (req: Request, res: Response) => {
    portalSessions.revoke(portalSessionToken(req));
    clearPortalSessionCookies(req, res);
    res.status(204).end();
  });

app.get("/portal/welcome", async (req: any, res: any) => {
    const userEmail = resolvePortalUser(req, res);
    if (!userEmail)
      return res.redirect("/login");
    try {
      await ensurePortalUserProvisioned(String(userEmail));
    } catch (e3) {
      console.error(`[Provision] Failed to provision ${userEmail} from welcome:`, e3);
      return res.status(500).send("Не удалось подготовить личную базу GBrain. Обратитесь к администратору.");
    }
    const areas = managedAccessAreas.map((a) => `
      <div class="area">
        <div><b>${escapeHtmlLocal(a.label)}</b><small>${escapeHtmlLocal(a.hint)}</small></div>
        <label><input type="checkbox" name="access" value="${escapeHtmlLocal(a.id)}:read"> чтение</label>
        <label><input type="checkbox" name="access" value="${escapeHtmlLocal(a.id)}:write"> запись</label>
      </div>`).join("\n");
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Добро пожаловать в GBrain</title><style>
body{margin:0;background:#151515;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.55}.wrap{max-width:920px;margin:0 auto;padding:32px}.card{background:#202028;border:1px solid #333;border-radius:12px;padding:22px;margin:16px 0}.muted{color:#aaa}.btn{display:inline-block;background:#007acc;color:white;border:0;border-radius:7px;padding:10px 14px;text-decoration:none;cursor:pointer;font-weight:600}.btn.gray{background:#444}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.area{display:flex;gap:10px;border:1px solid #333;border-radius:8px;padding:10px;background:#191919}.area small{display:block;color:#aaa;margin-top:3px}.reason{width:100%;min-height:80px;background:#151515;color:#fff;border:1px solid #444;border-radius:8px;padding:10px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}@media(max-width:720px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
  <h1>GBrain: первый вход</h1>
  <div class="muted">Вы вошли как ${escapeHtmlLocal(userEmail)}. Личная база уже подготовлена автоматически.</div>
  <div class="card"><h2>Что здесь есть</h2><ol>
    <li><b>Личная база</b> — ваши заметки, проекты и ежедневные записи. По умолчанию запись идёт туда.</li>
    <li><b>Shared / Общая база</b> — корпоративные справочники и общие инструкции, доступна на чтение.</li>
    <li><b>Закрытые разделы</b> — ИТ, производство, кадры и другие internal-области выдаются по заявке администратора.</li>
  </ol></div>
  <div class="card"><h2>Запросить доступ</h2><p class="muted">Отметьте разделы, которые нужны для работы. Заявка уйдет администратору на почту и появится в админке.</p>
    <form method="POST" action="/portal/welcome">
      <div class="grid">${areas}</div>
      <p><label>Зачем нужен доступ</label><textarea class="reason" name="reason" placeholder="Например: нужен доступ к разделу ИТ для работы с интеграциями"></textarea></p>
      <div class="actions"><button class="btn" type="submit">Отправить заявку и открыть портал</button><button class="btn gray" type="submit" name="skip" value="1">Открыть портал без заявки</button></div>
    </form>
  </div>
  <div class="card"><h2>Ссылка на портал</h2><p><a class="btn" href="/portal/welcome/skip">Открыть портал знаний</a></p><p class="muted">Если вы уже вошли на этом компьютере, GBrain может использовать cookie и не спрашивать почту повторно.</p></div>
</div></body></html>`);
  });

app.get("/portal/welcome/skip", (req: any, res: any) => {
    const userEmail = resolvePortalUser(req, res);
    if (!userEmail)
      return res.redirect("/login");
    markPortalOnboardingSeen(String(userEmail));
    res.redirect("/portal");
  });

app.post("/portal/welcome", express.urlencoded({ extended: false }), async (req: any, res: any) => {
    const userEmail = resolvePortalUser(req, res);
    if (!userEmail)
      return res.redirect("/login");
    try {
      await ensurePortalUserProvisioned(String(userEmail));
      if (!req.body?.skip)
        await saveInternalAccessRequest(String(userEmail), req.body?.access, req.body?.reason);
      markPortalOnboardingSeen(String(userEmail));
      res.redirect("/portal");
    } catch (e3) {
      console.error(`[Portal] Failed to handle welcome for ${userEmail}:`, e3);
      res.status(500).send("Не удалось сохранить заявку. Обратитесь к администратору.");
    }
  });

// Temporary rollback surface retained for one release. The production route below
// serves the componentized Portal SPA; remove this legacy handler after acceptance.
app.get("/portal-legacy", (req, res) => {
    return res.status(410).type('text').send('Legacy Portal disabled after SPA migration');
    /* c8 ignore start */ // retained temporarily only as rollback source text
    const userEmail = resolvePortalUser(req, res);
    if (!userEmail)
      return res.redirect("/login");
    if (!hasSeenPortalOnboarding(String(userEmail)))
      return res.redirect("/portal/welcome");
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>GBrain Portal</title><style>
*{box-sizing:border-box}body{margin:0;background:#151515;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;height:100vh;display:grid;grid-template-columns:360px 1fr}.sidebar{border-right:1px solid #333;background:#202020;overflow:auto;padding:16px}.main{overflow:auto;padding:24px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:16px}.muted{color:#aaa;font-size:13px}.source-select{width:100%;background:#1d1d1d;color:#e5e5e5;border:1px solid #3a3a3a;border-radius:8px;padding:10px;margin-bottom:12px;font:inherit}.source-select:focus{outline:0;border-color:#007acc;box-shadow:0 0 0 2px rgba(0,122,204,.25)}.entry{padding:8px 10px;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center}.entry:hover{background:#2b2b2b}.entry-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.crumb{color:#8cc8ff;cursor:pointer}.viewer{background:#1d1d1d;border:1px solid #333;border-radius:8px;padding:22px;min-height:260px}.markdown{line-height:1.65;max-width:980px}.markdown h1,.markdown h2,.markdown h3{color:#fff;margin:1.2em 0 .5em}.markdown h1{border-bottom:1px solid #444;padding-bottom:.25em}.markdown code{background:#2b2b2b;border:1px solid #3c3c3c;border-radius:4px;padding:1px 5px}.markdown pre{background:#111;border:1px solid #333;border-radius:8px;padding:14px;overflow:auto}.markdown pre code{background:transparent;border:0;padding:0}.markdown blockquote{border-left:3px solid #007acc;margin:1em 0;padding:.2em 1em;color:#cfcfcf;background:#202a33}.markdown a{color:#8cc8ff}.markdown .table-wrap{overflow:auto;margin:1em 0;border:1px solid #3a3a3a;border-radius:8px}.markdown table{width:100%;border-collapse:collapse;background:#191919}.markdown th,.markdown td{border:1px solid #3a3a3a;padding:8px 10px;vertical-align:top;text-align:left}.markdown th{background:#242424;color:#fff;font-weight:700}.markdown tr:nth-child(even) td{background:#202020}.btn{background:#007acc;color:white;border:0;border-radius:6px;padding:8px 12px;text-decoration:none;display:inline-block}.error{color:#ff9c9c}.search{margin:14px 0}.search input{width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#171717;color:#fff}.search-results{margin-top:8px;border-top:1px solid #333}.badge{font-size:11px;color:#bbb;background:#333;border-radius:999px;padding:2px 7px}</style></head><body>
<aside class="sidebar"><h2>GBrain</h2><div class="muted">${escapeHtmlLocal(userEmail)} \xB7 просмотр без редактирования</div><div id="adminBtnSection" style="display:none;gap:8px;flex-wrap:wrap;margin:12px 0"><a class="btn" href="/admin/access-requests">Заявки на доступ <span id="accessReqBadge" class="badge" style="display:none;background:#ffd479;color:#111;margin-left:6px"></span></a></div><div class="search"><input id="searchBox" type="search" placeholder="Поиск по доступным файлам..."><div id="searchResults" class="search-results"></div></div><h3>Источники</h3><div id="sources"></div><h3>Папки и файлы</h3><div id="tree" class="muted">Выберите источник</div></aside>
<main class="main"><div class="top"><div><h2 id="title">Портал знаний</h2><div id="breadcrumbs" class="muted"></div></div><a class="btn" href="/authorize" onclick="history.back();return false">Назад</a></div><div id="viewer" class="viewer muted">Выберите markdown-файл для просмотра или другой файл для скачивания.</div></main>
<script>
let currentSource=null,currentPath='',searchTimer=null;const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function api(url){const r=await fetch(url);if(!r.ok)throw new Error(await r.text());return r.json()}
function fileIcon(name,type,isText){if(type==='dir')return '\u{1F4C1}';const n=String(name||'').toLowerCase();if(n.endsWith('.md')||n.endsWith('.markdown'))return '\u{1F4DD}';if(n.endsWith('.txt'))return '\u{1F4C4}';if(n.endsWith('.pdf'))return '\u{1F4D5}';if(['.png','.jpg','.jpeg','.gif','.webp','.svg'].some(ext=>n.endsWith(ext)))return '\u{1F5BC}\uFE0F';if(['.xlsx','.xls','.csv'].some(ext=>n.endsWith(ext)))return '\u{1F4CA}';if(['.docx','.doc','.odt'].some(ext=>n.endsWith(ext)))return '\u{1F4D8}';if(['.pptx','.ppt'].some(ext=>n.endsWith(ext)))return '\u{1F4FD}\uFE0F';if(['.zip','.7z','.rar','.tar','.gz'].some(ext=>n.endsWith(ext)))return '\u{1F5DC}\uFE0F';return isText?'\u{1F4C4}':'\u2B07\uFE0F'}
function renderWikilinks(s){if(!s.includes('[['))return esc(s);const parts=s.split('[[');let html=esc(parts[0]);for(let i=1;i<parts.length;i++){const end=parts[i].indexOf(']]');if(end<0){html+='[['+esc(parts[i]);continue}const content=parts[i].slice(0,end);const rest=parts[i].slice(end+2);const bar=content.indexOf('|');const target=bar>=0?content.slice(0,bar).trim():content.trim();const label=bar>=0?content.slice(bar+1).trim():target;html+='<a href="#" class="wikilink" style="color:#ffd479;text-decoration:underline" data-target="'+esc(target)+'" onclick="clickWiki(this);return false;">'+esc(label)+'</a>'+esc(rest)}return html}
async function clickWiki(el){const target=el.dataset.target;try{const data=await api('/portal/api/resolve-link?link='+encodeURIComponent(target)+'&currentSource='+encodeURIComponent(currentSource||''));if(data.found){await selectSource(data.source);await loadTree(data.path.split('/').slice(0,-1).join('/'));openFile(data.path,true)}else{alert('Файл "'+target+'" не найден в доступных вам источниках.')}}catch(e){alert('Ошибка перехода по ссылке: '+e.message)}}
function renderInline(s){const bs=String.fromCharCode(92),tick=String.fromCharCode(96);return renderWikilinks(s).replace(new RegExp(bs+'*'+bs+'*'+'([^*]+)'+bs+'*'+bs+'*','g'),'<strong>$1</strong>').replace(new RegExp(tick+'([^'+tick+']+)'+tick,'g'),'<code>$1</code>').replace(new RegExp(bs+'[([^'+bs+']+)'+bs+']'+bs+'(([^)]+)'+bs+')','g'),(m,t,u)=>'<a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(t)+'</a>')}
function resetMainScroll(){const m=document.querySelector('.main');if(m)m.scrollTop=0;window.scrollTo(0,0)}
function splitTableRow(line){let t=String(line||'').trim();if(t.startsWith('|'))t=t.slice(1);if(t.endsWith('|'))t=t.slice(0,-1);const cells=[];let cur='',escNext=false;for(const ch of t){if(escNext){cur+=ch;escNext=false;continue}if(ch===String.fromCharCode(92)){escNext=true;continue}if(ch==='|'){cells.push(cur.trim());cur='';continue}cur+=ch}cells.push(cur.trim());return cells}
function isTableSeparator(line){const cells=splitTableRow(line);return cells.length>0&&cells.every(c=>{const x=c.trim();return /^:?-{3,}:?$/.test(x)})}
function isTableStart(lines,i){if(i+1>=lines.length)return false;const a=String(lines[i]||'').trim(),b=String(lines[i+1]||'').trim();return a.includes('|')&&b.includes('|')&&isTableSeparator(b)}
function renderTable(rows){const header=splitTableRow(rows[0]);const aligns=splitTableRow(rows[1]).map(c=>{const x=c.trim();if(x.startsWith(':')&&x.endsWith(':'))return 'center';if(x.endsWith(':'))return 'right';return 'left'});let html='<div class="table-wrap"><table><thead><tr>'+header.map((c,i)=>'<th style="text-align:'+esc(aligns[i]||'left')+'">'+renderInline(c)+'</th>').join('')+'</tr></thead><tbody>';for(let r=2;r<rows.length;r++){const cells=splitTableRow(rows[r]);html+='<tr>'+header.map((_,i)=>'<td style="text-align:'+esc(aligns[i]||'left')+'">'+renderInline(cells[i]||'')+'</td>').join('')+'</tr>'}return html+'</tbody></table></div>'}
function renderMarkdown(md){const fence=String.fromCharCode(96).repeat(3),nl=String.fromCharCode(10);let lines=String(md||'').split(nl).map(x=>x.endsWith(String.fromCharCode(13))?x.slice(0,-1):x);if(lines[0]&&lines[0].trim()==='---'){const end=lines.slice(1).findIndex(x=>x.trim()==='---');if(end>=0)lines=lines.slice(end+2)}let html='',inList=false,inCode=false,code=[];const close=()=>{if(inList){html+='</ul>';inList=false}};for(let i=0;i<lines.length;i++){const line=lines[i],t=line.trim();if(t.startsWith(fence)){if(inCode){html+='<pre><code>'+esc(code.join(nl))+'</code></pre>';code=[];inCode=false}else{close();inCode=true}continue}if(inCode){code.push(line);continue}if(isTableStart(lines,i)){close();const rows=[lines[i],lines[i+1]];i+=2;while(i<lines.length&&String(lines[i]||'').trim().includes('|')&&String(lines[i]||'').trim()!==''){rows.push(lines[i]);i++}i--;html+=renderTable(rows);continue}if(line.startsWith('### ')){close();html+='<h3>'+renderInline(line.slice(4))+'</h3>';continue}if(line.startsWith('## ')){close();html+='<h2>'+renderInline(line.slice(3))+'</h2>';continue}if(line.startsWith('# ')){close();html+='<h1>'+renderInline(line.slice(2))+'</h1>';continue}if(line.startsWith('>')){close();html+='<blockquote>'+renderInline(line.slice(line.startsWith('> ')?2:1))+'</blockquote>';continue}if(line.startsWith('- ')||line.startsWith('* ')){if(!inList){html+='<ul>';inList=true}html+='<li>'+renderInline(line.slice(2))+'</li>';continue}if(!t){close();continue}close();html+='<p>'+renderInline(line)+'</p>'}close();if(inCode)html+='<pre><code>'+esc(code.join(nl))+'</code></pre>';return '<div class="markdown">'+html+'</div>'}
async function loadSources(){try{const data=await api('/portal/api/sources');const box=document.getElementById('sources');if(!data.sources.length){box.innerHTML='<div class="muted">Нет доступных источников</div>';return}box.innerHTML='<select id="sourceSelect" class="source-select" aria-label="Источник">'+data.sources.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name||s.id)+' · '+esc(s.id)+'</option>').join('')+'</select>';const sel=document.getElementById('sourceSelect');sel.onchange=()=>selectSource(sel.value);selectSource(data.sources[0].id)}catch(e){document.getElementById('sources').innerHTML='<div class="error">'+esc(e.message)+'</div>'}}
async function selectSource(id){currentSource=id;currentPath='';const sel=document.getElementById('sourceSelect');if(sel&&sel.value!==id)sel.value=id;await loadTree('')}
function breadcrumbs(){const parts=currentPath?currentPath.split('/').filter(Boolean):[];let html='<span class="crumb" data-path="">'+esc(currentSource||'')+'</span>',acc='';for(const p of parts){acc+=(acc?'/':'')+p;html+=' / <span class="crumb" data-path="'+esc(acc)+'">'+esc(p)+'</span>'}document.getElementById('breadcrumbs').innerHTML=html;document.querySelectorAll('.crumb').forEach(e=>e.onclick=()=>loadTree(e.dataset.path||''))}
async function loadTree(path){currentPath=path||'';breadcrumbs();const data=await api('/portal/api/tree?source='+encodeURIComponent(currentSource)+'&path='+encodeURIComponent(currentPath));document.getElementById('title').textContent=currentPath||currentSource;const rows=[];if(currentPath){const parent=currentPath.split('/').slice(0,-1).join('/');rows.push('<div class="entry" data-dir="'+esc(parent)+'"><span class="entry-name">↩ ..</span></div>')}for(const d of data.entries.filter(e=>e.type==='dir'))rows.push('<div class="entry" data-dir="'+esc(d.path)+'"><span class="entry-name">'+fileIcon(d.name,'dir')+' '+esc(d.name)+'</span></div>');for(const f of data.entries.filter(e=>e.type==='file'))rows.push('<div class="entry" data-file="'+esc(f.path)+'" data-md="'+(f.markdown?'1':'0')+'"><span class="entry-name">'+fileIcon(f.name,'file',f.markdown)+' '+esc(f.name)+'</span><span class="badge">'+esc(f.size)+' байт</span></div>');document.getElementById('tree').innerHTML=rows.join('')||'<div class="muted">Папка пуста</div>';document.querySelectorAll('[data-dir]').forEach(e=>e.onclick=()=>loadTree(e.dataset.dir||''));document.querySelectorAll('[data-file]').forEach(e=>e.onclick=()=>openFile(e.dataset.file,e.dataset.md==='1'))}
async function openFile(path,isMd){const viewer=document.getElementById('viewer');if(!isMd){viewer.innerHTML='<p>Этот файл не markdown. Его можно скачать.</p><a class="btn" href="/portal/download?source='+encodeURIComponent(currentSource)+'&path='+encodeURIComponent(path)+'">Скачать файл</a>';resetMainScroll();return}const data=await api('/portal/api/file?source='+encodeURIComponent(currentSource)+'&path='+encodeURIComponent(path));document.getElementById('title').textContent=data.path;viewer.innerHTML=renderMarkdown(data.content);resetMainScroll()}
async function runSearch(q){const box=document.getElementById('searchResults');if(!q.trim()){box.innerHTML='';return}box.innerHTML='<div class="muted">Поиск...</div>';try{const data=await api('/portal/api/search?q='+encodeURIComponent(q.trim()));box.innerHTML=data.results.map(r=>'<div class="entry" data-src="'+esc(r.source)+'" data-path="'+esc(r.path)+'" data-md="'+(r.markdown?'1':'0')+'"><span class="entry-name">'+fileIcon(r.name,'file',r.markdown)+' '+esc(r.source)+' / '+esc(r.path)+'</span></div>').join('')||'<div class="muted">Ничего не найдено</div>';box.querySelectorAll('[data-src]').forEach(e=>e.onclick=async()=>{await selectSource(e.dataset.src);await loadTree(e.dataset.path.split('/').slice(0,-1).join('/'));openFile(e.dataset.path,e.dataset.md==='1')})}catch(e){box.innerHTML='<div class="error">'+esc(e.message)+'</div>'}}
async function loadAccessRequestBadge(){try{const data=await api('/admin/api/access-requests');const count=(data.requests||[]).filter(r=>r.status==='pending').length;const btn=document.getElementById('adminBtnSection');if(btn)btn.style.display='flex';const b=document.getElementById('accessReqBadge');if(b&&count>0){b.textContent=String(count);b.style.display='inline-block'}}catch(e){}}
document.getElementById('searchBox').addEventListener('input',e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>runSearch(e.target.value),250)});loadSources();loadAccessRequestBadge();
</script></body></html>`);
  });
/* c8 ignore stop */

// Portal SPA static files. The server remains the authorization boundary;
// the browser bundle never receives a source that /portal/api/sources did not grant.
const portalPathModule = await import('path');
const portalFsModule = await import('fs');
const portalDistPath = portalPathModule.join(process.cwd(), 'portal', 'dist');
const portalDevAssets = portalFsModule.existsSync(portalDistPath);
const portalEmbedded = portalDevAssets ? null : await import('../portal-embedded.ts');
const portalAssetCache = new Map<string, Buffer>();

const setPortalDocumentHeaders = (res: Response): void => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
};

const requirePortalPage = (req: Request, res: Response, next: NextFunction) => {
  const userEmail = resolvePortalUser(req, res);
  if (!userEmail) return res.redirect('/login');
  if (!hasSeenPortalOnboarding(String(userEmail))) return res.redirect('/portal/welcome');
  next();
};

const sendPortalIndex = (_req: Request, res: Response) => {
  setPortalDocumentHeaders(res);
  if (portalDevAssets) return res.sendFile(portalPathModule.join(portalDistPath, 'index.html'));
  const asset = portalEmbedded?.PORTAL_INDEX_HTML;
  if (!asset) return res.status(404).send('portal SPA not available');
  let body = portalAssetCache.get(asset.path);
  if (!body) {
    body = portalFsModule.readFileSync(asset.path);
    portalAssetCache.set(asset.path, body);
  }
  res.setHeader('Content-Type', asset.mime);
  res.send(body);
};

if (portalDevAssets) {
  app.use('/portal/assets', requirePortalPage, express.static(portalPathModule.join(portalDistPath, 'assets'), {
    immutable: true,
    maxAge: '1y',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));
} else {
  app.get('/portal/assets/{*path}', requirePortalPage, (req: Request, res: Response) => {
    const asset = portalEmbedded?.PORTAL_ASSETS[req.path];
    if (!asset) return res.status(404).send('portal asset not found');
    let body = portalAssetCache.get(asset.path);
    if (!body) {
      body = portalFsModule.readFileSync(asset.path);
      portalAssetCache.set(asset.path, body);
    }
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(body);
  });
}
app.get(['/portal', '/portal/'], requirePortalPage, sendPortalIndex);

app.use('/portal/api', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use('/portal/download', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/portal/api/session', (req: any, res: any) => {
  const userEmail = requirePortalUser(req, res);
  if (!userEmail) return;
  res.json({
    email: userEmail,
    isAdmin: adminEmails.has(String(userEmail).trim().toLowerCase()),
    readOnly: true,
  });
});

app.get("/portal/api/sources", async (req: any, res: any) => {
    const userEmail = requirePortalUser(req, res);
    if (!userEmail)
      return;
    const sources = await getSourceRowsForUser(userEmail);
    res.json({ sources: sources.map((source) => ({ id: source.id, name: source.name })) });
  });
  type PortalCachedPage = { slug: string; title: string };
  const portalPageCache = new Map<string, { expiresAt: number; pages: PortalCachedPage[]; complete: boolean }>();
  const getPortalPages = async (sourceId: string): Promise<{ pages: PortalCachedPage[]; complete: boolean }> => {
    const cached = portalPageCache.get(sourceId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const pages: PortalCachedPage[] = [];
    const pageSize = 500;
    let offset = 0;
    let complete = true;
    while (pages.length < 50_000) {
      const batch = await engine.listPages({ sourceId, limit: pageSize, offset, sort: 'slug' });
      for (const page of batch) {
        const slug = String(page.slug || '').replace(/^\/+|\/+$/g, '');
        if (slug) pages.push({ slug, title: String(page.title || slug) });
      }
      if (batch.length < pageSize) break;
      offset += batch.length;
    }
    if (pages.length >= 50_000) complete = false;
    const next = { expiresAt: Date.now() + 30_000, pages, complete };
    portalPageCache.set(sourceId, next);
    return next;
  };
  const getPortalCountedSlugs = async (sourceId: string): Promise<{ slugs: string[]; complete: boolean }> => {
    const cached = await getPortalPages(sourceId);
    return {
      slugs: cached.pages.map((page) => page.slug).filter((slug) => isPortalCountedDocument(`${slug}.md`)),
      complete: cached.complete,
    };
  };

  app.get("/portal/api/tree", async (req: any, res: any) => {
    const userEmail = requirePortalUser(req, res);
    if (!userEmail)
      return;
    const fs = require("fs");
    const path = require("path");
    const sourceId = String(req.query.source || "");
    const sources = await getSourceRowsForUser(userEmail);
    const source = sources.find((source) => source.id === sourceId);
    if (!source)
      return res.status(404).json({ error: "Not found" });
    const requestedFolder = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
    const target = resolvePortalPath(source.local_path, requestedFolder, true);
    if (!target)
      return res.status(404).json({ error: "Not found" });
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return res.status(404).json({ error: "Path not found" });
    }
    if (!stat.isDirectory())
      return res.status(400).json({ error: "Path is not a directory" });

    const counted = await getPortalCountedSlugs(source.id);
    const folderPrefix = requestedFolder ? `${requestedFolder}/` : '';
    const entries = fs.readdirSync(target, { withFileTypes: true }).filter((entry: any) =>
      entry.name !== ".git" &&
      !entry.name.startsWith(".") &&
      !entry.isSymbolicLink() &&
      ((entry.isDirectory() && isPortalVisibleDirectory(entry.name)) || (entry.isFile() && isPortalFileAllowed(entry.name)))
    ).map((entry: any) => {
      const full = path.join(target, entry.name);
      const rel = path.relative(source.local_path, full).split(path.sep).join("/");
      const st = fs.statSync(full);
      const childPrefix = `${rel}/`;
      return {
        name: entry.name,
        path: rel,
        type: entry.isDirectory() ? "dir" : "file",
        markdown: entry.isFile() && /\.(md|markdown|txt)$/i.test(entry.name),
        size: st.size,
        updatedAt: st.mtime.toISOString(),
        documentCount: entry.isDirectory()
          ? counted.slugs.filter((slug) => slug.startsWith(childPrefix)).length
          : undefined,
      };
    }).sort((a: any, b: any) => a.type === b.type ? a.name.localeCompare(b.name, "ru") : a.type === "dir" ? -1 : 1);

    const sourceSections = new Set(
      counted.slugs
        .filter((slug) => slug.includes('/'))
        .map((slug) => slug.split('/')[0])
        .filter((section) => isPortalVisibleDirectory(section)),
    );
    const summary = {
      sections: entries.filter((entry: any) => entry.type === 'dir').length,
      documents: counted.slugs.filter((slug) => !folderPrefix || slug.startsWith(folderPrefix)).length,
      complete: counted.complete,
    };
    const sourceSummary = {
      sections: sourceSections.size,
      documents: counted.slugs.length,
      complete: counted.complete,
    };
    res.json({ source: source.id, path: requestedFolder, entries, summary, sourceSummary });
  });
  app.get("/portal/api/file", async (req: any, res: any) => {
    const userEmail = requirePortalUser(req, res);
    if (!userEmail)
      return;
    const fs = require("fs");
    const sourceId = String(req.query.source || "");
    const sources = await getSourceRowsForUser(userEmail);
    const source = sources.find((source) => source.id === sourceId);
    if (!source)
      return res.status(404).json({ error: "Not found" });
    if (!isPortalFileAllowed(req.query.path))
      return res.status(404).json({ error: "Not found" });
    const target = resolvePortalPath(source.local_path, req.query.path);
    if (!target)
      return res.status(404).json({ error: "Not found" });
    if (!/\.(md|markdown|txt)$/i.test(String(req.query.path || "")))
      return res.status(400).json({ error: "Only markdown/text preview is allowed here" });
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return res.status(404).json({ error: "File not found" });
    }
    if (!stat.isFile())
      return res.status(400).json({ error: "Path is not a file" });
    if (stat.size > 1024 * 1024)
      return res.status(413).json({ error: "File is too large for preview; download it instead" });
    const content = fs.readFileSync(target, "utf8");
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
    const frontmatter = frontmatterMatch?.[1] || '';
    const readField = (field: string) => {
      const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'mi'));
      return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
    };
    const rawTags = readField('tags');
    const tags = rawTags
      ? rawTags.replace(/^\[|\]$/g, '').split(',').map((tag: string) => tag.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      : [];
    const requestedPath = String(req.query.path || '');
    const slug = readField('slug') || requestedPath.replace(/\.(md|markdown|txt)$/i, '');
    const firstHeading = content.replace(/^---\s*\n[\s\S]*?\n---(?:\s*\n|$)/, '').match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
    const title = readField('title') || firstHeading || path.basename(requestedPath).replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]/g, ' ');
    res.json({
      source: source.id,
      sourceName: source.name,
      path: requestedPath,
      name: path.basename(requestedPath),
      content,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      slug,
      title,
      type: readField('type'),
      status: readField('status'),
      tags,
    });
  });

  app.get('/portal/api/context', async (req: any, res: any) => {
    const userEmail = requirePortalUser(req, res);
    if (!userEmail) return;
    const fs = require('fs');
    const sourceId = String(req.query.source || '');
    const sources = await getSourceRowsForUser(userEmail);
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) return res.status(404).json({ error: 'Not found' });
    if (!isPortalFileAllowed(req.query.path)) return res.status(404).json({ error: 'Not found' });
    const target = resolvePortalPath(source.local_path, req.query.path);
    if (!target) return res.status(404).json({ error: 'Not found' });
    let content = '';
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return res.status(400).json({ error: 'Path is not a file' });
      content = fs.readFileSync(target, 'utf8');
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1] || '';
    const slug = frontmatter.match(/^slug:\s*(.+)$/mi)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
      || String(req.query.path || '').replace(/\.(md|markdown|txt)$/i, '');
    let backlinks: Array<{ source: string; slug: string; title: string; type: string; context: string }> = [];
    let meetings: Array<{ source: string; slug: string; title: string; type: string; context: string }> = [];
    try {
      const allowedSources = new Set(sources.map((candidate) => candidate.id));
      const [incomingLinks, outgoingLinks] = await Promise.all([
        // Anchor the NEAR endpoint to the exact page the user opened. Reading
        // all allowed sources by slug would merge same-slug page identities.
        // FAR endpoints are filtered against `allowedSources` below before exposure.
        engine.getBacklinks(slug, { sourceId: source.id }),
        engine.getLinks(slug, { sourceId: source.id }),
      ]);
      const seen = new Set<string>();
      backlinks = incomingLinks.flatMap((link) => {
        const linkSource = link.from_source_id || source.id;
        if (!allowedSources.has(linkSource)) return [];
        const key = `${linkSource}:${link.from_slug}:${link.link_type}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{
          source: linkSource,
          slug: link.from_slug,
          title: link.from_slug.split('/').pop()?.replace(/[-_]/g, ' ') || link.from_slug,
          type: link.link_type,
          context: link.context || '',
        }];
      }).slice(0, 30);

      // Meetings are a first-class context projection. Incoming meeting links
      // cover explicit mentions; outgoing `attended` links cover canonical
      // attendance edges from person cards. Both endpoint sources are restricted
      // to the already-authorized Portal source set before titles are hydrated.
      const meetingCandidates = new Map<string, { source: string; slug: string; type: string; context: string }>();
      for (const link of incomingLinks) {
        const linkSource = link.from_source_id || source.id;
        if (!allowedSources.has(linkSource) || !link.from_slug.startsWith('meetings/')) continue;
        meetingCandidates.set(`${linkSource}:${link.from_slug}`, {
          source: linkSource,
          slug: link.from_slug,
          type: link.link_type,
          context: link.context || '',
        });
      }
      for (const link of outgoingLinks) {
        const linkSource = link.to_source_id || source.id;
        if (link.link_type !== 'attended' || !allowedSources.has(linkSource) || !link.to_slug.startsWith('meetings/')) continue;
        meetingCandidates.set(`${linkSource}:${link.to_slug}`, {
          source: linkSource,
          slug: link.to_slug,
          type: 'attended',
          context: link.context || '',
        });
      }
      meetings = await Promise.all(
        [...meetingCandidates.values()]
          .sort((a, b) => b.slug.localeCompare(a.slug))
          .slice(0, 30)
          .map(async (candidate) => {
            const page = await engine.getPage(candidate.slug, { sourceId: candidate.source });
            return {
              ...candidate,
              title: page?.title || candidate.slug.split('/').pop()?.replace(/[-_]/g, ' ') || candidate.slug,
            };
          }),
      );
    } catch (error) {
      console.warn('[portal] context unavailable:', error instanceof Error ? error.message : error);
    }
    res.json({ source: source.id, slug, backlinks, meetings });
  });

  app.get("/portal/api/search", async (req: any, res: any) => {
    const userEmail = requirePortalUser(req, res);
    if (!userEmail)
      return;
    const fs = require("fs");
    const path = require("path");
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 2)
      return res.json({ results: [] });
    const sources = await getSourceRowsForUser(userEmail);
    const results: Array<Record<string, any> & PortalSearchRank> = [];
    const seenResults = new Set<string>();
    const maxResults = 50;
    const candidatePathForSlug = (source: PortalSourceRow, slug: string): string | null => {
      for (const candidate of [`${slug}.md`, `${slug}.markdown`, `${slug}.txt`]) {
        if (!isPortalFileAllowed(candidate)) continue;
        const resolved = resolvePortalPath(source.local_path, candidate);
        try {
          if (resolved && fs.statSync(resolved).isFile()) return candidate;
        } catch {}
      }
      return null;
    };

    // Title/slug/alias candidates are retrieved separately from body chunks so
    // an exact title cannot disappear merely because its body does not repeat it.
    try {
      const normalizedAlias = normalizeAlias(q);
      for (const source of sources) {
        const cached = await getPortalPages(source.id);
        const pagesBySlug = new Map(cached.pages.map((page) => [page.slug, page]));
        const slugs = new Set(await engine.resolveSlugs(q, { sourceId: source.id }));
        const titlePrefixMatches = cached.pages
          .filter((page) => isPortalTitlePrefixMatch(q, page.title))
          .map((page) => ({
            page,
            ranking: classifyPortalSearchMatch({ query: q, title: page.title, slug: page.slug }),
          }))
          .sort((a, b) => comparePortalSearchResults(a.ranking, b.ranking))
          .slice(0, 100);
        for (const { page } of titlePrefixMatches) slugs.add(page.slug);
        if (normalizedAlias) {
          const aliases = await engine.resolveAliases([normalizedAlias], { sourceId: source.id });
          for (const ref of aliases.get(normalizedAlias) || []) slugs.add(ref.slug);
        }
        for (const slug of slugs) {
          const candidatePath = candidatePathForSlug(source, slug);
          if (!candidatePath) continue;
          const key = `${source.id}:${candidatePath}`;
          if (seenResults.has(key)) continue;
          const indexedPage = pagesBySlug.get(slug);
          const storedPage = await engine.getPage(slug, { sourceId: source.id });
          if (!indexedPage && !storedPage) continue;
          const title = indexedPage?.title || storedPage?.title || slug;
          const candidateText = String(storedPage?.compiled_truth || '');
          const classification = classifyPortalSearchMatch({
            query: q,
            title,
            slug,
            path: candidatePath,
            chunkText: candidateText,
          });
          seenResults.add(key);
          results.push({
            source: source.id,
            sourceName: source.name,
            name: path.basename(candidatePath),
            path: candidatePath,
            markdown: true,
            size: 0,
            match: classification.match,
            title,
            snippet: cleanPortalSearchSnippet(candidateText, q),
            score: 0,
            rank: classification.rank,
          });
        }
      }
    } catch (error) {
      console.warn('[portal] title/alias candidate search unavailable:', error instanceof Error ? error.message : error);
    }

    // Indexed content search keeps request latency independent of repository size.
    // Source IDs come from the same ACL projection used by every portal route.
    try {
      const indexed = await engine.searchKeyword(q, {
        limit: 100,
        sourceIds: sources.map((source) => source.id),
      });
      for (const hit of indexed) {
        const source = sources.find((candidate) => candidate.id === (hit.source_id || 'default'));
        if (!source) continue;
        const fsCandidates = [`${hit.slug}.md`, `${hit.slug}.markdown`, `${hit.slug}.txt`];
        const candidatePath = fsCandidates.find((candidate) => {
          const resolved = resolvePortalPath(source.local_path, candidate);
          try { return Boolean(resolved && fs.statSync(resolved).isFile()); } catch { return false; }
        });
        if (!candidatePath) continue;
        const key = `${source.id}:${candidatePath}`;
        if (seenResults.has(key)) continue;
        seenResults.add(key);
        const classification = classifyPortalSearchMatch({
          query: q,
          title: hit.title || hit.slug,
          slug: hit.slug,
          path: candidatePath,
          chunkText: String(hit.chunk_text || ''),
          score: hit.score,
        });
        results.push({
          source: source.id,
          sourceName: source.name,
          name: path.basename(candidatePath),
          path: candidatePath,
          markdown: true,
          size: 0,
          match: classification.match,
          title: hit.title || hit.slug,
          snippet: cleanPortalSearchSnippet(String(hit.chunk_text || ''), q),
          score: hit.score,
          rank: classification.rank,
        });

      }
    } catch (error) {
      console.warn('[portal] indexed search unavailable, using filename fallback:', error instanceof Error ? error.message : error);
    }

    // Bounded filename fallback also finds attachments that are not indexed pages.
    let scannedEntries = 0;
    const walk = (source: PortalSourceRow, dir: string): void => {
      if (scannedEntries >= 10_000)
        return;
      let entries: any[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        scannedEntries += 1;
        if (scannedEntries >= 10_000)
          return;
        if (entry.name === ".git" || entry.name.startsWith("."))
          continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(source.local_path, full).split(path.sep).join("/");
        if (entry.isDirectory()) {
          walk(source, full);
          continue;
        }
        if (!entry.isFile())
          continue;
        if (!isPortalFileAllowed(rel))
          continue;
        const nameMatch = entry.name.toLowerCase().includes(q) || rel.toLowerCase().includes(q);
        const markdown = /\.(md|markdown|txt)$/i.test(entry.name);
        const key = `${source.id}:${rel}`;
        if (nameMatch && !seenResults.has(key)) {
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {}
          seenResults.add(key);
          const classification = classifyPortalSearchMatch({ query: q, title: entry.name, path: rel });
          results.push({
            source: source.id,
            sourceName: source.name,
            name: entry.name,
            path: rel,
            markdown,
            size,
            match: "name",
            title: entry.name,
            rank: Math.max(350, classification.rank - 50),
          });
        }
      }
    };
    for (const source of sources)
      walk(source, source.local_path);
    const ordered = results
      .sort(comparePortalSearchResults)
      .slice(0, maxResults)
      .map(({ rank: _rank, ...result }) => result);
    res.json({ query: q, results: ordered });
  });
  app.get("/portal/api/resolve-link", async (req: any, res: any) => {
    const userEmail = requirePortalUser(req, res);
    if (!userEmail)
      return;
    const fs = require("fs");
    const path = require("path");
    const link = String(req.query.link || "").trim().replace(/\\/g, "/");
    const currentSourceId = String(req.query.currentSource || "");
    if (!link)
      return res.status(400).json({ error: "Link is required" });
    const sources = await getSourceRowsForUser(userEmail);
    let targetLink = link;
    let requestedSourceId: string | null = null;
    const qualified = link.match(/^([a-z0-9-]{1,32}):(.*)$/);
    if (qualified) {
      requestedSourceId = qualified[1];
      targetLink = qualified[2];
      if (!sources.some((source) => source.id === requestedSourceId)) {
        return res.json({ found: false });
      }
    }
    const orderedSources = requestedSourceId ? sources.filter((source) => source.id === requestedSourceId) : [...sources].sort((a, b) => {
      if (a.id === currentSourceId)
        return -1;
      if (b.id === currentSourceId)
        return 1;
      if (a.id === "shared")
        return -1;
      if (b.id === "shared")
        return 1;
      return 0;
    });
    const extensions = [".md", ".markdown", ".txt", ""];
    const findFile = (localPath: string, targetLink: string): string | null => {
      const linkParts = targetLink.split("/");
      const basename = linkParts[linkParts.length - 1].toLowerCase();
      let scanned = 0;
      const walk = (dir: string): string | null => {
        if (scanned >= 5_000) return null;
        let entries: any[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return null;
        }
        for (const entry of entries) {
          scanned += 1;
          if (scanned >= 5_000) return null;
          if (entry.name === ".git" || entry.name.startsWith(".") || entry.isSymbolicLink())
            continue;
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(localPath, fullPath).split(path.sep).join("/");
          if (entry.isDirectory()) {
            const found: string | null = walk(fullPath);
            if (found)
              return found;
          } else if (entry.isFile()) {
            const relLower = relPath.toLowerCase();
            const nameLower = entry.name.toLowerCase();
            for (const ext of extensions) {
              const targetWithExt = targetLink.toLowerCase() + ext;
              const basenameWithExt = basename + ext;
              if (isPortalFileAllowed(relPath) && (relLower === targetWithExt || relLower.endsWith("/" + targetWithExt) || nameLower === basenameWithExt)) {
                return relPath;
              }
            }
          }
        }
        return null;
      };
      return walk(localPath);
    };
    for (const source of orderedSources) {
      const normalizedTarget = targetLink.replace(/\.(md|markdown|txt)$/i, '');
      const candidateSlugs = new Set([normalizedTarget]);
      try {
        candidateSlugs.add(await engine.resolveSlugWithAlias(normalizedTarget, source.id));
        const aliasNorm = normalizeAlias(normalizedTarget);
        if (aliasNorm) {
          const aliases = await engine.resolveAliases([aliasNorm], { sourceId: source.id });
          for (const ref of aliases.get(aliasNorm) || []) candidateSlugs.add(ref.slug);
        }
      } catch (error) {
        console.warn('[portal] indexed alias resolution unavailable:', error instanceof Error ? error.message : error);
      }
      for (const candidateSlug of candidateSlugs) {
        for (const ext of extensions) {
          const testPath = candidateSlug + ext;
          if (!isPortalFileAllowed(testPath)) continue;
          const target = resolvePortalPath(source.local_path, testPath);
          if (target) {
            try {
              const st = fs.statSync(target);
              if (st.isFile()) {
                return res.json({ found: true, source: source.id, sourceName: source.name, path: testPath });
              }
            } catch {}
          }
        }
      }
      const relPath = findFile(source.local_path, targetLink);
      if (relPath) {
        return res.json({ found: true, source: source.id, sourceName: source.name, path: relPath });
      }
    }
    res.json({ found: false });
  });
  app.get("/portal/download", async (req: any, res: any) => {
    const userEmail = resolvePortalUser(req, res);
    if (!userEmail)
      return res.status(401).send("Unauthorized");
    const fs = require("fs");
    const path = require("path");
    const sourceId = String(req.query.source || "");
    const sources = await getSourceRowsForUser(String(userEmail));
    const source = sources.find((source) => source.id === sourceId);
    if (!source)
      return res.status(404).send("Not found");
    const requestedPath = String(req.query.path || '');
    if (!isPortalFileAllowed(requestedPath))
      return res.status(404).send("Not found");
    const target = resolvePortalPath(source.local_path, requestedPath);
    if (!target)
      return res.status(404).send("Not found");
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return res.status(404).send("File not found");
    }
    if (!stat.isFile())
      return res.status(400).send("Path is not a file");
    res.download(target, path.basename(target));
  });


app.get("/admin/access-requests", requireAdmin, (_req: any, res: any) => {
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>GBrain Access Requests</title><style>
body{margin:0;background:#101014;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}.wrap{max-width:1180px;margin:0 auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center}.btn{background:#007acc;color:white;border:0;border-radius:6px;padding:8px 12px;text-decoration:none;cursor:pointer}.btn.gray{background:#444}.btn.red{background:#8b2f2f}.btn:disabled{opacity:.55;cursor:not-allowed}.card{background:#1d1d24;border:1px solid #333;border-radius:10px;padding:16px;margin:14px 0}.muted{color:#aaa;font-size:13px}.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}pre{white-space:pre-wrap;background:#15151a;border-radius:8px;padding:10px}.status-pending{color:#ffd479}.status-approved,.status-approved_partial{color:#91e091}.status-rejected{color:#ff9c9c}.grant-table{width:100%;border-collapse:collapse;margin-top:12px}.grant-table th,.grant-table td{border-bottom:1px solid #333;padding:8px;text-align:left}.grant-table th{color:#aaa;font-weight:500}.grant-table input{transform:scale(1.1)}.denied{color:#ffb7b7}.approved-list{color:#b7f0b7}
</style></head><body><div class="wrap"><div class="top"><div><h1>Заявки доступа GBrain</h1><div class="muted">Можно утвердить заявку целиком или скорректировать галочками, какие права выдать.</div></div><div><a class="btn gray" href="/admin/permissions">Права пользователей</a> <a class="btn gray" href="/admin/">Админ-панель</a></div></div><div id="list">Загрузка...</div></div><script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opt){const r=await fetch(url,opt);if(!r.ok)throw new Error(await r.text());return r.json()}
function requestedLabel(a){return a.write?'чтение+запись':(a.read?'чтение':'нет')}
function renderPendingRows(r){return '<table class="grant-table"><thead><tr><th>Область</th><th>Source</th><th>Запрошено</th><th>Дать чтение</th><th>Дать запись</th></tr></thead><tbody>'+((r.requests||[]).map((a,i)=>'<tr><td>'+esc(a.area)+'</td><td><code>'+esc(a.source_id||'')+'</code></td><td>'+esc(requestedLabel(a))+'</td><td><input class="grant-read" type="checkbox" data-index="'+i+'" '+((a.read||a.write)?'checked':'')+'></td><td><input class="grant-write" type="checkbox" data-index="'+i+'" '+(a.write?'checked':'')+'></td></tr>').join(''))+'</tbody></table>'}
function renderDecidedRows(r){const approved=(r.approved_requests||[]).map(a=>'<div class="approved-list">✓ '+esc(a.area)+' \xB7 '+esc(a.source_id||'')+' \xB7 '+esc(requestedLabel(a))+'</div>').join('');const denied=(r.denied_requests||[]).map(a=>'<div class="denied">\xD7 '+esc(a.area)+' \xB7 '+esc(a.source_id||'')+' \xB7 '+esc(requestedLabel(a))+'</div>').join('');if(approved||denied)return '<div style="margin-top:10px">'+approved+denied+'</div>';return '<div style="margin-top:10px">'+((r.requests||[]).map(a=>'<span>'+esc(a.area)+' \xB7 '+esc(a.source_id||'')+' \xB7 '+esc(requestedLabel(a))+'</span>').join('<br>'))+'</div>'}
function collectGrants(card){const grants=[];card.querySelectorAll('tbody tr').forEach(row=>{const idx=Number(row.querySelector('input').dataset.index);const read=row.querySelector('.grant-read').checked;const write=row.querySelector('.grant-write').checked;grants.push({index:idx,read:read||write,write})});return grants}
function renderReq(r){const pending=r.status==='pending';const rows=pending?renderPendingRows(r):renderDecidedRows(r);const actions=pending?'<div class="actions"><button class="btn js-decision" data-id="'+esc(r.id)+'" data-action="approve">Утвердить выбранные права</button><button class="btn gray js-check-all" type="button">Отметить всё как запрошено</button><button class="btn gray js-clear" type="button">Снять все галочки</button><button class="btn red js-decision" data-id="'+esc(r.id)+'" data-action="reject">Отклонить всё</button></div>':'';return '<div class="card" data-request-id="'+esc(r.id)+'"><h3>'+esc(r.email)+' <span class="status-'+esc(r.status)+'">'+esc(r.status)+'</span></h3><div class="muted">'+esc(r.id)+' \xB7 '+esc(r.requested_at||'')+'</div>'+rows+'<pre>'+esc(r.reason||'(причина не указана)')+'</pre>'+actions+(r.decided_at?'<div class="muted">Решение: '+esc(r.decided_at)+' \xB7 '+esc(r.decided_by||'')+'</div>':'')+'</div>'}
function bindCard(card){card.querySelectorAll('.grant-write').forEach(w=>w.onchange=()=>{if(w.checked){const r=card.querySelector('.grant-read[data-index="'+w.dataset.index+'"]');if(r)r.checked=true}});card.querySelectorAll('.grant-read').forEach(r=>r.onchange=()=>{if(!r.checked){const w=card.querySelector('.grant-write[data-index="'+r.dataset.index+'"]');if(w)w.checked=false}});const all=card.querySelector('.js-check-all');if(all)all.onclick=()=>{card.querySelectorAll('tbody tr').forEach(row=>{const read=row.querySelector('.grant-read');const write=row.querySelector('.grant-write');read.checked=true;write.checked=row.children[2].textContent.includes('запись')})};const clear=card.querySelector('.js-clear');if(clear)clear.onclick=()=>{card.querySelectorAll('input[type="checkbox"]').forEach(i=>i.checked=false)}}
async function load(){try{const data=await api('/admin/api/access-requests');document.getElementById('list').innerHTML=data.requests.map(renderReq).join('')||'<div class="card muted">Заявок нет</div>';document.querySelectorAll('.card').forEach(bindCard);document.querySelectorAll('.js-decision').forEach(b=>b.onclick=()=>decide(b))}catch(e){document.getElementById('list').innerHTML='<div class="card">Ошибка: '+esc(e.message)+'</div>'}}
async function decide(button){const id=button.dataset.id,action=button.dataset.action;const card=button.closest('.card');if(action==='approve'){const grants=collectGrants(card);const selected=grants.filter(g=>g.read||g.write).length;if(!selected){alert('Не выбрано ни одного права. Если нужно отказать полностью, нажмите \xABОтклонить всё\xBB.');return}if(!confirm('Утвердить выбранные права? Неотмеченные пункты будут записаны как невыданные.'))return;await api('/admin/api/access-requests/'+encodeURIComponent(id)+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grants})})}else{if(!confirm('Отклонить заявку полностью?'))return;await api('/admin/api/access-requests/'+encodeURIComponent(id)+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})}await load()}
load();
</script></body></html>`);
  });
  app.get("/admin/api/access-requests", requireAdmin, (_req: any, res: any) => {
    const requests = readAccessRequests().sort((a, b) => String(b.requested_at || "").localeCompare(String(a.requested_at || "")));
    res.json({ requests });
  });
  app.post("/admin/api/access-requests/:id/approve", requireAdmin, express.json(), (req: any, res: any) => {
    const id = String(req.params.id || "");
    const requests = readAccessRequests();
    const item = requests.find((r4) => r4.id === id);
    if (!item) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (item.status !== "pending") {
      res.status(400).json({ error: "Request is not pending" });
      return;
    }
    const requestedRows = Array.isArray(item.requests) ? item.requests : [];
    const rawGrants: Array<{ index?: unknown; read?: unknown; write?: unknown }> | null = Array.isArray(req.body?.grants) ? req.body.grants : null;
    const selectedRows = requestedRows.map((row, index): PortalAccessRow | null => {
      const grant = rawGrants ? rawGrants.find((g8) => Number(g8?.index) === index) : row;
      const write2 = !!grant?.write && !!row.write;
      const read2 = (!!grant?.read || write2) && (!!row.read || !!row.write);
      const sourceId = row.source_id || managedSourceIdForArea(String(row.area || ""));
      if (!sourceId) return null;
      return { area: row.area, source_id: sourceId, read: read2, write: write2, requested_read: !!row.read, requested_write: !!row.write };
    }).filter((row): row is PortalAccessRow => row !== null && (row.read || row.write));
    if (selectedRows.length === 0) {
      res.status(400).json({ error: "No permissions selected. Reject the request if nothing should be granted." });
      return;
    }
    const permsPath = userPermissionsPath();
    const perms = loadJsonFileLocal<Record<string, PortalUserPermissions>>(permsPath, {});
    const defaultSource = String(item.email || "").split("@")[0].replace(/[^a-z0-9]/g, "-");
    const user = perms[item.email] || { source_id: defaultSource, federated_read: [defaultSource, "shared"], federated_write: [defaultSource] };
    const read = new Set(Array.isArray(user.federated_read) ? user.federated_read : []);
    const write = new Set(Array.isArray(user.federated_write) ? user.federated_write : []);
    if (user.source_id)
      read.add(user.source_id);
    for (const row of selectedRows) {
      if (!row.source_id)
        continue;
      if (row.read || row.write)
        read.add(row.source_id);
      if (row.write)
        write.add(row.source_id);
    }
    user.federated_read = Array.from(read).filter(Boolean);
    user.federated_write = Array.from(write).filter(Boolean);
    perms[item.email] = user;
    writeJsonFileLocal(permsPath, perms);
    const selectedBySource = new Map(selectedRows.map((row) => [row.source_id, row]));
    const deniedRows = requestedRows.map((row): PortalAccessRow | null => {
      const sourceId = row.source_id || managedSourceIdForArea(String(row.area || ""));
      if (!sourceId) return null;
      const selected = selectedBySource.get(sourceId);
      const deniedRead = (!!row.read || !!row.write) && !selected?.read;
      const deniedWrite = !!row.write && !selected?.write;
      if (!deniedRead && !deniedWrite)
        return null;
      return { area: row.area, source_id: sourceId, read: deniedRead, write: deniedWrite };
    }).filter((row): row is PortalAccessRow => row !== null);
    const fullyApproved = deniedRows.length === 0 && selectedRows.length === requestedRows.length;
    item.status = fullyApproved ? "approved" : "approved_partial";
    item.decided_at = new Date().toISOString();
    item.decided_by = resolvePortalUser(req) || "admin";
    item.approved_at = item.decided_at;
    item.approved_by = item.decided_by;
    item.approved_requests = selectedRows.map((row) => ({ area: row.area, source_id: row.source_id, read: row.read, write: row.write }));
    item.denied_requests = deniedRows;
    writeAccessRequests(requests);
    res.json({ approved: true, partial: item.status === "approved_partial", permissions: user, approved_requests: item.approved_requests, denied_requests: item.denied_requests });
  });
  app.post("/admin/api/access-requests/:id/reject", requireAdmin, express.json(), (req: any, res: any) => {
    const id = String(req.params.id || "");
    const requests = readAccessRequests();
    const item = requests.find((r4) => r4.id === id);
    if (!item) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (item.status !== "pending") {
      res.status(400).json({ error: "Request is not pending" });
      return;
    }
    item.status = "rejected";
    item.decided_at = new Date().toISOString();
    item.decided_by = "admin";
    item.rejection_reason = String(req.body?.reason || "").slice(0, 1000);
    writeAccessRequests(requests);
    res.json({ rejected: true });
  });



  app.get('/admin/permissions', requireAdmin, (_req: Request, res: Response) => {
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>GBrain User Permissions</title><style>
body{margin:0;background:#101014;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}.wrap{max-width:1320px;margin:0 auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}.btn{background:#007acc;color:white;border:0;border-radius:6px;padding:8px 12px;text-decoration:none;cursor:pointer}.btn.gray{background:#444}.muted{color:#aaa;font-size:13px}table{width:100%;border-collapse:collapse;margin-top:18px;background:#1d1d24;border:1px solid #333;border-radius:10px;overflow:hidden}th,td{border-bottom:1px solid #333;padding:8px;text-align:center;vertical-align:middle}th{color:#bbb;font-weight:600;background:#181820;position:sticky;top:0}td.email{text-align:left;white-space:nowrap}td.source{text-align:left;color:#aaa;font-size:12px}input[type=checkbox]{transform:scale(1.1)}.cell{display:flex;gap:6px;justify-content:center;align-items:center}.r{color:#8cc8ff}.w{color:#ffd479}.saved{color:#91e091;margin-left:10px}.err{color:#ff9c9c;margin-left:10px}</style></head><body><div class="wrap"><div class="top"><div><h1>Права пользователей GBrain</h1><div class="muted">Таблица читает и меняет <code>~/.gbrain/user_permissions.json</code>. R = чтение, W = запись.</div></div><div><a class="btn gray" href="/admin/access-requests">Заявки</a> <a class="btn gray" href="/admin/">Админ-панель</a></div></div><div id="msg" class="muted"></div><div id="root">Загрузка...</div></div><script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opt){const r=await fetch(url,opt);if(!r.ok)throw new Error(await r.text());return r.json()}
function render(data){const areas=data.areas||[];const users=data.users||[];let html='<table><thead><tr><th>Пользователь</th><th>Личная область</th>'+areas.map(a=>'<th>'+esc(a.label)+'<br><span class="muted">'+esc(a.sourceId)+'</span></th>').join('')+'<th></th></tr></thead><tbody>';for(const u of users){html+='<tr data-email="'+esc(u.email)+'"><td class="email">'+esc(u.email)+'</td><td class="source"><code>'+esc(u.source_id||'')+'</code></td>'+areas.map(a=>{const r=(u.federated_read||[]).includes(a.sourceId);const w=(u.federated_write||[]).includes(a.sourceId);return '<td><div class="cell"><label class="r">R <input class="p-read" data-source="'+esc(a.sourceId)+'" type="checkbox" '+(r?'checked':'')+'></label><label class="w">W <input class="p-write" data-source="'+esc(a.sourceId)+'" type="checkbox" '+(w?'checked':'')+'></label></div></td>'}).join('')+'<td><button class="btn save">Сохранить</button></td></tr>'}html+='</tbody></table>';document.getElementById('root').innerHTML=html;document.querySelectorAll('tr[data-email]').forEach(bindRow)}
function bindRow(row){row.querySelectorAll('.p-write').forEach(w=>w.onchange=()=>{if(w.checked){const r=row.querySelector('.p-read[data-source="'+w.dataset.source+'"]');if(r)r.checked=true}});row.querySelectorAll('.p-read').forEach(r=>r.onchange=()=>{if(!r.checked){const w=row.querySelector('.p-write[data-source="'+r.dataset.source+'"]');if(w)w.checked=false}});row.querySelector('.save').onclick=async()=>{const email=row.dataset.email;const grants=[];row.querySelectorAll('.p-read').forEach(r=>{const w=row.querySelector('.p-write[data-source="'+r.dataset.source+'"]');grants.push({source_id:r.dataset.source,read:r.checked||w.checked,write:w.checked})});const msg=document.getElementById('msg');msg.className='muted';msg.textContent='Сохранение...';try{await api('/admin/api/permissions/'+encodeURIComponent(email),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grants})});msg.className='saved';msg.textContent='Сохранено: '+email}catch(e){msg.className='err';msg.textContent='Ошибка: '+e.message}}}
async function load(){try{render(await api('/admin/api/permissions'))}catch(e){document.getElementById('root').innerHTML='<div class="err">'+esc(e.message)+'</div>'}}load();
</script></body></html>`);
  });

  app.get('/admin/api/permissions', requireAdmin, (_req: Request, res: Response) => {
    const perms = loadJsonFileLocal<Record<string, PortalUserPermissions>>(userPermissionsPath(), {});
    const users = Object.entries(perms).sort(([a], [b]) => a.localeCompare(b)).map(([email, p]: any) => ({
      email,
      source_id: p?.source_id || '',
      federated_read: Array.isArray(p?.federated_read) ? p.federated_read : [],
      federated_write: Array.isArray(p?.federated_write) ? p.federated_write : [],
    }));
    res.json({ areas: managedAccessAreas, users });
  });

  app.post('/admin/api/permissions/:email', requireAdmin, express.json(), (req: Request, res: Response) => {
    const email = String(req.params.email || '').toLowerCase();
    const perms = loadJsonFileLocal<Record<string, PortalUserPermissions>>(userPermissionsPath(), {});
    const user = perms[email];
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    const allowedManaged = new Set(managedAccessAreas.map(a => a.sourceId));
    const grants = Array.isArray(req.body?.grants) ? req.body.grants : [];
    const read = new Set<string>(Array.isArray(user.federated_read) ? user.federated_read.filter((x: string) => !allowedManaged.has(x)) : []);
    const write = new Set<string>(Array.isArray(user.federated_write) ? user.federated_write.filter((x: string) => !allowedManaged.has(x)) : []);
    if (user.source_id) { read.add(user.source_id); write.add(user.source_id); }
    for (const grant of grants) {
      const sourceId = String(grant?.source_id || '');
      if (!allowedManaged.has(sourceId)) continue;
      const canWrite = !!grant.write;
      const canRead = !!grant.read || canWrite;
      if (canRead) read.add(sourceId);
      if (canWrite) write.add(sourceId);
    }
    user.federated_read = Array.from(read).filter(Boolean);
    user.federated_write = Array.from(write).filter(Boolean);
    perms[email] = user;
    writeJsonFileLocal(userPermissionsPath(), perms);
    res.json({ ok: true, user });
  });
  // OAuth authorization must be bound to the same opaque, server-side Portal
  // session used by the rest of the application. Never let the SDK issue an
  // authorization code without a verified resource owner.
  app.use('/authorize', (req: Request, res: Response, next: NextFunction) => {
    const portalEmail = resolvePortalUser(req, res);
    if (!portalEmail) {
      return res.redirect(`/login?${req.originalUrl.split('?')[1] || ''}`);
    }
    res.locals.gbrainPortalUser = portalEmail;
    next();
  });

  app.use(authRouter);

  // ---------------------------------------------------------------------------
  // Health check — liveness only. Full engine stats live at
  // /admin/api/full-stats (requireAdmin). See probeLiveness above for the why.
  // ---------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    const result = await probeLiveness(sql, config.engine || 'pglite', VERSION);
    res.status(result.status).json(result.body);
  });

  // ---------------------------------------------------------------------------
  // Admin authentication (cookie-based)
  // ---------------------------------------------------------------------------
  // v0.40 D15.5: safeHexEqual extracted to src/core/timing-safe.ts so the new
  // /webhooks/github HMAC verifier reuses the same constant-time compare.
  // POST /admin/login — JSON body with token (for programmatic/UI login)
  app.post('/admin/login', express.json(), (req, res) => {
    const token = req.body?.token;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token required' });
      return;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (!safeHexEqual(tokenHash, bootstrapHash)) {
      res.status(401).json({ error: 'Invalid token. Check your terminal output.' });
      return;
    }

    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    adminSessions.set(sessionId, expiresAt);

    res.cookie('gbrain_admin', sessionId, adminCookie(req, 24 * 60 * 60 * 1000));
    res.json({ status: 'authenticated' });
  });

  // ---------------------------------------------------------------------------
  // Magic-link nonce store (single-use) — D11 + D12
  //
  // Trust model (codex review pushback resolved this):
  //   - Bootstrap token is the long-term server admin secret. Printed to
  //     stderr at startup; lives in operator's terminal scrollback only.
  //   - Magic-link URLs use one-time NONCES (not the bootstrap token).
  //     Agent calls POST /admin/api/issue-magic-link with the bootstrap
  //     token in Authorization: Bearer to mint a nonce. Nonce expires in
  //     5 minutes if unredeemed; consumed on first redemption.
  //   - Bootstrap token never appears in a URL → no leakage via browser
  //     history, proxy access logs, or Referer headers.
  //   - Cookie sessions are HttpOnly + SameSite=Strict, but the bootstrap
  //     token itself is never client-side-readable JS state (no
  //     localStorage/sessionStorage cache — D12).
  //
  // Memory bound: nonces auto-purged on expiry sweep + LRU cap of 1000
  // entries (an attacker minting millions can't OOM the server).
  // ---------------------------------------------------------------------------
  const magicLinkNonces = new Map<string, number>(); // nonce → expiresAt
  const consumedNonces = new Set<string>();
  const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const NONCE_LRU_CAP = 1000;

  // Best-effort GC: remove expired entries on each issue/redeem call.
  function pruneExpiredNonces() {
    const now = Date.now();
    for (const [nonce, expiresAt] of magicLinkNonces) {
      if (expiresAt < now) magicLinkNonces.delete(nonce);
    }
    // F10: bound the live-nonce store too. An attacker with the bootstrap
    // token (or a misbehaving agent) could mint nonces faster than they
    // expire. Map iteration order is insertion order, so dropping from the
    // front gives a simple FIFO eviction matching the consumedNonces pattern.
    if (magicLinkNonces.size > NONCE_LRU_CAP) {
      const drop = magicLinkNonces.size - NONCE_LRU_CAP;
      const it = magicLinkNonces.keys();
      for (let i = 0; i < drop; i++) magicLinkNonces.delete(it.next().value as string);
    }
    // Cap consumedNonces growth — drop oldest entries past the LRU cap.
    if (consumedNonces.size > NONCE_LRU_CAP) {
      const drop = consumedNonces.size - NONCE_LRU_CAP;
      const it = consumedNonces.values();
      for (let i = 0; i < drop; i++) consumedNonces.delete(it.next().value as string);
    }
  }

  // POST /admin/api/issue-magic-link — agent-callable mint endpoint.
  // Auth: Authorization: Bearer <bootstrapToken>. Returns one-time nonce.
  app.post('/admin/api/issue-magic-link', express.json(), (req: Request, res: Response) => {
    const auth = (req.headers.authorization || '') as string;
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (!m) {
      res.status(401).json({ error: 'Authorization: Bearer <bootstrap-token> required' });
      return;
    }
    const tokenHash = createHash('sha256').update(m[1]).digest('hex');
    if (!safeHexEqual(tokenHash, bootstrapHash)) {
      res.status(401).json({ error: 'Invalid bootstrap token' });
      return;
    }
    pruneExpiredNonces();
    const nonce = randomBytes(32).toString('hex');
    magicLinkNonces.set(nonce, Date.now() + NONCE_TTL_MS);
    const baseUrl = publicUrl || `http://localhost:${port}`;
    res.json({ url: `${baseUrl}/admin/auth/${nonce}`, expires_in: NONCE_TTL_MS / 1000 });
  });

  // GET /admin/auth/:nonce — single-use magic link redemption.
  // Browser hits it, server validates the nonce (exists + unconsumed +
  // unexpired), marks consumed, sets cookie, redirects to dashboard.
  // Rate-limited at 10/min/IP to harden against DoS via bad-token loops.
  app.get('/admin/auth/:token', adminAuthRateLimiter, (req: Request, res: Response) => {
    const nonce = String(req.params.token ?? '');
    pruneExpiredNonces();

    const expiresAt = magicLinkNonces.get(nonce);
    const isValid = !!nonce && !!expiresAt && expiresAt > Date.now() && !consumedNonces.has(nonce);

    if (!isValid) {
      res.status(401).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GBrain</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{max-width:400px;padding:32px;text-align:left}
.logo{font-size:28px;font-weight:600;margin-bottom:24px}
.msg{color:#888;font-size:14px;line-height:1.6;margin-bottom:20px}
.hint{background:rgba(136,170,255,0.08);border:1px solid rgba(136,170,255,0.2);border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.5;color:#888}
.hint b{color:#e0e0e0}
.prompt{background:rgba(0,0,0,0.3);border-radius:6px;padding:8px 12px;margin-top:8px;font-family:monospace;font-size:12px;color:#88aaff}
</style></head><body><div class="box">
<div class="logo">GBrain</div>
<div class="msg">⚠️ This admin link has expired, was already used, or the server has restarted.</div>
<div class="hint"><b>Get a fresh link from your AI agent:</b>
<div class="prompt">&ldquo;Give me the GBrain admin login link&rdquo;</div>
</div></div></body></html>`);
      return;
    }

    // Consume the nonce — it's single-use, second click will fail.
    magicLinkNonces.delete(nonce);
    consumedNonces.add(nonce);

    const sessionId = randomBytes(32).toString('hex');
    const sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days for magic link
    adminSessions.set(sessionId, sessionExpiresAt);

    res.cookie('gbrain_admin', sessionId, adminCookie(req, 7 * 24 * 60 * 60 * 1000));
    res.redirect('/admin/');
  });

  // Admin auth middleware
  function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
    const cookies = (req.cookies as Record<string, string>) || {};
    const sessionId = cookies.gbrain_admin;
    if (sessionId && adminSessions.has(sessionId)) {
      const expiresAt = adminSessions.get(sessionId)!;
      if (Date.now() <= expiresAt) {
        next();
        return;
      }
      adminSessions.delete(sessionId);
    }

    // Bridge only a server-resolved opaque Portal session into an admin session.
    // The legacy unsigned session_user cookie is intentionally ignored.
    const portalEmail = resolvePortalUser(req, res) || '';
    if (isAdminEmail(portalEmail)) {
      const bridgedSessionId = randomBytes(32).toString('hex');
      const bridgedTtlMs = 30 * 24 * 60 * 60 * 1000;
      adminSessions.set(bridgedSessionId, Date.now() + bridgedTtlMs);
      res.cookie('gbrain_admin', bridgedSessionId, adminCookie(req, bridgedTtlMs));
      next();
      return;
    }

    res.status(401).json({ error: 'Admin authentication required' });
  }

  function requireAdminSameOrigin(req: express.Request, res: express.Response, next: express.NextFunction) {
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin') {
      res.status(403).json({ error: 'cross_site_admin_mutation_rejected' });
      return;
    }
    const origin = req.get('origin');
    if (origin) {
      try {
        const expectedOrigin = `${req.protocol}://${req.get('host')}`;
        if (new URL(origin).origin !== expectedOrigin) {
          res.status(403).json({ error: 'cross_origin_admin_mutation_rejected' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'invalid_origin' });
        return;
      }
    } else if (fetchSite !== 'same-origin') {
      res.status(403).json({ error: 'missing_same_origin_evidence' });
      return;
    }
    next();
  }

  function sendReviewError(res: express.Response, error: unknown): void {
    if (error instanceof ReviewConflictError) {
      res.status(error.code === 'not_found' ? 404 : 409).json({ error: error.code, message: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: 'review_request_failed', message });
  }

  // ---------------------------------------------------------------------------
  // Admin API endpoints
  // ---------------------------------------------------------------------------

  const meetingReviewQueue = new MinionQueue(engine);
  const meetingIngestScript = process.env.GBRAIN_MEETING_INGEST_SCRIPT || join(homedir(), 'scripts', 'meeting-ingest.sh');
  const enqueueMeetingIngest = async (argv: string[], idempotencyKey: string) => {
    const data = { cwd: homedir(), argv: [meetingIngestScript, ...argv] };
    validateShellJobParams(data);
    return meetingReviewQueue.add('shell', data, {
      max_attempts: 1,
      timeout_ms: 600_000,
      idempotency_key: idempotencyKey,
    }, { allowProtectedSubmit: true });
  };
  const enqueueCalibrationProfile = async () => {
    const cliEntry = process.argv[1];
    if (!cliEntry) throw new Error('calibration_cli_entry_unavailable');
    const data = { cwd: homedir(), argv: [process.execPath, cliEntry, 'dream', '--phase', 'calibration_profile'] };
    validateShellJobParams(data);
    const hourBucket = new Date().toISOString().slice(0, 13);
    return meetingReviewQueue.add('shell', data, {
      max_attempts: 1,
      timeout_ms: 1_800_000,
      idempotency_key: `admin-calibration-profile:${hourBucket}`,
    }, { allowProtectedSubmit: true });
  };

  app.get('/admin/api/meeting-review/items', requireAdmin, async (req: Request, res: Response) => {
    try {
      const statusRaw = String(req.query.status ?? 'pending');
      const status = ['pending', 'accepted', 'rejected'].includes(statusRaw) ? statusRaw as MeetingReviewStatus : 'pending';
      res.json(await listMeetingReviewItems({
        status,
        query: typeof req.query.q === 'string' ? req.query.q : undefined,
        limit: Number(req.query.limit ?? 100),
      }));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.get('/admin/api/meeting-review/items/:id', requireAdmin, async (req: Request, res: Response) => {
    try { res.json(await getMeetingReviewItem(String(req.params.id))); }
    catch (error) { sendReviewError(res, error); }
  });

  app.post('/admin/api/meeting-review/items/:id/revisions/manual', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try { res.json(await createManualMeetingRevision(String(req.params.id), req.body?.draft, adminActor(req))); }
    catch (error) { sendReviewError(res, error); }
  });

  app.post('/admin/api/meeting-review/items/:id/revisions/llm', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await createLlmMeetingRevision(
        String(req.params.id),
        String(req.body?.field ?? 'canonical_markdown') as 'canonical_markdown' | 'shared_markdown' | 'split_markdown',
        String(req.body?.comment ?? ''),
        adminActor(req),
      ));
    } catch (error) { sendReviewError(res, error); }
  });

  app.post('/admin/api/meeting-review/items/:id/accept', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const actor = adminActor(req);
    try {
      await acceptMeetingReview(id, req.body?.draft, actor);
      try {
        const job = await enqueueMeetingIngest(['--wait-lock', '--apply', '--ids', id], `meeting-review:${id}:accepted-v1`);
        const item = await attachMeetingReviewJob(id, job.id, actor);
        res.status(202).json({ item, job_id: job.id });
      } catch (queueError) {
        await reopenMeetingReviewAfterQueueFailure(id, queueError instanceof Error ? queueError.message : String(queueError), actor);
        throw queueError;
      }
    } catch (error) { sendReviewError(res, error); }
  });

  app.post('/admin/api/meeting-review/items/:id/reject', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try { res.json(await rejectMeetingReview(String(req.params.id), String(req.body?.reason ?? ''), adminActor(req))); }
    catch (error) { sendReviewError(res, error); }
  });

  app.post('/admin/api/meeting-review/refresh', requireAdmin, requireAdminSameOrigin, express.json(), async (_req: Request, res: Response) => {
    try {
      const slot = new Date().toISOString().slice(0, 16);
      const job = await enqueueMeetingIngest(['--dry-run', '--limit', '50'], `meeting-review:refresh:${slot}`);
      res.status(202).json({ job_id: job.id });
    } catch (error) { sendReviewError(res, error); }
  });

  app.get('/admin/api/ai-review/proposals', requireAdmin, async (req: Request, res: Response) => {
    try {
      const statusRaw = String(req.query.status ?? 'pending');
      const status = ['pending', 'accepted', 'rejected', 'superseded'].includes(statusRaw)
        ? statusRaw as TakeProposalStatus
        : 'pending';
      res.json(await listTakeProposals(engine, {
        status,
        sourceId: typeof req.query.source_id === 'string' ? req.query.source_id : undefined,
        query: typeof req.query.q === 'string' ? req.query.q : undefined,
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
      }));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.get('/admin/api/ai-review/proposals/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await getTakeProposalReview(engine, Number(req.params.id)));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.post('/admin/api/ai-review/proposals/:id/revisions/manual', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await createManualTakeRevision(engine, Number(req.params.id), req.body?.draft, adminActor(req)));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.post('/admin/api/ai-review/proposals/:id/revisions/llm', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await createLlmTakeRevision(
        engine,
        Number(req.params.id),
        String(req.body?.comment ?? ''),
        adminActor(req),
        typeof req.body?.model === 'string' ? req.body.model : undefined,
      ));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.post('/admin/api/ai-review/proposals/:id/accept', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await acceptTakeProposal(
        engine,
        Number(req.params.id),
        req.body?.draft,
        adminActor(req),
        typeof req.body?.revision_id === 'number' ? req.body.revision_id : undefined,
      ));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.post('/admin/api/ai-review/proposals/:id/reject', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await rejectTakeProposal(engine, Number(req.params.id), adminActor(req), req.body?.reason));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.get('/admin/api/ai-review/concepts', requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await listConceptProposals(engine, {
        status: String(req.query.status ?? 'pending'),
        query: typeof req.query.q === 'string' ? req.query.q : undefined,
        limit: Number(req.query.limit ?? 50),
      }));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.get('/admin/api/ai-review/concepts/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await getConceptProposalReview(engine, Number(req.params.id)));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.post('/admin/api/ai-review/concepts/:id/revisions/manual', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await createManualConceptRevision(engine, Number(req.params.id), String(req.body?.proposed_markdown ?? ''), adminActor(req)));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.post('/admin/api/ai-review/concepts/:id/revisions/llm', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await createLlmConceptRevision(engine, Number(req.params.id), String(req.body?.comment ?? ''), adminActor(req), req.body?.model));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.post('/admin/api/ai-review/concepts/:id/accept', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await acceptConceptProposal(engine, Number(req.params.id), req.body?.proposed_markdown, adminActor(req), {
        revisionId: typeof req.body?.revision_id === 'number' ? req.body.revision_id : undefined,
        allowOverwriteExisting: req.body?.allow_overwrite_existing === true,
      }));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  app.post('/admin/api/ai-review/concepts/:id/reject', requireAdmin, requireAdminSameOrigin, express.json(), async (req: Request, res: Response) => {
    try {
      res.json(await rejectConceptProposal(engine, Number(req.params.id), adminActor(req), req.body?.reason));
    } catch (error) {
      sendReviewError(res, error);
    }
  });

  // Sign-out-everywhere: nuke ALL active admin sessions in-memory. Every
  // browser/tab fails its next request, gets 401, redirects to login.
  // The bootstrap token itself is unaffected (still valid for new
  // magic-link mints) — this only revokes existing cookie sessions.
  app.post('/admin/api/sign-out-everywhere', requireAdmin, (_req: Request, res: Response) => {
    const count = adminSessions.size;
    adminSessions.clear();
    res.json({ revoked_sessions: count });
  });

  app.get('/admin/api/agents', requireAdmin, async (_req: Request, res: Response) => {
    try {
      // Unified view: OAuth clients + legacy API keys
      const oauthClients = await sql`
        SELECT c.client_id as id, c.client_name as name, 'oauth' as auth_type,
          c.grant_types, c.scope, c.created_at, c.token_ttl,
          CASE WHEN c.deleted_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          (SELECT max(created_at) FROM mcp_request_log WHERE token_name = c.client_id) as last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id AND created_at > now() - interval '24 hours') as requests_today
        FROM oauth_clients c ORDER BY c.created_at DESC
      `;
      const legacyKeys = await sql`
        SELECT a.id, a.name, 'api_key' as auth_type,
          '{"bearer"}' as grant_types, 'read write admin' as scope, a.created_at, null as token_ttl,
          CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          a.last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name AND created_at > now() - interval '24 hours') as requests_today
        FROM access_tokens a ORDER BY a.created_at DESC
      `;
      res.json([...oauthClients, ...legacyKeys]);
    } catch (e) {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // v0.38 Slice 4 — per-OAuth-client agent spend viewer. Pre-computes today's
  // spend (committed + pending reservations) per client so the Agents tab
  // can render a "$X / $Y today" cell. Read-side endpoint only — no mutation.
  // Falls back to an empty array on pre-v0.38 brains where mcp_spend_log
  // exists but agent dispatch hasn't recorded anything.
  app.get('/admin/api/agents/spend', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await queryAgentClientSpend(engine);
      res.json(rows);
    } catch (e) {
      // Pre-v0.38 brains: tables may not exist yet. Return empty so the UI
      // renders gracefully instead of erroring.
      res.json([]);
    }
  });

  app.get('/admin/api/stats', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const [clients] = await sql`SELECT count(*)::int as count FROM oauth_clients`;
      const [tokens] = await sql`SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > ${Math.floor(Date.now() / 1000)}`;
      const [requests] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`;
      const [apiKeys] = await sql`SELECT count(*)::int as count FROM access_tokens WHERE revoked_at IS NULL`;
      res.json({
        connected_agents: (clients as any).count,
        active_tokens: (tokens as any).count,
        active_api_keys: (apiKeys as any).count,
        requests_today: (requests as any).count,
      });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.get('/admin/api/health-indicators', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [expiring] = await sql`SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at BETWEEN ${now} AND ${now + 86400}`;
      const [errors] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE status != 'success' AND created_at > now() - interval '24 hours'`;
      const [total] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`;
      const errorRate = (total as any).count > 0 ? ((errors as any).count / (total as any).count * 100).toFixed(1) : '0';
      res.json({
        expiring_soon: (expiring as any).count,
        error_rate: `${errorRate}%`,
      });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // Full engine stats. v0.28.10 moved this off /health (which is now liveness
  // only — see probeLiveness) so dashboards needing page_count / chunk_count
  // / etc. authenticate as admin and call this endpoint. probeHealth races
  // engine.getStats() against HEALTH_TIMEOUT_MS so a saturated pool returns
  // 503 rather than hanging.
  app.get('/admin/api/full-stats', requireAdmin, async (_req: Request, res: Response) => {
    const result = await probeHealth(engine, config.engine || 'pglite', VERSION);
    res.status(result.status).json(result.body);
  });

  // v0.41 D2 — live jobs dashboard data. Shares readSnapshot() with the
  // TTY `gbrain jobs watch` command so the two surfaces stay 1:1.
  app.get('/admin/api/jobs/watch', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { readSnapshot } = await import('./jobs-watch.ts');
      const snap = await readSnapshot(engine);
      res.json(snap);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  // Historical Minion/autopilot activity. Admin-only and intentionally
  // returns a curated report shape rather than raw job data (which may contain
  // repo paths or handler-specific parameters).
  app.get('/admin/api/activity/runs', requireAdmin, async (req: Request, res: Response) => {
    try {
      const first = (value: unknown): string | undefined => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
        return undefined;
      };
      const integer = (value: unknown): number | undefined => {
        const raw = first(value);
        if (raw === undefined) return undefined;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      const { readActivitySnapshot } = await import('./activity-runs.ts');
      const report = await readActivitySnapshot(engine, {
        period: first(req.query.period),
        since: first(req.query.since),
        until: first(req.query.until),
        status: first(req.query.status),
        name: first(req.query.name),
        source: first(req.query.source),
        limit: integer(req.query.limit),
        offset: integer(req.query.offset),
        exportAll: first(req.query.export) === 'true' || first(req.query.export) === '1',
      });
      res.json(report);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const invalid = /Invalid |must be earlier|cannot exceed/.test(msg);
      res.status(invalid ? 400 : 500).json({ error: msg });
    }
  });

  // Source Ingest admin review/config console. Admin-authenticated and local/trusted:
  // this is the human UI for configuring connectors and profiles before any write job.
  app.get('/admin/api/source-ingest/overview', requireAdmin, async (_req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const [profiles, status, refresh, sources, connectorConfigs, catalogTree] = await Promise.all([
        operationsByName.source_profile_get.handler(ctx, {}),
        operationsByName.source_sync_status.handler(ctx, { limit: 200 }),
        operationsByName.source_refresh.handler(ctx, {}),
        engine.executeRaw(`SELECT id, name, local_path AS path, (config->>'federated')::boolean AS federated FROM sources ORDER BY id`),
        operationsByName.source_connector_config_get.handler(ctx, {}),
        operationsByName.source_ingest_tree.handler(ctx, {}),
      ]);
      const connectorConfigRows = Array.isArray((connectorConfigs as any)?.rows) ? (connectorConfigs as any).rows : [];
      res.json({
        connectors: sourceIngestConnectorDescriptors(),
        profiles,
        status,
        refresh,
        sources,
        connector_configs: connectorConfigs,
        source_tables: sourceTableSummariesFromConfigs(connectorConfigRows as any),
        catalog_tree: catalogTree,
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/admin/api/source-ingest/catalog/tree', requireAdmin, async (_req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      res.json(await operationsByName.source_ingest_tree.handler(ctx, {}));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/admin/api/source-ingest/schema-view', requireAdmin, async (_req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const [active_pack, stats, graph] = await Promise.all([
        operationsByName.get_active_schema_pack.handler(ctx, {}),
        operationsByName.schema_stats.handler(ctx, {}),
        operationsByName.schema_graph.handler(ctx, {}),
      ]);
      res.json({ ok: true, active_pack, stats, graph });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/admin/api/source-ingest/schema-view/type/:type', requireAdmin, async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      res.json(await operationsByName.schema_explain_type.handler(ctx, { type: req.params.type }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/admin/api/source-ingest/schema-view/type-card/:type', requireAdmin, async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      res.json(await operationsByName.schema_type_card.handler(ctx, { type: req.params.type }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/schema-view/proposal', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'shared', remote: false, dryRun: false };
    try {
      res.json(await operationsByName.schema_proposal_create.handler(ctx, req.body || {}));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/admin/api/source-ingest/article-template/:type', requireAdmin, async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      res.json(await operationsByName.source_article_template.handler(ctx, { gbrain_type: req.params.type }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/connector', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const connector_id = typeof body.connector_id === 'string' ? body.connector_id.trim() : '';
      const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
      const display_name = typeof body.display_name === 'string' ? body.display_name.trim() : connector_id;
      if (!connector_id || !kind) {
        res.status(400).json({ error: 'connector_id_and_kind_required' });
        return;
      }
      const out = await operationsByName.source_connector_upsert.handler(ctx, {
        connector_id,
        kind,
        display_name,
        config_json: body.config_json && typeof body.config_json === 'object' ? body.config_json : {},
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/connector/delete', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const connector_id = typeof req.body?.connector_id === 'string' ? req.body.connector_id.trim() : '';
      if (!connector_id) {
        res.status(400).json({ error: 'connector_id_required' });
        return;
      }
      res.json(await operationsByName.source_connector_delete.handler(ctx, {
        connector_id,
        confirm_token: typeof req.body?.confirm_token === 'string' ? req.body.confirm_token : undefined,
        force: req.body?.force === true,
      }));
    } catch (e) {
      res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/delete-impact', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const kind = typeof req.body?.kind === 'string' ? req.body.kind.trim() : '';
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      if (!kind || !id) {
        res.status(400).json({ error: 'kind_id_required' });
        return;
      }
      res.json(await operationsByName.source_catalog_delete_impact.handler(ctx, { kind, id }));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  async function sourceConnectorRuntimeConfig(body: Record<string, unknown>): Promise<{ connectorId: string; objectName?: string; config: Record<string, unknown>; credentialStatus: Record<string, unknown> }> {
    const connectorId = typeof body.connector_id === 'string' ? body.connector_id.trim() : 'appsheet-vehicles';
    const objectName = typeof body.source_object === 'string' && body.source_object.trim() ? body.source_object.trim() : undefined;
    const tableName = typeof body.table_name === 'string' ? body.table_name.trim() : undefined;
    const configId = typeof body.config_id === 'string' ? body.config_id : (objectName ? defaultSourceConnectorConfigId(connectorId, objectName, tableName) : `connector:${connectorId}`);
    const saved = await operationsByName.source_connector_list.handler(
      { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true },
      { connector_id: connectorId },
    ) as { rows?: Array<Record<string, unknown>> };
    const row = saved.rows?.[0];
    const rowConfig = row?.config_json && typeof row.config_json === 'object' ? row.config_json as Record<string, unknown> : {};
    const objectSecretConfig = objectName ? await getSourceConnectorSecretConfig(engine, connectorId, objectName, configId) : {};
    const connectorSecretConfig = await getSourceConnectorSecretConfig(engine, connectorId, '__connection__', `connector:${connectorId}`);
    const credentialStatus = await sourceConnectorSecretStatus(engine, connectorId, `connector:${connectorId}`, '__connection__') as unknown as Record<string, unknown>;
    const isAppSheet = connectorId === 'appsheet' || connectorId === 'appsheet-vehicles' || connectorId.startsWith('appsheet-');
    return {
      connectorId,
      objectName,
      credentialStatus,
      config: {
        ...rowConfig,
        ...nonSecretConnectorConfigFromBody(body),
        ...(isAppSheet && objectName ? { table_name: tableName || objectName } : {}),
        ...connectorSecretConfig,
        ...objectSecretConfig,
      },
    };
  }

  app.post('/admin/api/source-ingest/catalog/connector/list-objects', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { connectorId, objectName, config: runtimeConfig } = await sourceConnectorRuntimeConfig((req.body || {}) as Record<string, unknown>);
      if (!objectName && (connectorId === 'appsheet' || connectorId === 'appsheet-vehicles' || connectorId.startsWith('appsheet-'))) {
        res.json({ ok: true, connector_id: connectorId, objects: [], note: 'No table/object was requested. AppSheet does not expose reliable table discovery here; enter the table name in Base view and run Execute/Discover there.' });
        return;
      }
      const connector = getSourceConnector(connectorId, runtimeConfig);
      if (!connector) {
        res.status(400).json({ ok: false, error: `unsupported_connector: ${connectorId}` });
        return;
      }
      const objects = await connector.listObjects();
      res.json({ ok: true, connector_id: connectorId, objects });
    } catch (e) {
      res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/connector/test', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const started = Date.now();
    try {
      const { connectorId, objectName, config: runtimeConfig, credentialStatus } = await sourceConnectorRuntimeConfig((req.body || {}) as Record<string, unknown>);
      const connector = getSourceConnector(connectorId, runtimeConfig);
      if (!connector) {
        res.status(400).json({ ok: false, status: 'unsupported_connector', connector_id: connectorId });
        return;
      }
      const credentialsConfigured = (credentialStatus.configured !== false);
      const isAppSheet = connectorId === 'appsheet' || connectorId === 'appsheet-vehicles' || connectorId.startsWith('appsheet-');
      const shouldProbeObjects = credentialsConfigured && (!!objectName || connectorId === 'postgres' || connectorId.startsWith('postgres-'));
      if (shouldProbeObjects && isAppSheet && objectName) await connector.sample(objectName, 1);
      const objects = shouldProbeObjects ? await connector.listObjects() : [];
      if (!credentialsConfigured) {
        await recordSourceConnectorTest(engine, connectorId, false);
        res.json({ ok: false, status: 'credentials_missing', connector_id: connectorId, elapsed_ms: Date.now() - started, credential_status: credentialStatus, objects, note: 'Connector-level test does not require a table. Add credentials here; table-specific extraction is tested from Base view.' });
        return;
      }
      await recordSourceConnectorTest(engine, connectorId, true);
      res.json({ ok: true, status: shouldProbeObjects ? 'connection_ok' : 'credentials_stored_unverified', connector_id: connectorId, ...(objectName ? { source_object: objectName } : {}), elapsed_ms: Date.now() - started, credential_status: credentialStatus, objects, note: shouldProbeObjects ? 'Connector credentials are valid; object discovery succeeded.' : 'Credentials are stored but were not verified against a concrete AppSheet table. Create or open a Base view to run a remote read probe.' });
    } catch (e) {
      const connectorId = typeof req.body?.connector_id === 'string' ? req.body.connector_id : '';
      if (connectorId) await recordSourceConnectorTest(engine, connectorId, false).catch(() => undefined);
      res.status(200).json({ ok: false, status: 'connection_failed', elapsed_ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/base-view/discover', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const connector_id = typeof body.connector_id === 'string' ? body.connector_id.trim() : '';
      const object_name = typeof body.object_name === 'string' ? body.object_name.trim() : '';
      if (!connector_id || !object_name) {
        res.status(400).json({ error: 'connector_id_object_name_required' });
        return;
      }
      const selected_fields = Array.isArray(body.selected_fields) ? body.selected_fields.flatMap(v => String(v).split(/\\n|[\n,]/)).map(s => s.trim()).filter(Boolean) : [];
      const primary_key_field = typeof body.primary_key_field === 'string' && body.primary_key_field.trim() ? body.primary_key_field.trim() : undefined;
      const updated_at_field = typeof body.updated_at_field === 'string' && body.updated_at_field.trim() ? body.updated_at_field.trim() : undefined;
      const sample_limit = Number.isFinite(Number(body.sample_limit)) ? Number(body.sample_limit) : 25;
      const { config: runtimeConfig } = await sourceConnectorRuntimeConfig({ ...body, connector_id, source_object: object_name, table_name: object_name, config_id: `connector:${connector_id}` });
      const out = await operationsByName.source_discover.handler(ctx, {
        connector_id,
        source_object: object_name,
        sample_limit,
        connector_config: runtimeConfig,
        ...(selected_fields.length ? { selected_fields } : {}),
        ...(primary_key_field ? { primary_key_field } : {}),
        ...(updated_at_field ? { updated_at_field } : {}),
      });
      res.json(out);
    } catch (e) {
      res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/base-view/execute', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const out = await operationsByName.source_base_view_execute.handler(ctx, {
        base_view_id: typeof req.body?.base_view_id === 'string' ? req.body.base_view_id : undefined,
        draft: req.body?.draft && typeof req.body.draft === 'object' ? req.body.draft : undefined,
        sample_limit: Number.isFinite(Number(req.body?.sample_limit)) ? Number(req.body.sample_limit) : undefined,
        connector_config: req.body?.connector_config && typeof req.body.connector_config === 'object' ? req.body.connector_config : undefined,
        discover_all_fields: req.body?.discover_all_fields === true,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/base-view', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const base_view_id = typeof body.base_view_id === 'string' ? body.base_view_id.trim() : '';
      const connector_id = typeof body.connector_id === 'string' ? body.connector_id.trim() : '';
      const object_name = typeof body.object_name === 'string' ? body.object_name.trim() : '';
      if (!base_view_id || !connector_id || !object_name) {
        res.status(400).json({ error: 'base_view_id_connector_id_object_name_required' });
        return;
      }
      const selected_fields = Array.isArray(body.selected_fields) ? body.selected_fields.flatMap(v => String(v).split(/\\n|[\n,]/)).map(s => s.trim()).filter(Boolean) : [];
      const row_filter = Array.isArray(body.row_filter) ? body.row_filter : [];
      const sample_limit = Number.isFinite(Number(body.sample_limit)) ? Number(body.sample_limit) : 50;
      const has_primary_key_field = Object.prototype.hasOwnProperty.call(body, 'primary_key_field');
      const has_updated_at_field = Object.prototype.hasOwnProperty.call(body, 'updated_at_field');
      const primary_key_field = typeof body.primary_key_field === 'string' ? body.primary_key_field.trim() : '';
      const updated_at_field = typeof body.updated_at_field === 'string' ? body.updated_at_field.trim() : '';
      const discovery_json = body.discovery_json && typeof body.discovery_json === 'object'
        ? { ...(body.discovery_json as Record<string, unknown>), ...(primary_key_field ? { primary_key_field } : {}), ...(updated_at_field ? { updated_at_field } : {}) }
        : (primary_key_field || updated_at_field ? { ...(primary_key_field ? { primary_key_field } : {}), ...(updated_at_field ? { updated_at_field } : {}) } : undefined);
      const out = await operationsByName.source_base_view_upsert.handler(ctx, {
        base_view_id,
        connector_id,
        object_name,
        display_name: typeof body.display_name === 'string' ? body.display_name.trim() : base_view_id,
        selected_fields,
        row_filter,
        sample_limit,
        ...(has_primary_key_field ? { primary_key_field } : {}),
        ...(has_updated_at_field ? { updated_at_field } : {}),
        discovery_json,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/base-view/delete', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const base_view_id = typeof req.body?.base_view_id === 'string' ? req.body.base_view_id.trim() : '';
      if (!base_view_id) {
        res.status(400).json({ error: 'base_view_id_required' });
        return;
      }
      res.json(await operationsByName.source_base_view_delete.handler(ctx, {
        base_view_id,
        confirm_token: typeof req.body?.confirm_token === 'string' ? req.body.confirm_token : undefined,
        force: req.body?.force === true,
      }));
    } catch (e) {
      res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/transform-view', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const transform_view_id = typeof body.transform_view_id === 'string' ? body.transform_view_id.trim() : '';
      const sql = typeof body.sql === 'string' ? body.sql : '';
      const primary_key_field = typeof body.primary_key_field === 'string' ? body.primary_key_field.trim() : '';
      if (!transform_view_id || !sql.trim() || !primary_key_field) {
        res.status(400).json({ error: 'transform_view_id_sql_primary_key_required' });
        return;
      }
      const inputs = Array.isArray(body.inputs) ? body.inputs.map((input: unknown) => {
        const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        return { alias: String(raw.alias ?? '').trim(), base_view_id: String(raw.base_view_id ?? '').trim() };
      }).filter(input => input.alias && input.base_view_id) : [];
      if (inputs.length === 0) {
        res.status(400).json({ error: 'transform_inputs_required' });
        return;
      }
      const out = await operationsByName.source_transform_view_upsert.handler(ctx, {
        transform_view_id,
        display_name: typeof body.display_name === 'string' ? body.display_name.trim() : transform_view_id,
        inputs,
        sql,
        primary_key_field,
        updated_at_field: typeof body.updated_at_field === 'string' && body.updated_at_field.trim() ? body.updated_at_field.trim() : undefined,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/transform-view/execute', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const out = await operationsByName.source_transform_view_execute.handler(ctx, {
        transform_view_id: typeof req.body?.transform_view_id === 'string' ? req.body.transform_view_id : undefined,
        draft: req.body?.draft && typeof req.body.draft === 'object' ? req.body.draft : undefined,
        sample_limit: Number.isFinite(Number(req.body?.sample_limit)) ? Number(req.body.sample_limit) : undefined,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/transform-view/delete', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const transform_view_id = typeof req.body?.transform_view_id === 'string' ? req.body.transform_view_id.trim() : '';
      if (!transform_view_id) {
        res.status(400).json({ error: 'transform_view_id_required' });
        return;
      }
      res.json(await operationsByName.source_transform_view_delete.handler(ctx, {
        transform_view_id,
        confirm_token: typeof req.body?.confirm_token === 'string' ? req.body.confirm_token : undefined,
        force: req.body?.force === true,
      }));
    } catch (e) {
      res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/article-view', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const article_view_id = typeof body.article_view_id === 'string' ? body.article_view_id.trim() : '';
      const input_kind = body.input_kind === 'transform_view' ? 'transform_view' : 'base_view';
      const input_id = typeof body.input_id === 'string' ? body.input_id.trim() : '';
      const gbrain_type = typeof body.gbrain_type === 'string' ? body.gbrain_type.trim() : '';
      const target_source_id = typeof body.target_source_id === 'string' ? body.target_source_id.trim() : '';
      const slug_template = typeof body.slug_template === 'string' ? body.slug_template.trim() : '';
      if (!article_view_id || !input_id || !gbrain_type || !target_source_id || !slug_template) {
        res.status(400).json({ error: 'article_view_id_input_type_target_slug_required' });
        return;
      }
      const identity = body.identity && typeof body.identity === 'object' ? body.identity as Record<string, unknown> : {};
      const security = body.security && typeof body.security === 'object' ? body.security as Record<string, unknown> : { classification: 'shared', pii: false };
      const update_policy = body.update_policy && typeof body.update_policy === 'object' ? body.update_policy as Record<string, unknown> : { mode: 'managed_block', preserve_manual_sections: true };
      const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping as Record<string, unknown> : undefined;
      const article_template = body.article_template && typeof body.article_template === 'object' ? body.article_template as Record<string, unknown> : undefined;
      const change_intelligence = body.change_intelligence && typeof body.change_intelligence === 'object' ? body.change_intelligence as Record<string, unknown> : undefined;
      const freshness_policy = body.freshness_policy && typeof body.freshness_policy === 'object' ? body.freshness_policy as Record<string, unknown> : undefined;
      const link_rules = Array.isArray(body.link_rules) ? body.link_rules : [];
      const out = await operationsByName.source_article_view_upsert.handler(ctx, {
        article_view: {
          article_view_id,
          display_name: typeof body.display_name === 'string' ? body.display_name.trim() : article_view_id,
          input: { kind: input_kind, id: input_id },
          gbrain_type,
          target_source_id,
          slug_template,
          identity,
          mapping,
          article_template,
          change_intelligence,
          link_rules,
          freshness_policy,
          update_policy,
          security,
          status: typeof body.status === 'string' ? body.status : 'draft',
        },
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/article-view/delete', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const article_view_id = typeof req.body?.article_view_id === 'string' ? req.body.article_view_id.trim() : '';
      if (!article_view_id) {
        res.status(400).json({ error: 'article_view_id_required' });
        return;
      }
      res.json(await operationsByName.source_article_view_delete.handler(ctx, { article_view_id }));
    } catch (e) {
      res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/article-view/dry-run', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const article_view_id = typeof req.body?.article_view_id === 'string' ? req.body.article_view_id.trim() : '';
      if (!article_view_id) {
        res.status(400).json({ error: 'article_view_id_required' });
        return;
      }
      const out = await operationsByName.source_article_view_dry_run.handler(ctx, {
        article_view_id,
        sample_limit: Number.isFinite(Number(req.body?.sample_limit)) ? Number(req.body.sample_limit) : 25,
        connector_config: req.body?.connector_config && typeof req.body.connector_config === 'object' ? req.body.connector_config : undefined,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/article-view/approve', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const article_view_id = typeof req.body?.article_view_id === 'string' ? req.body.article_view_id.trim() : '';
      if (!article_view_id) {
        res.status(400).json({ error: 'article_view_id_required' });
        return;
      }
      const current_chain_hash = typeof req.body?.current_chain_hash === 'string' ? req.body.current_chain_hash.trim() : undefined;
      if (!current_chain_hash) {
        res.status(400).json({ error: 'current_chain_hash_required' });
        return;
      }
      const out = await operationsByName.source_article_view_approve.handler(ctx, { article_view_id, approved_by: 'admin-ui', current_chain_hash });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/catalog/article-view/run', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const article_view_id = typeof req.body?.article_view_id === 'string' ? req.body.article_view_id.trim() : '';
      if (!article_view_id) {
        res.status(400).json({ error: 'article_view_id_required' });
        return;
      }
      const out = await operationsByName.source_article_view_run.handler(ctx, {
        article_view_id,
        limit: Number.isFinite(Number(req.body?.limit)) ? Number(req.body.limit) : undefined,
        changed_since: req.body?.changed_since === true,
        require_clean_git: req.body?.require_clean_git !== false,
        no_embed: req.body?.no_embed === true,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/admin/api/source-ingest/catalog/article-view/:article_view_id/runs', requireAdmin, async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const article_view_id = String(req.params.article_view_id || '').trim();
      const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : 20;
      const out = await operationsByName.source_article_view_runs.handler(ctx, { article_view_id, limit });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/refresh-report', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const profile_id = typeof req.body?.profile_id === 'string' ? req.body.profile_id : undefined;
      const out = await operationsByName.source_refresh.handler(ctx, { ...(profile_id ? { profile_id } : {}) });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  function adminActor(req: Request): string {
    const sessionId = (req.cookies as Record<string, string>)?.gbrain_admin || 'unknown';
    return `admin-ui:${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`;
  }

  app.post('/admin/api/source-ingest/save-config', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      if (!req.body?.config || typeof req.body.config !== 'object') {
        res.status(400).json({ error: 'config_required' });
        return;
      }
      const out = await operationsByName.source_connector_config_put.handler(ctx, { config: req.body.config, actor: adminActor(req) });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/save-secret', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const connector_id = typeof req.body?.connector_id === 'string' ? req.body.connector_id : 'appsheet-vehicles';
      const source_object = typeof req.body?.source_object === 'string' ? req.body.source_object : 'vehicle';
      if (!req.body?.secrets || typeof req.body.secrets !== 'object') {
        res.status(400).json({ error: 'secrets_required' });
        return;
      }
      const out = await operationsByName.source_connector_secret_put.handler(ctx, {
        config_id: typeof req.body?.config_id === 'string' ? req.body.config_id : connectorSecretConfigId(connector_id),
        connector_id,
        source_object,
        secrets: req.body.secrets,
        actor: adminActor(req),
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/delete-secret', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      const connector_id = typeof req.body?.connector_id === 'string' ? req.body.connector_id : 'appsheet-vehicles';
      const source_object = typeof req.body?.source_object === 'string' ? req.body.source_object : 'vehicle';
      const out = await operationsByName.source_connector_secret_delete.handler(ctx, {
        config_id: typeof req.body?.config_id === 'string' ? req.body.config_id : connectorSecretConfigId(connector_id),
        connector_id,
        source_object,
        actor: adminActor(req),
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/admin/api/source-ingest/secret-audit', requireAdmin, async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const config_id = typeof req.query?.config_id === 'string' ? req.query.config_id : undefined;
      const limit = typeof req.query?.limit === 'string' ? Number(req.query.limit) : undefined;
      const out = await operationsByName.source_connector_secret_audit.handler(ctx, { config_id, limit });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  function nonSecretConnectorConfigFromBody(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof body.table_name === 'string' && body.table_name.trim()) out.table_name = body.table_name.trim();
    if (typeof body.primary_key_field === 'string' && body.primary_key_field.trim()) out.primary_key_field = body.primary_key_field.trim();
    if (typeof body.updated_at_field === 'string' && body.updated_at_field.trim()) out.updated_at_field = body.updated_at_field.trim();
    if (typeof body.base_url === 'string' && body.base_url.trim()) out.base_url = body.base_url.trim();
    if (typeof body.schema === 'string' && body.schema.trim()) out.schema = body.schema.trim();
    if (Array.isArray(body.allowed_objects)) out.allowed_objects = body.allowed_objects.map(String).filter(Boolean);
    if (body.connector_config && typeof body.connector_config === 'object') {
      const raw = body.connector_config as Record<string, unknown>;
      if (typeof raw.table_name === 'string' && raw.table_name.trim()) out.table_name = raw.table_name.trim();
      if (typeof raw.primary_key_field === 'string' && raw.primary_key_field.trim()) out.primary_key_field = raw.primary_key_field.trim();
      if (typeof raw.updated_at_field === 'string' && raw.updated_at_field.trim()) out.updated_at_field = raw.updated_at_field.trim();
      if (typeof raw.base_url === 'string' && raw.base_url.trim()) out.base_url = raw.base_url.trim();
      if (typeof raw.schema === 'string' && raw.schema.trim()) out.schema = raw.schema.trim();
      if (Array.isArray(raw.allowed_objects)) out.allowed_objects = raw.allowed_objects.map(String).filter(Boolean);
    }
    return out;
  }

  async function sourceIngestUiConfig(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const connector_id = typeof body.connector_id === 'string' ? body.connector_id : 'appsheet-vehicles';
    const source_object = typeof body.source_object === 'string' ? body.source_object : 'vehicle';
    const config_id = typeof body.config_id === 'string' ? body.config_id : defaultSourceConnectorConfigId(connector_id, source_object, typeof body.table_name === 'string' ? body.table_name : undefined);
    const secret_config_id = connectorSecretConfigId(connector_id);
    const saved = await operationsByName.source_connector_config_get.handler(
      { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true },
      { config_id },
    ) as { rows?: Array<Record<string, unknown>> };
    const row = saved.rows?.[0];
    const nonSecretConfig = { ...(row?.config_json && typeof row.config_json === 'object' ? row.config_json as Record<string, unknown> : {}), ...nonSecretConnectorConfigFromBody(body) };
    const secretConfig = await getSourceConnectorSecretConfig(engine, connector_id, source_object, secret_config_id);
    return {
      connector_id,
      source_object,
      target_source_id: typeof body.target_source_id === 'string' ? body.target_source_id : (typeof row?.target_source_id === 'string' ? row.target_source_id : 'shared'),
      slug_prefix: typeof body.slug_prefix === 'string' ? body.slug_prefix : (typeof row?.slug_prefix === 'string' ? row.slug_prefix : 'source-ingest/vehicles'),
      freshness_policy: typeof body.freshness_policy === 'string' ? body.freshness_policy : (typeof row?.freshness_policy === 'string' ? row.freshness_policy : 'P30D'),
      table_name: typeof body.table_name === 'string' ? body.table_name : (typeof row?.table_name === 'string' ? row.table_name : 'vehicles'),
      primary_key_field: typeof body.primary_key_field === 'string' ? body.primary_key_field : (typeof nonSecretConfig.primary_key_field === 'string' ? nonSecretConfig.primary_key_field : 'vehicleID'),
      updated_at_field: typeof body.updated_at_field === 'string' ? body.updated_at_field : (typeof nonSecretConfig.updated_at_field === 'string' ? nonSecretConfig.updated_at_field : ''),
      source_table_id: config_id,
      secret_config_id,
      connector_config: { ...nonSecretConfig, ...secretConfig },
    };
  }

  app.post('/admin/api/source-ingest/discover', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const ui = await sourceIngestUiConfig((req.body || {}) as Record<string, unknown>);
      const sample_limit = Number.isFinite(Number(req.body?.sample_limit)) ? Number(req.body.sample_limit) : 25;
      const out = await operationsByName.source_discover.handler(ctx, { connector_id: ui.connector_id, source_object: ui.source_object, sample_limit, connector_config: ui.connector_config });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/test-connection', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    const started = Date.now();
    try {
      const ui = await sourceIngestUiConfig((req.body || {}) as Record<string, unknown>);
      const out = await operationsByName.source_discover.handler(ctx, {
        connector_id: ui.connector_id,
        source_object: ui.source_object,
        sample_limit: 1,
        connector_config: ui.connector_config,
      }) as Record<string, unknown>;
      res.json({
        ok: true,
        status: 'connection_ok',
        connector_id: ui.connector_id,
        source_object: ui.source_object,
        table_name: ui.table_name,
        elapsed_ms: Date.now() - started,
        sampled: out.sampled ?? 0,
        fields_count: Array.isArray(out.fields) ? out.fields.length : 0,
        id_candidates: out.idCandidates ?? [],
        updated_at_candidates: out.updatedAtCandidates ?? [],
      });
    } catch (e) {
      res.status(200).json({
        ok: false,
        status: 'connection_failed',
        elapsed_ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  function applySourceIngestUiOverrides(profile: unknown, body: Record<string, unknown>): Record<string, unknown> {
    const raw = { ...((profile as Record<string, unknown>) || {}) };
    const target = { ...((raw.target as Record<string, unknown>) || {}) };
    const freshness = { ...((raw.freshness as Record<string, unknown>) || {}) };
    if (typeof body.slug_prefix === 'string' && body.slug_prefix.trim()) {
      const keyField = typeof body.primary_key_field === 'string' && body.primary_key_field.trim() ? body.primary_key_field.trim() : 'id';
      target.slug_template = `${body.slug_prefix.trim().replace(/\/+$/g, '')}/{{ ${keyField} | slugify }}`;
    }
    if (typeof body.target_source_id === 'string' && body.target_source_id.trim()) {
      target.suggested_source_id = body.target_source_id.trim();
    }
    if (typeof body.freshness_policy === 'string' && body.freshness_policy.trim()) {
      freshness.policy = body.freshness_policy.trim();
    }
    raw.target = target;
    raw.freshness = freshness;
    return raw;
  }

  app.post('/admin/api/source-ingest/draft', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      const ui = await sourceIngestUiConfig((req.body || {}) as Record<string, unknown>);
      const sample_limit = Number.isFinite(Number(req.body?.sample_limit)) ? Number(req.body.sample_limit) : 25;
      const selected_fields = Array.isArray(req.body?.selected_fields) ? req.body.selected_fields.map(String).filter(Boolean) : undefined;
      const drafted = await operationsByName.source_profile_draft.handler(ctx, {
        connector_id: ui.connector_id,
        source_object: ui.source_object,
        target_source_id: ui.target_source_id,
        sample_limit,
        connector_config: ui.connector_config,
        selected_fields,
        primary_key_field: ui.primary_key_field,
        updated_at_field: ui.updated_at_field,
      });
      const profile = applySourceIngestUiOverrides((drafted as any).profile, ui);
      res.json({ ...(drafted as Record<string, unknown>), profile });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  const sourceIngestDryRunApprovals = new Map<string, { profile_hash: string; approved_source_id: string; ack: boolean; requires_ack: boolean; at: number }>();
  const sourceIngestDryRunKey = (req: Request) => String(req.cookies?.gbrain_admin || req.ip || 'admin-local');

  app.post('/admin/api/source-ingest/dry-run', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: true };
    try {
      if (!req.body?.profile || typeof req.body.profile !== 'object') {
        res.status(400).json({ error: 'profile_required' });
        return;
      }
      const sample_limit = Number.isFinite(Number(req.body?.sample_limit)) ? Number(req.body.sample_limit) : 25;
      const profile = req.body.profile as Record<string, unknown>;
      const connector = typeof profile.source_connector === 'string' ? profile.source_connector : 'appsheet-vehicles';
      const object = typeof profile.source_object === 'string' ? profile.source_object : 'vehicle';
      const ui = await sourceIngestUiConfig({ ...(req.body || {}) as Record<string, unknown>, connector_id: connector, source_object: object });
      const out = await operationsByName.source_dry_run.handler(ctx, { profile: req.body.profile, sample_limit, connector_config: ui.connector_config });
      const outObj = out as Record<string, unknown>;
      if (typeof outObj.profile_hash === 'string' && outObj.ok !== false) {
        const sensitivity = (outObj.routing_sensitivity && typeof outObj.routing_sensitivity === 'object') ? outObj.routing_sensitivity as Record<string, unknown> : {};
        const piiFields = Array.isArray(sensitivity.pii_fields) ? sensitivity.pii_fields : [];
        const approvedSourceId = String(ui.target_source_id);
        const routedSource = typeof sensitivity.approved_source_id === 'string' ? sensitivity.approved_source_id : approvedSourceId;
        const requiresAck = sensitivity.pii === true || piiFields.length > 0 || routedSource !== approvedSourceId;
        sourceIngestDryRunApprovals.set(sourceIngestDryRunKey(req), {
          profile_hash: outObj.profile_hash,
          approved_source_id: approvedSourceId,
          ack: req.body?.sensitivity_ack === true,
          requires_ack: requiresAck,
          at: Date.now(),
        });
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  function clampSourceIngestPreviewLimit(raw: unknown, fallback = 25, max = 100): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(1, Math.floor(n)));
  }

  function capSourceIngestPreviewPayload(records: Array<{ external_id: string; source_updated_at: string | null; data: Record<string, unknown> }>, maxBytes = 262_144) {
    const capped: typeof records = [];
    let truncated = false;
    for (const record of records) {
      const next = [...capped, record];
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > maxBytes) {
        truncated = true;
        break;
      }
      capped.push(record);
    }
    return { records: capped, truncated };
  }

  app.post('/admin/api/source-ingest/transform-preview', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      if (!req.body?.profile || typeof req.body.profile !== 'object') {
        res.status(400).json({ error: 'profile_required' });
        return;
      }
      const sample_limit = clampSourceIngestPreviewLimit(req.body?.sample_limit);
      const validation = validateSourceIngestProfile(req.body.profile);
      if (!validation.ok || !validation.profile) {
        res.status(400).json({ ok: false, error: 'invalid_profile', validation });
        return;
      }
      const profile = validation.profile as unknown as Record<string, unknown>;
      const connector = typeof profile.source_connector === 'string' ? profile.source_connector : 'appsheet-vehicles';
      const object = typeof profile.source_object === 'string' ? profile.source_object : 'vehicle';
      const ui = await sourceIngestUiConfig({ ...(req.body || {}) as Record<string, unknown>, connector_id: connector, source_object: object });
      const records = await buildProfileSampleRecords(validation.profile, sample_limit, {
        engine,
        connectorConfigOverride: ui.connector_config as Record<string, unknown>,
        defaultConnector: connector,
        defaultObject: object,
      });
      const previewRecords = records.map(r => ({ external_id: r.external_id, source_updated_at: r.source_updated_at ?? null, data: r.data }));
      const capped = capSourceIngestPreviewPayload(previewRecords);
      res.json({ ok: true, count: records.length, returned: capped.records.length, truncated: capped.truncated || capped.records.length < records.length, records: capped.records });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/admin/api/source-ingest/approve-profile', requireAdmin, express.json(), async (req: Request, res: Response) => {
    const ctx: OperationContext = { engine, config, logger: console, sourceId: 'default', remote: false, dryRun: false };
    try {
      if (!req.body?.profile || typeof req.body.profile !== 'object') {
        res.status(400).json({ error: 'profile_required' });
        return;
      }
      const approved_source_id = typeof req.body?.approved_source_id === 'string' ? req.body.approved_source_id : undefined;
      if (!approved_source_id) {
        res.status(400).json({ error: 'approved_source_id_required' });
        return;
      }
      const dry_run_profile_hash = typeof req.body?.profile_hash === 'string' ? req.body.profile_hash : undefined;
      if (!dry_run_profile_hash) {
        res.status(400).json({ error: 'profile_hash_required' });
        return;
      }
      const actualProfileHash = profileHash(req.body.profile as any);
      if (dry_run_profile_hash !== actualProfileHash) {
        res.status(409).json({ error: 'profile_hash_mismatch', profile_hash: dry_run_profile_hash, actual_profile_hash: actualProfileHash });
        return;
      }
      const lastDryRun = sourceIngestDryRunApprovals.get(sourceIngestDryRunKey(req));
      if (!lastDryRun || lastDryRun.profile_hash !== dry_run_profile_hash) {
        res.status(409).json({ error: 'dry_run_profile_hash_mismatch', profile_hash: dry_run_profile_hash, last_profile_hash: lastDryRun?.profile_hash ?? null });
        return;
      }
      if (lastDryRun.approved_source_id !== approved_source_id) {
        res.status(409).json({ error: 'dry_run_source_mismatch', dry_run_target_source_id: lastDryRun.approved_source_id, approved_source_id });
        return;
      }
      if (req.body?.sensitivity_ack === true) {
        lastDryRun.ack = true;
        sourceIngestDryRunApprovals.set(sourceIngestDryRunKey(req), lastDryRun);
      }
      if (lastDryRun.requires_ack && !lastDryRun.ack) {
        res.status(409).json({ error: 'sensitivity_ack_required' });
        return;
      }
      const dry_run_target_source_id = typeof req.body?.dry_run_target_source_id === 'string' ? req.body.dry_run_target_source_id : undefined;
      if (dry_run_target_source_id && dry_run_target_source_id !== approved_source_id) {
        res.status(409).json({ error: 'dry_run_source_mismatch', dry_run_target_source_id, approved_source_id });
        return;
      }
      const out = await operationsByName.source_profile_put.handler(ctx, {
        profile: req.body.profile,
        approve: true,
        approved_source_id,
        profile_hash: dry_run_profile_hash,
        approved_by: 'admin-ui',
        change_note: typeof req.body?.change_note === 'string' ? req.body.change_note : 'approved from admin source-ingest UI',
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // v0.36.1.0 (T15 / E6 / D23) — Calibration tab data endpoints.
  // Server-rendered SVG charts; admin SPA renders via TrustedSVG wrapper.
  // v0.36.1.0 (TD3) — pattern drill-down. Returns the source takes that
  // produced the pattern statement at index `id` of the active profile.
  // v0.36.1.0 ship state: returns the top N takes in the holder's overall
  // takes table, sorted by weight desc. v0.37+ will store per-pattern
  // source_take_ids on calibration_profiles_patterns so the drill-down
  // shows the EXACT takes that drove the pattern.
  app.get('/admin/api/calibration/pattern/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { getLatestProfile } = await import('./calibration.ts');
      const holder = (req.query.holder as string) || 'garry';
      const profile = await getLatestProfile(engine, { holder });
      if (!profile) {
        res.status(404).json({ error: 'no_profile' });
        return;
      }
      const rawId = req.params.id;
      const idStr = Array.isArray(rawId) ? rawId[0] : rawId;
      const idx = Number.parseInt(idStr ?? '', 10) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= profile.pattern_statements.length) {
        res.status(400).json({ error: 'invalid_pattern_index', max: profile.pattern_statements.length });
        return;
      }
      const statement = profile.pattern_statements[idx];
      // v0.36.1.0 ship state: surface the top resolved takes for the
      // holder as drill-down evidence. Per-pattern provenance is v0.37.
      const takes = await engine.executeRaw<{
        id: number;
        page_slug: string;
        row_num: number;
        claim: string;
        weight: number;
        resolved_quality: string | null;
        since_date: string | null;
      }>(
        `SELECT id, page_slug, row_num, claim, weight, resolved_quality, since_date
           FROM takes
           WHERE holder = $1 AND active = true AND resolved_at IS NOT NULL
           ORDER BY weight DESC, since_date DESC
           LIMIT 25`,
        [holder],
      );
      res.json({
        pattern_statement: statement,
        pattern_index: idx + 1,
        holder,
        provenance_note: 'v0.36.1.0 ship state shows top-25 resolved takes for this holder; per-pattern source_take_ids land in v0.37.',
        takes,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.post('/admin/api/calibration/run', requireAdmin, requireAdminSameOrigin, async (_req: Request, res: Response) => {
    try {
      const job = await enqueueCalibrationProfile();
      res.status(202).json({ job_id: job.id, status: job.status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'calibration_enqueue_failed' });
    }
  });

  app.get('/admin/api/calibration/profile', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { getLatestProfile } = await import('./calibration.ts');
      const holder = (req.query.holder as string) || 'garry';
      const profile = await getLatestProfile(engine, { holder });
      res.json(profile);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.get('/admin/api/calibration/charts/:type', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { getLatestProfile } = await import('./calibration.ts');
      const {
        renderBrierTrend,
        renderDomainBars,
        renderAbandonedThreadsCard,
        renderPatternStatementsCard,
      } = await import('../core/calibration/svg-renderer.ts');
      const holder = (req.query.holder as string) || 'garry';
      const type = req.params.type;
      const profile = await getLatestProfile(engine, { holder });

      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=60');

      if (type === 'brier-trend') {
        // v0.36.1.0 ship state: 1-point series from the active profile. A
        // proper 90-day time series will read from calibration_profiles
        // generated_at history in v0.37 once we have multiple snapshots.
        const series = profile?.brier !== null && profile?.brier !== undefined
          ? [{ date: profile.generated_at.slice(0, 10), brier: profile.brier }]
          : [];
        return res.send(renderBrierTrend({ series }));
      }
      if (type === 'domain-bars') {
        // v0.36.1.0 ship state: domain_scorecards JSONB is a placeholder
        // (per-domain rendering comes when batchGetTakesScorecards lands in
        // a follow-up). Render empty for now.
        return res.send(renderDomainBars({ bars: [] }));
      }
      if (type === 'pattern-statements') {
        return res.send(
          renderPatternStatementsCard(
            (profile?.pattern_statements ?? []).map((text: string) => ({ text })),
          ),
        );
      }
      if (type === 'abandoned-threads') {
        // v0.36.1.0 ship state: pull abandoned threads inline via a small
        // SQL query (the doctor check counts them; this surfaces details).
        const rows = await engine.executeRaw<{
          id: number;
          page_slug: string;
          claim: string;
          weight: number;
          since_date: string;
        }>(
          `SELECT id, page_slug, claim, weight, since_date
             FROM takes
             WHERE active = true AND resolved_at IS NULL AND superseded_by IS NULL
               AND weight >= 0.7
               AND since_date::date < (now() - INTERVAL '12 months')
             ORDER BY since_date ASC
             LIMIT 5`,
        );
        const now = new Date();
        const threads = rows.map(r => {
          const since = new Date((r.since_date.length === 7 ? r.since_date + '-15' : r.since_date));
          const monthsSilent = Math.max(0, Math.floor((now.getTime() - since.getTime()) / (1000 * 60 * 60 * 24 * 30)));
          return {
            takeId: r.id,
            pageSlug: r.page_slug,
            claim: r.claim,
            monthsSilent,
            conviction: r.weight,
          };
        });
        return res.send(renderAbandonedThreadsCard(threads));
      }
      res.status(400).json({ error: 'unknown_chart_type', supported: ['brier-trend', 'domain-bars', 'pattern-statements', 'abandoned-threads'] });
      return;
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
      return;
    }
  });

  app.get('/admin/api/requests', requireAdmin, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = 50;
      const offset = (page - 1) * limit;
      const agent = req.query.agent as string;
      const operation = req.query.operation as string;
      const status = req.query.status as string;

      // Dynamic filtering: SqlQuery is deliberately scalar-only and does not
      // support fragment composition (the prior `sql\`AND ... = ${v}\`` shape).
      // Build the WHERE clause with positional placeholders + a params array.
      // `WHERE 1=1` lets us always have a WHERE clause and conditionally
      // append `AND col = $N` fragments — still parameterized, still escaped
      // by the driver, no sql.unsafe.
      const filters: string[] = [];
      const params: (string | number)[] = [];
      if (agent && agent !== 'all') {
        filters.push(`AND token_name = $${params.length + 1}`);
        params.push(agent);
      }
      if (operation && operation !== 'all') {
        filters.push(`AND operation = $${params.length + 1}`);
        params.push(operation);
      }
      if (status && status !== 'all') {
        filters.push(`AND status = $${params.length + 1}`);
        params.push(status);
      }
      const filterSql = filters.join(' ');
      const limitParam = `$${params.length + 1}`;
      const offsetParam = `$${params.length + 2}`;

      const rows = await engine.executeRaw(
        `SELECT id, token_name, COALESCE(agent_name, token_name) as agent_name,
                operation, latency_ms, status, params, error_message, created_at
         FROM mcp_request_log
         WHERE 1=1 ${filterSql}
         ORDER BY created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...params, limit, offset],
      );
      const [countResult] = await engine.executeRaw<{ total: number }>(
        `SELECT count(*)::int as total FROM mcp_request_log
         WHERE 1=1 ${filterSql}`,
        params,
      );
      res.json({ rows, total: countResult.total, page, pages: Math.ceil(countResult.total / limit) });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // Legacy API keys (access_tokens table)
  app.get('/admin/api/api-keys', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const keys = await sql`
        SELECT id, name, created_at, last_used_at,
          CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status
        FROM access_tokens ORDER BY created_at DESC
      `;
      res.json(keys);
    } catch (e) {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.post('/admin/api/api-keys', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      const { generateToken, hashToken } = await import('../core/utils.ts');
      const token = generateToken('gbrain_');
      const hash = hashToken(token);
      const id = (await import('crypto')).randomUUID();
      await sql`INSERT INTO access_tokens (id, name, token_hash) VALUES (${id}, ${name}, ${hash})`;
      res.json({ name, token, id });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to create API key' });
    }
  });

  app.post('/admin/api/api-keys/revoke', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      await sql`UPDATE access_tokens SET revoked_at = now() WHERE name = ${name} AND revoked_at IS NULL`;
      res.json({ revoked: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Revoke failed' });
    }
  });

  // Register client from admin dashboard
  app.post('/admin/api/register-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      // v0.39.3.0 WARN-9 + CV12: accept BOTH `scopes` (admin SPA convention)
      // AND `scope` (OAuth wire-format convention, singular). The pre-fix
      // code destructured only `scopes` and used `scopes || 'read'` which:
      //   - Silently ignored `scope` requests (always defaulted to 'read')
      //   - Threw on array input because registerClientManual's parseScopeString
      //     calls .split(' ') which arrays don't have
      //   - Accepted `['read write']` (space-in-element bug shape codex flagged)
      //     and other malformed inputs
      // normalizeScopesInput handles all four valid shapes (string, string[],
      // missing, empty) and rejects the rest with a structured 400.
      const { name, tokenTtl, grantTypes, redirectUris, tokenEndpointAuthMethod } = req.body;
      const rawScopes = (req.body as Record<string, unknown>).scopes ?? (req.body as Record<string, unknown>).scope;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      let scopeString: string;
      try {
        scopeString = normalizeScopesInput(rawScopes);
      } catch (e) {
        res.status(400).json({
          error: 'invalid_scopes',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      const grants = Array.isArray(grantTypes) && grantTypes.length > 0 ? grantTypes : ['client_credentials'];
      const uris = Array.isArray(redirectUris) ? redirectUris : [];
      // v0.41.3 (T1+T4): validate token_endpoint_auth_method via shared
      // ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS before reaching the provider.
      // Pre-v0.41.3 this endpoint did INSERT (confidential) → UPDATE (NULL
      // out secret_hash) for the 'none' case, which left a confidential
      // row stranded if the UPDATE failed (codex F4). Atomic now: pass the
      // method to registerClientManual and let it INSERT the correct row
      // in a single statement.
      let validatedAuthMethod: string | undefined;
      try {
        validatedAuthMethod = validateTokenEndpointAuthMethod(tokenEndpointAuthMethod);
      } catch (e) {
        res.status(400).json({
          error: 'invalid_token_endpoint_auth_method',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      const result = await oauthProvider.registerClientManual(
        name, grants, scopeString, uris, 'default', undefined, validatedAuthMethod,
      );
      // Set per-client TTL if specified
      if (tokenTtl && Number(tokenTtl) > 0) {
        await sql`UPDATE oauth_clients SET token_ttl = ${Number(tokenTtl)} WHERE client_id = ${result.clientId}`;
      }
      res.json({ ...result, tokenTtl: tokenTtl ? Number(tokenTtl) : null });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Registration failed' });
    }
  });

  // Update client TTL
  app.post('/admin/api/update-client-ttl', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId, tokenTtl } = req.body;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      const ttl = tokenTtl === null || tokenTtl === 0 ? null : Number(tokenTtl);
      await sql`UPDATE oauth_clients SET token_ttl = ${ttl} WHERE client_id = ${clientId}`;
      res.json({ updated: true, tokenTtl: ttl });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Update failed' });
    }
  });

  // Revoke OAuth client
  app.post('/admin/api/revoke-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId } = req.body;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      // Soft-delete the client
      await sql`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = ${clientId} AND deleted_at IS NULL`;
      // Revoke all active tokens for this client
      await sql`DELETE FROM oauth_tokens WHERE client_id = ${clientId}`;
      res.json({ revoked: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Revoke failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // SSE live activity feed
  // ---------------------------------------------------------------------------
  app.get('/admin/events', requireAdmin, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n: connected\n\n');

    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); sseClients.delete(res); }
    }, 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // ---------------------------------------------------------------------------
  // Admin SPA static files (v0.36.x #1090)
  // ---------------------------------------------------------------------------
  // Two-tier resolution:
  //   1. Dev path — admin/dist next to cwd. Vite rebuilds land here first,
  //      so devs hacking on the SPA see changes without re-running
  //      build-admin-embedded.
  //   2. Binary path — `src/admin-embedded.ts` exports `ADMIN_ASSETS`, a
  //      manifest of request-path → resolved-path keyed by every file in
  //      admin/dist at generation time. Bun's `with { type: 'file' }` ESM
  //      imports resolve correctly inside the compiled binary, so a
  //      globally-installed `gbrain serve --http` actually serves /admin
  //      instead of 404. Pre-fix the cwd-relative path was the ONLY
  //      resolution path, and every fresh install of the compiled binary
  //      hit 404 on /admin (issue #1090).
  const path = await import('path');
  const fs = await import('fs');
  const adminDistPath = path.join(process.cwd(), 'admin', 'dist');
  const useDevPath = fs.existsSync(adminDistPath);
  if (useDevPath) {
    app.use('/admin', express.static(adminDistPath));
    app.get('/admin/{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/admin/api/') || req.path === '/admin/events' || req.path === '/admin/login') {
        return next();
      }
      res.sendFile(path.join(adminDistPath, 'index.html'));
    });
  } else {
    // Embedded path. Read assets from the generated manifest. Cache the
    // bytes per asset on first request — these never change for a given
    // binary, so subsequent requests skip the fs read.
    const { ADMIN_ASSETS, ADMIN_INDEX_HTML } = await import('../admin-embedded.ts');
    const cache = new Map<string, Buffer>();
    function loadAsset(asset: { path: string }): Buffer {
      const hit = cache.get(asset.path);
      if (hit) return hit;
      const buf = fs.readFileSync(asset.path);
      cache.set(asset.path, buf);
      return buf;
    }
    app.get('/admin/{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/admin/api/') || req.path === '/admin/events' || req.path === '/admin/login') {
        return next();
      }
      const hit = ADMIN_ASSETS[req.path];
      if (hit) {
        res.setHeader('Content-Type', hit.mime);
        res.send(loadAsset(hit));
        return;
      }
      // SPA fallback — every unmatched /admin/* route resolves to index.html
      // so client-side routing takes over (login, dashboard, agents, ...).
      if (ADMIN_INDEX_HTML) {
        res.setHeader('Content-Type', ADMIN_INDEX_HTML.mime);
        res.send(loadAsset(ADMIN_INDEX_HTML));
        return;
      }
      res.status(404).send('admin SPA not available');
    });
  }

  // ---------------------------------------------------------------------------
  // MCP tool calls (bearer auth + scope enforcement)
  // ---------------------------------------------------------------------------
  const mcpOperations = operations.filter(op => !op.localOnly);

  // v0.36.x #1076: MCP Streamable HTTP spec — GET /mcp opens an optional SSE
  // backchannel for server-initiated messages. gbrain's transport is stateless
  // and doesn't push server-initiated messages, so per spec we MUST return 405
  // (not 404) so probing clients (claude.ai, etc.) recognize this as an MCP
  // endpoint, not a missing route. Without this, clients display "endpoint not
  // found" instead of "endpoint exists but no SSE channel."
  app.get('/mcp', (_req: Request, res: Response) => {
    res.set('Allow', 'POST, DELETE');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  app.post('/mcp', mcpRateLimiter, requireBearerAuth({ verifier: oauthProvider }), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const authInfo = (req as any).auth as AuthInfo;

    // Human-readable agent name is now threaded through AuthInfo by
    // verifyAccessToken (which JOINs oauth_clients in its existing token
    // SELECT). No per-request DB roundtrip needed. Falls back to clientId
    // for legacy tokens or when the JOIN row's client_name is NULL.
    const agentName = authInfo.clientName ?? authInfo.clientId;

    // Create a fresh MCP server per request (stateless)
    const server = new Server(
      { name: 'gbrain', version: VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // v0.28.10: log every JSON-RPC method, not just successful tools/call.
      // Pre-fix, /admin/api/requests showed nothing for clients that only
      // ever called tools/list, and the v0.26.3 persistence regression test
      // asserting >= 2 rows after tools/list + tools/call was unreachable.
      const latency = Date.now() - startTime;
      try {
        await executeRawJsonb(
          engine,
          `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [authInfo.clientId, agentName, 'tools/list', latency, 'success'],
          [null],
        );
      } catch { /* best effort */ }
      broadcastEvent({
        agent: agentName,
        operation: 'tools/list',
        scopes: authInfo.scopes.join(','),
        latency_ms: latency,
        status: 'success',
        timestamp: new Date().toISOString(),
      });
      return {
        tools: mcpOperations.map(op => ({
          name: op.name,
          description: op.description,
          inputSchema: {
            type: 'object' as const,
            properties: Object.fromEntries(
              Object.entries(op.params).map(([k, v]) => [k, paramDefToSchema(v)]),
            ),
            required: Object.entries(op.params).filter(([, v]) => v.required).map(([k]) => k),
          },
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params;
      const op = mcpOperations.find(o => o.name === name);
      if (!op) {
        // v0.28.10: persist unknown-op attempts. Operators investigating
        // misbehaving agents need to see the full attempt log, not just
        // valid-op success/error.
        const latency = Date.now() - startTime;
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [authInfo.clientId, agentName, name, latency, 'error', `unknown_operation: ${name}`],
            [null],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: name,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'error',
          error: { code: 'unknown_operation', message: `Unknown: ${name}` },
          timestamp: new Date().toISOString(),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_operation', message: `Unknown: ${name}` }) }], isError: true };
      }

      // Scope enforcement (v0.28: hasScope replaces exact-string-match so
      // admin tokens satisfy any scope, write satisfies read, and the new
      // sources_admin / users_admin scopes resolve through the same
      // hierarchy. Plain string includes() at this site would have made
      // sources_admin tokens look like they couldn't even read.)
      const requiredScope = op.scope || 'read';
      if (!hasScope(authInfo.scopes, requiredScope)) {
        // v0.28.10: persist scope-rejected attempts. Same operator-visibility
        // motivation as the unknown-op path — and it makes the v0.26.3
        // persistence regression test reliable across both rejection paths.
        const latency = Date.now() - startTime;
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [authInfo.clientId, agentName, name, latency, 'error', `insufficient_scope: requires '${requiredScope}'`],
            [null],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: name,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'error',
          error: { code: 'insufficient_scope', message: `requires '${requiredScope}'` },
          timestamp: new Date().toISOString(),
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'insufficient_scope',
              message: `Operation ${name} requires '${requiredScope}' scope`,
              your_scopes: authInfo.scopes,
            }),
          }],
          isError: true,
        };
      }

      // F8: redact request payload by default (declared keys only via the
      // op's `params` allow-list; values + attacker-controlled key names
      // never written to mcp_request_log or the SSE feed). --log-full-params
      // bypasses this for operators debugging on their own laptop, with the
      // startup warning printed earlier.
      //
      // D1 (v0.31 wave): mcp_request_log.params is JSONB. Pre-v0.31 wrote
      // a JSON-string into that JSONB column via the postgres.js template
      // tag's loose typing — readable but semantically wrong (params->>'op'
      // would return the encoded string, not the value). Post-v0.31 we
      // pass the OBJECT through executeRawJsonb with an explicit ::jsonb
      // cast, so reads return real objects and `params->>'op'` returns
      // 'tools/list'. Pre-existing string-shaped rows are normalized by
      // migration v41 in src/core/migrate.ts.
      const safeParamsSummary = summarizeMcpParams(name, params);
      const logParamsObj: unknown = logFullParams
        ? (params || null)
        : (safeParamsSummary || null);
      const broadcastParams = logFullParams ? (params || {}) : safeParamsSummary;

      // v0.31 (D12 / eE1): refactor the inlined op.handler call to go through
      // src/mcp/dispatch.ts so HTTP MCP shares the same dispatch path as
      // stdio MCP. The dispatcher does param validation, OperationContext
      // build, error envelope unification, and (new) `_meta.brain_hot_memory`
      // injection via the metaHook. HTTP-specific concerns (mcp_request_log
      // persistence + SSE broadcast) stay here; the dispatcher returns the
      // ToolResult and we read isError + _meta to pick the right branch.
      const tokenAllowList = (authInfo as AuthInfo & { takesHoldersAllowList?: string[] }).takesHoldersAllowList
        ?? ['world'];
      // v0.34.1 (#861, D13): AuthInfo.sourceId is now a real typed field
      // populated from oauth_clients.source_id (migration v60 backfilled
      // NULL → 'default'). Pre-fix this site cast through AuthInfo and
      // fell back to GBRAIN_SOURCE env / 'default' — the silent-fallback
      // path codex flagged in plan review. Post-v60, every OAuth client
      // has source_id set; legacy bearer tokens default to 'default' in
      // verifyAccessToken. The env-fallback is gone.
      const tokenSourceId = authInfo.sourceId ?? 'default';

      let toolResult: Awaited<ReturnType<typeof dispatchToolCall>>;
      try {
        toolResult = await dispatchToolCall(engine, name, params as Record<string, unknown> | undefined, {
          remote: true,
          takesHoldersAllowList: tokenAllowList,
          sourceId: tokenSourceId,
          metaHook: getBrainHotMemoryMeta,
          // v0.31 follow-up fix: thread auth so the whoami op (and any
          // future scope-aware handlers) can introspect the caller. The
          // original D12/eE1 refactor moved dispatch into dispatchToolCall
          // but forgot to pass authInfo; whoami fell through to the
          // unknown_transport throw because ctx.auth was undefined.
          auth: authInfo,
          logger: {
            info: (msg: string) => console.error(`[INFO] ${msg}`),
            warn: (msg: string) => console.error(`[WARN] ${msg}`),
            error: (msg: string) => console.error(`[ERROR] ${msg}`),
          },
        });
      } catch (e) {
        // dispatchToolCall absorbs OperationError + Error and returns
        // isError:true; only an unexpected throw lands here. Treat as the
        // F15 unified envelope. v0.31 wave (D1): mcp_request_log.params is
        // JSONB — write the object via executeRawJsonb so reads return a
        // real object, not a JSON-encoded string.
        const latency = Date.now() - startTime;
        const errorPayload = serializeError(e);
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [authInfo.clientId, agentName, name, latency, 'error', errorPayload.message],
            [logParamsObj],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: name,
          params: broadcastParams,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'error',
          error: errorPayload,
          timestamp: new Date().toISOString(),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ error: errorPayload }) }], isError: true };
      }

      const latency = Date.now() - startTime;
      if (toolResult.isError) {
        // dispatchToolCall serializes the error into the content text;
        // for the audit log we re-extract a message string for the
        // mcp_request_log error_message column. Best-effort parse.
        let errMsg = 'unknown_error';
        try {
          const parsed = JSON.parse(toolResult.content[0]?.text ?? '{}');
          errMsg = parsed.error?.message ?? parsed.message ?? errMsg;
        } catch { /* ignore */ }
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [authInfo.clientId, agentName, name, latency, 'error', errMsg],
            [logParamsObj],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: name,
          params: broadcastParams,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'error',
          error: { code: 'op_error', message: errMsg },
          timestamp: new Date().toISOString(),
        });
        return toolResult;
      }

      try {
        await executeRawJsonb(
          engine,
          `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [authInfo.clientId, agentName, name, latency, 'success'],
          [logParamsObj],
        );
      } catch { /* best effort */ }
      broadcastEvent({
        agent: agentName,
        operation: name,
        params: broadcastParams,
        scopes: authInfo.scopes.join(','),
        latency_ms: latency,
        status: 'success',
        timestamp: new Date().toISOString(),
      });
      return toolResult;
    });

    // F14: wrap transport setup + handleRequest in try/catch. Without this,
    // an SDK-level throw (e.g., schema parse failure on a malformed request)
    // propagates to express's default error handler, which renders an HTML
    // error page — clients expecting JSON-RPC envelopes break. On
    // !res.headersSent we emit a minimal JSON 500 so the client at least
    // gets parseable JSON back.
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as any });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP request handler error:', e instanceof Error ? e.message : e);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'internal_error',
          message: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // v0.38 ingestion substrate — POST /ingest (webhook source)
  //
  // The webhook ingestion source lives INSIDE serve --http (NOT in the
  // ingestion daemon) per the /plan-eng-review E1 decision. This avoids
  // cross-process IPC: the daemon supervises only daemon-side sources
  // (file-watcher, inbox-folder, cron-scheduler) while serve --http hosts
  // the network surface and submits Minion jobs directly.
  //
  // Auth: existing OAuth `write` scope. Rate limit: 100 events / 10s per
  // IP (reuses the IP-keyed pattern from ccRateLimiter; a future tweak
  // could key on authInfo.clientId for fairer per-agent fairness).
  // Payload cap: 1 MB default. Content-type allowlist: markdown, plain,
  // HTML, JSON. Binary content is REJECTED with HTTP 415 in v1 — the
  // binary-upload flow ships as a separate route in a later wave when
  // content-type processors land.
  //
  // Events always carry untrusted_payload: true because the input came
  // over the network from an OAuth-authenticated but otherwise untrusted
  // source (Zapier / IFTTT / Apple Shortcuts). The downstream
  // ingest_capture handler logs the flag; a future v2 wave wires it
  // through the put_page op to skip auto-link.
  // ---------------------------------------------------------------------------
  const ingestRateLimiter = rateLimit({
    windowMs: 10_000, // 10 seconds
    limit: 100, // 100 events per IP per window
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limit_exceeded', message: 'too many /ingest events; backoff and retry' },
  });

  // Maximum payload bytes for POST /ingest. Configurable via env. Default 1 MB.
  const ingestMaxBytes = (() => {
    const fromEnv = process.env.GBRAIN_INGEST_MAX_BYTES;
    if (!fromEnv) return 1_048_576;
    const n = parseInt(fromEnv, 10);
    return Number.isFinite(n) && n > 0 ? n : 1_048_576;
  })();

  // Content-type allowlist: text-shaped types only in v1. The handler
  // routes binary content_types with HTTP 415; a future wave + skillpack
  // processors will accept image/audio/video/pdf via a separate flow.
  const INGEST_ALLOWED_CONTENT_TYPES: ReadonlySet<IngestionContentType> = new Set([
    'text/markdown',
    'text/plain',
    'text/html',
    'application/json',
  ]);

  // Single MinionQueue instance shared across POST /ingest invocations
  // (the queue is stateless beyond the engine handle; reusing avoids
  // per-request construction).
  const ingestQueue = new MinionQueue(engine);

  app.post(
    '/ingest',
    ingestRateLimiter,
    requireBearerAuth({ verifier: oauthProvider, requiredScopes: ['write'] }),
    express.raw({ type: '*/*', limit: ingestMaxBytes }),
    async (req: Request, res: Response) => {
      const startTime = Date.now();
      const authInfo = (req as Request & { auth?: AuthInfo }).auth as AuthInfo;
      const agentName = authInfo.clientName ?? authInfo.clientId;

      // v0.39.3.0 BUG-2: outer try/catch ensures any unexpected throw
      // returns a JSON envelope instead of leaking express's default HTML
      // error page. Mirrors the MCP handler's F14 pattern (serve-http.ts
      // F14 envelope around transport.handleRequest). The `!res.headersSent`
      // guard (codex F#16) prevents a second-response attempt if the throw
      // happens after the inner queue.add try/catch already responded.
      try {

      // v0.39.3.0 BUG-2: explicit null/undefined guard BEFORE body coercion.
      // When the request has no body at all (no Content-Length header, no
      // body-parser fed us anything), `req.body` is `undefined`. The pre-fix
      // code's `else` branch called `Buffer.from(JSON.stringify(undefined),
      // 'utf8')` — and `JSON.stringify(undefined) === undefined` (the
      // literal, not the string), which makes `Buffer.from(undefined, 'utf8')`
      // throw TypeError. Express's default error handler then served an HTML
      // 500 page. Guard fires first to keep the response shape JSON.
      if (req.body == null) {
        res.status(400).json({
          error: 'empty_body',
          message: 'POST /ingest requires a non-empty body',
        });
        return;
      }

      // Express raw() returns a Buffer. Decode as UTF-8; reject non-UTF-8
      // bytes loudly so callers know their payload was garbled.
      let body: Buffer;
      if (Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (typeof req.body === 'string') {
        body = Buffer.from(req.body, 'utf8');
      } else {
        // express.json or urlencoded fired earlier in the chain and parsed
        // for us. Re-serialize so we can hash and forward. The null/undefined
        // case is already guarded above so JSON.stringify produces a real
        // string here (objects round-trip, primitives become their JSON form).
        body = Buffer.from(JSON.stringify(req.body), 'utf8');
      }

      if (body.length === 0) {
        res.status(400).json({ error: 'empty_body', message: 'POST /ingest requires a non-empty body' });
        return;
      }

      // Detect content_type. Caller can override via the X-Gbrain-Content-Type
      // header for the JSON case (since the request's Content-Type would say
      // application/json but the user might intend the body to be markdown).
      const declared = (req.header('x-gbrain-content-type') || req.header('content-type') || '').toLowerCase();
      let contentType: IngestionContentType;
      if (declared.startsWith('text/markdown')) {
        contentType = 'text/markdown';
      } else if (declared.startsWith('text/html')) {
        contentType = 'text/html';
      } else if (declared.startsWith('text/plain')) {
        contentType = 'text/plain';
      } else if (declared.startsWith('application/json')) {
        contentType = 'application/json';
      } else if (declared.startsWith('text/')) {
        // Unknown text/* sub-types pass through as text/plain.
        contentType = 'text/plain';
      } else {
        // Binary or unknown — rejected in v1.
        res.status(415).json({
          error: 'unsupported_content_type',
          message: `content_type '${declared}' not supported. Use one of: ${[...INGEST_ALLOWED_CONTENT_TYPES].join(', ')}. ` +
            'Binary content (image/audio/video/pdf) is not yet supported via POST /ingest — install a content-type processor skillpack.',
        });
        return;
      }

      if (!INGEST_ALLOWED_CONTENT_TYPES.has(contentType)) {
        res.status(415).json({
          error: 'unsupported_content_type',
          message: `content_type '${contentType}' is in the taxonomy but not currently accepted by POST /ingest`,
        });
        return;
      }

      const content = body.toString('utf8');
      const contentHash = computeContentHash(content);
      const sourceUri = (req.header('x-gbrain-source-uri') || `mcp-webhook:${authInfo.clientId}:${Date.now()}`).slice(0, 1024);
      const sourceId = (req.header('x-gbrain-source-id') || `webhook-${authInfo.clientId}`).slice(0, 256);
      const callerSlug = req.header('x-gbrain-slug');

      const event: IngestionEvent = {
        source_id: sourceId,
        source_kind: 'webhook',
        source_uri: sourceUri,
        received_at: new Date().toISOString(),
        content_type: contentType,
        content,
        content_hash: contentHash,
        untrusted_payload: true, // ALWAYS true for network input
        metadata: {
          ip: req.ip,
          user_agent: req.header('user-agent') ?? '',
          client_id: authInfo.clientId,
          ...(callerSlug ? { slug: callerSlug } : {}),
        },
      };

      const validationErr = validateIngestionEvent(event);
      if (validationErr) {
        res.status(400).json({
          error: 'invalid_event',
          message: validationErr.message,
          field: validationErr.field,
        });
        return;
      }

      try {
        const job = await ingestQueue.add(
          'ingest_capture',
          {
            event,
            ...(callerSlug ? { slug: callerSlug } : {}),
          },
          {
            // Idempotency: same content from the same client within the
            // queue's lifetime is a single job. Different content gets
            // different jobs. Daemon-side dedup catches the 24h window;
            // the queue-level idempotency catches simultaneous retries.
            idempotency_key: `ingest:webhook:${authInfo.clientId}:${contentHash}`,
            // Cap waiting jobs from a single client so a runaway integration
            // can't fill the queue.
            maxWaiting: 50,
          },
        );

        const latency = Date.now() - startTime;
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [authInfo.clientId, agentName, 'webhook_ingest', latency, 'success'],
            [{ content_type: contentType, content_hash: contentHash, bytes: body.length, job_id: job.id }],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: 'webhook_ingest',
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'success',
          timestamp: new Date().toISOString(),
        });

        res.status(202).json({
          job_id: job.id,
          content_hash: contentHash,
          source_id: sourceId,
          message: 'Accepted. Event queued for ingestion.',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('POST /ingest queue submission error:', msg);
        res.status(500).json({
          error: 'queue_submission_failed',
          message: msg,
        });
      }

      // v0.39.3.0 BUG-2: outer try/catch close — anything that throws BEFORE
      // the inner queue.add try/catch lands here. The headersSent guard
      // (codex F#16) skips the second-response attempt if the inner block
      // already wrote a response and then threw on a downstream line (e.g.
      // a logging side-effect after `res.status(202).json(...)`).
      } catch (outerErr) {
        const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
        console.error('POST /ingest unexpected handler error:', msg);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'internal_error',
            message: msg,
          });
        }
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /webhooks/github — push-triggered sync (v0.40 Federated Sync v2)
  // ---------------------------------------------------------------------------
  // Anonymous endpoint by necessity (GitHub doesn't carry an OAuth token).
  // Auth is via per-source HMAC-SHA256 in the X-Hub-Signature-256 header.
  //
  // D3: 60 req/min/IP rate limit + pre-DB short-circuit on missing
  //     signature, so probe traffic doesn't even touch the source-lookup
  //     query.
  // D5: event=push AND ref-match against sources.config.tracked_branch.
  //     Other event types (ping, pull_request, etc.) return 202 'ignored'
  //     so GitHub doesn't retry.
  // D15.5: HMAC compare uses the shared safeHexEqual helper.
  // D18: submits 'sync' job with auto_embed_backfill=true and priority -10
  //     (above autopilot's 0).
  // ---------------------------------------------------------------------------
  const githubWebhookLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limit_exceeded', message: 'too many GitHub webhook requests' },
  });

  app.post(
    '/webhooks/github',
    githubWebhookLimiter,
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req: Request, res: Response) => {
      // D3 pre-DB short-circuit: missing signature → 401 without any
      // source lookup. Bot probe traffic ends here.
      const sigHeader = req.header('X-Hub-Signature-256');
      if (!sigHeader) {
        res.status(401).json({ error: 'missing_signature', message: 'X-Hub-Signature-256 header is required' });
        return;
      }

      // D5: filter by event header. GitHub fires webhooks for every event
      // type. Anything other than 'push' is acknowledged with 202 + reason
      // so GitHub doesn't retry — but no source lookup or job submission.
      const event = req.header('X-GitHub-Event') ?? '';
      if (event !== 'push') {
        res.status(202).json({ status: 'ignored', reason: `event=${event || '(missing)'}` });
        return;
      }

      const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body), 'utf8');
      if (payload.length === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }

      let parsed: { repository?: { full_name?: string }; ref?: string };
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'malformed_json' });
        return;
      }

      const fullName = parsed.repository?.full_name;
      const ref = parsed.ref;
      if (!fullName || !ref) {
        res.status(400).json({ error: 'missing_fields', message: 'repository.full_name and ref are required' });
        return;
      }

      // Source lookup via the v87 partial expression index on
      // config->>'github_repo'. fast even on large brains.
      let source: { id: string; config: Record<string, unknown> | string } | null = null;
      try {
        const rows = await engine.executeRaw<{ id: string; config: Record<string, unknown> | string }>(
          `SELECT id, config FROM sources WHERE config->>'github_repo' = $1 LIMIT 1`,
          [fullName],
        );
        source = rows[0] ?? null;
      } catch (err) {
        console.error('webhook: source lookup error:', err);
        res.status(500).json({ error: 'lookup_failed' });
        return;
      }
      if (!source) {
        res.status(404).json({ error: 'unknown_repo', repo: fullName });
        return;
      }

      const cfg = (typeof source.config === 'string' ? JSON.parse(source.config) : source.config) as {
        webhook_secret?: string;
        tracked_branch?: string;
      };

      // D5: ref must match the configured tracked branch (default 'main').
      const trackedBranch = cfg.tracked_branch ?? 'main';
      const expectedRef = `refs/heads/${trackedBranch}`;
      if (ref !== expectedRef) {
        res.status(202).json({
          status: 'ignored',
          reason: `ref_mismatch`,
          received_ref: ref,
          tracked_branch: trackedBranch,
        });
        return;
      }

      const secret = cfg.webhook_secret;
      if (!secret || typeof secret !== 'string') {
        res.status(401).json({ error: 'webhook_not_configured', message: 'Run: gbrain sources webhook set ' + source.id });
        return;
      }

      // HMAC verify. GitHub sends "sha256=<hex>" — strip the prefix BEFORE
      // safeHexEqual because Buffer.from('sha256=...', 'hex') silently
      // truncates at the first non-hex char (the 's'), leaving both
      // operands as 0-byte buffers and making every signature "match".
      // Pinned by test/sources-webhook.test.ts tamper assertions.
      const { createHmac } = await import('node:crypto');
      const computedHex = createHmac('sha256', secret).update(payload).digest('hex');
      const prefix = 'sha256=';
      if (!sigHeader.startsWith(prefix)) {
        res.status(401).json({ error: 'signature_mismatch', message: 'expected sha256= prefix' });
        return;
      }
      if (!safeHexEqual(sigHeader.slice(prefix.length), computedHex)) {
        res.status(401).json({ error: 'signature_mismatch' });
        return;
      }

      // Submit sync job with priority -10 (above autopilot's 0).
      try {
        const queue = new MinionQueue(engine);
        const job = await queue.add(
          'sync',
          {
            sourceId: source.id,
            auto_embed_backfill: true,
            embed_reason: 'webhook',
          },
          {
            priority: -10,
            idempotency_key: `webhook:sync:${source.id}:${Math.floor(Date.now() / 30_000)}`,
            maxWaiting: 1,
          },
        );
        res.status(202).json({ job_id: job.id, source_id: source.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('webhook: queue submission error:', msg);
        res.status(500).json({ error: 'queue_submission_failed', message: msg });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Start server
  // ---------------------------------------------------------------------------
  const clientCount = await sql`SELECT count(*)::int as count FROM oauth_clients`;

  app.listen(port, bind, () => {
    console.error(`
╔══════════════════════════════════════════════════════╗
║  GBrain MCP Server v${VERSION.padEnd(37)}║
╠══════════════════════════════════════════════════════╣
║  Port:      ${String(port).padEnd(40)}║
║  Bind:      ${bind.padEnd(40)}║
║  Engine:    ${(config.engine || 'pglite').padEnd(40)}║
║  Issuer:    ${issuerUrl.origin.padEnd(40)}║
║  Clients:   ${String((clientCount[0] as any).count).padEnd(40)}║
║  DCR:       ${(enableDcr ? 'enabled' : 'disabled').padEnd(40)}║
║  Skills:    ${skillStatus.bannerValue.padEnd(40)}║
║  Token TTL: ${(tokenTtl + 's').padEnd(40)}║
╠══════════════════════════════════════════════════════╣
║  Admin:     http://localhost:${port}/admin${' '.repeat(Math.max(0, 19 - String(port).length))}║
║  MCP:       http://localhost:${port}/mcp${' '.repeat(Math.max(0, 21 - String(port).length))}║
║  Health:    http://localhost:${port}/health${' '.repeat(Math.max(0, 18 - String(port).length))}║
╠══════════════════════════════════════════════════════╣
${suppressBootstrapPrint
  ? '║  Admin Token: suppressed (--suppress-bootstrap-token) ║\n╚══════════════════════════════════════════════════════╝'
  : bootstrapFromEnv
    ? '║  Admin Token: from $GBRAIN_ADMIN_BOOTSTRAP_TOKEN     ║\n╚══════════════════════════════════════════════════════╝'
    : `║  Admin Token (paste into /admin login):              ║\n║  ${bootstrapToken.substring(0, 50)}  ║\n║  ${bootstrapToken.substring(50).padEnd(50)}  ║\n╚══════════════════════════════════════════════════════╝`}
`);
  });
}
