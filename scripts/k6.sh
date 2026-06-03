#!/usr/bin/env bash
# Thin wrapper around `k6 run` that prints a friendly install hint when k6
# isn't on PATH, and threads any extra args through to k6.
#
# Usage (called by package.json's `load:*` scripts):
#   ./scripts/k6.sh smoke
#   ./scripts/k6.sh steady
#   ./scripts/k6.sh spike
#   ./scripts/k6.sh soak
#   ./scripts/k6.sh smoke -e BASE_URL=http://stage.example.com:3001
#
# All scenarios run the same main.js — they differ only in the SCENARIO env
# var. Tighten arrival rate / duration / pinned pipeline via:
#   RATE=50 ./scripts/k6.sh steady
#   DURATION=30m ./scripts/k6.sh soak
#   PIPELINE=load-deep-chain ./scripts/k6.sh steady
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
SCRIPT="${HERE}/../tests/load/k6/main.js"

exec k6 run \
  -e "SCENARIO=${SCENARIO}" \
  "$@" \
  "${SCRIPT}"
