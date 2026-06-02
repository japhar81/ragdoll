# RAGdoll Python Plugins Service

A self-contained ASGI service that hosts Python-only crawler plugins for the
RAGdoll platform. Speaks the
[`ragdoll.plugin.v1.PluginRuntime`](../../proto/plugin.proto) connect-rpc
contract (ADR [0022](../../docs/adr/0022-connect-rpc-plugin-transport.md))
from a single Hypercorn listener.

The two-line summary:

| Route                                            | Purpose                                              |
|--------------------------------------------------|------------------------------------------------------|
| `/ragdoll.plugin.v1.PluginRuntime/*`             | Connect HTTP/JSON + gRPC + gRPC-Web                  |
| `GET /healthz`                                   | 5-line Starlette shim for k8s liveness probes        |

The dual-host of `POST /execute` from the Phase B cutover was removed
(2026-06-01) — every caller is on the Connect wire.

`app/connect_bridge.py` translates the `ExecuteRequest` proto into the
pydantic `ExecuteRequest` the handlers already accept (Struct ⇄ dict via
`MessageToDict` / `Struct.update`) so the per-plugin code is wire-agnostic.

Plugins shipped:

| `plugin.id`         | Engine                       |
|---------------------|------------------------------|
| `crawl4ai_crawler`  | crawl4ai `AsyncWebCrawler`   |
| `scrapy_spider`     | Scrapy (run in a subprocess) |
| `rerank_bge_local`  | cross-encoder (sentence-transformers; optional `[reranker]` extra) |

The directory is fully isolated from the Node/TS side. The only coupling
is the proto contract.

## Calling it

The TypeScript runtime calls this sidecar via
`@ragdoll/plugin-sdk/transport` (`executeRegisteredPlugin` →
`executeExternalConnect`); plugin authors targeting Python should follow
[`docs/developer/plugin-author-quickstart.md` sections 9-14](../../docs/developer/plugin-author-quickstart.md#plugin-author-quickstart-python).
The runtime emits `PluginRuntime.Execute` (unary) by default; pipelines
with `manifest.streaming: true` route through `ExecuteServerStream`.

Quick smoke probes (from inside the docker network):

```sh
# Liveness (k8s probe-style)
docker exec ragdoll-api-1 wget -qO- http://python-plugins:8000/healthz
# → {"ok":true,"plugins":["crawl4ai_crawler","rerank_bge_local","scrapy_spider"]}

# Capability via Connect Health RPC
docker exec ragdoll-api-1 sh -c '
  wget -qO- --post-data="{}" --header="Content-Type: application/json" \
    http://python-plugins:8000/ragdoll.plugin.v1.PluginRuntime/Health'
# → {"ok": true, "plugins": ["crawl4ai_crawler","rerank_bge_local","scrapy_spider"], "message": ""}
```

## Effective config merge

`node.config` < `context.resolvedConfig.values` < top-level `config`
(last wins). Same semantics inside every handler — the merge happens in
`app.models.ExecuteRequest.effective_config()` which is called by all
three plugin handlers.

---

## Plugin configs

**`crawl4ai_crawler`**

| key                   | default      |
|-----------------------|--------------|
| `url` / `urls`        | (one required) |
| `maxPages`            | `10`         |
| `maxDepth`            | `1`          |
| `sameDomainOnly`      | `true`       |
| `allowedDomains`      | `[]`         |
| `extract`             | `"markdown"` (`"markdown"` \| `"text"`) |
| `timeoutMs`           | `60000`      |
| `allowPrivateNetworks`| `false`      |

**Breadth-first crawl.** The plugin does *not* fetch only the seed(s). It
runs a BFS:

1. The frontier is a FIFO queue of `(url, depth)` seeded from `url` / `urls`
   at depth `0`. A `visited` set of *normalized* URLs (fragment stripped, a
   single trailing `/` dropped) guarantees each page is fetched **once** —
   `a`, `a/` and `a#x` collapse to one fetch.
2. URLs are popped FIFO (seed first, then its links, breadth-first) until
   `maxPages` documents are collected, the frontier drains, or the
   wall-clock exceeds `timeoutMs`.
3. **Every** popped URL is re-checked by the SSRF guard *before* it is
   fetched (scheme, `allowedDomains`, `sameDomainOnly` vs. its seed host,
   private-network deny, `allowPrivateNetworks` override). A blocked or
   duplicate link is **skipped** — it never fails the whole run. A page
   whose fetch raises is likewise skipped. `metadata.skipped` counts these.
4. If the page's depth `< maxDepth`, its anchors (crawl4ai's `links`,
   resolved relative→absolute against the page URL, filtered to http/https)
   are enqueued at `depth+1` if not already visited.
