# Observability

RAGdoll ships a fully wired observability stack in the local Docker compose:
**Grafana, Loki, Tempo, and Prometheus** all live in a single
`grafana/otel-lgtm` container that also hosts the OpenTelemetry Collector
the API and worker push to. One container, three signals, one URL.

## What's in the box

| Signal      | Backend     | What you see                                                |
| ----------- | ----------- | ----------------------------------------------------------- |
| **Logs**    | Loki        | Every container's stdout/stderr (api / worker / web / postgres / redis / opensearch / ollama / python-plugins) plus structured OTLP log records from the api/worker SDK |
| **Metrics** | Prometheus  | API request rate / latency / errors; worker throughput / duration; Postgres (pg_*); Redis (redis_*); per-container CPU / memory from docker_stats |
| **Traces**  | Tempo       | `pipeline.execute` and per-node spans, linked from logs (trace_id stamped on every record emitted inside a span) |
| **UI**      | Grafana 12  | Auto-provisioned datasources + two dashboards: "RAGdoll · Overview" (app signals) and "RAGdoll · Infrastructure" (backing-services) |

## How logs from every container reach Loki

The bundled OTel Collector runs a `filelog` receiver that tails every
container's JSON log file at `/var/lib/docker/containers/*/*-json.log`
(mounted read-only into the LGTM container). Each line is parsed,
stamped with a `container_name` resource attribute, and shipped to
Loki via OTLP. The api/worker continue to push structured records via
the SDK's OTLP log exporter on top of that, so an `error` line from
the worker's logger appears in Loki with all its structured fields
(`requestId`, `pipeline_id`, `duration_ms`, `trace_id`, ...) and the
matching plain Docker log line is right beside it.

A `docker_stats` receiver in the same collector adds per-container
CPU, memory, and I/O metrics keyed by `compose_service`. Those drive
the bottom row of the **RAGdoll · Infrastructure** dashboard.

**Caveat about container labels:** the bundled OTel Collector's
`container` filelog operator is too strict on its path-validation in
v0.134 ("failed to detect a valid log path" even for canonical
`/var/lib/docker/containers/<id>/<id>-json.log`), so we parse the
Docker JSON wrapper ourselves and stamp `container_id` (the 64-char
hex) as the Loki stream label rather than the friendly container name.
The `container.name` is exposed correctly on the docker_stats metrics
side (label `compose_service`); on the logs side, look up the id with
`docker ps --format '{{.ID}} {{.Names}}'` on the host.

## Side-car exporters

Two small images expose Prometheus metrics for the backing stores:

- `prometheuscommunity/postgres-exporter` → port 9187 (in-network).
  Surfaces `pg_stat_database_*`, `pg_locks_count`, `pg_up`, etc.
- `oliver006/redis_exporter` → port 9121 (in-network). Surfaces
  `redis_up`, `redis_connected_clients`, `redis_memory_used_bytes`,
  `redis_commands_processed_total`, etc.

Both are scraped every 15 s by the bundled collector's `prometheus`
receiver (see `infra/otel/otelcol-config.yaml`).

OpenSearch and Ollama don't ship a Prometheus exporter out of the
box. Their **logs** are still captured (filelog → Loki), and the
worker's per-node spans cover what the LLM/embedding calls are doing
from the application side.

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

**Only Postgres warnings & above** (Loki):

```logql
{container_name="ragdoll-postgres-1"} |~ "(WARNING|ERROR|FATAL|PANIC)"
```

**All Ollama lines mentioning the chat endpoint** (Loki):

```logql
{container_name="ragdoll-ollama-1"} |= "/api/chat"
```

**Slow API requests (>1s)** — these come through with `level=warn`
and `message="slow_request"` from the API's request log:

```logql
{service_name="ragdoll-api"} | json | message="slow_request"
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
