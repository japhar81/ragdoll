# RAGdoll

RAGdoll is a multi-tenant RAG / LLM pipeline platform. It separates the visual
builder, control plane, and runtime so pipeline definitions stay versioned,
portable, diffable, and executable outside the UI. The platform is working and
tested: 68 offline unit tests plus functional tests for the API and worker pass
with no dependency install.

## What is implemented

- TypeScript monorepo for API, worker, web UI, core packages, plugins,
  examples, docs, and infra.
- Versioned pipeline spec with DAG/plugin/config/secret validation, content
  checksums, immutable published versions, archive, export/import, and
  deployment selection.
- Hierarchical configuration resolver with per-key source explanations, lock
  enforcement, tenant/runtime override policy, and redaction.
- Encrypted secret provider (AES-256-GCM, tenant-scoped) backed by Postgres or
  in-memory; pipeline specs hold references only.
- Plugin loader auto-discovering builtin in-process plugins and provider
  adapters; built-in RAG plugins covering ingest, chunk, embed, upsert,
  retrieve, prompt, chat, parse, guardrail, and evaluation.
- Provider abstraction with OpenAI, Anthropic, and Ollama-compatible adapters.
- Runtime `DagExecutor` with tenant context, redaction, retries, usage
  capture, real deadline and cancellation handling, and OpenTelemetry spans.
- Authentication: signed session tokens, hashed API keys, and an insecure
  dev provider (auto-disabled in production), bridged to 8-role RBAC with
  tenant-scoped enforcement.
- Control-plane API (Fastify) with tenants, pipelines, versions, deployments,
  config, secrets (always redacted), executions, audit, usage, plugins,
  providers, and queued run/ingest. In-memory by default; Postgres + migrations
  when `DATABASE_URL` is set.
- Async worker with a `QueuePort`, in-memory and BullMQ adapters, and handlers
  for run, ingest, reindex, evaluate, batch, tenant deletion, model refresh,
  and plugin health.
- Vector store abstraction with in-memory and Qdrant adapters and enforced
  collection-per-tenant-pipeline isolation.
- React Flow visual builder with resolved-config preview, validation, and
  import/export.

Honest limits: the dev auth provider is insecure and for local use only;
`POST /api/pipelines/:id/stream` returns a well-formed SSE sequence but does
not yet stream tokens (it reports `not_enabled`).

## Quick start

```bash
npm test                  # 68 unit tests, offline, no install
npm run test:functional   # API + worker functional tests, offline
npm run typecheck         # tsc --noEmit (requires install)

# Full local stack (Postgres, Redis, Qdrant, Ollama, OTel, API, worker)
docker compose -f infra/docker/docker-compose.yml up

# Run services directly (in-memory unless DATABASE_URL/REDIS_URL are set)
npm run dev:api
npm run dev:worker

# Web UI (requires install)
npm install
npm run build:web
npm --workspace @ragdoll/web run dev
```

`npm run test:e2e` runs the cross-component suite in `tests/e2e/` (API →
queue → worker → runtime, offline), and `npm run test:all` runs unit,
functional, and e2e together. Full local development is described in
`docs/developer/local-development.md`.

## Design notes

- Platform interfaces are owned by RAGdoll. LangChain/LangGraph may live inside
  plugins; persisted specs never expose them.
- Postgres is the system of record for metadata, encrypted secrets, audit
  logs, deployments, executions, and usage.
- Qdrant is the default vector adapter; isolation defaults to
  collection-per-tenant-pipeline with a mandatory tenant payload filter.
- Redis/BullMQ is the default async queue, behind a `QueuePort` interface.
- OpenTelemetry is lazy and optional, so the test suite stays install-free.

## Key docs

- Architecture: `docs/architecture/initial-design.md`,
  `docs/architecture/runtime.md`
- ADRs: `docs/adr/0001`–`0007`
- Developer: `docs/developer/local-development.md`,
  `docs/developer/plugin-development.md`,
  `docs/developer/provider-development.md`
- Admin: `docs/admin/governance-and-security.md`,
  `docs/admin/kubernetes-deployment.md`,
  `docs/admin/operations-runbook.md`,
  `docs/admin/upgrade-and-migrations.md`
- API contract: `docs/api/openapi.yaml`
