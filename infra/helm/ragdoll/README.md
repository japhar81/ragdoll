# RAGdoll Helm Chart

`helm install ragdoll ./infra/helm/ragdoll` stands up a complete,
working RAGdoll stack: api + autoscaling worker + web UI + bundled
Postgres + bundled Redis + bundled Qdrant + a generated Secret with
random crypto keys and a bootstrap admin user. No external services
required, no Secret to pre-apply.

Bring your own backend at any time by flipping the corresponding
`bundled<X>.enabled: false`; everything else keeps working.

## Multiple releases in one namespace

Every resource is prefixed with the **release name** (`<release>-api`,
`<release>-web`, `<release>-worker`, `<release>-qdrant`, …) and every Service
selector / Deployment selector is scoped to that release, so two releases can
coexist in a single namespace without colliding or cross-selecting each other's
pods:

```sh
helm install rag-blue ./infra/helm/ragdoll -n shared
helm install rag-green ./infra/helm/ragdoll -n shared   # no collisions
```

> **Upgrade note.** With the conventional release name `ragdoll`
> (`helm install ragdoll …`) every rendered name is **unchanged** from earlier
> chart versions — an in-place upgrade is a no-op rename. If you installed under
> a *different* release name on an older chart (which hard-coded `ragdoll-*`
> regardless of release), this upgrade **renames** the workloads to
> `<release>-*`; Kubernetes will recreate them (brief downtime). Pin the old
> names with `--set` overrides, or accept the recreate.

## Install

The Bitnami subchart tarballs (postgres, redis, opensearch) are **vendored**
under `charts/` — no `helm dependency update` step, and the chart installs
straight from a git clone (Argo/Flux/Harness included). Only re-run
`helm dependency update infra/helm/ragdoll` (and commit the result) when
deliberately bumping a subchart version.

```sh
# 1. Install. With defaults, this also provisions a fully running
#    Postgres + Redis + Qdrant — nothing else to configure.
helm install ragdoll infra/helm/ragdoll \
  --namespace ragdoll --create-namespace

# 2. The NOTES.txt from the install prints the bootstrap admin
#    credentials (random per install, preserved across upgrades).
kubectl -n ragdoll get secret ragdoll-ragdoll-secrets \
  -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d ; echo

# 4. Expose externally:
#    Vanilla k8s
helm upgrade ragdoll infra/helm/ragdoll -n ragdoll \
  --reuse-values \
  --set ingress.enabled=true \
  --set 'ingress.hosts[0].host=ragdoll.example.com' \
  --set 'ingress.hosts[0].paths[0].path=/' \
  --set 'ingress.hosts[0].paths[0].pathType=Prefix'

#    OpenShift
helm upgrade ragdoll infra/helm/ragdoll -n ragdoll \
  --reuse-values \
  --set openshift.route.enabled=true
```

## Bundled vs BYO matrix

| Backend | Default | How it ships | How to BYO |
| --- | --- | --- | --- |
| Postgres | bundled | Bitnami `postgresql` subchart (`oci://registry-1.docker.io/bitnamicharts/postgresql:16.7.4`) | `bundledpostgres.enabled=false` + set `DATABASE_URL` on your Secret + `secrets.create=false` |
| Redis | bundled | Bitnami `redis` subchart, standalone, snapshot-failure-proof `redis.conf` | `bundledredis.enabled=false` + `REDIS_URL` |
| Qdrant | bundled | hand-rolled `ragdoll-qdrant` Deployment + Service + PVC (no Bitnami chart exists) | `bundledqdrant.enabled=false` + `qdrant.url` |
| OpenSearch | **disabled** | Bitnami `opensearch` subchart, off by default (heavy install) | `bundledopensearch.enabled=true` to enable, OR `opensearch.url` for BYO |
| Dgraph | n/a | not shipped | `dgraph.url` |
| Ollama | n/a | not shipped | `ollama.baseUrl` |
| OTel Collector | n/a | not shipped | `otel.endpoint` |

