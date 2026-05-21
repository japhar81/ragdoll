# RAGdoll

RAGdoll is a multi-tenant RAG / LLM pipeline platform. It separates the
visual builder, control plane, and runtime so pipeline definitions stay
versioned, portable, diffable, and executable outside the UI.

The platform is working and tested: a large offline unit suite plus
functional, e2e, plugin, CLI, and web-logic tests (**422 tests passing**)
run with **zero install**.

## What's in the box

**Core platform**

- TypeScript monorepo: API, worker, web UI, core packages, plugins,
  CLI, examples, docs, and Docker infra.
- Versioned pipeline spec with DAG / plugin / config / secret validation,
  content checksums, immutable published versions, archive, export/import,
  and deployment selection.
- Hierarchical configuration resolver with per-key source explanations,
  lock enforcement, tenant/runtime override policy, and redaction.
- Encrypted secret provider (AES-256-GCM, tenant-scoped) backed by
  Postgres or in-memory; pipeline specs hold references only.
- Plugin loader auto-discovering 25 built-in in-process plugins covering
  ingest, chunk, embed, upsert, retrieve, prompt, chat, parse,
  guardrail, evaluation, plus OpenSearch BM25 / vector / hybrid retrievers,
  webhook trigger / output, and a tiny sample transformer.
- External-plugin HTTP transport (contract v1) with an optional Python
  crawler sidecar (`crawl4ai_crawler`, `scrapy_spider`) gated on
  `PYTHON_PLUGIN_URL`, with a default-deny SSRF guard (ADR 0010).
- Provider abstraction with OpenAI, Anthropic, and Ollama-compatible
  adapters.
- Runtime `DagExecutor` with tenant context, redaction, retries, usage
  capture, real deadline and cancellation handling, and OpenTelemetry
  spans.

**Auth, RBAC, and triggers** (ADR 0011, 0012)

- Local accounts (scrypt password hashes) + SSO via OIDC and SAML, with
  three configurable signup modes (admin-only / open + default role /
  open + zero access). Default-deny end-to-end — header-trusting dev
  auth is opt-in via `RAGDOLL_DEV_AUTH=1`.
- Casbin-based RBAC with hierarchical scope coverage (* > tenant > env >
  pipeline). 8 built-in roles, fully editable via the admin UI.
- Trigger surfaces: UI Run button, cron schedules (croner), webhook
  tokens (`POST /api/triggers/webhook/<token>` mints turn into a
  pipeline run), the `ragdoll` CLI, and a `/mcp` endpoint serving a
  full Model Context Protocol surface so an LLM client can drive the
  platform.

**Control plane and runtime**

- Control-plane API (Fastify) with tenants, environments, pipelines,
  versions, deployments, activations, config, secrets (always
  redacted), executions, audit, usage, plugins, providers, schedules,
  webhook triggers, and MCP. Postgres + migrations when `DATABASE_URL`
  is set; full in-memory mode otherwise.
- Async worker with a `QueuePort`, in-memory and BullMQ adapters;
  handlers for run, ingest, reindex, evaluate, batch, tenant deletion,
  model refresh, and plugin health.
- Vector store abstraction with in-memory and Qdrant adapters and
  enforced collection-per-tenant-pipeline isolation, plus an OpenSearch
  client + knn_vector store for the OpenSearch plugin suite.

**Web UI**

- React Flow visual Builder with resolved-config preview, validation,
  and per-node 3-tab inspector (Config / Resolved / Docs).
- Folder tree, scheduler, executions trace viewer, RBAC admin
  (users / roles / IdPs / auth settings).
- Embedded help: hover tooltips, `?` field popovers, `⌘K` command
  palette (cmdk), keyboard shortcuts overlay, and a slide-in help
  drawer that renders bundled markdown docs offline.

**Observability** (ADR 0014)

- Single `grafana/otel-lgtm` container = Grafana + Loki + Tempo +
  Prometheus + bundled OTel Collector. One URL covers logs, metrics,
  and traces.
- Every container's stdout/stderr is tailed to Loki via a `filelog`
  receiver; the api/worker also push structured OTLP log records with
  trace_id stamping for log↔trace correlation.
- Per-request and per-execution Prometheus metrics
  (`ragdoll_api_requests_total`, `ragdoll_worker_execution_duration_ms`,
  …) plus `pg_*` and `redis_*` from side-car exporters, and
  `container_*` from `docker_stats`.
