.PHONY: up down smoke test

# Bring up the full local stack (build + start everything). First run pulls
# CPU Ollama models and builds images.
up:
	./scripts/dev-up.sh

# Tear down the stack and delete its volumes.
down:
	./scripts/dev-down.sh

# Health + plugins + an end-to-end question against the local-demo pipeline.
smoke:
	./scripts/smoke.sh

# All offline test suites (unit + functional + e2e).
test:
	npm test && npm run test:functional && npm run test:e2e