A fully-BYO install pins everything to your own services:

```sh
helm install ragdoll infra/helm/ragdoll \
  --set bundledpostgres.enabled=false \
  --set bundledredis.enabled=false \
  --set bundledqdrant.enabled=false \
  --set secrets.create=false \
  --set secrets.existingSecret=my-ragdoll-secret
```

## Generated Secret

When `secrets.create: true` (default), the chart generates
`<release>-ragdoll-secrets` on first install with:

- `SECRET_ENCRYPTION_KEY` — random 64-char, **preserved across
  upgrades** via the `lookup`-with-fallback pattern. Rotating
  invalidates every encrypted secret-at-rest in the platform's own
  secret store, so this stays sticky.
- `SESSION_SECRET` — random 64-char, preserved. Rotating logs
  everyone out.
- `BOOTSTRAP_ADMIN_PASSWORD` — random 24-char, preserved.
  `BOOTSTRAP_ADMIN_EMAIL` comes from `api.bootstrapAdmin.email`
  (default `admin@change-me.local` — override per env).
- `DATABASE_URL` / `REDIS_URL` / `OPENSEARCH_URL` — computed from
  the bundled subchart Service names + the values you set for
  `bundledpostgres.auth.*` etc. **Always overwritten** on each
  render so flipping a `bundled*.enabled` tracks through cleanly.

The generated Secret is annotated `helm.sh/resource-policy: keep` —
it survives `helm uninstall` so a re-install reuses the same crypto
material. Delete it explicitly (`kubectl delete secret …`) to roll.

When `secrets.create: false`, the chart references the operator-
supplied Secret named `secrets.existingSecret` instead — same shape
as [the example](../../k8s/ragdoll-secrets.example.yaml).

## ⚠ Production overrides

The bundled Postgres ships with a placeholder password
(`ragdoll-please-override`) so the chart installs cleanly out of the
box. **Override before any non-dev install**:

```yaml
bundledpostgres:
  auth:
    password: <strong-1>
    postgresPassword: <different-strong-2>
```

The chart's generated Secret reads these same values when computing
`DATABASE_URL`, so the api/worker always see the same password
Postgres provisions itself with.

## Custom labels + annotations (Kyverno / Gatekeeper / OPA)

`commonLabels` and `commonAnnotations` get applied to every resource
the chart renders — Deployments, Services, ConfigMap, Job, HPAs,
Ingress/Route, SCC RBAC, Redis, the ServiceAccount, all of it. For
clusters with a Kyverno policy that mandates specific labels on every
object, set them once:

```yaml
commonLabels:
  app.kubernetes.io/part-of: ragdoll
  environment: prod
  team: platform
commonAnnotations:
  ragdoll.example.com/owner: "team-platform"
  ragdoll.example.com/cost-center: "rd-100"
```

If an operator-supplied label key collides with a chart default, the
operator's value wins so policy labels can't be silently overridden.

## Quick start

```sh
# 1. Edit infra/k8s/ragdoll-secrets.example.yaml — at minimum:
#    DATABASE_URL, REDIS_URL, SECRET_ENCRYPTION_KEY, SESSION_SECRET,
#    BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD.
kubectl apply -f infra/k8s/ragdoll-secrets.example.yaml

# 2. Install the chart. Override values per environment via -f or --set.
helm install ragdoll infra/helm/ragdoll \
  --set api.webBaseUrl=https://ragdoll.your-domain.example \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=ragdoll.your-domain.example \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=Prefix

# 3. Watch the db-init Job complete, then api/worker reach Ready:
kubectl get jobs,pods -l 'app in (ragdoll-db-init, ragdoll-api, ragdoll-worker)'

# 4. Sign in at WEB_BASE_URL using the bootstrap admin credentials.
#    From Profile → API keys, mint a `rgd_…` key for CLI / CI use.
```

## Upgrades

`helm upgrade` re-runs the `db-init` Job (pre-upgrade hook), which
applies any new migrations and reseeds the default-role catalog.
Migrations are tracked in `schema_migrations`; seeds use `ON CONFLICT
DO NOTHING`. Safe to re-run on every revision.

