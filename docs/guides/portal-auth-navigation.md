# Portal authentication and reading continuity

The Portal preserves the current local reader URL through authentication. This includes the source, document or folder query, and a client-visible fragment. Server page redirects preserve the request URL; fragments are browser-only and are explicitly captured by client-initiated authentication.

## Reader behavior

- A foreground read receiving HTTP 401 starts at most one login navigation per page lifetime. Concurrent failed requests cannot start competing login transactions.
- Background review-summary reads never initiate navigation. A 401 displays a non-modal sign-in notice and pauses periodic/focus refresh while the notice is active. Already loaded content remains readable; this does not permit additional unauthorized server reads.
- The notice provides a deliberate sign-in action which returns to the same reader URL.
- Reading position is captured before a loading skeleton can collapse the article. Authentication stores only the URL, scroll coordinates, and timestamp in tab-local session storage, not document contents or credentials.
- Restoration consumes the saved position only for the matching URL within thirty minutes, after the document has rendered. Invalid, stale, negative, non-finite, or unavailable storage is ignored.
- A failed fetch does not deliberately reset the scroll of the same rendered document.

## Security boundaries

Existing server session freshness, absolute expiry, source ACLs, OIDC state/PKCE, cookie clearing, and return-target normalization are unchanged. Page redirects and the failed silent-revalidation fallback pass the return target through the existing local-URL normalizer. Expired or revoked sessions still require authentication.

Review vote submissions retain their existing non-navigating 401 behavior and explicit retry flow. This change does not automatically resubmit a vote or move staged review data into persistent storage.

## Focused checks

```sh
bun test test/portal-auth-navigation.test.ts test/portal-auth-notice.test.ts test/portal-page-auth-navigation.test.ts
bun run build:portal
bun run typecheck
```

Browser acceptance should cover desktop, intermediate desktop, and mobile: open a long document, scroll, force the background summary to return 401, verify unchanged URL/content/scroll, then explicitly authenticate and verify the full URL and scroll are restored. Concurrent foreground failures must produce one login transition. Use isolated synthetic APIs for deterministic regression tests and distinguish those from a real identity-provider round trip.
