# Portal client checks

See [SPA architecture](../docs/architecture/portal-spa.md) for delivery and authentication.

## Document fragments

- Existing H1–H3 canonical IDs and their duplicate suffixes remain stable. H4–H6
  receive IDs after that allocation; the sidebar still lists H1–H3 only.
- Headings also receive deterministic GitHub-style aliases: lowercase Unicode,
  punctuation removal, spaces replaced individually with hyphens, duplicate
  suffixes starting at `-1`. Accents, Cyrillic й/ё, underscores and existing
  hyphens are preserved. This is not a general fuzzy slug matcher.
- A canonical ID wins over an alias. Ambiguous aliases and duplicate canonical
  targets fail closed. Raw Markdown cannot supply trusted IDs or aliases: these
  are assigned after sanitization. Matching decodes percent escapes exactly once.
- Plain same-document fragment clicks stay inside the article scroll container.
  Unknown/malformed fragments do not reset scroll or add history. Modified clicks
  retain normal browser behavior. Wikilinks continue through their separate resolver.
- Native hash `popstate`, including repeat hashes, and same-document Back/Forward
  never reload file/context/tree. Initial deep links scroll after the article
  mounts. Cross-document/source navigation still loads the destination normally.
  Accepting a history destination invalidates older document, folder and binary-tree
  responses, including their error/loading cleanup; obsolete loads cannot overwrite
  the current article, tree, URL or stored recents.
- The right-hand outline resolves only inside the current article; unrelated DOM
  IDs cannot intercept it.
  Successful fragment and outline selections invalidate pending navigation; outline clicks do not change URL/history.

## Authentication and reading continuity

The document layout effect owns initial positioning: a valid exact-URL auth
return restores the saved reading offset before any fragment fallback. A fresh
document without that saved position uses its fragment, or starts at the top.
There is no competing passive document effect that can overwrite restoration.

Same-document history accepted during a loading skeleton defers its fragment
scroll until the committed article remounts, and invalidates the obsolete request.
A failed in-app document load instead restores the pre-skeleton reading offset
of that same committed document. Background authentication notices and explicit
reauthentication retain the existing auth policy and full return URL.

After building, run the integration regression from the repository root:

```sh
bun test test/portal-auth-anchor-interaction.test.ts test/portal-auth-notice.test.ts test/portal-auth-navigation.test.ts test/portal-page-auth-navigation.test.ts
python portal/scripts/check-auth-anchors.browser.py --root . \
  --chromium /absolute/path/to/chrome --out /private/auth-anchor-results
```

The Python environment must already contain Playwright. The exact-built browser
fixture checks delayed auth restoration, Back through a loading skeleton to a
non-top heading, and failed-load reading preservation at three viewport widths.
All APIs are intercepted; it neither authenticates to production nor uses a DB.
Keep screenshots and reports outside the repository.

## Focused verification

From `portal/`, after `bun install --frozen-lockfile`:

```sh
bun test src/keyboard.test.ts src/mobile-navigation.test.ts src/navigation.test.ts src/security-contract.test.ts
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/absolute/path/to/chrome \
bun run test:anchors
bun run build
```

The browser harness uses Bun (not an old system Node), real Chromium, the actual
renderer, mounted `PortalApp`, and production CSS. Playwright is supplied by the
operator's existing installation; no browser download occurs. Every request is
intercepted locally under `http://portal.test`; no credentials, database or real
Portal server are used. Browser and temporary bundles are cleaned up in `finally`.
Use a finite TERM-to-KILL timeout and narrow CPU limits on shared hosts.

Optional private article acceptance (keep files and reports **outside this repo**):

```sh
ANCHOR_ARTICLE_FILE=/private/article.md ANCHOR_EXPECT_LINKS=13 \
ANCHOR_REPORT_DIR=/private/anchor-results \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/absolute/path/to/chrome \
bun run test:anchors
```

This reads original bytes without rewriting links, excludes wikilinks from the
unique fragment count, clicks every local fragment, checks target visibility and
zero file refetches, and verifies the input SHA-256 is unchanged. Optional JSON and
screenshots can contain private article content. It is **local mounted-client
acceptance, not authenticated production proof**.

From the repository root, regenerate delivery artifacts after source changes:

```sh
bun run build:portal
bun run check:portal-embedded
```

The embedded consistency command compares generated output to the committed Git
version. For an uncommitted candidate, first record the embedded file checksum,
rerun `scripts/build-portal-embedded.ts`, and require the checksum to stay unchanged;
run `check:portal-embedded` again after committing.

Neither command deploys or changes the running installation. Independent review
and authenticated operational acceptance remain separate release gates.