5. If **no** seed URL survives the SSRF guard the run is fatal and returns
   `{"error": ...}` per the contract; otherwise a fully-failed *followed*
   page is just skipped.

So with the shipped `web-crawl-demo.yaml` (`maxDepth:1`, `maxPages:5`,
`sameDomainOnly:true`): the seed is fetched, then up to 4 same-domain links
from it, for `pageCount == 5` (not `1`). `maxDepth:0` fetches only the
seed(s).

Output:
`{"outputs":{"documents":[{"url","title","markdown"|"text","metadata"}],"pageCount":N},"usage":{},"metadata":{"crawler":"crawl4ai","pagesRequested":maxPages,"pagesFetched":N,"skipped":S}}`

**`scrapy_spider`**

| key                   | default |
|-----------------------|---------|
| `startUrls`           | (required, list) |
| `allowedDomains`      | `[]`    |
| `maxPages`            | `20`    |
| `maxDepth`            | `2`     |
| `allowPrivateNetworks`| `false` |

Output: same `documents` shape with `"metadata":{"crawler":"scrapy"}`.

## SSRF guard (`app/safety.py`)

This is a multi-tenant crawler, so the default posture is **deny**. The guard
runs on **every** URL the BFS is about to fetch — seeds *and* links discovered
on crawled pages — so a hostile page cannot pivot the crawler onto a private
address or off-domain target. For every such URL:

- Scheme must be `http` or `https` (no `file:`, `ftp:`, `gopher:`, `data:`…).
- Host must be present.
- If `allowedDomains` is set, host must equal or be a subdomain of one entry.
- If `sameDomainOnly` (crawl4ai default `true`), host must match a seed host.
- Host is resolved (literal IPs are checked directly). **Every** resolved
  address is checked; if *any* is private / loopback / link-local / multicast
  / reserved / unspecified (incl. IPv4-mapped IPv6), the URL is **blocked**
  unless `config.allowPrivateNetworks` is `true`.
- Crawl limits (`maxPages`, `maxDepth`, `timeoutMs`) are enforced.

The resolver is injectable, so it is fully unit-tested offline (no DNS).

## How Scrapy is run

Scrapy drives a Twisted reactor, which can only run once per process and
clashes with uvicorn's asyncio loop. The spider therefore runs in a **child
process** (`multiprocessing` `spawn` context) via a `CrawlerProcess`; scraped
items are streamed to a temp JSONL file the parent reads back. The parent
joins with a timeout derived from `timeoutMs` and terminates the child if it
overruns. `scrapy` is imported lazily inside the child entry point only.

## Run it

```bash
cd services/python-plugins
poetry install            # poetry lock + install (network needed)
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
# or:
poetry run serve          # honors HOST (default 0.0.0.0) and PORT (default 8000)
# or:
make serve                # make test
```

Environment:

- `PORT` — listen port, default `8000`.
- `HOST` — bind host, default `0.0.0.0`.

> **Browser dependency:** `crawl4ai` needs a Chromium browser. Run
> `playwright install chromium` once in the runtime image. This is handled at
> image build time by the Docker/k8s agent — it is **not** required for unit
> tests.

`poetry lock` was generated successfully (committed `poetry.lock`).
`poetry lock && poetry install` also runs at image build by the Docker agent.

## Tests

```bash
cd services/python-plugins
poetry run pytest
```

Tests use a small `FakeClient` (defined in `tests/conftest.py`) that calls
the HANDLERS dispatch directly without going through HTTP. It preserves the
ergonomics of `client.post("/execute", json=body)` / `client.get("/healthz")`
the legacy FastAPI TestClient gave us, so the per-plugin unit tests didn't
need to be rewritten when the FastAPI `/execute` route was removed. Wire
fidelity (the actual Connect protocol round-trip) is covered by
`tests/e2e/cross-language-plugin.e2e.test.ts` on the Node side, which hits
the running sidecar container.

`crawl4ai`/`scrapy` are imported lazily inside the run functions, so tests
require **no network, no browser, and no Twisted reactor** — monkeypatch
`run_crawl4ai` / `run_scrapy` + inject a fake DNS resolver. The dev deps
(`pytest`, `pytest-asyncio`, `pydantic`) are sufficient to run the suite.
