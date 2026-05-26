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
# --env-file only when one exists, so fresh checkouts before `cp .env.example
# .env` still come up — every env var has a sensible default in compose.
ENV_ARGS=()
[[ -f .env ]] && ENV_ARGS=(--env-file ./.env)
COMPOSE=(docker compose "${ENV_ARGS[@]}" -f infra/docker/docker-compose.yml)
SERVICES=("${@:-api worker-1 worker-2 web file-watcher}")

"${COMPOSE[@]}" up -d --build ${SERVICES[@]}
# otel-collector config is volume-mounted; pick up edits without a rebuild.
"${COMPOSE[@]}" restart otel-collector >/dev/null 2>&1 || true
"${COMPOSE[@]}" ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"
echo "Refreshed. Reload http://localhost:8088 (API http://localhost:3001)."
