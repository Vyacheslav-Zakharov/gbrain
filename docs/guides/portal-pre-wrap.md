# Portal preformatted text wrapping

The article reader wraps fenced text to the available article width using scoped
`white-space: pre-wrap` and `overflow-wrap: anywhere`. Nested code inherits
whitespace. Markdown content, indentation and copy text are unchanged. Overflow
remains available as a fallback rather than clipping content.

## Browser regression

From `portal/`, run:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chromium \
bun run scripts/check-pre-wrap.browser.ts
```

Optional `PRIVATE_ARTICLE=/private/path.md` and `EVIDENCE_DIR=/private/output`
exercise actual article text without checking it into Git. Evidence uses the
production bundle with mocked read-only APIs, not authenticated live Portal.
Tests cover 390/1440 widths, long prose, unbroken tokens, indentation, blank lines,
article overflow, unchanged textContent and browser selection versus the prior
preformatted layout. Chromium can omit a trailing newline from selection even
before wrapping; compare selections before/after rather than to textContent.

## CSS-only release artifact

A clean baseline rebuilt with the available toolchain produced the same JS as
the candidate rebuild, but differed from the previously installed minified JS.
To exclude unrelated compiler output drift, this release deliberately retains
the exact installed baseline JS asset `index-C-CgITaR.js`, uses the newly built
CSS asset, and regenerates `src/portal-embedded.ts` from that composed dist.
The composed bundle passes the same browser regression. A later full Vite
build may rename the JS again; this is not a source-code change.

Verification: browser RED on baseline and GREEN after fix; 11 targeted Portal
unit tests; anchor browser checks; root typecheck; Portal build; embedded
regeneration; diff checks. No database schema, authorization or article changes.
