# RAGdoll Helm Chart

Deploys the RAGdoll API, worker (split into a cron-scheduler "leader"
plus N stateless "followers"), web UI, optional Python plugin sidecar,
and a one-shot `db-init` Job that migrates the schema + seeds defaults
on every install/upgrade.

The first install also provisions a single platform-admin user from
`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (see the
[example secret](../../k8s/ragdoll-secrets.example.yaml)) so you can
sign into the web UI immediately after `helm install` completes.

## What this chart does NOT deploy

Bring-your-own backends:

- **Postgres** (orchestration state) — provide via `DATABASE_URL` on
  the secret. No bundled option; use Bitnami's chart or a managed
  service.
- **Redis** (job queue + event bus) — provide via `REDIS_URL`, OR set
  `redis.enabled: true` for the bundled in-cluster Redis (see below).
- **Qdrant** / **OpenSearch** / **Dgraph** (vector / lexical / graph
  retrieval) — point at existing services via the URLs in
  `values.yaml`.
- **OpenTelemetry collector** — point at your existing endpoint via
  `otel.endpoint`.
- **Ollama** (local LLM) — optional, set `ollama.baseUrl` to enable.

### Bundled Redis (opt-in)

Setting `redis.enabled: true` ships a minimal single-replica
`ragdoll-redis` Deployment + Service + ConfigMap. The config is
deliberately defensive against the `MISCONF Redis is configured to
save RDB snapshots, but it's currently unable to persist to disk`
error operators hit on misconfigured Redises:

- `save ""` — disable RDB snapshots entirely.
- `stop-writes-on-bgsave-error no` — even if a snapshot somehow runs
  and fails, writes keep working.
- `appendonly no` by default (no AOF either).

That's safe for RAGdoll because Redis state is in-flight jobs
(re-enqueueable on retry), the change-event bus (best-effort fanout),
the SSO state cache (10-min TTL), and the scheduler lease (10s TTL).
**None of it is source of truth.** A Redis pod restart loses
everything in flight and recovers cleanly.

When you DO want persistence, set `redis.persistence.enabled: true` —
Redis switches to AOF (incremental, no bgsave failure mode) and mounts
a PVC at `/data`. Strategy is `Recreate` (not RollingUpdate) so two
pods can never race AOF rewrites against the same PVC.

After enabling, set `REDIS_URL=redis://ragdoll-redis:6379` on the
`ragdoll-secrets` Secret.

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
- **Job queue** (worker fan-out, retry, scheduling) → BullMQ on
  Redis.
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

- Every worker pod starts both the BullMQ consumer AND a scheduler
  interval timer.
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
believe they are leader. BullMQ jobs are deduplicated by job id, and
the scheduler enqueues with deterministic `schedule:<id>:<tickAt>`
ids, so a duplicate enqueue from the brief overlap drops cleanly.

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
