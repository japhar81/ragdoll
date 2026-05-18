"""Breadth-first multi-page crawl tests for ``crawl4ai_crawler``.

Offline: the ``run_crawl4ai`` seam is monkeypatched to return a small fake
site graph (no network/browser), and the SSRF resolver is faked. These tests
nail down the regression where ``maxPages:5`` only ever fetched the seed
(``pageCount == 1``).
"""

from __future__ import annotations

import app.plugins.crawl4ai_plugin as c4a
import app.safety as safety
from tests.conftest import make_request_body

# Seed links to 6 same-domain pages (one of them twice), 1 off-domain page,
# and 1 host that resolves to a private IP. Followed pages have no links so
# the crawl stays at depth 1.
SEED = "https://site.com/"
SITE = {
    "https://site.com/": {
        "title": "Home",
        "markdown": "# Home",
        "links": [
            "https://site.com/a",
            "https://site.com/b",
            "https://site.com/c",
            "https://site.com/d",
            "https://site.com/e",
            "https://site.com/f",
            "https://site.com/b#dup",          # duplicate of /b -> fetched once
            "https://site.com/a/",             # trailing slash dup of /a
            "https://other.com/x",             # off-domain
            "http://intranet.site.com/secret",  # resolves private -> SSRF block
        ],
    },
}
for _p in ("a", "b", "c", "d", "e", "f"):
    SITE[f"https://site.com/{_p}"] = {
        "title": _p.upper(),
        "markdown": f"# {_p}",
        "links": [],
    }
SITE["https://other.com/x"] = {"title": "X", "markdown": "x", "links": []}
SITE["http://intranet.site.com/secret"] = {
    "title": "secret",
    "markdown": "secret",
    "links": [],
}


def _resolver(host):
    # site.com (+subdomains) and other.com are public; intranet.* is private.
    if host.startswith("intranet."):
        return ["10.0.0.9"]
    return ["93.184.216.34"]


def _fake_site_seam():
    """A per-URL fake fetch: looks the URL up in SITE."""

    async def fake_run(url, cfg):
        page = SITE.get(url)
        if page is None:
            raise RuntimeError(f"no fake page for {url}")
        out = {
            "url": url,
            "title": page["title"],
            "metadata": {"title": page["title"]},
            "links": page["links"],
        }
        if cfg["extract"] == "markdown":
            out["markdown"] = page["markdown"]
        else:
            out["text"] = page["markdown"]
        return out

    return fake_run


def _crawl(client, monkeypatch, config):
    monkeypatch.setattr(c4a, "run_crawl4ai", _fake_site_seam())
    monkeypatch.setattr(safety, "system_resolver", _resolver)
    body = make_request_body("crawl4ai_crawler", config)
    r = client.post("/execute", json=body)
    assert r.status_code == 200
    return r.json()


def test_bfs_fetches_maxpages_not_just_seed(client, monkeypatch):
    """The core regression: maxPages:5 / maxDepth:1 yields 5 pages, not 1."""
    data = _crawl(
        client,
        monkeypatch,
        {"url": SEED, "maxPages": 5, "maxDepth": 1, "sameDomainOnly": True},
    )
    out = data["outputs"]
    assert out["pageCount"] == 5
    urls = [d["url"] for d in out["documents"]]
    # Seed first (BFS/FIFO), then same-domain links up to the cap.
    assert urls[0] == SEED
    assert all(u.startswith("https://site.com/") for u in urls)
    assert len(set(urls)) == 5  # all distinct
    assert data["metadata"]["pagesRequested"] == 5
    assert data["metadata"]["pagesFetched"] == 5
    # The cap is reached by the seed + first 4 same-domain links, so the
    # off-domain / private-IP links are never even popped (skipped == 0).
    # Their SSRF/same-domain filtering is asserted in the large-cap tests.
    assert data["metadata"]["skipped"] == 0


