"""``crawl4ai_crawler`` plugin handler.

Performs a **breadth-first** crawl: starting from the seed ``url`` / ``urls``
it follows same-page links until ``maxPages`` documents are collected, the
frontier drains, or the wall-clock exceeds ``timeoutMs``. Every followed URL
is re-checked by the SSRF guard before it is fetched (this is a multi-tenant
crawler, so a malicious page must not be able to pivot the crawler onto a
private address or off-domain target).

All real crawl I/O lives in :func:`run_crawl4ai`, which lazily imports
``crawl4ai`` *inside* the function and fetches exactly one URL. Tests
monkeypatch :func:`run_crawl4ai` (the module attribute) so collection never
imports playwright/crawl4ai and can supply a per-URL fake site graph.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import time
from collections import deque
from typing import Any, Dict, List, Tuple
from urllib.parse import urldefrag, urljoin, urlsplit

from app.safety import SafetyPolicy, SSRFError

PLUGIN_ID = "crawl4ai_crawler"

DEFAULTS: Dict[str, Any] = {
    "maxPages": 10,
    "maxDepth": 1,
    "sameDomainOnly": True,
    "allowedDomains": [],
    "extract": "markdown",
    "timeoutMs": 60_000,
    "allowPrivateNetworks": False,
}


def _resolve_config(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = {**DEFAULTS, **(config or {})}

    urls: List[str] = []
    if cfg.get("url"):
        urls.append(str(cfg["url"]))
    if cfg.get("urls"):
        if not isinstance(cfg["urls"], (list, tuple)):
            raise ValueError("config.urls must be a list of strings")
        urls.extend(str(u) for u in cfg["urls"])
    if not urls:
        raise ValueError("crawl4ai_crawler requires config.url or config.urls")

    extract = cfg.get("extract", "markdown")
    if extract not in ("markdown", "text"):
        raise ValueError("config.extract must be 'markdown' or 'text'")

    cfg["_urls"] = urls
    cfg["extract"] = extract
    return cfg


def _normalize(url: str) -> str:
    """Canonicalize a URL for the ``visited`` set.

    Drops the ``#fragment`` and a single trailing ``/`` on the path so that
    ``a/``, ``a`` and ``a#x`` are treated as the same page (fetched once).
    """
    no_frag, _ = urldefrag(url)
    parts = urlsplit(no_frag)
    path = parts.path
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    rebuilt = parts._replace(path=path)
    return rebuilt.geturl()


def _extract_links(page: Dict[str, Any], base_url: str) -> List[str]:
    """Pull outbound links from a fetched page and absolutize them.

    crawl4ai's result exposes anchors via ``links`` (a list, or a dict like
    ``{"internal": [...], "external": [...]}`` whose entries are either strings
    or ``{"href": ...}`` dicts). We accept all of those shapes plus a plain
    ``hrefs`` list, resolve relative refs against ``base_url``, and keep only
    http/https targets. SSRF/visited filtering happens in the BFS loop.
    """
    raw = page.get("links")
    if raw is None:
        raw = page.get("hrefs")

    candidates: List[Any] = []
    if isinstance(raw, dict):
        for group in raw.values():
            if isinstance(group, (list, tuple)):
                candidates.extend(group)
    elif isinstance(raw, (list, tuple)):
        candidates.extend(raw)

    out: List[str] = []
    seen: set[str] = set()
    for item in candidates:
        if isinstance(item, dict):
            href = item.get("href") or item.get("url")
        else:
            href = item
        if not href or not isinstance(href, str):
            continue
        absolute = urljoin(base_url, href.strip())
        scheme = urlsplit(absolute).scheme.lower()
        if scheme not in ("http", "https"):
            continue
        if absolute not in seen:
            seen.add(absolute)
            out.append(absolute)
    return out


async def run_crawl4ai(url: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch a *single* ``url`` using crawl4ai's AsyncWebCrawler.

    Returns one raw page dict: ``{"url","title","markdown"/"text","metadata",
    "links"}``. ``links`` is whatever crawl4ai exposed for the page (the BFS
    loop normalizes/filters it). This is the single seam tests replace; a test
    can return a different fake page per URL to simulate a site graph.
    """
    # Lazy import: keeps pytest collection offline and browser-free.
    from crawl4ai import AsyncWebCrawler  # type: ignore

    extract = cfg.get("extract", "markdown")

    async with AsyncWebCrawler(verbose=False) as crawler:
        result = await crawler.arun(url=url)

    md = getattr(result, "markdown", "") or ""
    text = (
        getattr(result, "cleaned_html", "")
        or getattr(result, "text", "")
        or ""
    )
    meta = getattr(result, "metadata", {}) or {}
    title = meta.get("title") if isinstance(meta, dict) else None
    page: Dict[str, Any] = {
        "url": getattr(result, "url", url),
        "title": title or "",
        "metadata": meta if isinstance(meta, dict) else {},
        "links": getattr(result, "links", None),
    }
    page["markdown" if extract == "markdown" else "text"] = (
        md if extract == "markdown" else text
    )
    return page


