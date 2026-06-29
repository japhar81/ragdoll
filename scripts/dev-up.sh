#!/usr/bin/env bash
# Bring up the full local RAGdoll stack (build + start everything).
#
# First run downloads the CPU Ollama models (qwen2.5:0.5b, nomic-embed-text)
# and builds the images, so it can take a few minutes. CPU inference is slow;
# the first /run may take tens of seconds.
#
# Works with docker compose, podman compose, podman-compose, and legacy
# docker-compose — see scripts/_compose.sh for runtime detection. Set the
# COMPOSE env var to override (e.g. COMPOSE="podman-compose").
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=./_compose.sh
source "$(dirname "$0")/_compose.sh"
# Warn early if a Podman machine is too small for the stack (OpenSearch OOM).
ragdoll_preflight_podman_memory
exec "${COMPOSE[@]}" up --build "$@"
