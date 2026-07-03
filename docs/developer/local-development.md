# Local Development

## Prerequisites

- Node 22.18 or newer.
- Docker and Docker Compose for Postgres, Redis, Qdrant, Ollama, and the
  OpenTelemetry collector.

## Tests

```bash
npm test                  # unit tests (packages only), offline, no install
npm run test:functional   # apps/api + apps/worker functional tests, offline
npm run test:e2e          # cross-component e2e (API+queue+worker), offline
npm run test:plugins      # plugin contract tests
npm run test:security     # RBAC / redaction / cross-tenant boundary
npm run test:cli          # CLI smoke
npm run test:web          # web-logic helpers (storage / api shaping / specs)
npm run test:all          # everything above (~623 tests)
npm run test:playwright   # browser integration suite — needs `make refresh`
                          # to be running and per-run `integration_testing`
                          # tenant; ~56 specs at tests/playwright/
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

Apply code changes to a running stack (rebuild + restart api/worker/web;
keeps the DB and pulled models; no re-seed):

```bash
make refresh       # or: ./scripts/dev-refresh.sh   (then just reload the browser)
```

Changed `packages/db/migrations` or `packages/db/seeds`? Those run once in
the `db-init` one-shot, so re-seed with `make down && make up`.

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

### Python crawler plugins (crawl4ai / scrapy)

`make up` also builds and starts the `python-plugins` Hypercorn sidecar
(`services/python-plugins/`) and Compose sets `PYTHON_PLUGIN_URL` (and
`PYTHON_PLUGIN_TIMEOUT_MS`) on both the API and worker, so the
`crawl4ai_crawler` and `scrapy_spider` datasource nodes appear in the
builder palette under "Crawling" automatically. The runtime talks to the
sidecar over connect-rpc (ADR 0022) — same wire as every other external
plugin.

> **First build is slow and large.** The `python-plugins` image bundles a
> full headless Chromium plus its OS libraries
> (`playwright install --with-deps chromium`). This is intentional and
> only happens on `make up`. `make refresh` rebuilds **only**
> `api worker web` by design, so it does **not** rebuild this service.
> After changing `services/python-plugins/`, rebuild it explicitly:
>
> ```bash
> docker compose -f infra/docker/docker-compose.yml up -d --build python-plugins
> ```

The API depends on `python-plugins` only as `service_started` (it just
lists/validates the manifests), while the worker waits for it to be
healthy (Chromium ready) before executing crawl jobs. The service is
internal — it is reachable in-network at `http://python-plugins:8000` and
is not published to the host (uncomment the `ports:` block in
`docker-compose.yml` to debug it directly).