The api/worker pods wait for `db-init` to finish via an init container
that polls the `schema_migrations` table — pods stay `PodInitializing`
until the schema is ready, then start cleanly.

## Horizontal scaling

The chart is built for multi-pod workloads from the start. Three
HorizontalPodAutoscaler resources are available; the worker one is on
by default, api/web are opt-in.

| Workload | HPA default | min | max | Notes |
| --- | --- | --- | --- | --- |
| `ragdoll-worker-follower` | **on** | 1 | 10 | Scales on CPU @ 70%. Leader stays at 1 replica. |
| `ragdoll-api` | off | 2 | 6 | Enable with `api.autoscaling.enabled=true`. Requires Redis. |
| `ragdoll-web` | off | 2 | 6 | Enable with `web.autoscaling.enabled=true`. Stateless nginx, always safe. |

Override per-env via the `*.autoscaling.{min,max}Replicas` and
`targetCPUUtilizationPercentage` values. When autoscaling is enabled
the chart omits the `replicas` field on the Deployment so a helm
upgrade doesn't reset the HPA's current scale.

HPAs require the metrics-server addon (or an equivalent metrics
provider) on the cluster.

### Shared state — what makes multi-pod safe

Every process-local state that would otherwise break across pods has
a Redis-backed implementation, picked when `REDIS_URL` is set on the
existing secret:

- **Change-event bus** (`/api/events` WebSocket fan-out) →
  Redis pubsub channel `ragdoll:changes`.
- **Job queue** (worker fan-out, retry, dead-letter) → NATS JetStream
  work-queue stream (`NATS_URL`).
- **SSO pending-state cache** (10-min TTL between OIDC/SAML start
  and callback) → Redis with server-side `EX` TTL. Without this
  a callback that lands on a different api pod than the start
  would fail with `sso_state_invalid`.
- **Session tokens** are stateless HMACs (no shared session table
  required).

Single-pod / offline test installs that omit `REDIS_URL` fall back to
in-process implementations of each — the contract is identical.

## Worker scheduler (Redis lease)

The worker's built-in cron scheduler ticks every schedule defined in
the platform. Running >1 worker replica with naive timers would fire
each schedule N times, so the scheduler is gated by a Redis lease:

- Every worker pod binds the shared NATS JetStream consumer AND starts a
  scheduler interval timer.
- Each pod periodically tries `SET ragdoll:scheduler:leader <podId> NX
  PX 10000`. Whoever succeeds holds the lease for 10 s and renews
  every ~3 s.
- A pod's scheduler tick short-circuits with `enqueued: 0` when its
  local `isLeader()` returns false. Only the lease holder actually
  enqueues — every other pod's tick is a cheap no-op.
- Failover: when the holder pauses (GC, crash, network partition)
  it stops renewing, the lease expires after the TTL, and the next
  pod's `SET … NX` succeeds. End-to-end failover ≈ 10–15 s.

Result: workers are **interchangeable**. The follower-only Deployment
that used to gate `WORKER_SCHEDULER_ENABLED=false` is gone. A single
autoscaled `ragdoll-worker` Deployment scales freely (HPA min 1 /
max 10 by default); even running at `min: 1` doesn't risk duplicate
cron tickets when k8s rolls a pod, because the next-started pod
acquires the lease cleanly.

Split-brain caveat: during a lease handoff (a pod pausing >10 s, then
waking up before its next renewal attempt) two pods may briefly both
believe they are leader. The primary guard is the lease itself plus
`markRun`, which advances each schedule's `next_run_at` right after it
fires — so the other pod's `listDue` no longer returns it. (JetStream also
deduplicates re-publishes of the *same* `Nats-Msg-Id`/job id within the
stream's duplicate window, which collapses a producer-side publish retry,
though scheduler fires use fresh ids so the lease is what bounds overlap.)

