#!/usr/bin/env bash
# Tear down the local RAGdoll stack and delete its volumes (postgres / qdrant
# / ollama data). Drop `-v` here if you want to keep pulled models.
#
# Works with docker compose, podman compose, podman-compose, and legacy
# docker-compose — see scripts/_compose.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=./_compose.sh
source "$(dirname "$0")/_compose.sh"
exec "${COMPOSE[@]}" down -v "$@"
