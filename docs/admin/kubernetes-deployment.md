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

### HTTP/2 + native gRPC for external plugins

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

## Plugins on OpenShift / OKD

Two ways to get custom plugin code into a cluster:

- **`git://` (or `https://`) source** — the loader clones from your internal
  git server at a pinned ref. Nothing to bake into the image. Preferred when
  the cluster can reach your git server.
- **`file://` source** — the plugin repo is baked into the api/worker image at
  build time and the loader clones it from the local filesystem. Use this in
  air-gapped clusters, or where the pods must not egress to git.

Both are the same code path: **a plugin source is always a git repo.** The
loader runs `git ls-remote` to resolve `ref` → sha, then clones that sha into
a content-addressed cache. This is the single biggest gotcha with `file://` —
a plain directory of `.ts` files is **not** enough. The path must contain a
`.git` dir and the ref must exist in it.

The repo layout the loader expects, with `subpath: "plugins"`:

```
custom-plugins/            <- git repo root (file:///opt/ragdoll-plugins)
└── plugins/               <- `subpath`; scanned for plugin modules
    ├── index.ts           <- exports `manifest` + `execute`
    └── package.json       <- optional; if present, deps are installed here
```

Give that `package.json` a `"type": "module"` — without it Node reparses each
`.ts` module and logs a `MODULE_TYPELESS_PACKAGE_JSON` warning per load:

```json
{ "name": "custom-plugins", "version": "1.0.0", "type": "module",
  "dependencies": { "ms": "^2.1.3" } }
```

### 1. Bake the repo into the image

OpenShift's restricted SCC runs the container as an **arbitrary UID** (e.g.
`1000680000`) that is *not* in `/etc/passwd`, but **is** in group `0`. So
anything the pod must read has to be group-`0` readable — that's the whole
trick, and it's why the `chgrp -R 0` / `chmod -R g=u` pair below is not
optional.

```dockerfile
# Containerfile.custom — your image, FROM the RAGdoll image (api and worker
# share one image; they differ only in the command the chart runs).
FROM registry.example.com/ragdoll:0.2.0

# Copy the plugin repo INCLUDING its .git dir — the loader clones from it.
# (A `git clone --bare` of your repo also works and is smaller; point the
# file:// URL at the bare repo path.)
COPY ./custom-plugins /opt/ragdoll-plugins

# Arbitrary-UID readability: group 0 gets whatever the owner has. This is the
# load-bearing step — without it the assigned UID cannot read the repo.
RUN chgrp -R 0 /opt/ragdoll-plugins && \
    chmod -R g=u /opt/ragdoll-plugins
```

Build with buildah/podman, push to your internal registry, and point
`image.repository` (+ `image.tag`) at it in values. The chart runs the same
image for api and worker, so one build covers both.

The plugin working copies and npm's cache are **not** written to
`/opt/ragdoll-plugins` — that directory stays read-only. They go to the
plugin-cache volume (below), so group-`0` **read** access is all you need.

### 2. The plugin cache volume (already on by default)

`npm ci`/`npm install` runs for any plugin with a `package.json`. npm derives
its cache from `$HOME`, and an arbitrary UID with no passwd entry gets
`$HOME=/` — so npm tries to `mkdir /.npm` on the root filesystem and dies with
`EACCES`. The loader therefore pins its npm cache *under the plugin cache
root*, and the chart mounts a writable volume there for both api and worker:

```yaml
pluginCache:
  enabled: true                        # default
  path: /var/cache/ragdoll/plugins     # RAGDOLL_PLUGIN_CACHE_DIR
  sizeLimit: 2Gi                       # caps the clone + every node_modules
  medium: ""                           # "Memory" for a tmpfs
```

This is the default, so **there is nothing to configure** — it is called out
only because it is what makes `readOnlyRootFilesystem: true` viable, and
because raising `sizeLimit` is the fix if a plugin with a heavy dependency
tree fills the volume. Do not set `NPM_CONFIG_CACHE` yourself unless you have
a reason to; the loader picks a writable location on its own.

### 3. Register the source

`file://` takes an absolute path — note the three slashes (`file://` + `/opt`):

```sh
curl -sS -X POST https://ragdoll.example.com/api/plugins/sources \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
        "id": "custom",
        "gitUrl": "file:///opt/ragdoll-plugins",
        "ref": "main",
        "subpath": "plugins",
        "displayName": "Custom plugins",
        "host": "worker"
      }'
```

- `ref` — branch, tag, or commit-ish. Must exist in the baked repo. If you
  bake a detached checkout with no branch, pin `ref` to the **commit sha**.
- `subpath` — directory inside the repo to scan; omit for the repo root.
- `host` — `worker` for TypeScript plugins (in-process), `sidecar` for Python
  ones (pushed to the python-plugins sidecar).

The same source can be created from the UI (Plugins → Sources), which is why
`file://` shows up as an option there.

Then refresh (or restart the pods) and confirm the source loaded:

```sh
curl -sS https://ragdoll.example.com/api/plugins/sources \
  -H "authorization: Bearer $TOKEN" |
  jq '.sources[] | {id, status, pluginCount, errorStage, error}'
```

`status` is `loaded` / `failed`; on a failure `errorStage` names the stage that
broke it — `resolve`, `clone`, `install`, `verify`, or `import` — which is
usually enough to tell a bad `ref` (`resolve`) from a dependency problem
(`install`) without reading any logs.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `npm error code EACCES … mkdir /.npm` | Pre-`0.2.0` image. The loader now pins the npm cache under `RAGDOLL_PLUGIN_CACHE_DIR`; upgrade. Only shows up for plugins that actually have dependencies. |
| `ref "main" not found on file:///opt/...` | The baked path isn't a git repo (no `.git`), or the branch wasn't included in the copy. Bake the repo, not just the files. |
| `Permission denied` reading `/opt/ragdoll-plugins` | Missing the `chgrp -R 0` + `chmod -R g=u` step — the assigned UID reaches the files only through group `0`. |
| Install fails with `ENOSPC` | `pluginCache.sizeLimit` too small for the dependency tree; raise it. |
| Plugin loads but `import` fails with `ERR_MODULE_NOT_FOUND` | The plugin has a dependency but no `package.json` in the scanned `subpath`, so no install ran. |
| `Directory import '…' is not supported` at `import` stage | Pre-`0.2.0` image: a `subpath` pointing at a directory wasn't resolved to an entry file. Upgrade. The loader now resolves `<subpath>/` to its `package.json` main/exports, then `index.js`/`index.ts`. Ensure the scanned directory actually has one of those. |

### A note on `runAsNonRoot` (vanilla Kubernetes)

The RAGdoll images declare no `USER`, so they would run as root if the runtime
let them. On OpenShift this is a non-issue — the SCC assigns an arbitrary
non-root UID and `containerSecurityContext.runAsNonRoot: true` is satisfied.
On **vanilla Kubernetes** nothing assigns one, so the kubelet refuses the pod
(*"container has runAsNonRoot and image will run as root"*). Pin a UID there:

```yaml
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1001        # any non-zero UID; not needed on OpenShift/OKD
```

If you bake your own image (above), setting `USER 1001` in it has the same
effect and is the cleaner fix.

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