`WORKER_SCHEDULER_ENABLED=false` is retained as a cluster-wide
emergency kill-switch (e.g. silence a runaway schedule while
operators investigate). Setting it on a single pod is harmless — that
pod just won't fire even if it holds the lease. Setting it on every
pod stops scheduling.

## API / MCP exposure

The web container's nginx reverse-proxies these paths to the api
Service internally:

- `/api/*` — REST API (CLI, web UI, third-party clients)
- `/mcp` — Model Context Protocol endpoint (Claude Desktop, IDE
  extensions, llm scripts)
- `/healthz`, `/readyz` — health probes

So one Ingress (vanilla k8s) or Route (OpenShift) on the web Service
covers all three audiences. CLI users point at
`https://<your-host>/api/...`; MCP clients point at
`https://<your-host>/mcp`. WebSocket upgrades for `/api/events` ride
through because nginx is configured with `Upgrade` / `Connection`
hop-by-hop headers (and HAProxy on OpenShift honours them by default).

Optional: enable `apiIngress.enabled` (k8s) or
`openshift.apiRoute.enabled` (OpenShift) for installs that want the
API on its OWN hostname — e.g. `api.ragdoll.example.com` distinct
from `ragdoll.example.com` for the web UI. Lets you apply different
TLS certs, ingress classes, rate limits, or WAF policies.

## OpenShift

The chart ships first-class OpenShift support:

| Concern | Vanilla k8s | OpenShift |
| --- | --- | --- |
| External entrypoint | `ingress.enabled: true` | `openshift.route.enabled: true` |
| Pod security | `podSecurityContext.runAsNonRoot: true` + drop ALL caps (passes both PSA `restricted` and `restricted-v2` SCC out of the box) | same — no custom SCC needed |
| Web port | 8080 (nginx-unprivileged) | 8080 |
| HPA metrics | metrics-server addon | Prometheus Adapter — same `autoscaling/v2` HPA |

Install on OpenShift:

```sh
oc apply -f infra/k8s/ragdoll-secrets.example.yaml   # edit first
helm install ragdoll infra/helm/ragdoll \
  --set openshift.route.enabled=true \
  --set ingress.enabled=false \
  --set openshift.route.host=ragdoll.apps.your-cluster.example
```

The default `podSecurityContext` + `containerSecurityContext` pass
`restricted-v2` (the SCC OpenShift assigns to every namespace's SAs
out of the box). Only enable `openshift.scc.enabled` and bind to a
named SCC (`anyuid`, `nonroot-v2`, …) if you've had to relax the
defaults — e.g. you mounted a hostPath for debugging.

Internal Route URL is generated by OpenShift's router from the route
name unless you pin `openshift.route.host`. TLS terminates at the
router (`edge`), with insecure HTTP redirected. Override
`openshift.route.tls.termination` to `passthrough` / `reencrypt` if
your security model needs end-to-end TLS.

## Observability — OTel push vs Prometheus pull

RAGdoll's observability path is built on the OpenTelemetry SDK with a
single shared `MeterProvider`. The chart lets you attach **either or
both** backends — every metric the app code emits via `getMeter()`
fans out to whichever readers are active. No call site needs to know
which backend is on.

| `otel.enabled` | `prometheus.enabled` | Behaviour |
| --- | --- | --- |
| `true` (default) | `false` (default) | Legacy single-OTLP-push to `otel.endpoint`. Identical to the docker-compose LGTM bundle. |
| `false` | `true` | Pull-only — `/metrics` on each pod, scraped by a `ServiceMonitor`. Use when prometheus-operator is your platform-standard. |
| `true` | `true` | **Both readers attached to the same MeterProvider.** Use during a migration between systems, or to feed Prometheus for HPA decisions while keeping OTLP for tracing/log correlation. |
| `false` | `false` | Metrics fully off — `getMeter()` returns a `NoopMeter`. Zero-cost calls; useful for stripped-down installs. |

Logs + traces continue to push over OTLP regardless of either toggle
(controlled by `OTEL_LOGS_ENABLED` / `OTEL_TRACES_ENABLED` env vars
on the deployments).

