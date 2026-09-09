#!/usr/bin/env bash
# Regression guard: the standalone compiled CLI must initialize and reopen a
# real PGLite brain with its embedded data/WASM/extension assets.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_TMP="$(mktemp -d /tmp/gbrain-pglite-compiled.XXXXXX)"
OUT_BIN="$ROOT_TMP/gbrain"
PROBE_BIN="$ROOT_TMP/pglite-extension-probe"
HOME_DIR="$ROOT_TMP/home"
TMP_DIR="$ROOT_TMP/tmp"
trap 'rm -rf "$ROOT_TMP"' EXIT
mkdir -p "$HOME_DIR" "$TMP_DIR"

# Portable wall-clock cap: macOS has no GNU `timeout`, but every supported
# build host already has Bun.
run_with_timeout() {
  local seconds="$1"
  shift
  bun -e '
    const seconds = Number(process.argv[1]);
    const child = Bun.spawn(process.argv.slice(2), { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, seconds * 1000);
    const exitCode = await child.exited;
    clearTimeout(timer);
    process.exit(timedOut ? 124 : exitCode);
  ' "$seconds" "$@"
}

cd "$REPO_ROOT"
bun build --compile --outfile "$OUT_BIN" src/cli.ts >/dev/null
bun build --compile --outfile "$PROBE_BIN" scripts/pglite-compiled-probe.ts >/dev/null
# Run outside the repository so success cannot come from cwd/node_modules sidecars.
cd "$ROOT_TMP"
HOME="$HOME_DIR" TMPDIR="$TMP_DIR" run_with_timeout 120 "$OUT_BIN" init --pglite --no-embedding --json \
  >"$ROOT_TMP/init.json" 2>"$ROOT_TMP/init.log"

if [[ ! -f "$HOME_DIR/.gbrain/brain.pglite/PG_VERSION" ]]; then
  echo "[check-pglite-compiled] FAIL: compiled init did not create a PGLite data directory." >&2
  sed -n '1,120p' "$ROOT_TMP/init.log" >&2
  exit 1
fi

HOME="$HOME_DIR" TMPDIR="$TMP_DIR" run_with_timeout 60 "$OUT_BIN" doctor --json \
  >"$ROOT_TMP/doctor.json" 2>"$ROOT_TMP/doctor.log"
bun -e 'const value = JSON.parse(await Bun.file(process.argv[1]).text()); const connection = value?.checks?.find((check) => check.name === "connection"); if (!value || typeof value !== "object" || connection?.status !== "ok") process.exit(1)' \
  "$ROOT_TMP/doctor.json"

shopt -s nullglob
VECTOR_CACHE=("$TMP_DIR/gbrain-pglite-assets-$(id -u)"/vector-*.tar.gz)
TRGM_CACHE=("$TMP_DIR/gbrain-pglite-assets-$(id -u)"/pg-trgm-*.tar.gz)
if [[ "${#VECTOR_CACHE[@]}" -ne 1 || "${#TRGM_CACHE[@]}" -ne 1 ]]; then
  echo "[check-pglite-compiled] FAIL: extension bundles were not materialized outside Bun VFS." >&2
  exit 1
fi
# A fresh compiled process must detect and repair same-UID cache corruption.
printf 'corrupted-cache-fixture' >"${VECTOR_CACHE[0]}"
printf 'corrupted-cache-fixture' >"${TRGM_CACHE[0]}"

HOME="$HOME_DIR" TMPDIR="$TMP_DIR" run_with_timeout 60 "$PROBE_BIN" \
  "$HOME_DIR/.gbrain/brain.pglite" >"$ROOT_TMP/extensions.json" 2>"$ROOT_TMP/extensions.log"
bun -e 'const value = JSON.parse(await Bun.file(process.argv[1]).text()); if (value.dimensions !== 3 || !(value.trigram > 0)) process.exit(1)' \
  "$ROOT_TMP/extensions.json"

echo "[check-pglite-compiled] OK — standalone binary initialized/reopened PGLite; vector + pg_trgm executed."
