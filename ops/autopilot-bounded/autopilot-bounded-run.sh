#!/usr/bin/env bash
set -euo pipefail
set -a
source "$HOME/.gbrain/pg.sh"
source "$HOME/.gbrain/env.sh"
set +a
export PATH="$HOME/.bun/bin:$PATH"
exec "$HOME/.gbrain/autopilot-venv/bin/python3" "$HOME/.gbrain/autopilot-bounded-run.py"
