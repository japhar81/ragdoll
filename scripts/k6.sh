#!/usr/bin/env bash
# Thin wrapper around `k6 run` that prints a friendly install hint when k6
# isn't on PATH, and threads any extra args through to k6.
#
# Usage (called by package.json's `load:*` scripts):
#   ./scripts/k6.sh smoke
#   ./scripts/k6.sh steady
#   ./scripts/k6.sh spike
#   ./scripts/k6.sh soak
#   ./scripts/k6.sh trend      # sustained + per-bucket drift analyzer
#   ./scripts/k6.sh smoke -e BASE_URL=http://stage.example.com:3001
#
# All scenarios run the same main.js — they differ only in the SCENARIO env
# var. Tighten arrival rate / duration / pinned pipeline via:
#   RATE=50 ./scripts/k6.sh steady
#   DURATION=30m ./scripts/k6.sh soak
#   PIPELINE=load-deep-chain ./scripts/k6.sh steady
#
# Endpoint choice (ENDPOINT env): `invoke` (sync, in-API) or `run` (async,
# worker-backed; iteration polls /api/executions/:id until terminal). The
# `soak` scenario defaults to `run` so the Worker scale-out dashboard
# actually populates during a soak; every other scenario defaults to
# `invoke` (low-variance API/runtime latency). Override per-run:
#   ENDPOINT=run ./scripts/k6.sh steady     # exercise workers under steady load
#   ENDPOINT=invoke ./scripts/k6.sh soak    # API-only soak (no queue)
#
# `trend` additionally writes k6's per-sample NDJSON to
# tests/load/k6/.last-run.ndjson and then runs scripts/load-trend.ts to
# bucket the per-pipeline p95 over the run; the analyzer exits non-zero if
# drift > DRIFT_LIMIT (default 1.5x). Knobs: DURATION (default 5m),
# BUCKET_SECONDS (default 30), DRIFT_LIMIT (default 1.5).
#
# Defaults assume the local Docker stack on http://localhost:3001 with the
# bootstrap admin + `tenant-local` seeded. See docs/admin/load-testing.md.

set -euo pipefail

SCENARIO="${1:-smoke}"
shift || true

if ! command -v k6 >/dev/null 2>&1; then
  cat >&2 <<EOF
error: k6 is not installed.

Install k6 to run the load harness:
  macOS:   brew install k6
  linux:   https://grafana.com/docs/k6/latest/set-up/install-k6/
  docker:  alias k6='docker run --rm -i --network host -v "\$PWD":/scripts grafana/k6'

After install, retry:  npm run load:${SCENARIO}
EOF
  exit 127
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
SCRIPT="${ROOT}/tests/load/k6/main.js"

# Default path. `trend` overrides this to a known location so the analyzer
# can read it. Tests/CI may set NDJSON_OUT to redirect elsewhere.
NDJSON_OUT="${NDJSON_OUT:-}"

if [ "${SCENARIO}" = "trend" ]; then
  : "${NDJSON_OUT:=${ROOT}/tests/load/k6/.last-run.ndjson}"
  # Wipe any prior run's output so a failed k6 invocation can't poison the
  # analyzer with stale samples.
  rm -f "${NDJSON_OUT}"
  k6 run \
    -e "SCENARIO=${SCENARIO}" \
    --out "json=${NDJSON_OUT}" \
    "$@" \
    "${SCRIPT}"
  k6_status=$?
  if [ "$k6_status" -ne 0 ]; then
    # k6 already printed its threshold failures; surface the exit code and
    # skip drift analysis (the data is already suspect).
    exit "$k6_status"
  fi
  exec node --experimental-strip-types \
    "${ROOT}/scripts/load-trend.ts" "${NDJSON_OUT}"
fi

exec k6 run \
  -e "SCENARIO=${SCENARIO}" \
  "$@" \
  "${SCRIPT}"
