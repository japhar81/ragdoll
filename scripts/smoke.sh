#!/usr/bin/env bash
# Smoke-test the running local stack: health, plugin list, and an end-to-end
# question against the seeded `local-demo` pipeline on CPU Ollama.
#
# Dev auth: the API trusts x-actor-id / x-roles / x-tenant-id headers
# (insecure, local-only).
#
# NOTE: the first /run is SLOW — CPU Ollama plus first-token latency. Models
# are downloaded on the first `docker compose up`; until ollama-pull finishes
# the run will fail. Re-run this script after the pull completes.
set -euo pipefail

API="${API_URL:-http://localhost:3001}"
ADMIN=(-H "x-actor-id: smoke" -H "x-roles: platform_admin")
QUESTION="${1:-What is RAGdoll?}"

py() { python3 -c "import sys,json;$1"; }

echo "== GET /healthz =="
curl -fsS "$API/healthz"; echo

echo
echo "== GET /api/plugins =="
PLUGINS="$(curl -fsS "${ADMIN[@]}" "$API/api/plugins")"
echo "$PLUGINS" | py "d=json.load(sys.stdin);print('plugins:',', '.join(p['id'] for p in d['plugins']))"

echo
echo "== resolve local-demo pipeline id + tenant-local id =="
PIPELINE_ID="$(curl -fsS "${ADMIN[@]}" "$API/api/pipelines" \
  | py "d=json.load(sys.stdin);print(next(p['id'] for p in d['pipelines'] if p['slug']=='local-demo'))")"
TENANT_ID="$(curl -fsS "${ADMIN[@]}" "$API/api/tenants" \
  | py "d=json.load(sys.stdin);print(next(t['id'] for t in d['tenants'] if t['slug']=='tenant-local'))")"
echo "pipeline=$PIPELINE_ID tenant=$TENANT_ID"

echo
echo "== POST /api/pipelines/<local-demo>/run (CPU Ollama — this is SLOW) =="
RUN="$(curl -fsS -X POST "${ADMIN[@]}" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "content-type: application/json" \
  -d "{\"input\":{\"question\":\"$QUESTION\"},\"environment\":\"dev\"}" \
  "$API/api/pipelines/$PIPELINE_ID/run")"
echo "$RUN" | py "print(json.dumps(json.load(sys.stdin),indent=2))"

EXEC_ID="$(echo "$RUN" | py "print(json.load(sys.stdin)['executionId'])")"

echo
echo "== polling execution $EXEC_ID (worker runs it via CPU Ollama) =="
for i in $(seq 1 60); do
  EXEC="$(curl -fsS "${ADMIN[@]}" "$API/api/executions/$EXEC_ID")"
  STATUS="$(echo "$EXEC" | py "print(json.load(sys.stdin)['execution']['status'])")"
  echo "  [$i] status=$STATUS"
  if [ "$STATUS" != "running" ]; then
    echo
    echo "== final execution =="
    echo "$EXEC" | py "print(json.dumps(json.load(sys.stdin),indent=2))"
    break
  fi
  sleep 3
done

echo
echo "Done. Web UI: http://localhost:8080  API: $API"
