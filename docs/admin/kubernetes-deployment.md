# Kubernetes Deployment

## Components

- `ragdoll-api`: stateless control-plane API (`apps/api/src/server.ts`), with
  `/readyz` readiness and `/healthz` liveness probes.
- `ragdoll-worker`: runtime and async worker (`apps/worker/src/index.ts`).
- `ragdoll-web`: static frontend, deployable behind any ingress.
- `ragdoll-python-plugins` (optional): Python crawler sidecar
  (`services/python-plugins/`) hosting the external `crawl4ai_crawler`,
  `scrapy_spider`, and (optional) `rerank_bge_local` plugins over the
  `ragdoll.plugin.v1.PluginRuntime` connect-rpc contract (ADR 0022;
  sandboxing rationale in ADR 0010). Only needed if those plugins are
  used.
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

### Building behind a Docker Hub proxy / air-gapped registry

Every Dockerfile in the repo (`infra/docker/{api,web,worker,file-watcher}.Dockerfile`
and `services/python-plugins/Dockerfile`) declares its base image as a
build ARG with the upstream default. Override per-build to pull from an
internal mirror — no Dockerfile edits required:

```bash
# Node-based images (api, worker, web build stage, file-watcher)
docker build \
  --build-arg NODE_BASE_IMAGE=registry.internal/library/node:22-alpine \
  -f infra/docker/api.Dockerfile -t ragdoll-api .

# web runtime stage uses a second ARG
docker build \
  --build-arg NODE_BASE_IMAGE=registry.internal/library/node:22-alpine \
  --build-arg NGINX_BASE_IMAGE=registry.internal/nginxinc/nginx-unprivileged:1.27-alpine \
  -f infra/docker/web.Dockerfile -t ragdoll-web .

# Python crawler sidecar
docker build \
  --build-arg PYTHON_BASE_IMAGE=registry.internal/library/python:3.12-slim \
  -f services/python-plugins/Dockerfile -t ragdoll-python-plugins .
```

`docker compose build` honours the same ARGs via `--build-arg`. For
rate-limited Docker Hub clusters, set these to your proxy's mirror path
in CI/CD and the upstream defaults stay out of the build entirely.

### HTTP/2 + native gRPC for external plugins (Phase B)

The python-plugins sidecar serves Connect HTTP/JSON + native gRPC + gRPC-Web
from one Hypercorn listener (see ADR
[0022](../adr/0022-connect-rpc-plugin-transport.md)). For the runtime's
default `connect` transport over HTTP/1.1, no extra cluster config is needed —
unary, server-streaming, and client-streaming all work over plain h1.

**Full-duplex bidi and `protocol: "grpc"` require HTTP/2 end-to-end.** Two
gotchas:

1. **Service `appProtocol: http2`.** The chart sets this on the python-plugins
   Service when `pythonPlugins.http2.enabled: true` (the default). Some
   older Service-mesh proxies (Linkerd ≤2.13, Istio ≤1.17) don't honor
   `appProtocol` and downgrade to HTTP/1.1 silently — `kubectl describe svc
   ragdoll-python-plugins` shows the field as set; verify with
   `grpcurl -plaintext <pod-ip>:8000 list` against a pod IP that bypasses
   the proxy to isolate. Flip `pythonPlugins.http2.enabled: false` if your
   mesh isn't ready; only native gRPC + full-duplex bidi callers degrade.
2. **OpenShift Routes need passthrough TLS + h2-via-ALPN.** The chart's
   `python-plugins-service.yaml` is **ClusterIP-only** (no Route) — the
   sidecar is intentionally internal. If you expose it externally for any
   reason, the Route must use `passthrough` termination so the h2 ALPN
   negotiation reaches the pod intact; `edge` termination terminates h2 at
   the router and re-encodes downstream as h1.

For plugin authors deploying their OWN external Connect server, mirror the
same pattern: `appProtocol: http2` on the Service, Hypercorn (Python) or
http2.createServer (Node) in the container, ClusterIP unless an inbound
mesh requires Route exposure.