> **Running more than one sidecar.** `PYTHON_PLUGIN_URL` accepts a
> comma-separated list, and RAGdoll fans a plugin-source reload out to
> every instance (issues-log #8). Layer the
> `docker-compose.python-scale.yml` overlay to run a second sidecar and
> wire both:
>
> ```bash
> docker compose -f infra/docker/docker-compose.yml \
>                -f infra/docker/docker-compose.python-scale.yml up --build
> ```
>
> In k8s the sidecar is co-located per pod instead (Helm
> `pythonPlugins.mode: sidecar`, the default): each api/worker pod runs
> its own `python-plugins` container and reaches it on `localhost`, so a
> reload always lands on the instance that serves that pod's calls. Set
> `pythonPlugins.mode: standalone` for the legacy shared Deployment.

Crawl a public site via the builder: open `http://localhost:8088`, add a
**Crawl4AI Crawler** datasource node, set `url`
(e.g. `https://example.com`), keep `sameDomainOnly` and the default
`maxPages`/`maxDepth`, wire it into a pipeline, save, and run. The
SSRF guard blocks private/loopback targets by default — use a real public
URL. `scrapy_spider` is the same but takes `startUrls` (list) and
`allowedDomains`.

Run the Python unit tests (offline, no network/browser/Twisted):

```bash
cd services/python-plugins && poetry run pytest
```

The suite monkeypatches the crawl engines and injects a fake DNS
resolver, so `poetry install` of dev deps is enough — no Chromium needed.

### Organizing pipelines (folders), versioning & rollback, per-tenant activations, scheduling

See ADR 0009 for the model. Quick local flows (all behind the dev auth
headers):

- **Folders.** `GET /api/folders` returns the nested tree; `POST
  /api/folders` creates one; `PUT/DELETE /api/folders/:id` rename/reparent
  or delete (deleting a non-empty folder is `409`). Move a pipeline with
  `PUT /api/pipelines/:id/folder` (`folderId: null` = root).
- **Versioning & rollback.** `POST /api/pipelines/:id/save` is the
  auto-versioned save: identical spec => idempotent (`created:false`);
  otherwise a new published version is created at the global-max version
  bumped by `level` (default `patch`), with `parentVersionId` lineage, and
  `pipelines.latestVersionId` advances. `GET
  /api/pipelines/:id/versions` flags `isLatest` against that pointer.
  `POST /api/pipelines/:id/rollback {versionId}` moves the latest pointer
  only — no new version, no mutation (unknown id => `404`).
- **Per-tenant activations.** `GET/POST
  /api/tenants/:id/pipelines/:pid/activations` and
  `PUT/DELETE .../activations/:aid` manage 1..N labeled bindings per
  tenant+pipeline+environment, each pinned or `trackLatest`, each
  independently `enabled`. `POST /api/pipelines/:id/run` resolves the
  version via `activation` label > `default` > sole-enabled, then falls
  back to the legacy deployment if no activations exist.
- **Scheduling.** `GET/POST /api/schedules`, `PUT/PATCH/DELETE
  /api/schedules/:id`. The `cron` is a 5-field expression validated on
  create/change (`422` on bad cron or timezone); `nextRunAt` is computed
  then. Cron parsing and the next-fire computation go through
  [`croner`](https://github.com/Hexagon/croner) — `@ragdoll/cron` is a tiny
  wrapper preserving the `parseCron` / `nextAfter` / `nextRuns` surface used
  by the API, worker, and web preview. The `timezone` field IS honoured
  (DST included). Locally the scheduler runs **inside the single worker
  process** and ticks ~every 60s; it enqueues onto the same queue this
  worker consumes, so a scheduled run executes end to end locally.

After changing any of this code, `make refresh` (rebuild + restart
api/worker/web; DB and pulled models kept) and reload the browser;
changes to `packages/db/migrations` still need `make down && make up`.

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
- `NATS_URL` — the job queue (NATS JetStream — replaced BullMQ; ADR 0004).
  Also carries the durable platform-event stream (ADR 0036). Unset → an
  in-process queue (single-process / tests).
- `REDIS_URL` — the scheduler leader-election lease, the `/api/events` change
  bus, and the SSO state store (NOT the queue anymore). Unset → single-process
  fallbacks.
- `SECRET_ENCRYPTION_KEY` — key for the AES-256-GCM secret provider.
- `SESSION_SECRET` — HMAC key for session tokens.
- `QDRANT_URL`, `QDRANT_API_KEY` — select and authenticate the Qdrant adapter.
- `OTEL_ENABLED` — set to `false` to force the no-op tracer.
- `WORKER_QUEUE_NAME`, `WORKER_CONCURRENCY`, `WORKER_MAX_RETRIES` — worker
  tuning.
- `PYTHON_PLUGIN_URL` — base URL(s) of the Python crawler sidecar (comma-list
  for several — issues-log #8). When set, `@ragdoll/plugin-loader` registers
  the external `crawl4ai_crawler` / `scrapy_spider` plugins (no-op when unset).
- `PYTHON_PLUGIN_TIMEOUT_MS` — external plugin execute/health timeout
  (default `300000`; crawls are slow).
- **Pluggable providers (ADR 0035)** — `RAGDOLL_IDENTITY_PROVIDER` /
  `RAGDOLL_AUTHZ_PROVIDER`: module specifiers for a custom identity (auth/SSO)
  or authorization (PolicyEngine) provider, imported at boot (unset → built-in
  OIDC/SAML + Casbin/builtin). `RAGDOLL_AUTHZ_ALLOW_BUILTIN=1` permits the
  dependency-free authz fallback in production.
- **Platform plugins (ADR 0036)** — `RAGDOLL_PLATFORM_PLUGINS`: comma-list of
  in-process hook modules (imported at boot). `RAGDOLL_HOOK_SIDECAR_URL` +
  `RAGDOLL_HOOK_SIDECAR_SECRET` + `RAGDOLL_HOOK_SIDECAR_FAIL_CLOSED`: an
  out-of-process hook sidecar (HTTP/JSON). See
  [platform-plugins.md](./platform-plugins.md).
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
