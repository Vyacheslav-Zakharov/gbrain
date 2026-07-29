#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d portal/dist ]; then
  echo "[check:portal-embedded] no portal/dist; skipping"
  exit 0
fi
bun run scripts/build-portal-embedded.ts >/dev/null
if ! git diff --exit-code -- src/portal-embedded.ts; then
  echo "[check:portal-embedded] src/portal-embedded.ts is stale. Run: bun run build:portal"
  exit 1
fi
echo "[check:portal-embedded] OK"
