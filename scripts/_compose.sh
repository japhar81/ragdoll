#!/usr/bin/env bash
# Compose-runtime detector for the dev scripts. Sourced (NOT exec'd) by
# scripts/dev-up.sh, dev-down.sh, dev-refresh.sh, and smoke.sh; exposes:
#
#   COMPOSE — bash array, suitable for "${COMPOSE[@]}" expansion.
#             Already includes the canonical compose file path AND any
#             runtime-specific override (e.g. infra/docker/docker-compose.podman.yml).
#   COMPOSE_RUNTIME — one of "docker" / "podman", for scripts that need to
#                     condition behaviour (e.g. otel container-log scraping).
#
# Detection precedence:
#   1. $COMPOSE env override (e.g. COMPOSE="podman compose" — wins).
#   2. `docker compose` (Docker Desktop / Compose v2 plugin).
#   3. `podman compose` (Podman 4.7+).
#   4. `podman-compose` (the pip-installed Python wrapper).
#   5. `docker-compose` (legacy Compose v1).
#
# Exits with a clear error if none are available. Safe to source multiple
# times in the same shell.
#
# Repo root is assumed to be the parent of this script's directory.

if [[ -z "${RAGDOLL_REPO_ROOT:-}" ]]; then
  # ${BASH_SOURCE[0]} is the path to THIS script, even when sourced.
  RAGDOLL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/docker-compose.yml}"
COMPOSE_RUNTIME=""
COMPOSE_BIN=()

# Helper: does `$1 $2 …` exist as a working compose invocation? We probe by
# running `version` because every compose flavor implements it cheaply.
_compose_works() {
  "$@" version >/dev/null 2>&1
}

if [[ -n "${COMPOSE:-}" ]]; then
  # Operator override: split on whitespace into the array.
  # shellcheck disable=SC2206
  COMPOSE_BIN=($COMPOSE)
  case "${COMPOSE_BIN[0]}" in
    podman*) COMPOSE_RUNTIME="podman" ;;
    docker*) COMPOSE_RUNTIME="docker" ;;
    *) COMPOSE_RUNTIME="${COMPOSE_BIN[0]}" ;;
  esac
elif _compose_works docker compose; then
  COMPOSE_BIN=(docker compose)
  COMPOSE_RUNTIME="docker"
elif _compose_works podman compose; then
  COMPOSE_BIN=(podman compose)
  COMPOSE_RUNTIME="podman"
elif _compose_works podman-compose; then
  COMPOSE_BIN=(podman-compose)
  COMPOSE_RUNTIME="podman"
elif _compose_works docker-compose; then
  COMPOSE_BIN=(docker-compose)
  COMPOSE_RUNTIME="docker"
else
  echo "ragdoll: no working compose runtime found." >&2
  echo "  Install Docker Desktop, Podman 4.7+, or set COMPOSE='your compose cmd'." >&2
  exit 127
fi

# Build the final COMPOSE array: <runtime cmd> [optional --env-file] -f <main>
# [-f <runtime override>]. Callers add their own subcommands on top.
COMPOSE=("${COMPOSE_BIN[@]}")
if [[ -f "${RAGDOLL_REPO_ROOT}/.env" ]]; then
  COMPOSE+=(--env-file "${RAGDOLL_REPO_ROOT}/.env")
fi
COMPOSE+=(-f "${RAGDOLL_REPO_ROOT}/${COMPOSE_FILE}")

# Runtime-specific override file. Podman has no /var/run/docker.sock and no
# /var/lib/docker/containers, so the otel-collector's container-log scraping
# bind mounts must be disabled there. The override file lives next to the
# main compose file; included only when present.
_OVERRIDE="${RAGDOLL_REPO_ROOT}/infra/docker/docker-compose.${COMPOSE_RUNTIME}.yml"
if [[ -f "$_OVERRIDE" ]]; then
  COMPOSE+=(-f "$_OVERRIDE")
fi

export COMPOSE_RUNTIME
# COMPOSE is consumed via array expansion by callers; nothing to export.
