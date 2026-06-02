# ADR 0010: External Python Plugins over a Stable HTTP Contract (Crawler Sidecar)

## Status

Accepted. **Wire contract superseded by ADR
[0022](./0022-connect-rpc-plugin-transport.md) (Phase A/B, 2026-06-01).**
The out-of-process-sidecar motivation (sandbox headless Chromium / Scrapy
away from the worker) is unchanged and still load-bearing. The HTTP
contract v1 described below is deprecated — the sidecar dual-hosts it
during cutover, but new plugins (and the in-tree `rerank_bge_local`
consumer) target the `ragdoll.plugin.v1.PluginRuntime` Connect service
instead. The `ExternalPluginEndpoint.mode: "http" | "grpc"` union and
`buildExternalRequestBody` helper referenced here no longer exist; see
ADR 0022 for the replacement.

## Context

RAGdoll's first-party plugins are in-process TypeScript modules
auto-discovered by `@ragdoll/plugin-loader` (ADR 0001, ADR 0008). Some
capabilities cannot reasonably live in the Node worker:

- **Crawl4AI** drives a headless Chromium via Playwright; **Scrapy** runs
  a Twisted reactor (single-run-per-process, asyncio-hostile). Both are
  Python-only, heavy, and would conflict with the worker's runtime.
- Bundling a browser and Twisted into the worker image inflates its size,
  couples crawler upgrades to control-plane releases, and gives a
  network-facing crawler the worker's blast radius.

`@ragdoll/plugin-sdk` already modeled an external transport seam
(`RegisteredPlugin.mode: "external"`, `ExternalPluginEndpoint`) that was
previously scaffold-only. We need real Python crawlers without dragging
their dependencies into the worker, while keeping the builder/UX, config,
and secret model identical to in-process plugins.

## Decision

**Support external plugins over a stable HTTP contract; run the Python
crawlers as a separate sidecar service, not in the Node worker.**

**Wire contract v1.** `@ragdoll/plugin-sdk` implements the previously
scaffolded `mode: "external"` HTTP transport in `executeRegisteredPlugin`:
`POST {baseUrl}{executePath ?? "/execute"}` with a JSON-safe body
(`plugin`, `node`, `inputs`, `config`, `secrets`, and a reduced `context`
where `deadline` is an ISO string or `null` and `resolvedConfig` is
collapsed to `{ values: { <key>: { value } } }` — no sensitivity/secret
metadata leaves the control plane). A 200 `{ outputs, metadata?, usage?,
artifacts? }` is success; a 200 `{ "error" }` is an *expected* plugin
failure; any non-2xx is an *unexpected* failure. Health is
`GET {baseUrl}{healthPath ?? "/healthz"}` via `externalPluginHealth`. Both
calls use an `AbortController` timeout (`endpoint.timeoutMs`, default
300000 ms — crawls are slow). The exact body is built by the standalone
`buildExternalRequestBody` so the same shape can be asserted on both
sides. gRPC (`endpoint.mode: "grpc"`) is **not implemented** and fails
fast with a clear error.

**Python sidecar.** `services/python-plugins/` is a self-contained FastAPI
service that speaks contract v1 (`GET /healthz`, `POST /execute`) and
hosts two datasource plugins: `crawl4ai_crawler` (Crawl4AI /
Playwright-Chromium) and `scrapy_spider` (Scrapy in a spawned
`multiprocessing` child, since a Twisted reactor cannot share the uvicorn
process). It has no Node coupling beyond the HTTP contract. The Python
environment is managed with **Poetry** (`pyproject.toml` + committed
`poetry.lock`); Chromium is installed at image build via
`playwright install --with-deps chromium`.

**Builder integration is unchanged.** `@ragdoll/plugin-loader` registers
the two crawler manifests as `mode: "external"` plugins **only when
`PYTHON_PLUGIN_URL` is set** (no-op otherwise, so offline/default behavior
is byte-for-byte unchanged). The manifests carry full `configSchema` /
`ui.formHints` / `paletteGroup: "Crawling"`, so they surface in the visual
builder with schema-driven forms exactly like in-process plugins
(ADR 0008). Optional `PYTHON_PLUGIN_TIMEOUT_MS` overrides the endpoint
timeout (default 300000 ms).

**SSRF security stance.** A network-facing crawler in a multi-tenant
platform is dangerous, so `app/safety.py` is **default-deny**: scheme must
be `http`/`https`; host must be present; `allowedDomains` /
`sameDomainOnly` allowlisting; *every* resolved address is checked and the
URL is blocked if any is private / loopback / link-local / multicast /
reserved / unspecified (including IPv4-mapped IPv6, a common rebinding
bypass). Per-execution `maxPages` / `maxDepth` / `timeoutMs` caps apply.
A tenant can opt out only via explicit `allowPrivateNetworks`. Because
resolved non-secret config and **resolved secret values cross the wire**
in the `POST /execute` body, the sidecar is a trust boundary: it MUST be
cluster-internal and reachable only by the API/worker, never exposed
publicly.

## Consequences

- Real browser-driven and Scrapy crawlers are available as first-class
  builder nodes without polluting the worker image with Chromium/Twisted;
  the crawler service scales and upgrades independently.
- Operational cost: one extra service to deploy, health-check, and
  network-isolate. The image is intentionally large and slow to build —
  the first build downloads a full headless Chromium plus OS libraries.
  It is deliberately excluded from the fast `make refresh` path.
- The HTTP contract is explicitly **v1**. The Python models and the SDK
  wire builder must evolve together; there is no negotiation/versioning
  beyond the `v1` label, so a breaking change requires coordinated
  releases of both sides.
- gRPC transport remains **unimplemented**; only HTTP works today.
- Resolved secrets traverse the wire to the sidecar, so the sidecar is
  inside the trust boundary. In a real multi-tenant deployment, egress
  controls / a `NetworkPolicy` around the crawler are strongly
  recommended in addition to the in-process SSRF guard.
- The SSRF guard validates **seed** URLs up-front; for `crawl4ai_crawler`
  it also enforces `sameDomainOnly` against seed hosts, but deep
  link-following inside the crawler engines relies on the engine's own
  depth/domain limits plus these caps — it is not a per-fetched-URL proxy.
  Treat `allowedDomains` + `maxDepth`/`maxPages` as the real containment
  knobs for untrusted targets.
