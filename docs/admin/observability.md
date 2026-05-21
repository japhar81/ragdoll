# Observability

RAGdoll ships a fully wired observability stack in the local Docker compose:
**Grafana, Loki, Tempo, and Prometheus** all live in a single
`grafana/otel-lgtm` container that also hosts the OpenTelemetry Collector
the API and worker push to. One container, three signals, one URL.

## What's in the box

| Signal      | Backend     | What you see                                                |
| ----------- | ----------- | ----------------------------------------------------------- |
| **Logs**    | Loki        | Single-line JSON from every service, filtered & searchable  |
| **Metrics** | Prometheus  | API request rate / latency / errors; worker throughput / duration |
| **Traces**  | Tempo       | `pipeline.execute` and per-node spans, linked from logs     |
| **UI**      | Grafana 11+ | Auto-provisioned datasources + the "RAGdoll · Overview" dashboard |

## Open it

```sh
make refresh        # rebuilds api/worker/web and restarts the LGTM container
make obs            # prints the URL (Grafana UI on :3300)
```

Then visit **http://localhost:3300**. The `RAGdoll` folder in the
dashboards tree has the pre-built overview.

> **Note:** the LGTM container is anonymous-friendly in local dev — you
> land on the dashboard with viewer access. Edit it inline; changes live
> in the bundled SQLite under the `lgtm-data` Docker volume.

## How the wiring works

The API and worker both:

1. Lazy-load `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, and the
   OTLP HTTP log exporter. The shared `ConsoleJsonLogger` continues to
   write a JSON line to stdout *and* mirrors each record into the OTel
   log pipeline so Loki sees it.
2. Lazy-load `@opentelemetry/sdk-metrics` and the OTLP HTTP metric
   exporter. Metrics tick every 15 s into Prometheus.
3. Use the existing tracer (`packages/observability/src/index.ts`) — no
   change. Spans go to Tempo via the bundled collector.

Three env knobs control the wiring per process:

| Variable                       | Default          | Effect when set to `false`             |
| ------------------------------ | ---------------- | -------------------------------------- |
| `OTEL_ENABLED`                 | _on_             | Skip span emission (NoopTracer)        |
| `OTEL_LOGS_ENABLED`            | _on_             | Skip OTLP log export (stdout-only)     |
| `OTEL_METRICS_ENABLED`         | _on_             | Skip OTLP metric export (NoopMeter)    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | (compose: …4318) | Target collector (HTTP)                |
| `OTEL_SERVICE_NAME`            | per service      | Stamped on every record as `service.name` |

The collector inside `grafana/otel-lgtm` listens on the same `4317`
(gRPC) / `4318` (HTTP) ports as the previous standalone collector, so
nothing in the app config moves.

## Metric reference

| Metric                                    | Type      | Labels                          |
| ----------------------------------------- | --------- | ------------------------------- |
| `ragdoll_api_requests_total`              | counter   | `method`, `route`, `status`     |
| `ragdoll_api_request_duration_ms`         | histogram | `method`, `route`, `status`     |
| `ragdoll_worker_executions_total`         | counter   | `pipeline_id`, `environment`, `status` |
| `ragdoll_worker_execution_duration_ms`    | histogram | `pipeline_id`, `environment`, `status` |

The `route` label is **normalized** (UUIDs and 16+ char identifiers
collapse to `:id`) so high-cardinality paths can't blow up Prometheus.

## Trace ↔ log correlation

The Loki datasource is provisioned with a `derivedFields` rule that
matches `"trace_id":"<hex>"` in any log line and turns it into a clickable
Tempo deep-link. Vice versa: open any span in Tempo → "Logs for this
span" lands in Loki, filtered by `trace_id`.

## Adding a metric

```ts
import { getMeter } from "@ragdoll/observability";

const meter = getMeter();
const queueDepth = meter.counter("ragdoll_worker_queue_depth", {
  description: "Pending jobs in the BullMQ queue.",
  unit: "{job}"
});

// later, anywhere in the hot path:
queueDepth.add(1, { queue: "ragdoll-jobs" });
```

Until `wireOtelMetrics` runs (it's called at api/worker boot), the
returned counter is a `NoopCounter` — calling `.add()` is safe and inert.

## Adding a panel to the overview dashboard

Edit it live in Grafana, then **Share → Export → Save to file**, and
drop the JSON into `infra/grafana/dashboards/`. The provisioning loop
re-syncs every 30 s, so a `make refresh` is optional.

## Common queries

**API p95 latency by route over the last 15 m** (Prometheus):

```promql
histogram_quantile(
  0.95,
  sum by (le, route) (rate(ragdoll_api_request_duration_ms_bucket[15m]))
)
```

**All `pipeline.execute` failures in the last hour** (Loki):

```logql
{service_name="ragdoll-worker"}
  |= "run_pipeline"
  |= "failed"
  | json
```

**Slowest pipeline executions** (LogQL → derived from `duration_ms`):

```logql
{service_name="ragdoll-worker"}
  |= "run_pipeline completed"
  | json
  | duration_ms > 5000
```

## Rollback

To go back to the stdout-only debug exporter:

1. In `infra/docker/docker-compose.yml`, replace the `grafana/otel-lgtm`
   image block with the previous `otel/opentelemetry-collector-contrib`
   block (it's preserved in the git history at the commit before
   `feat/observability-lgtm`).
2. `make refresh`.

The app code degrades gracefully — `wireOtelLogs` / `wireOtelMetrics`
return a no-op shutdown if the collector is gone, so logs keep landing
on stdout and metrics are dropped silently.
