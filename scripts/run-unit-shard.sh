#!/usr/bin/env bash
# scripts/run-unit-shard.sh
#
# Runs the unit suite for a single shard. Excludes test/e2e/* (those are run
# by scripts/run-e2e.sh in the E2E phase). When SHARD=N/M is set, keeps every
# M-th file starting at index N (1-indexed); otherwise runs the full unit set.
#
# Used by scripts/ci-local.sh to fan 4 unit-shard workers in parallel inside
# the runner container, each pinned to its own postgres shard for the
# downstream E2E phase.
#
# A shard is split into bounded batches, each executed in a fresh Bun process.
# PGLite embeds PostgreSQL in WASM; its allocator does not reliably return all
# memory to the OS between test files inside one long-lived process. Recycling
# the process between batches bounds cumulative RSS without reducing coverage.
# Shards can still run in parallel (two at a time in ci-local); batches within
# one shard are deliberately sequential.

set -euo pipefail

cd "$(dirname "$0")/.."

# --max-concurrency=N is forwarded to `bun test`. v0.26.4: invoked by
# run-unit-parallel.sh; safe to call without (defaults to bun's default cap).
# --batch-size=N controls how many files share one Bun process. The default is
# intentionally conservative: two local shards (or four explicit CI shards)
# may run concurrently.
MAX_CONC=""
BATCH_SIZE="${GBRAIN_TEST_BATCH_SIZE:-1}"
DRY_RUN=0
DRY_RUN_BATCHES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-concurrency) MAX_CONC="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONC="${1#*=}"; shift ;;
    --batch-size) BATCH_SIZE="$2"; shift 2 ;;
    --batch-size=*) BATCH_SIZE="${1#*=}"; shift ;;
    --dry-run-list) DRY_RUN=1; shift ;;
    --dry-run-batches) DRY_RUN_BATCHES=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! printf '%s' "$BATCH_SIZE" | grep -qE '^[0-9]+$' || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "ERROR: invalid batch size: $BATCH_SIZE (expected a positive integer)" >&2
  exit 2
fi

# All non-E2E test files, sorted for deterministic shard splits.
# Tier 4: *.slow.test.ts is "always-slow" (cold-path correctness checks);
# *.serial.test.ts is "concurrency-unsafe" (file-wide shared state). Both
# are excluded from the fast loop. Slow runs via `bun run test:slow`; serial
# runs via scripts/run-serial-tests.sh after the parallel pass.
# Use while-read to stay portable to macOS bash 3.2 (no mapfile).
all_files=()
while IFS= read -r f; do
  all_files+=("$f")
done < <(find test -name '*.test.ts' -not -path 'test/e2e/*' -not -name '*.slow.test.ts' -not -name '*.serial.test.ts' | sort)

files=()
if [ -n "${SHARD:-}" ]; then
  shard_n=${SHARD%/*}
  shard_m=${SHARD#*/}
  if ! printf '%s' "$shard_n" | grep -qE '^[0-9]+$' || \
     ! printf '%s' "$shard_m" | grep -qE '^[0-9]+$' || \
     [ "$shard_n" -lt 1 ] || [ "$shard_m" -lt 1 ] || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$SHARD (expected N/M with 1<=N<=M, both integers)" >&2
    exit 1
  fi
  i=0
  for f in "${all_files[@]}"; do
    if [ $((i % shard_m + 1)) -eq "$shard_n" ]; then
      files+=("$f")
    fi
    i=$((i + 1))
  done
else
  files=("${all_files[@]}")
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "[unit-shard ${SHARD:-(unsharded)}] no files; exiting clean."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

file_count=${#files[@]}
batch_count=$(( (file_count + BATCH_SIZE - 1) / BATCH_SIZE ))

if [ "$DRY_RUN_BATCHES" = "1" ]; then
  batch_n=1
  start=0
  while [ "$start" -lt "$file_count" ]; do
    remaining=$((file_count - start))
    length=$BATCH_SIZE
    [ "$remaining" -lt "$length" ] && length=$remaining
    echo "# batch $batch_n/$batch_count ($length files)"
    printf '%s\n' "${files[@]:start:length}"
    start=$((start + length))
    batch_n=$((batch_n + 1))
  done
  exit 0
fi

echo "[unit-shard ${SHARD:-(unsharded)}] running $file_count files in $batch_count process-isolated batches (batch-size=$BATCH_SIZE)"
# Deliberate fail-fast: set -e propagates the first failing Bun subprocess and
# prevents later batches from obscuring the causal failure or extending a
# doomed CI shard. The parallel wrapper still completes its other shards.
batch_n=1
start=0
while [ "$start" -lt "$file_count" ]; do
  remaining=$((file_count - start))
  length=$BATCH_SIZE
  [ "$remaining" -lt "$length" ] && length=$remaining
  batch_files=("${files[@]:start:length}")
  echo "[unit-shard ${SHARD:-(unsharded)}] batch $batch_n/$batch_count: $length files"
  if [ -n "$MAX_CONC" ]; then
    bun test --max-concurrency="$MAX_CONC" --timeout=60000 "${batch_files[@]}"
  else
    bun test --timeout=60000 "${batch_files[@]}"
  fi
  start=$((start + length))
  batch_n=$((batch_n + 1))
done
