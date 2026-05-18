# Local Development

## Prerequisites

- Node 22.18 or newer.
- Docker and Docker Compose for Postgres, Redis, Qdrant, Ollama, and the
  OpenTelemetry collector.

## Tests

```bash
npm test                  # 68 unit tests (packages only), offline, no install
npm run test:functional   # apps/api + apps/worker functional tests, offline
npm run test:e2e          # cross-component e2e (API+queue+worker), offline
npm run test:all          # test + test:functional + test:e2e
npm run typecheck         # tsc --noEmit (requires npm install)
```

`npm test` and `npm run test:functional` use Node's built-in test runner with
`--experimental-strip-types`, so they run before any dependency install. The
functional suite exercises the real `createApp` router and worker handlers with
in-memory dependencies.

## One-command local stack

```bash
make up            # or: ./scripts/dev-up.sh
                   # or: docker compose -f infra/docker/docker-compose.yml up --build
```

This single command builds the images and starts the whole platform:
Postgres, Redis, Qdrant, Ollama (CPU), the OTEL collector, a one-shot
`db-init` (runs migrations + every `packages/db/seeds/*.sql`), a one-shot
`ollama-pull` (downloads `qwen2.5:0.5b` + `nomic-embed-text`), then the API,
worker, and the nginx-served web UI.

> **First run is slow.** The first `up` downloads the two CPU models and
> builds images (several minutes). CPU inference itself is slow — the first
> `/run` against the demo can take tens of seconds. Until `ollama-pull`
> finishes, a run will fail; just retry.

URLs:

- Web UI: `http://localhost:8088` (nginx serves the SPA and reverse-proxies
  `/api`, `/healthz`, `/readyz` to the API)
- API: `http://localhost:3001`
- Postgres: `localhost:5432` (`ragdoll`/`ragdoll`)
- Redis: `localhost:6379`
- Qdrant: `http://localhost:6333`
- Ollama-compatible API: `http://localhost:11434`
- OTLP: `localhost:4317` / `localhost:4318`

Tear down (also deletes volumes / pulled models):

```bash
make down          # or: ./scripts/dev-down.sh
```

### Persistence wiring

`docker-compose.yml` sets `DATABASE_URL`, so the API and worker both use the
Postgres-backed control-plane repositories (pipelines, pipeline versions,
deployments, config definitions/values, providers, datasource connections,
vector collections, audit logs, usage records, API keys) plus the Postgres
execution store and secret repository. The same `packages/db` repos back both
processes, so the seeded data is read by the API and executed by the worker.
With no `DATABASE_URL` (e.g. `npm run dev:api`) everything falls back to
in-memory repositories.

### Demo: ask a question on CPU Ollama

The `zz-local-demo.sql` seed (named so it loads after `demo.sql`) publishes a
`local-demo` pipeline
(`input -> basic_rag_prompt -> provider_chat -> output`, no retriever so it
needs no vectors), deploys it to `dev` for tenant `tenant-local`, and sets
tenant-scoped config so it resolves to `provider=ollama`,
`model=qwen2.5:0.5b`, `base_url=http://ollama:11434`.

Smoke it end to end (health, plugins, then a question through the worker):

```bash
make smoke         # or: ./scripts/smoke.sh "What is RAGdoll?"
```

Or via the web UI at `http://localhost:8088`.

Equivalent raw curl (the script discovers the seeded pipeline + tenant ids
for you):

```bash
PID=$(curl -fsS -H "x-roles: platform_admin" http://localhost:3001/api/pipelines \
  | python3 -c "import sys,json;print(next(p['id'] for p in json.load(sys.stdin)['pipelines'] if p['slug']=='local-demo'))")
TID=$(curl -fsS -H "x-roles: platform_admin" http://localhost:3001/api/tenants \
  | python3 -c "import sys,json;print(next(t['id'] for t in json.load(sys.stdin)['tenants'] if t['slug']=='tenant-local'))")
curl -fsS -X POST -H "x-roles: platform_admin" -H "x-tenant-id: $TID" \
  -H "content-type: application/json" \
  -d '{"input":{"question":"What is RAGdoll?"},"environment":"dev"}' \
  "http://localhost:3001/api/pipelines/$PID/run"
```

`/run` is asynchronous: it returns `202` with an `executionId`; the worker
picks it up off the BullMQ queue and calls CPU Ollama. Poll
`GET /api/executions/<id>` until it leaves `running` (the smoke script does
this automatically).

## Run services directly

```bash
npm run dev:api      # apps/api/src/server.ts
npm run dev:worker   # apps/worker/src/index.ts
```

With no `DATABASE_URL` the API uses in-memory repositories; with no `REDIS_URL`
the worker logs readiness and exposes the in-memory queue (no external
transport to consume). Set both to use Postgres + BullMQ. The API runs
migrations automatically when `DATABASE_URL` is set.

## Environment variables

- `RAGDOLL_ENV` — `production` disables the dev auth fallback.
- `DATABASE_URL` — enables Postgres repositories and migrations.
- `REDIS_URL` — enables the BullMQ queue/consumer.
- `SECRET_ENCRYPTION_KEY` — key for the AES-256-GCM secret provider.
- `SESSION_SECRET` — HMAC key for session tokens.
- `QDRANT_URL`, `QDRANT_API_KEY` — select and authenticate the Qdrant adapter.
- `OTEL_ENABLED` — set to `false` to force the no-op tracer.
- `WORKER_QUEUE_NAME`, `WORKER_CONCURRENCY`, `WORKER_MAX_RETRIES` — worker
  tuning.
- `PORT`, `HOST` — API bind address.

## API smoke checks

```bash
curl http://localhost:3001/healthz
curl http://localhost:3001/readyz
curl -H "x-roles: platform_admin" http://localhost:3001/api/plugins
```

The dev auth provider trusts `x-actor-id` / `x-tenant-id` / `x-roles` headers;
it is insecure and local-only.

## Web UI

```bash
npm install
npm run build:web                       # production build
npm --workspace @ragdoll/web run dev    # dev server
```

The UI expects the API reverse-proxied at `/api` during Vite development.
