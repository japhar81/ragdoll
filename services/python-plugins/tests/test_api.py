"""HTTP contract tests using FastAPI TestClient. No network/browser/reactor.

The crawl seams (``run_crawl4ai`` / ``run_scrapy``) are monkeypatched and the
SSRF resolver is patched to a fake, so nothing leaves the process.
"""

from __future__ import annotations

import app.plugins.crawl4ai_plugin as c4a
import app.plugins.scrapy_plugin as scr
import app.safety as safety
from tests.conftest import make_request_body

PUBLIC = ["93.184.216.34"]


def _fake_resolver(host):
    # Everything resolves to a public address in API tests.
    return PUBLIC


# --------------------------------------------------------------------------- #
# /healthz
# --------------------------------------------------------------------------- #
def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["plugins"] == ["crawl4ai_crawler", "scrapy_spider"]


# --------------------------------------------------------------------------- #
# crawl4ai happy path
# --------------------------------------------------------------------------- #
def test_execute_crawl4ai_happy_path(client, monkeypatch):
    captured = {}

    async def fake_run(urls, cfg):
        captured["urls"] = urls
        captured["cfg"] = cfg
        return [
            {
                "url": "https://example.com/",
                "title": "Example",
                "markdown": "# Example\nhello",
                "metadata": {"title": "Example"},
            }
        ]

    monkeypatch.setattr(c4a, "run_crawl4ai", fake_run)
    monkeypatch.setattr(safety, "system_resolver", _fake_resolver)

    body = make_request_body(
        "crawl4ai_crawler", {"url": "https://example.com/"}
    )
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    data = r.json()

    # Envelope shape exactly per contract.
    assert set(data.keys()) == {"outputs", "metadata", "usage"}
    assert data["metadata"] == {"crawler": "crawl4ai"}
    assert data["usage"] == {}
    assert data["outputs"]["pageCount"] == 1
    doc = data["outputs"]["documents"][0]
    assert doc["url"] == "https://example.com/"
    assert doc["title"] == "Example"
    assert doc["markdown"] == "# Example\nhello"
    assert doc["metadata"] == {"title": "Example"}

    # Config defaults applied.
    assert captured["cfg"]["maxPages"] == 10
    assert captured["cfg"]["maxDepth"] == 1
    assert captured["cfg"]["sameDomainOnly"] is True
    assert captured["cfg"]["extract"] == "markdown"
    assert captured["cfg"]["timeoutMs"] == 60000


def test_execute_crawl4ai_text_extract(client, monkeypatch):
    async def fake_run(urls, cfg):
        return [
            {
                "url": "https://example.com/",
                "title": "T",
                "text": "plain text body",
                "metadata": {},
            }
        ]

    monkeypatch.setattr(c4a, "run_crawl4ai", fake_run)
    monkeypatch.setattr(safety, "system_resolver", _fake_resolver)

    body = make_request_body(
        "crawl4ai_crawler",
        {"urls": ["https://example.com/"], "extract": "text"},
    )
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    doc = r.json()["outputs"]["documents"][0]
    assert doc["text"] == "plain text body"
    assert "markdown" not in doc


def test_execute_crawl4ai_missing_url(client, monkeypatch):
    monkeypatch.setattr(safety, "system_resolver", _fake_resolver)
    body = make_request_body("crawl4ai_crawler", {})
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    assert "config.url" in r.json()["error"]


def test_execute_crawl4ai_ssrf_blocked(client, monkeypatch):
    def private_resolver(host):
        return ["10.0.0.9"]

    monkeypatch.setattr(safety, "system_resolver", private_resolver)
    body = make_request_body(
        "crawl4ai_crawler", {"url": "http://intranet.example.com/"}
    )
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    assert "non-public" in r.json()["error"]


def test_execute_crawl4ai_ssrf_bypass(client, monkeypatch):
    async def fake_run(urls, cfg):
        return [{"url": urls[0], "title": "", "markdown": "ok", "metadata": {}}]

    def private_resolver(host):
        return ["10.0.0.9"]

    monkeypatch.setattr(c4a, "run_crawl4ai", fake_run)
    monkeypatch.setattr(safety, "system_resolver", private_resolver)
    body = make_request_body(
        "crawl4ai_crawler",
        {"url": "http://intranet.example.com/", "allowPrivateNetworks": True},
    )
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    assert r.json()["outputs"]["pageCount"] == 1


# --------------------------------------------------------------------------- #
# scrapy happy path
# --------------------------------------------------------------------------- #
def test_execute_scrapy_happy_path(client, monkeypatch):
    captured = {}

    def fake_run(start_urls, cfg):
        captured["urls"] = start_urls
        captured["cfg"] = cfg
        return [
            {
                "url": "https://example.com/a",
                "title": "A",
                "text": "body a",
                "metadata": {"status": 200},
            },
            {
                "url": "https://example.com/b",
                "title": "B",
                "text": "body b",
                "metadata": {"status": 200},
            },
        ]

    monkeypatch.setattr(scr, "run_scrapy", fake_run)
    monkeypatch.setattr(safety, "system_resolver", _fake_resolver)

    body = make_request_body(
        "scrapy_spider",
        {
            "startUrls": ["https://example.com/a"],
            "allowedDomains": ["example.com"],
        },
    )
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    data = r.json()
    assert set(data.keys()) == {"outputs", "metadata", "usage"}
    assert data["metadata"] == {"crawler": "scrapy"}
    assert data["outputs"]["pageCount"] == 2
    assert data["outputs"]["documents"][1]["url"] == "https://example.com/b"
    # defaults applied
    assert captured["cfg"]["maxPages"] == 20
    assert captured["cfg"]["maxDepth"] == 2


def test_execute_scrapy_missing_start_urls(client, monkeypatch):
    monkeypatch.setattr(safety, "system_resolver", _fake_resolver)
    body = make_request_body("scrapy_spider", {"allowedDomains": ["x.com"]})
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    assert "startUrls" in r.json()["error"]


# --------------------------------------------------------------------------- #
# error cases
# --------------------------------------------------------------------------- #
def test_unknown_plugin(client):
    body = make_request_body("does_not_exist", {})
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    assert r.json() == {"error": "unknown plugin does_not_exist"}


def test_malformed_body_not_json(client):
    r = client.post(
        "/execute",
        content=b"this is not json",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 200
    assert "invalid JSON" in r.json()["error"]


def test_malformed_body_missing_plugin(client):
    r = client.post("/execute", json={"node": {}, "inputs": {}})
    assert r.status_code == 200
    assert "invalid request body" in r.json()["error"]


def test_resolved_config_merge(client, monkeypatch):
    """context.resolvedConfig.values feed effective_config; top-level wins."""
    captured = {}

    async def fake_run(urls, cfg):
        captured["cfg"] = cfg
        return [{"url": urls[0], "title": "", "markdown": "x", "metadata": {}}]

    monkeypatch.setattr(c4a, "run_crawl4ai", fake_run)
    monkeypatch.setattr(safety, "system_resolver", _fake_resolver)

    body = make_request_body("crawl4ai_crawler", {"url": "https://example.com/"})
    body["context"]["resolvedConfig"]["values"] = {
        "maxPages": {"value": 3},
        "extract": {"value": "text"},
    }
    # top-level config overrides resolvedConfig for extract
    body["config"]["extract"] = "markdown"

    r = client.post("/execute", json=body)
    assert r.status_code == 200
    assert captured["cfg"]["maxPages"] == 3  # from resolvedConfig
    assert captured["cfg"]["extract"] == "markdown"  # top-level wins
