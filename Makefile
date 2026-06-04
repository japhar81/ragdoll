.PHONY: up down refresh smoke test load load-smoke load-steady load-spike load-soak load-trend load-worker load-worker-smoke load-worker-steady load-worker-spike load-worker-soak load-worker-trend build-load-seeds crawl-up crawl-up-reranker obs oc-build-api oc-build-web oc-build-python-plugins oc-build-all

# Bring up the full local stack (build + start everything). First run pulls
# CPU Ollama models and builds images.
up:
	./scripts/dev-up.sh

# Rebuild + restart api/worker/web after code changes (no model re-pull, no
# re-seed) so a browser reload reflects the change.
refresh:
	./scripts/dev-refresh.sh

# Tear down the stack and delete its volumes.
down:
	./scripts/dev-down.sh

# Health + plugins + an end-to-end question against the local-demo pipeline.
smoke:
	./scripts/smoke.sh

# All offline test suites (unit + functional + e2e).
test:
	npm test && npm run test:functional && npm run test:e2e

# k6 load harness against the running local stack. `load` defaults to the
# smoke scenario (1 VU × 30 iters across every load-* pipeline) so it's safe
# to run anytime; the other targets ramp up. See docs/admin/load-testing.md.
#
#   make load              # smoke — sanity check
#   make load-steady       # constant arrival (RATE=20rps default, 1 min)
#   make load-spike        # 1->50 VUs ramp, hold, drain
#   make load-soak         # 5 VUs for 10 min (override with DURATION=30m)
#   make load-trend        # sustained 10rps for 5 min + per-bucket drift table
#                          # (override DURATION, RATE, BUCKET_SECONDS, DRIFT_LIMIT)
#
# Worker variants — same scenarios, but ENDPOINT=run so iterations POST to
# /api/pipelines/:id/run and poll /api/executions/:id until terminal. The
# BullMQ workers actually do the work, which lights up the "RAGdoll · Worker
# scale-out" Grafana dashboard (ragdoll_worker_* metrics). Use these when you
# care about queue + worker behavior, not just API/runtime compute.
#
#   make load-worker            # smoke against the worker path
#   make load-worker-steady
#   make load-worker-spike
#   make load-worker-soak       # same as `make load-soak` (soak defaults to ENDPOINT=run)
#   make load-worker-trend
#
# All scenarios honor BASE_URL, PIPELINE, RATE, DURATION env vars — see the
# wrapper for the full list. Worker-mode adds POLL_INTERVAL_MS / POLL_TIMEOUT_MS.
load: load-smoke
load-smoke:
	./scripts/k6.sh smoke
load-steady:
	./scripts/k6.sh steady
load-spike:
	./scripts/k6.sh spike
load-soak:
	./scripts/k6.sh soak
load-trend:
	./scripts/k6.sh trend

load-worker: load-worker-smoke
load-worker-smoke:
	ENDPOINT=run ./scripts/k6.sh smoke
load-worker-steady:
	ENDPOINT=run ./scripts/k6.sh steady
load-worker-spike:
	ENDPOINT=run ./scripts/k6.sh spike
load-worker-soak:
	ENDPOINT=run ./scripts/k6.sh soak
load-worker-trend:
	ENDPOINT=run ./scripts/k6.sh trend

# Regenerate packages/db/seeds/zzzzzzz-load-test-pipelines.sql from
# examples/load/pipelines/*.yaml. Run after editing a load YAML; the
# generator also rewrites the YAML in canonical (laid-out + staged) form
# so the seed and the YAML hash to the same checksum.
build-load-seeds:
	npm run build:load-seeds

# Build + start only the Python crawler plugin service. Kept separate from
# `refresh` because the image bundles a headless Chromium and is slow to
# build — rebuild it explicitly, not on every code-refresh.
#
# `scripts/compose.sh` auto-detects docker compose / podman compose / etc.
# (see scripts/_compose.sh).
crawl-up:
	./scripts/compose.sh up -d --build python-plugins

# Same as crawl-up, but also installs the `reranker` poetry group so the
# rerank_bge plugin's `provider: local` branch works. Adds ~2GB of torch
# + sentence-transformers weights to the image; only operators who want
# local cross-encoder inference need this. Hosted HF API (the default
# `provider: hf-api`) needs no extra deps.
crawl-up-reranker:
	./scripts/compose.sh build \
	  --build-arg POETRY_INSTALL_ARGS='--no-root --only main --with reranker' \
	  python-plugins
	./scripts/compose.sh up -d python-plugins

# OpenShift: build each app's image inside the cluster (no host Docker
# required) and push to the project's internal registry. Run once on a
# fresh cluster; re-run any time the corresponding Dockerfile or its
# source changes.
#
# The unified script (`scripts/oc-build.sh`) takes NAME + DOCKERFILE
# via env. Each target wires the right pair. `oc-build-all` rebuilds
# every image — useful after a `git pull` before `helm upgrade`.
oc-build-api:
	NAME=ragdoll-api DOCKERFILE=infra/docker/api.Dockerfile ./scripts/oc-build.sh

oc-build-web:
	NAME=ragdoll-web DOCKERFILE=infra/docker/web.Dockerfile ./scripts/oc-build.sh

oc-build-python-plugins:
	NAME=ragdoll-python-plugins DOCKERFILE=services/python-plugins/Dockerfile ./scripts/oc-build.sh

oc-build-all: oc-build-api oc-build-web oc-build-python-plugins

# Print (and on macOS open) the local Grafana URL. The all-in-one LGTM
# container (otel-collector service) hosts Grafana on :3300; logs / metrics
# / traces all land there. See docs/admin/observability.md.
obs:
	@echo "Grafana → http://localhost:3300  (dashboard: RAGdoll → Overview)"
	@command -v open >/dev/null 2>&1 && open http://localhost:3300 || true
