#!/usr/bin/env bash
# RAGdoll CLI launcher.
#
# Thin wrapper that runs `apps/cli/src/index.ts` directly with Node's
# `--experimental-strip-types` flag, so the CLI works without an install /
# build step. Use it the same way you'd use the published `ragdoll` bin:
#
#   ./ragdoll.sh --help
#   ./ragdoll.sh auth login
#   ./ragdoll.sh pipelines list
#   ./ragdoll.sh executions tail <id>
#
# Auth and the selected tenant come from ~/.ragdoll/config.json (or the
# RAGDOLL_TOKEN / RAGDOLL_TENANT_ID env vars).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --experimental-strip-types --no-warnings "$REPO_ROOT/apps/cli/src/index.ts" "$@"
