# ADR 0014 — LGTM observability stack (Grafana, Loki, Tempo, Prometheus)

Status: Accepted (2026-05-20)

## Context

ADR 0007 set up an opt-in OpenTelemetry tracer with a graceful no-op
fallback. The bundled collector — a vanilla `otel-collector-contrib`
container — only logged to stdout (`debug` exporter). That left us with
the *capacity* for traces but no place to view them, and no metrics or
log aggregation at all.

We want a polished, end-to-end view of what the platform is doing —
request rate, error rate, p95 latency, execution throughput, slow runs,
log search, trace inspection — without a half-day operations setup.

## Decision

Replace the standalone `otel-collector` with **Grafana's all-in-one
`grafana/otel-lgtm` image**. It bundles:

- **OTel Collector** (same OTLP ports — 4317 gRPC, 4318 HTTP — so the
  api/worker `OTEL_EXPORTER_OTLP_ENDPOINT` doesn't move),
- **Loki** (logs backend),
- **Tempo** (traces backend),
- **Prometheus** (metrics backend),
- **Grafana** (UI with the three datasources pre-wired).

Grafana is exposed on host port **3300** (not 3000 — that port is too
commonly clashed). The container persists state to a `lgtm-data` Docker
volume so dashboards / Loki indexes survive `make refresh`.

App-side: the existing `ConsoleJsonLogger` gains an optional sink that
forwards each record to an OTel log record. `wireOtelLogs()` and
`wireOtelMetrics()` follow the lazy-import / no-op-fallback pattern
established by `createTracer()` in ADR 0007 — both return a shutdown
closure that flushes the batch processors on SIGTERM. The api and
worker each emit two metrics today:

| Metric                                    | Labels                          |
| ----------------------------------------- | ------------------------------- |
| `ragdoll_api_requests_total` (counter)    | `method`, `route`, `status`     |
| `ragdoll_api_request_duration_ms` (hist)  | `method`, `route`, `status`     |
| `ragdoll_worker_executions_total` (count) | `pipeline_id`, `environment`, `status` |
| `ragdoll_worker_execution_duration_ms` (hist) | `pipeline_id`, `environment`, `status` |

A "RAGdoll · Overview" dashboard is provisioned from JSON so it auto-
appears on first boot. Datasources (Loki, Tempo, Prometheus) are
provisioned via YAML and configured for **trace ↔ log correlation**:
clicking a Tempo span deep-links to Loki logs filtered by trace id, and
log lines containing `"trace_id":"…"` link back to Tempo.

## Why all-in-one (not the four-container split)

- **Lightweight.** One image, one volume, one port. The user-facing
  asked for "lightweight if we can."
- **Local-dev focus.** The full LGTM-stack-as-microservices is the
  right answer in production (each component is operationally
  independent), but in compose the simplicity wins and the in-container
  components scale plenty for a developer's machine.
- **Drop-in compatible.** The bundled collector listens on the same
  OTLP ports as the previous standalone — no app config changes.
- **Easy upgrade path.** When ready for prod, swap the all-in-one for
  per-service deployments and re-point `OTEL_EXPORTER_OTLP_ENDPOINT`;
  app code is unchanged.

## Trade-offs

- **Bundle pulls a heavier Docker image** (~1 GB for `otel-lgtm` vs.
  ~80 MB for the bare collector). One-time cost; acceptable.
- **Local dev anonymous access.** Grafana auth is on by default but the
  compose drops you in as an anonymous viewer. Not for production.
- **No pre-built alerting.** Dashboards are read-mostly today. Alerting
  rules can be added under `infra/grafana/provisioning/alerting/` in a
  follow-up; not in scope here.

## Consequences

- One URL — http://localhost:3300 — for logs, metrics, traces, and the
  RAGdoll overview dashboard. The "what is the platform doing" question
  now has a single answer surface.
- The shared logger and meter are wired by `wireOtelLogs()` /
  `wireOtelMetrics()` at process boot; both return a flush closure that
  the api/worker call on SIGTERM so the last few seconds of telemetry
  reach the collector.
- Tests added under `packages/observability/test/observability.test.ts`
  (8 install-free tests covering log sink forwarding + enabled-false
  no-op shutdown paths). All other suites unchanged.
- `make obs` prints the Grafana URL; the rest of the dev loop
  (`make up`, `make refresh`) is unchanged.
- Rollback: revert the compose swap; the app code degrades to no-op
  exporters automatically (see `docs/admin/observability.md`).