async def _bfs_crawl(
    seed_urls: List[str],
    cfg: Dict[str, Any],
    policy: SafetyPolicy,
) -> Tuple[List[Dict[str, Any]], int]:
    """Breadth-first crawl driven entirely on the Python side.

    Frontier is a FIFO queue of ``(url, depth)`` seeded from ``seed_urls``.
    A ``visited`` set of normalized URLs guarantees each page is fetched at
    most once. We pop until ``maxPages`` documents are collected, the frontier
    drains, or the wall-clock exceeds ``timeoutMs``. Every popped URL is
    SSRF-checked *before* fetching; a blocked or duplicate link is skipped
    (it does not fail the whole run). Returns ``(documents, skipped_count)``.
    """
    max_pages = max(0, int(cfg.get("maxPages", 10)))
    max_depth = max(0, int(cfg.get("maxDepth", 1)))
    timeout_s = max(0.0, float(cfg.get("timeoutMs", 60_000)) / 1000.0)
    extract = cfg["extract"]

    crawl = run_crawl4ai  # late-bound so monkeypatch on the module wins.

    frontier: deque[Tuple[str, int]] = deque()
    visited: set[str] = set()
    documents: List[Dict[str, Any]] = []
    skipped = 0
    start = time.monotonic()

    for su in seed_urls:
        norm = _normalize(su)
        if norm not in visited:
            visited.add(norm)
            frontier.append((su, 0))

    while frontier and len(documents) < max_pages:
        if time.monotonic() - start > timeout_s:
            break
        url, depth = frontier.popleft()

        # SSRF re-check on EVERY URL we are about to fetch (seed or followed).
        try:
            safe_url = policy.check_url(url)
        except SSRFError:
            skipped += 1
            continue

        try:
            page = await crawl(safe_url, cfg)
        except Exception:  # noqa: BLE001 - one bad page must not kill the run.
            skipped += 1
            continue

        doc: Dict[str, Any] = {
            "url": page.get("url", safe_url),
            "title": page.get("title", "") or "",
            "metadata": page.get("metadata", {}) or {},
        }
        if extract == "markdown":
            doc["markdown"] = page.get("markdown", "") or ""
        else:
            doc["text"] = page.get("text", "") or ""
        documents.append(doc)

        if depth >= max_depth or len(documents) >= max_pages:
            continue

        for link in _extract_links(page, page.get("url", safe_url)):
            norm = _normalize(link)
            if norm in visited:
                continue
            visited.add(norm)
            frontier.append((link, depth + 1))

    return documents, skipped


def _run_coro(coro):
    """Run an awaitable to completion from a sync context.

    FastAPI dispatches sync handlers inside a running event loop, so a plain
    ``asyncio.run`` raises. We run the coroutine on a fresh loop in a worker
    thread, which works whether or not an outer loop is running.
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def handle(request) -> Dict[str, Any]:
    """Entry point dispatched from main.py for ``crawl4ai_crawler``."""
    cfg = _resolve_config(request.effective_config())
    urls = cfg["_urls"]

    policy = SafetyPolicy(
        allow_private_networks=bool(cfg["allowPrivateNetworks"]),
        allowed_domains=list(cfg.get("allowedDomains") or []),
        same_domain_only=bool(cfg["sameDomainOnly"]),
        max_pages=int(cfg["maxPages"]),
        max_depth=int(cfg["maxDepth"]),
        timeout_ms=int(cfg["timeoutMs"]),
    ).seed_from(urls)

    # Validate every seed URL up-front: if no seed survives the SSRF guard the
    # run is fatal -> {"error": ...} per the contract (SSRFError is a
    # ValueError, so main.py maps it). A page followed *from* a seed that is
    # blocked is skipped, not fatal (handled inside _bfs_crawl).
    safe_seeds: List[str] = []
    first_err: SSRFError | None = None
    for u in urls:
        try:
            safe_seeds.append(policy.check_url(u))
        except SSRFError as exc:
            if first_err is None:
                first_err = exc
    if not safe_seeds:
        raise first_err or SSRFError("no usable seed URL")

    documents, skipped = _run_coro(_bfs_crawl(safe_seeds, cfg, policy))

    return {
        "outputs": {"documents": documents, "pageCount": len(documents)},
        "usage": {},
        "metadata": {
            "crawler": "crawl4ai",
            "pagesRequested": int(cfg["maxPages"]),
            "pagesFetched": len(documents),
            "skipped": skipped,
        },
    }
