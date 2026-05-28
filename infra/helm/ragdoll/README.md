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
  the secret.
- **Redis** (job queue + event bus) — provide via `REDIS_URL`.
- **Qdrant** / **OpenSearch** / **Dgraph** (vector / lexical / graph
  retrieval) — point at existing services via the URLs in
  `values.yaml`.
- **OpenTelemetry collector** — point at your existing endpoint via
  `otel.endpoint`.
- **Ollama** (local LLM) — optional, set `ollama.baseUrl` to enable.

The chart focuses on the RAGdoll workloads and their wiring. Pair it
with the upstream Bitnami / Strimzi / etc. charts for the backends.

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

## Worker scheduler split

The worker has a built-in cron scheduler (croner) that ticks every
schedule defined in the platform. Running >1 worker replica with the
scheduler enabled would fire every schedule N times, so the chart
splits the workload into:

- **`ragdoll-worker-leader`** (`replicas: 1`, `WORKER_SCHEDULER_ENABLED=true`)
  — single pod, owns the cron scheduler AND consumes BullMQ jobs.
  NOT autoscaled — the scheduler must be single-fire.
- **`ragdoll-worker-follower`** (HPA min 1 / max 10 by default,
  `WORKER_SCHEDULER_ENABLED=false`) — N pods, consume jobs only.

If the leader pod crashes the scheduler pauses until it restarts;
queued jobs continue to drain via the followers. There is no
HA-failover for the scheduler today — a follow-up could add a
leader-election sidecar.

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
