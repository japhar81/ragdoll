# RAGdoll Python Plugins Service

A self-contained FastAPI service that hosts Python-only crawler plugins for the
RAGdoll platform. It speaks **EXTERNAL PLUGIN HTTP CONTRACT v1**: a TypeScript
transport client calls this HTTP server to execute a plugin and gets back a
normalized result envelope.

Plugins shipped:

| `plugin.id`        | Engine                       |
|--------------------|------------------------------|
| `crawl4ai_crawler` | crawl4ai `AsyncWebCrawler`   |
| `scrapy_spider`    | Scrapy (run in a subprocess) |

This directory is fully isolated from the Node/TS side. The only coupling is
the HTTP contract below.

## HTTP contract v1

- `GET /healthz` → `200 {"ok": true, "plugins": ["crawl4ai_crawler","scrapy_spider"]}`
- `POST /execute` with JSON body:

  ```json
  {
    "plugin": {"category": "...", "id": "...", "version": "..."},
    "node":   {"id": "...", "config": {}, "secrets": {}},
    "inputs": {},
    "config": {},
    "secrets": {},
    "context": {
      "requestId": "...", "executionId": "...", "tenantId": "...",
      "pipelineId": "...", "pipelineVersionId": "...", "environment": "...",
      "deadline": null,
      "resolvedConfig": {"values": {"<key>": {"value": "<any>"}}}
    }
  }
  ```

- **Success** → `200`:

  ```json
  { "outputs": {...}, "metadata": {...}, "usage": {...}, "artifacts": [ ... ] }
  ```

  (`metadata` / `usage` / `artifacts` included only when present.)

- **Failure** → `200 {"error": "<message>"}` for *expected* failures
  (unknown plugin, SSRF-blocked, bad config, malformed body). Truly
  unexpected exceptions surface as HTTP `500 {"error": ...}`. The TS client
  treats a 200 `{error}` **or** any non-2xx as a plugin failure.

Effective config is merged as `node.config` < `context.resolvedConfig.values`
< top-level `config` (last wins).

### Plugin configs

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

Output:
`{"outputs":{"documents":[{"url","title","markdown"|"text","metadata"}],"pageCount":N},"usage":{},"metadata":{"crawler":"crawl4ai"}}`

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

This is a multi-tenant crawler, so the default posture is **deny**. For every
target URL:

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

Tests use FastAPI's `TestClient` and require **no network, no browser, and no
Twisted reactor**. `crawl4ai`/`scrapy` are imported lazily inside the run
functions, and tests monkeypatch `run_crawl4ai` / `run_scrapy` plus inject a
fake DNS resolver. The dev deps (`pytest`, `pytest-asyncio`, `httpx`) plus
`fastapi`/`pydantic` are sufficient to run the suite.
