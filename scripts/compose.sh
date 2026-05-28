#!/usr/bin/env bash
# Thin compose wrapper for the Makefile. Sources _compose.sh to pick the
# right runtime (docker / podman) and forwards every argument to it.
#
# The Makefile can't source a bash file directly; this script bridges the
# detection logic so `make crawl-up` etc. work identically on docker and
# podman setups.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=./_compose.sh
source "$(dirname "$0")/_compose.sh"
exec "${COMPOSE[@]}" "$@"