- Two pre-provisioned dashboards: **RAGdoll · Overview** (API + worker)
  and **RAGdoll · Infrastructure** (Postgres / Redis / container
  CPU+mem / all-container logs).

## Quick start

```sh
# One-command stack: Postgres, Redis, Qdrant, Ollama (CPU), OpenSearch,
# OTel/LGTM, python-plugins, db migrations + seeds, API, worker, web.
make up

# Code-only rebuild (no model re-pull, no re-seed).
make refresh

# Tear it down (removes volumes).
make down
```

Tests:

```sh
npm test                  # unit (packages)
npm run test:functional   # API + worker
npm run test:e2e          # cross-component
npm run test:plugins      # plugin contract
npm run test:cli          # CLI
npm run test:web          # web-logic helpers
npm run test:all          # all of the above (422 tests)
```

Run services directly (in-memory unless `DATABASE_URL` / `REDIS_URL`
are set):

```sh
npm run dev:api
npm run dev:worker
npm --workspace @ragdoll/web run dev
```

### URLs

| Surface              | URL                          |
| -------------------- | ---------------------------- |
| Web console          | http://localhost:8088        |
| Control-plane API    | http://localhost:3001        |
| Grafana (LGTM)       | http://localhost:3300        |
| OTLP HTTP / gRPC     | :4318 / :4317                |
| Qdrant               | http://localhost:6333        |
| OpenSearch           | http://localhost:9200        |
| Ollama               | http://localhost:11434       |

### Default credentials

The first boot provisions a platform admin from `BOOTSTRAP_ADMIN_EMAIL`
and `BOOTSTRAP_ADMIN_PASSWORD` (see `infra/docker/docker-compose.yml`).
For local development:

| Field    | Value                  |
| -------- | ---------------------- |
| Email    | `admin@ragdoll.local`  |
| Password | `ragdoll-admin`        |

**Change both env vars before any non-local deployment.**

### CLI

A standalone bin (`apps/cli/`) + a repo-root convenience wrapper:

```sh
./ragdoll.sh --help
./ragdoll.sh auth login --email admin@ragdoll.local --password ragdoll-admin
./ragdoll.sh tenants list
./ragdoll.sh pipelines list
./ragdoll.sh executions tail <execution-id>
```

The wrapper invokes `apps/cli/src/index.ts` directly via Node's
`--experimental-strip-types`, so no install / build step is needed.

## Design notes

- Platform interfaces are owned by RAGdoll. LangChain/LangGraph may
  live inside plugins; persisted specs never expose them.
- Postgres is the system of record for metadata, encrypted secrets,
  audit logs, deployments, executions, and usage.
- Qdrant is the default vector adapter; isolation defaults to
  collection-per-tenant-pipeline with a mandatory tenant payload filter.
- Redis/BullMQ is the default async queue, behind a `QueuePort`
  interface.
- OpenTelemetry is lazy and optional, so the test suite stays
  install-free. The full Grafana LGTM stack ships in the local compose
  but app code degrades to a no-op tracer / meter / logger if the
  collector is unreachable.

## Honest limits

- The dev auth provider (`RAGDOLL_DEV_AUTH=1`) is insecure and for
  local use only; it accepts whatever `x-roles` / `x-actor-id` headers
  the caller sends.
- `POST /api/pipelines/:id/stream` returns a well-formed SSE sequence
  but does not yet stream tokens (it reports `not_enabled`).
- Local CPU Ollama is slow on first call (cold model). The first
  `/run` of a fresh stack may take 30–60 s.

## Key docs

- Architecture: `docs/architecture/initial-design.md`,
  `docs/architecture/runtime.md`
- ADRs: `docs/adr/0001`–`0014`
- Developer: `docs/developer/local-development.md`,
  `docs/developer/plugin-development.md`,
  `docs/developer/provider-development.md`
- Admin: `docs/admin/access-control.md`,
  `docs/admin/triggers.md`,
  `docs/admin/cli.md`,
  `docs/admin/mcp.md`,
  `docs/admin/in-app-help.md`,
  `docs/admin/observability.md`,
  `docs/admin/governance-and-security.md`,
  `docs/admin/kubernetes-deployment.md`,
  `docs/admin/operations-runbook.md`,
  `docs/admin/upgrade-and-migrations.md`
- Plugin reference: `docs/plugins/README.md`
- API contract: `docs/api/openapi.yaml`
