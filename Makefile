.PHONY: up down refresh smoke test crawl-up obs

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

# Build + start only the Python crawler plugin service. Kept separate from
# `refresh` because the image bundles a headless Chromium and is slow to
# build — rebuild it explicitly, not on every code-refresh.
crawl-up:
	docker compose -f infra/docker/docker-compose.yml up -d --build python-plugins

# Print (and on macOS open) the local Grafana URL. The all-in-one LGTM
# container (otel-collector service) hosts Grafana on :3300; logs / metrics
# / traces all land there. See docs/admin/observability.md.
obs:
	@echo "Grafana → http://localhost:3300  (dashboard: RAGdoll → Overview)"
	@command -v open >/dev/null 2>&1 && open http://localhost:3300 || true