## Python crawler sidecar (optional)

The `crawl4ai_crawler` / `scrapy_spider` plugins run in a separate Python
service, not in the worker (ADR 0010). It is only required if those
datasource plugins are used; skip it otherwise. The image is built from
`services/python-plugins/Dockerfile` and bundles a full headless Chromium.

> The local Compose stack (`infra/docker/docker-compose.yml`) already
> defines the `python-plugins` service and wires `PYTHON_PLUGIN_URL` /
> `PYTHON_PLUGIN_TIMEOUT_MS` into the API and worker. The Helm chart does
> **not** ship a `python-plugins` template yet — deploy it with the
> manifests below (or add an equivalent chart template) when enabling
> external crawlers in Kubernetes.

Deployment and Service (one replica is fine; the crawl4ai engine is
single-process per request):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ragdoll-python-plugins
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ragdoll-python-plugins
  template:
    metadata:
      labels:
        app: ragdoll-python-plugins
    spec:
      containers:
        - name: python-plugins
          image: "your-registry/ragdoll-python-plugins:0.1.0"
          ports:
            - containerPort: 8000
          env:
            - name: PORT
              value: "8000"
          readinessProbe:
            httpGet: { path: /healthz, port: 8000 }
            initialDelaySeconds: 30
          livenessProbe:
            httpGet: { path: /healthz, port: 8000 }
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 2Gi
---
apiVersion: v1
kind: Service
metadata:
  name: ragdoll-python-plugins
spec:
  selector:
    app: ragdoll-python-plugins
  ports:
    - port: 8000
      targetPort: 8000
```

**Resource / memory note.** A headless Chromium is memory-hungry and the
image is large and slow to pull/build (the first build downloads Chromium
plus OS libraries). Size requests/limits with headroom (start at ~1–2Gi
memory) and expect a slow first pull; give the readiness probe a generous
`initialDelaySeconds`.

**Wiring into the API and worker.** Set `PYTHON_PLUGIN_URL` (and
optionally `PYTHON_PLUGIN_TIMEOUT_MS`, default `300000`) on **both** the
API and worker so the loader registers the external plugins and the worker
can execute them. Add these to the shared secret/config consumed via
`envFrom`, or add explicit `env` entries to the api/worker Deployments:

```yaml
env:
  - name: PYTHON_PLUGIN_URL
    value: "http://ragdoll-python-plugins:8000"
  - name: PYTHON_PLUGIN_TIMEOUT_MS
    value: "300000"
```

A suggested set of values keys to add if you template this in the chart:
`pythonPlugins.enabled`, `pythonPlugins.replicas`,
`pythonPlugins.image.repository`/`tag`, `pythonPlugins.resources`, and
`pythonPlugins.url` (the value plumbed into `PYTHON_PLUGIN_URL`).

**Security (sidecar trust boundary).** Every plugin invocation
(`PluginRuntime.Execute` over Connect) carries resolved non-secret config
**and resolved secret values** for the node, so the sidecar is inside the
trust boundary: keep its Service cluster-internal (no Ingress, no public
LoadBalancer) and reachable only from the API/worker. It is a
network-facing crawler — its in-process SSRF guard is default-deny
(private/loopback/link-local/reserved blocked, scheme + domain
allowlists), but for a real multi-tenant deployment add a `NetworkPolicy`
that (a) restricts ingress to the API/worker pods and (b) constrains
egress (block RFC1918 / metadata IPs, allow only intended
crawl egress). Defense in depth: the application guard plus network
egress controls, not either alone.

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
- If the Python crawler sidecar is deployed, keep its Service
  cluster-internal and apply a `NetworkPolicy` for ingress (API/worker
  only) and egress (block private/metadata ranges) in addition to the
  built-in SSRF guard.
- Export OpenTelemetry to a secured collector.
- Enable Postgres backups and point-in-time recovery.
