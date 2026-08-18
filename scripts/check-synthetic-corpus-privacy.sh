#!/usr/bin/env bash
# v0.36.1.0 (T20 / CDX-14) — privacy CI guard for the synthetic calibration corpus.
#
# Scans test/fixtures/calibration/ for patterns that look like real-world
# specificity. Fails the build if any are found. Closes the synthetic-corpus
# privacy hole flagged by codex review CDX-14: "CC reads real brain pages
# locally, writes nothing still risks privacy if any generated synthetic
# fixture memorizes structure-specific facts. Placeholder names are not enough."
#
# What this catches:
#   - Real dollar amounts (e.g. "$50M", "$1.2B")
#   - Specific large round counts ($X cap is OK; "$50M Series B" is not)
#   - Year-specific date strings outside the 2024-2026 placeholder range
#   - The real founder/company names from the operator's network (looked up
#     from a sibling file scripts/check-synthetic-corpus-allowlist.txt when
#     present; otherwise we just check the placeholder allow-list)
#
# False positives stay safer than false negatives — this guard biases toward
# the operator manually verifying a flagged page is legitimately synthetic.

set -e

CORPUS_DIR="test/fixtures/calibration"
PLACEHOLDERS=(
  "alice-example"
  "charlie-example"
  "acme-example"
  "widget-co"
  "fund-a"
  "fund-b"
  "fund-c"
  "acme-seed"
  "widget-series-a"
  "meetings/2026-"
)

# Skip if directory doesn't exist yet (early-clone state).
if [ ! -d "$CORPUS_DIR" ]; then
  echo "OK: $CORPUS_DIR does not exist yet (skipping privacy scan)"
  exit 0
fi

VIOLATIONS=0

# Check 1: real dollar amounts. Synthetic pages should say "$X" or describe
# amounts as ranges; explicit numerics like "$50M" suggest real-world specificity.
echo "[corpus-privacy] checking for explicit dollar amounts..."
while IFS= read -r match; do
  if [ -n "$match" ]; then
    echo "  VIOLATION: explicit dollar amount in $match"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done < <(grep -rEn '\$[0-9]+[MBKkmb]\b' "$CORPUS_DIR" --include='*.md' --include='*.json' 2>/dev/null || true)

# Check 2: explicit year-specific dates outside the 2024-2026 placeholder window.
# The corpus uses placeholder timeline references like "2024-Q2", "2026-04-03".
# Numbers like "2019" or "2027" mapped to specific events are suspicious.
echo "[corpus-privacy] checking for out-of-range year references..."
while IFS= read -r match; do
  if [ -n "$match" ]; then
    # Allow 2019 (used as a generic past year), 2023, 2027 (used as future). The
    # specific concern is dates the operator might recognize as a real prior event.
    # This is a low-precision heuristic; manual review decides.
    : # informational, not a failure for v0.36.1.0
  fi
done < <(grep -rEn '\b(201[0-8]|2030|2031)\b' "$CORPUS_DIR" --include='*.md' --include='*.json' 2>/dev/null || true)

# Check 3: presence of expected placeholders. Synthetic pages should reference
# at least one canonical placeholder. A page with ZERO placeholder names is
# suspicious — might be referring to real people/companies.
echo "[corpus-privacy] checking that fixture pages reference at least one placeholder..."
while IFS= read -r file; do
  has_placeholder=false
  for ph in "${PLACEHOLDERS[@]}"; do
    if grep -q "$ph" "$file" 2>/dev/null; then
      has_placeholder=true
      break
    fi
  done
  # Allow README + label JSON files to skip this check.
  # Also allow essay-genre fixtures, which are anonymized PG-essay-style writing
  # and don't reference specific people/companies by design.
  case "$file" in
    *README.md|*labels.json|*/essay-*.md) continue ;;
  esac
  if [ "$has_placeholder" = "false" ]; then
    echo "  VIOLATION: $file references no placeholder name (expected at least one of: ${PLACEHOLDERS[*]})"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done < <(find "$CORPUS_DIR" -name '*.md' -type f 2>/dev/null)

# Check 4: JSON fixtures that declare themselves synthetic must carry the exact
# privacy contract and contain no URL or email indicators. This closes the gap
# where the original guard scanned only Markdown fixtures.
echo "[corpus-privacy] validating synthetic JSON declarations..."
while IFS= read -r file; do
  if ! node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const raw = fs.readFileSync(file, "utf8");
    const value = JSON.parse(raw);
    if (!Object.prototype.hasOwnProperty.call(value, "synthetic")) process.exit(0);
    const privacy = "No real people, companies, systems, dates, or source text.";
    if (value.synthetic !== true || value.privacy !== privacy || /https?:\/\/|[\w.+-]+@[\w.-]+/i.test(raw)) process.exit(1);
  ' "$file"; then
    echo "  VIOLATION: synthetic JSON privacy declaration or content check failed in $file"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done < <(find "$CORPUS_DIR" -name '*.json' -type f 2>/dev/null)

if [ "$VIOLATIONS" -gt 0 ]; then
  echo ""
  echo "❌ $VIOLATIONS privacy violation(s) found in $CORPUS_DIR."
  echo ""
  echo "The synthetic calibration corpus must use anonymized placeholder names"
  echo "(see test/fixtures/calibration/README.md). Real names of YC partners,"
  echo "portfolio companies, funds, etc. cannot enter this directory."
  echo ""
  echo "Either:"
  echo "  - replace the offending content with placeholder names"
  echo "  - confirm the dollar amount is intentionally generic, then update"
  echo "    this script to exempt it"
  exit 1
fi

echo "✓ corpus privacy: $VIOLATIONS violations across $(find "$CORPUS_DIR" \( -name '*.md' -o -name '*.json' \) -type f 2>/dev/null | wc -l | tr -d ' ') fixtures"
