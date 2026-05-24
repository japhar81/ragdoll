#!/usr/bin/env bash
# Bring up the full local RAGdoll stack (build + start everything).
#
# First run downloads the CPU Ollama models (qwen2.5:0.5b, nomic-embed-text)
# and builds the images, so it can take a few minutes. CPU inference is slow;
# the first /run may take tens of seconds.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_ARGS=()
[[ -f .env ]] && ENV_ARGS=(--env-file ./.env)
exec docker compose "${ENV_ARGS[@]}" -f infra/docker/docker-compose.yml up --build "$@"
