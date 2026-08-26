#!/usr/bin/env bash
# scripts/run-unit-shard.sh
#
# Runs the unit suite for a single shard. Excludes test/e2e/*, *.slow.test.ts,
# and *.serial.test.ts. The selected files are split into fresh Bun processes
# so PGLite/WASM high-water memory returns to the OS between batches.

set -euo pipefail
# Unit tests are hermetic: never inherit a live Postgres URL or brain home.
unset DATABASE_URL GBRAIN_DATABASE_URL GBRAIN_HOME
cd "$(dirname "$0")/.."

MAX_CONC=""
BATCH_SIZE="${GBRAIN_TEST_BATCH_SIZE:-5}"
COLD_BATCH_SIZE="${GBRAIN_TEST_COLD_BATCH_SIZE:-1}"
BATCH_TIMEOUT="${GBRAIN_TEST_BATCH_TIMEOUT:-300}"
BATCH_KILL_AFTER="${GBRAIN_TEST_BATCH_KILL_AFTER:-20}"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-concurrency) MAX_CONC="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONC="${1#*=}"; shift ;;
    --batch-size) BATCH_SIZE="$2"; shift 2 ;;
    --batch-size=*) BATCH_SIZE="${1#*=}"; shift ;;
    --dry-run-list) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

valid_positive() { printf '%s' "$1" | grep -qE '^[0-9]+$' && [ "$1" -ge 1 ]; }
valid_positive "$BATCH_SIZE" || { echo "ERROR: invalid batch size: $BATCH_SIZE" >&2; exit 2; }
valid_positive "$COLD_BATCH_SIZE" || { echo "ERROR: invalid cold batch size: $COLD_BATCH_SIZE" >&2; exit 2; }
valid_positive "$BATCH_TIMEOUT" || { echo "ERROR: invalid batch timeout: $BATCH_TIMEOUT" >&2; exit 2; }
valid_positive "$BATCH_KILL_AFTER" || { echo "ERROR: invalid batch kill-after: $BATCH_KILL_AFTER" >&2; exit 2; }

all_files=()
while IFS= read -r f; do all_files+=("$f"); done < <(
  find test -name '*.test.ts' -not -path 'test/e2e/*' -not -name '*.slow.test.ts' -not -name '*.serial.test.ts' | sort
)

files=()
if [ -n "${SHARD:-}" ]; then
  shard_n=${SHARD%/*}; shard_m=${SHARD#*/}
  if ! valid_positive "$shard_n" || ! valid_positive "$shard_m" || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$SHARD (expected N/M with 1<=N<=M)" >&2; exit 1
  fi
  i=0
  for f in "${all_files[@]}"; do
    [ $((i % shard_m + 1)) -eq "$shard_n" ] && files+=("$f")
    i=$((i + 1))
  done
else
  files=("${all_files[@]}")
fi

[ "${#files[@]}" -gt 0 ] || { echo "[unit-shard ${SHARD:-(unsharded)}] no files; exiting clean."; exit 0; }
if [ "$DRY_RUN" = "1" ]; then printf '%s\n' "${files[@]}"; exit 0; fi

snapshot_files=(); cold_files=()
for file in "${files[@]}"; do
  cold_path=0
  case "$file" in
    test/*migrat*.test.ts|test/bootstrap.test.ts|test/schema-bootstrap-coverage.test.ts|test/embedding-dim-check.test.ts)
      cold_path=1 ;;
  esac
  if [ "$cold_path" -eq 0 ] && grep -q 'delete process\.env\.GBRAIN_PGLITE_SNAPSHOT' "$file" 2>/dev/null; then
    cold_path=1
  fi
  if [ "$cold_path" -eq 1 ]; then cold_files+=("$file"); else snapshot_files+=("$file"); fi
done

snapshot_count=${#snapshot_files[@]}; cold_count=${#cold_files[@]}
total_batches=$((
  (snapshot_count + BATCH_SIZE - 1) / BATCH_SIZE
  + (cold_count + COLD_BATCH_SIZE - 1) / COLD_BATCH_SIZE
))
shard_label="${SHARD:-unsharded}"; receipt_label="${shard_label//\//-}"
run_id="${GBRAIN_TEST_RUN_ID:-$(date +%s)-$$}"; run_id="${run_id//[^A-Za-z0-9_.-]/_}"
receipt_dir=".context/test-batches/$run_id"; mkdir -p "$receipt_dir"
receipt="$receipt_dir/$receipt_label.jsonl"; : > "$receipt"

TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
fi
[ -n "$TIMEOUT_BIN" ] || { echo "ERROR: GNU timeout/gtimeout is required for descendant-safe batch termination" >&2; exit 3; }

echo "[unit-shard $shard_label] running ${#files[@]} files in $total_batches batch(es), batch-size=$BATCH_SIZE, cold-batch-size=$COLD_BATCH_SIZE"

batch_n=0; first_rc=0
run_group() {
  local mode="$1" limit="$2"; shift 2
  local group=("$@") offset=0 group_total=$#
  local batch=() started finished rc
  while [ "$offset" -lt "$group_total" ]; do
    batch_n=$((batch_n + 1)); batch=("${group[@]:offset:limit}")
    started=$(date +%s); rc=0
    echo "[unit-shard $shard_label] batch $batch_n/$total_batches mode=$mode running ${#batch[@]} files"
    local cmd=(bun test --timeout=60000)
    [ -n "$MAX_CONC" ] && cmd+=("--max-concurrency=$MAX_CONC")
    cmd+=("${batch[@]}")
    if [ "$mode" = "cold" ]; then
      GBRAIN_PGLITE_SNAPSHOT= "$TIMEOUT_BIN" --signal=TERM --kill-after="${BATCH_KILL_AFTER}s" "${BATCH_TIMEOUT}s" "${cmd[@]}" || rc=$?
    else
      "$TIMEOUT_BIN" --signal=TERM --kill-after="${BATCH_KILL_AFTER}s" "${BATCH_TIMEOUT}s" "${cmd[@]}" || rc=$?
    fi
    finished=$(date +%s)
    printf '{"kind":"batch","batch":%d,"batches_total":%d,"mode":"%s","files":%d,"started_at":%d,"finished_at":%d,"rc":%d}\n' \
      "$batch_n" "$total_batches" "$mode" "${#batch[@]}" "$started" "$finished" "$rc" >> "$receipt"
    [ "$rc" -eq 0 ] || { [ "$first_rc" -ne 0 ] || first_rc="$rc"; }
    offset=$((offset + limit))
  done
}

[ "$snapshot_count" -eq 0 ] || run_group snapshot "$BATCH_SIZE" "${snapshot_files[@]}"
[ "$cold_count" -eq 0 ] || run_group cold "$COLD_BATCH_SIZE" "${cold_files[@]}"
printf '{"kind":"complete","complete":true,"rc":%d,"files_total":%d,"batches_total":%d}\n' \
  "$first_rc" "${#files[@]}" "$total_batches" >> "$receipt"
exit "$first_rc"