Enable Prometheus scraping:

```sh
helm upgrade ragdoll infra/helm/ragdoll \
  --set prometheus.enabled=true
```

This adds a named `metrics` port (default 9464) on the api + worker
Services + Deployments, a marker label `prometheus-scrape: "true"`,
a headless `ragdoll-worker` Service so the operator's Prometheus can
discover the worker pods, plus a `ServiceMonitor` and starter
`PrometheusRule`. The latter two CRDs ship with prometheus-operator
— the chart runs a `helm lookup` at template time and fails with a
clear message if the CRD isn't installed. Override
`prometheus.assumeCrdsInstalled=true` to bypass the check when
rendering offline (e.g. `helm template` in CI).

Pin the ServiceMonitor's `release` label so your Prometheus picks it
up:

```sh
helm upgrade ragdoll infra/helm/ragdoll \
  --set prometheus.enabled=true \
  --set 'prometheus.serviceMonitor.additionalLabels.release=kube-prometheus-stack'
```

See [`docs/admin/prometheus.md`](../../../docs/admin/prometheus.md)
for the operator-side guide (installing kube-prometheus-stack, label
discovery, cardinality controls, default starter alerts).

## Bootstrap admin

`server.ts` runs `bootstrapAccessControl()` on every boot. If a user
with `BOOTSTRAP_ADMIN_EMAIL` doesn't exist, it creates one with
`BOOTSTRAP_ADMIN_PASSWORD` and grants `platform_admin` at `scope: *`.
If a user with that email DOES exist (e.g. you changed the password
in the UI later), the env values are ignored — `kubectl apply` to the
secret won't override your live credentials.

To redo the bootstrap (e.g. you typo'd the email), delete the wrong
row in psql and re-roll the api Deployment:

```sql
DELETE FROM users WHERE email = 'typoed@example.com';
```

```sh
kubectl rollout restart deployment/ragdoll-api
```

## Per-environment values

Common overrides:

```yaml
# values.prod.yaml
api:
  replicas: 4
  webBaseUrl: "https://ragdoll.acme.example"

api:
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 12

web:
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 8

worker:
  followers:
    autoscaling:
      enabled: true
      minReplicas: 2     # always keep some warm capacity
      maxReplicas: 30    # peak ingestion bursts
  ollamaWarmModels: ""   # production uses a hosted LLM, not Ollama

pythonPlugins:
  enabled: false   # no crawler use case in prod

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
    - host: ragdoll.acme.example
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - secretName: ragdoll-acme-tls
      hosts: [ragdoll.acme.example]

# Hosted backends — no Ollama, OpenSearch on a different cluster
ollama:
  baseUrl: ""
opensearch:
  url: "https://opensearch.acme.internal:9200"
otel:
  endpoint: "https://otel.acme.internal:4318"
  resourceAttributes: "service.namespace=ragdoll,deployment.environment=prod"
```

## Troubleshooting

**`db-init` Job fails on first install** — check the Job's pod logs.
99% of the time it's a bad `DATABASE_URL` on the secret. The Job's
`activeDeadlineSeconds: 600` will kill a hung migration after 10
minutes.

**api / worker stuck in `PodInitializing`** — the `wait-for-db-init`
init container is polling `schema_migrations`. If the db-init Job
already failed, the init container will retry 60 times (~2 min) then
fail loudly. Look at `kubectl logs <pod> -c wait-for-db-init`.

**Can't sign in as bootstrap admin** — confirm `BOOTSTRAP_ADMIN_*`
landed on the secret (`kubectl get secret ragdoll-secrets -o yaml`).
Check api logs for the `bootstrap_admin_created` event — if it's
missing, the email already exists in the `users` table from a prior
run.

**Web returns 502 on /api/...** — the templated nginx config points
at `ragdoll-api:80` (the Service this chart renders). If you renamed
the API release or disabled the API Deployment, regenerate the web
ConfigMap to match.
