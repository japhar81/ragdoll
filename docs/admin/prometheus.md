# Prometheus / kube-prometheus-stack integration

This is the operator-side companion to the chart's [`Observability`
section](../../infra/helm/ragdoll/README.md#observability--otel-push-vs-prometheus-pull).
It covers installing the CRDs RAGdoll's `ServiceMonitor` +
`PrometheusRule` depend on, getting Prometheus to actually discover
the targets, and the cardinality knobs you'll want to think about
before scaling up.

For the architectural rationale of the dual-reader design ("why am
I able to run both OTel and Prometheus at the same time?"), see
[`observability.md`](./observability.md).

## TL;DR

```sh
# 1. Install kube-prometheus-stack (one-time, per cluster):
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace

# 2. Turn on RAGdoll's Prometheus path AND pin the ServiceMonitor's
#    `release` label so the operator's Prometheus discovers it:
helm upgrade ragdoll infra/helm/ragdoll \
  --set prometheus.enabled=true \
  --set 'prometheus.serviceMonitor.additionalLabels.release=monitoring'

# 3. Confirm — should list ragdoll-api + ragdoll-worker as targets:
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
open http://localhost:9090/targets
```

## What the chart renders

`prometheus.enabled=true` flips on five things, all on the same
Helm release:

| Object | When | Purpose |
| --- | --- | --- |
| Named `metrics` port (9464) on `ragdoll-api` + `ragdoll-worker` Deployments | always | The OTel SDK's `PrometheusExporter` listens here for `/metrics` requests. |
| `metrics` port + `prometheus-scrape: "true"` label on `ragdoll-api` Service | always | Lets ServiceMonitor select it. |
| New headless `ragdoll-worker` Service | always | Workers serve no inbound HTTP otherwise — this exists ONLY so prometheus-operator can discover their pod IPs via the Endpoints object. |
| `ServiceMonitor` (CRD `monitoring.coreos.com/v1`) | `prometheus.serviceMonitor.enabled` (default true) | Tells the operator's Prometheus what to scrape, how often, and how to relabel. |
| `PrometheusRule` (CRD `monitoring.coreos.com/v1`) | `prometheus.prometheusRule.enabled` (default true) | Default starter alerts — replace wholesale by overriding `prometheus.prometheusRule.rules`. |

The two CRD-backed objects only render when the CRDs actually exist
in the cluster. The chart runs `helm lookup` at template time; if
the CRD is missing the install fails with a clear message. To
bypass the check (e.g. CI pipelines rendering manifests offline
before apply): `prometheus.assumeCrdsInstalled=true`.

## Why a separate "scrape" label

The chart's ServiceMonitor selector matches Services with both
`app.kubernetes.io/instance: <release>` AND
`prometheus-scrape: "true"`. This avoids accidentally scraping the
api Service in releases where `prometheus.enabled` is false — the
label is only stamped when the master toggle is on. So you can run
two RAGdoll releases side-by-side, one with the Prometheus path on
and one without, and the operator's Prometheus picks up only the
former.

## Why a headless worker Service

Workers don't serve inbound HTTP traffic (they're BullMQ consumers
+ scheduler timers). prometheus-operator's `ServiceMonitor` needs a
Service object to discover targets — it reads the Service's
Endpoints to get pod IPs and scrapes those directly. We give it a
`clusterIP: None` Service so kube-proxy doesn't allocate a virtual
IP, no `iptables` rules are added, and there's no extra hop —
Prometheus connects pod-direct.

## Cardinality — the one knob to watch

Out of the box, every metric label the app code adds becomes a
distinct time-series in Prometheus. The big ones to worry about:

| Label | Where it's added | Cardinality risk |
| --- | --- | --- |
| `tenant_id` | every counter/histogram emitted from runtime / api | Bounded by tenant count. Usually fine; can be tens of thousands for SaaS. |
| `pipeline_id` | runtime + worker emit | Bounded by pipeline definitions. Hundreds-to-thousands per tenant. |
| `pipeline_version_id` | runtime emit | Bounded by edits — can explode (one tenant making frequent edits → hundreds of thousands). |
| `execution_id` | NEVER added as a metric label | This would be unbounded per-run. We use it on traces / logs only. |
| `pod` (`__meta_kubernetes_pod_name`) | added by Prometheus's default labeling | Bounded by pod count. |

If your dashboards don't need the dimension, drop it at scrape time
in `prometheus.serviceMonitor.metricRelabelings`. Example — keep
`pipeline_id` for the worker but drop it for the api metrics (which
already have route-level granularity):

```yaml
prometheus:
  serviceMonitor:
    metricRelabelings:
      - sourceLabels: [__name__, pipeline_id]
        regex: ragdoll_api_.*;.+
        action: labeldrop
        replacement: pipeline_id
```

`metric_relabel_configs` runs after the scrape but before storage,
so it's the right knob for "I want the metric, just not this
label." For dropping entire metrics, use `keep` / `drop` actions
matched on `__name__`.

## Starter alerts

The default `PrometheusRule.rules` ships three alerts. Tune
thresholds + `for:` windows for your environment — these are
sensible baselines, not SLOs.

| Alert | Triggers when | Why it matters |
| --- | --- | --- |
| `RagdollApiHighErrorRate` | 5xx ratio > 5% sustained for 10 min on any api pod | Either the api is throwing, a downstream backend is failing, or a recent deploy regressed. |
| `RagdollWorkerExecutionsStuck` | `inflight > 0` for 15 min but `executions_total` rate = 0 | A plugin is hung, the queue is wedged, or the scheduler lease has been lost. Check pod logs + Redis lease holder. |
| `RagdollSchedulerLeaderMissing` | Zero executions cluster-wide for 20 min | Either real idle (false positive — adjust window) or the lease has no holder. Inspect `ragdoll:scheduler:leader` in Redis. |

Override the whole list:

```yaml
prometheus:
  prometheusRule:
    rules:
      - alert: MyCustomAlert
        expr: ...
        for: 5m
        labels: { severity: critical }
        annotations: { summary: "..." }
```

## Migrating from OTel → Prometheus (or back)

Both backends can be on at once — that's the supported transition
mode. Run with both enabled for at least one full release cycle so
you can sanity-check that the new system shows the same numbers as
the old one. The two readers attach to the same `MeterProvider`, so
a `getMeter().counter().add()` reaches **both** without any
double-invocation in the call sites.

```sh
# Phase 1: turn Prometheus on while keeping OTel push.
helm upgrade ragdoll infra/helm/ragdoll \
  --set prometheus.enabled=true \
  --set otel.enabled=true   # default

# Phase 2: verify dashboards in both systems match; cut over.

# Phase 3: turn OTel push off.
helm upgrade ragdoll infra/helm/ragdoll \
  --set prometheus.enabled=true \
  --set otel.enabled=false
```

OTel push for **traces and logs** continues to work regardless —
`otel.enabled` only gates the metrics reader. If you want logs +
traces off too (rare — you'd lose trace ↔ log correlation), set
`OTEL_LOGS_ENABLED=false` / `OTEL_TRACES_ENABLED=false` on the
deployments separately.

## Troubleshooting

**`prometheus.serviceMonitor.enabled=true but the ServiceMonitor
CRD is not installed`**
Install prometheus-operator first. Or, if you're rendering
manifests offline before apply (the cluster *does* have the CRD,
but `helm template` can't see it), set
`prometheus.assumeCrdsInstalled=true`.

**Prometheus doesn't show RAGdoll targets**
Check the `release` label. Most kube-prometheus-stack installs
configure their Prometheus to discover ServiceMonitors with a
matching `release` label. Pin yours via
`prometheus.serviceMonitor.additionalLabels.release=<their helm
release name>`.

**Targets show up but are DOWN**
The most common cause: NetworkPolicy blocking the
operator-namespace ↔ ragdoll-namespace traffic on port 9464. The
operator's Prometheus pod needs egress to `ragdoll`-namespace pods
on the named `metrics` port.

**`/metrics` returns 404**
The OTel `PrometheusExporter` only starts when
`PROMETHEUS_METRICS_ENABLED=true` on the container — the chart
sets this automatically when `prometheus.enabled=true`. Check
`kubectl describe pod` for the env var; if it's missing, the helm
release didn't actually flip.

**HPA reading 0 from a Prometheus-backed query**
Confirm the metric name. The OTel SDK auto-converts dots to
underscores when emitting in Prometheus exposition format — a
metric instrumented as `ragdoll.api.requests` shows up as
`ragdoll_api_requests`. Counters also get a `_total` suffix
appended by the exporter. Grep `/metrics` to confirm the name
Prometheus actually sees before pointing your HPA at it.
