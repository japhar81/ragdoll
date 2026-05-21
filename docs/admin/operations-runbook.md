# Operations Runbook

Operational procedures for running RAGdoll in production. See
`upgrade-and-migrations.md` for migration ordering and zero-downtime notes.

## Deploy

1. Build and push the image; install or upgrade via Helm
   (`infra/helm/ragdoll`, see `kubernetes-deployment.md`).
2. Ensure the Kubernetes secret carries `DATABASE_URL`, `REDIS_URL`,
   `SECRET_ENCRYPTION_KEY`, `SESSION_SECRET`, and `RAGDOLL_ENV=production`.
3. The API runs `runMigrations` automatically on startup when `DATABASE_URL`
   is set; confirm via the `migrations_applied` log line.
4. Verify `/readyz` and `/healthz` on `ragdoll-api`, then check worker logs for
   the BullMQ "worker consuming BullMQ queue" line.

## Migrations

Migrations live in `packages/db/migrations` and are applied by `runMigrations`
(`packages/db/src/migrate.ts`): `*.sql` files sorted by filename, each in its
own transaction, recorded in `schema_migrations`. The API applies them at
startup; to run them out-of-band, invoke `runMigrations(pool)` against the
target database before rolling pods. Re-running is safe (already-applied files
are skipped).

## Secret encryption key rotation

`SECRET_ENCRYPTION_KEY` feeds the AES-256-GCM `StaticKeyProvider`. There is no
automatic re-encryption. To rotate:

1. Stand up the new key alongside the old (out-of-band re-encrypt: read each
   secret with the old key, `put` it again with the new key so a new version
   is written).
2. Roll API and worker pods with the new `SECRET_ENCRYPTION_KEY`.
3. Rotate individual provider secrets via `PUT /api/secrets/:id` (writes a new
   version; the secrets API never returns plaintext).

Rotate `SESSION_SECRET` similarly; outstanding session tokens become invalid
on change, so coordinate with a re-login window.

## Queue and worker operations

- Queue selection: `REDIS_URL` set -> BullMQ consumer; unset -> in-memory
  (no external transport; for tests/single-process only).
- Tune with `WORKER_CONCURRENCY`, `WORKER_QUEUE_NAME` (default `ragdoll-jobs`),
  `WORKER_MAX_RETRIES`. BullMQ enqueues with exponential backoff and
  `removeOnComplete`/`removeOnFail` caps.
- Scale workers by queue depth; use separate pools for ingestion vs.
  latency-sensitive runs.
- Cancellation: `QueuePort.cancel` removes/aborts the job; handlers honor the
  per-job `AbortSignal`. Aborted runs are recorded as execution status
  `cancelled`.
- Stuck job: inspect with BullMQ tooling, `retry` to requeue, or
  `deadLetter` to fail it with a reason.

## Health and readiness

- `GET /healthz` — liveness; `GET /readyz` — readiness. Both are unauthenticated.
- Postgres connectivity is lazy; a failing pool surfaces as 500s and is logged
  as `unhandled_route_error`. Watch the `pg_isready` healthcheck in Compose or
  the database probe in your platform.

## Incident basics

- Logs are single-line JSON (`ConsoleJsonLogger`) with `level`, `message`,
  `timestamp`, and a `requestId` on API requests; correlate with the
  `x-request-id` response header. In the local compose, the same lines
  are also OTLP-exported to **Loki** inside the bundled
  `grafana/otel-lgtm` container — searchable at **Grafana → Explore →
  Loki**, pre-tuned by the "RAGdoll · Overview" dashboard.
- Metrics: every API request emits `ragdoll_api_requests_total` and
  `ragdoll_api_request_duration_ms`; every worker pipeline run emits
  `ragdoll_worker_executions_total` and
  `ragdoll_worker_execution_duration_ms`. Open Grafana on
  **http://localhost:3300** for the dashboard or query Prometheus
  directly inside the container. See `docs/admin/observability.md` for
  the full metric reference and common queries.
- Traces: spans are emitted per execution and per node when OpenTelemetry is
  installed and `OTEL_ENABLED` is not `false`. They land in **Tempo**
  in the LGTM container; clicking a span deep-links to the matching
  log lines in Loki.
- Auth failures return 401 (`unauthorized`); permission failures return 403
  (`forbidden`) — check the principal's roles and tenant.
- Suspected secret exposure: audit diffs and secret values are redacted before
  persistence; rotate the affected secret and `SECRET_ENCRYPTION_KEY`.
- Roll back by deploying the prior image; published pipeline versions are
  immutable so a rollback cannot corrupt specs.
