#!/usr/bin/env bash
# Rebuild + restart the app services so a browser reload reflects code
# changes. Run this after merging changes while the stack is up.
#
# Fast: the Dockerfiles copy package manifests before source, so the
# `npm install` layer stays cached and only the source layer rebuilds.
#
# This does NOT re-run migrations/seeds (db-init) or re-pull models. If you
# changed packages/db/migrations or packages/db/seeds, run instead:
#     make down && make up
#
# Optionally pass explicit service names: ./scripts/dev-refresh.sh api
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f infra/docker/docker-compose.yml)
SERVICES=("${@:-api worker web file-watcher}")

"${COMPOSE[@]}" up -d --build ${SERVICES[@]}
# otel-collector config is volume-mounted; pick up edits without a rebuild.
"${COMPOSE[@]}" restart otel-collector >/dev/null 2>&1 || true
"${COMPOSE[@]}" ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"
echo "Refreshed. Reload http://localhost:8088 (API http://localhost:3001)."
