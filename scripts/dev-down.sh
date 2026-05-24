#!/usr/bin/env bash
# Tear down the local RAGdoll stack and delete its volumes (postgres / qdrant
# / ollama data). Drop `-v` here if you want to keep pulled models.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_ARGS=()
[[ -f .env ]] && ENV_ARGS=(--env-file ./.env)
exec docker compose "${ENV_ARGS[@]}" -f infra/docker/docker-compose.yml down -v "$@"
