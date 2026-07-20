# Embedded Portal SPA

## Purpose

`/portal` is the read-only knowledge workspace for authenticated Avers users. It is a React/Vite SPA embedded into the GBrain HTTP server; it is not a separate runtime service.

## Delivery model

- Sources: `portal/`.
- Browser build: `portal/dist/`.
- Embedded manifest: `src/portal-embedded.ts`.
- Generator: `scripts/build-portal-embedded.ts`.
- Drift gate: `scripts/check-portal-embedded.sh`.
- HTTP integration: `src/commands/serve-http.ts`.

The server uses `portal/dist` in a checkout and embedded file imports in a package installation. Hashed JS/CSS assets are immutable. The HTML document and authenticated APIs use `private, no-store`.

Build and verify:

```bash
bun run build:portal
bun run check:portal-embedded
bun run typecheck
bun test test/portal-security.test.ts test/portal-ui-contract.test.ts
cd portal && bun test && bun run build
```

## UI architecture

Desktop is an editorial workspace with:

1. source selector, folder tree, recent and favorite documents;
2. central Markdown reader;
3. outline, metadata and ACL-scoped backlinks.

At widths up to 900 px, the reader becomes full-screen and the explorer/context panels become inert drawers. The source control remains a native `<select>`.

Navigation state is represented by `source`, `path`, and `folder` query parameters. Browser Back/Forward is supported. Global search opens with `Ctrl/Cmd+K`; arrows select, Enter opens, Escape closes, and focus is trapped/restored.

## Authentication

Portal identity is never read from an email-valued browser cookie.

1. OTP verification issues a random 256-bit opaque token.
2. The cookie is `__Host-gbrain_portal` on HTTPS and `gbrain_portal` for local HTTP development.
3. Only SHA-256 token hashes and server-side session records are persisted in `~/.gbrain/portal_sessions.json` with mode `0600`.
4. Session expiry is checked server-side.
5. Logout revokes the session and clears both current and legacy cookie names.
6. The Admin bridge resolves the opaque Portal session before applying `GBRAIN_ADMIN_EMAILS`.

`session_user` is a migration-only cookie name: it is cleared and never trusted.

## Authorization boundary

Every content route resolves the user first and derives allowed sources server-side:

- `/portal/api/sources`
- `/portal/api/tree`
- `/portal/api/file`
- `/portal/api/search`
- `/portal/api/context`
- `/portal/api/resolve-link`
- `/portal/download`

The client never expands ACLs. Search and backlinks receive the allowed source IDs. A source-qualified wikilink to an inaccessible source returns the same not-found shape as an unknown target.

## Filesystem boundary

User locators are processed by `src/core/portal-security.ts`:

- absolute paths, traversal segments, encoded bytes, controls and backslashes are rejected;
- hidden path segments are rejected;
- every existing path segment is checked with `lstat`;
- symlinks are rejected;
- the final `realpath` must remain beneath the registered source root;
- downloads use an explicit document/archive extension allowlist;
- unsupported configuration, key and extensionless files are not listed or downloadable.

Markdown preview is limited to 1 MiB. Other allowed files are download-only.

## Markdown boundary

Markdown is parsed with `marked`, then sanitized in the browser with:

- an explicit element allowlist;
- per-element attribute allowlists;
- event/style/srcdoc removal by exclusion;
- blocked protocol-relative links;
- HTTP(S), mail and telephone protocol checks;
- same-origin image paths only;
- `noopener noreferrer` for external links.

The document is also constrained by CSP (`object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`) and `nosniff`.

## Personalization

Recent documents, favorites and the last source are lightweight client-side features. Their localStorage keys are partitioned by the authenticated account email so one browser account does not inherit another account's state.

## Operational verification

Before deployment:

1. build Portal and regenerate embedded assets;
2. run Portal unit/security/contract tests;
3. run GBrain typecheck and relevant serve-http regressions;
4. run an authenticated account with broad grants and a restricted account;
5. prove an unsigned `session_user` cannot access Portal or Admin;
6. prove cross-source access, traversal, hidden files and unsupported downloads fail closed;
7. run desktop, search, keyboard, mobile drawer and console smoke checks.

Deployment copies both `src/commands/serve-http.ts`, `src/core/portal-security.ts`, `src/portal-embedded.ts`, and the embedded Portal asset files into the installed package. The update-guard manifest must include every copied file and semantic markers for the embedded SPA and opaque session store. Two sequential service restarts are required to prove the guard does not revert the deployment.

## Operational acceptance and backlog

- Moderated pilot protocol and measurable gates: [`../portal-operational-acceptance.md`](../portal-operational-acceptance.md).
- Prioritized post-launch backlog and legacy-removal gate: [`../portal-backlog.md`](../portal-backlog.md).

## Deferred scope

- Editing and write workflows.
- Server-side favorites/history.
- Graph visualization. If evaluated later, it must remain a contextual 1–2 hop view rather than the primary navigation model.
- Removal of the disabled legacy source block after the rollback window and operational acceptance gate.
