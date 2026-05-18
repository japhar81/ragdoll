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

## Start infrastructure

```bash
docker compose -f infra/docker/docker-compose.yml up
```

Services:

- API: `http://localhost:3001` (Postgres + Redis wired by compose)
- Worker: consumes the BullMQ queue
- Postgres: `localhost:5432`
- Redis: `localhost:6379`
- Qdrant: `http://localhost:6333`
- Ollama-compatible API: `http://localhost:11434`
- OTLP: `localhost:4317` / `localhost:4318`

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
