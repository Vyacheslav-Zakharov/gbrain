#!/usr/bin/env bash
set -euo pipefail

marker="${HOME:-}/.gbrain/MIGRATION_FENCE.json"
if [[ "${GBRAIN_MIGRATION_FENCE:-0}" == "1" || ( -n "${HOME:-}" && -f "$marker" ) ]]; then
  printf '%s\n' '[gbrain] MIGRATION_FENCE_ACTIVE: postinstall schema migration skipped.' >&2
  exit 0
fi

if command -v gbrain >/dev/null 2>&1; then
  gbrain apply-migrations --yes --non-interactive
else
  printf '%s\n' '[gbrain] postinstall skipped. Run `gbrain doctor` and `gbrain apply-migrations --yes` manually.' >&2
fi
