.PHONY: up down refresh smoke test

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
