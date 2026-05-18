# Kubernetes Deployment

## Components

- `ragdoll-api`: stateless control-plane API (`apps/api/src/server.ts`), with
  `/readyz` readiness and `/healthz` liveness probes.
- `ragdoll-worker`: runtime and async worker (`apps/worker/src/index.ts`).
- `ragdoll-web`: static frontend, deployable behind any ingress.
- Postgres: metadata, encrypted secrets, audit, executions, usage.
- Redis: BullMQ-compatible queue.
- Qdrant: default vector database.
- OpenTelemetry collector: traces, metrics, logs.

The Helm chart is at `infra/helm/ragdoll`. API and worker pods get all
environment variables from `secrets.existingSecret` via `envFrom.secretRef`.

## Secrets

Create the secret from `infra/k8s/ragdoll-secrets.example.yaml` and replace all
values:

```bash
kubectl apply -f infra/k8s/ragdoll-secrets.example.yaml
```

Required keys consumed by the code: `DATABASE_URL`, `REDIS_URL`,
`SECRET_ENCRYPTION_KEY`, `SESSION_SECRET`, plus optionally `QDRANT_URL`,
`QDRANT_API_KEY`, `RAGDOLL_ENV`, `OTEL_ENABLED`, and the OTLP endpoint
variables. Note: the example manifest and the Compose file currently use a
single `RAGDOLL_SECRET_KEY` placeholder; the running code reads
`SECRET_ENCRYPTION_KEY` (secret envelope) and `SESSION_SECRET` (session token
HMAC). Set those explicitly in the Kubernetes secret. Use a real KMS or
external secret operator in production.

## Helm install

```bash
helm install ragdoll infra/helm/ragdoll \
  --set image.repository=your-registry/ragdoll \
  --set image.tag=0.1.0
```

`values.yaml` exposes `api.replicas`/`api.port`, `worker.replicas`,
`web.replicas`/`web.port`, `postgres.externalUrl`, `redis.externalUrl`,
`qdrant.url`, `otel.endpoint`, and `secrets.existingSecret`.

## Scaling notes

- Scale API horizontally behind an ingress.
- Scale workers by queue depth and execution latency.
- Use separate worker pools for ingestion and latency-sensitive query
  execution.
- Keep provider rate limits tenant-aware to avoid noisy-neighbor failures.
- Prefer Qdrant collection-per-tenant-pipeline isolation for regulated
  tenants.

## Production policies

- Set `RAGDOLL_ENV=production` so the dev auth fallback is rejected.
- Disable global fallback API keys unless explicitly approved.
- Require tenant-scoped provider credentials for SaaS LLM providers.
- Deny datasource connectors from private networks by default.
- Export OpenTelemetry to a secured collector.
- Enable Postgres backups and point-in-time recovery.