def test_bfs_visited_dedupe(client, monkeypatch):
    """A page linked twice (and via trailing-slash/fragment) is fetched once."""
    data = _crawl(
        client,
        monkeypatch,
        {"url": SEED, "maxPages": 20, "maxDepth": 1, "sameDomainOnly": True},
    )
    urls = [d["url"] for d in data["outputs"]["documents"]]
    # 6 unique same-domain children + the seed = 7; /b and /a appear once.
    assert urls.count("https://site.com/b") == 1
    assert urls.count("https://site.com/a") == 1
    assert data["outputs"]["pageCount"] == 7


def test_bfs_off_domain_skipped_when_same_domain_only(client, monkeypatch):
    data = _crawl(
        client,
        monkeypatch,
        {"url": SEED, "maxPages": 20, "maxDepth": 1, "sameDomainOnly": True},
    )
    urls = [d["url"] for d in data["outputs"]["documents"]]
    assert "https://other.com/x" not in urls


def test_bfs_off_domain_followed_when_same_domain_off(client, monkeypatch):
    data = _crawl(
        client,
        monkeypatch,
        {
            "url": SEED,
            "maxPages": 20,
            "maxDepth": 1,
            "sameDomainOnly": False,
        },
    )
    urls = [d["url"] for d in data["outputs"]["documents"]]
    assert "https://other.com/x" in urls
    # The private-IP link is STILL blocked by the SSRF guard even though
    # sameDomainOnly is off (defense holds on every followed link).
    assert "http://intranet.site.com/secret" not in urls


def test_bfs_private_ip_link_blocked_by_ssrf(client, monkeypatch):
    """A followed link that resolves to a private IP is dropped, not fatal."""
    data = _crawl(
        client,
        monkeypatch,
        {
            "url": SEED,
            "maxPages": 20,
            "maxDepth": 1,
            "sameDomainOnly": False,
        },
    )
    urls = [d["url"] for d in data["outputs"]["documents"]]
    assert "http://intranet.site.com/secret" not in urls
    # Run still succeeded with the public pages.
    assert data["outputs"]["pageCount"] >= 7
    assert data["metadata"]["skipped"] >= 1


def test_bfs_depth_zero_only_seed(client, monkeypatch):
    data = _crawl(
        client,
        monkeypatch,
        {"url": SEED, "maxPages": 20, "maxDepth": 0, "sameDomainOnly": True},
    )
    assert data["outputs"]["pageCount"] == 1
    assert data["outputs"]["documents"][0]["url"] == SEED


def test_bfs_depth_one_seed_plus_children(client, monkeypatch):
    data = _crawl(
        client,
        monkeypatch,
        {"url": SEED, "maxPages": 20, "maxDepth": 1, "sameDomainOnly": True},
    )
    assert data["outputs"]["pageCount"] == 7  # seed + 6 unique children


def test_bfs_envelope_shape_unchanged(client, monkeypatch):
    data = _crawl(
        client,
        monkeypatch,
        {"url": SEED, "maxPages": 5, "maxDepth": 1},
    )
    assert set(data.keys()) == {"outputs", "metadata", "usage"}
    assert set(data["outputs"].keys()) == {"documents", "pageCount"}
    assert data["usage"] == {}
    assert data["metadata"]["crawler"] == "crawl4ai"
    for doc in data["outputs"]["documents"]:
        assert set(doc.keys()) == {"url", "title", "markdown", "metadata"}


def test_bfs_demo_seed_yields_five(client, monkeypatch):
    """web-crawl-demo.yaml: maxDepth:1 maxPages:5 -> seed + 4 children = 5."""
    data = _crawl(
        client,
        monkeypatch,
        {
            "url": SEED,
            "maxPages": 5,
            "maxDepth": 1,
            "sameDomainOnly": True,
            "extract": "markdown",
            "timeoutMs": 60000,
        },
    )
    assert data["outputs"]["pageCount"] == 5
