"""``crawl4ai_crawler`` plugin handler.

All real crawl I/O lives in :func:`run_crawl4ai`, which lazily imports
``crawl4ai`` *inside* the function. Tests monkeypatch :func:`run_crawl4ai`
(or the module attribute) so collection never imports playwright/crawl4ai.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
from typing import Any, Dict, List

from app.safety import SafetyPolicy

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


async def run_crawl4ai(urls: List[str], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Crawl ``urls`` using crawl4ai's AsyncWebCrawler.

    Returns a list of raw page dicts: ``{"url","title","markdown"/"text",
    "metadata"}``. This is the single seam tests replace.
    """
    # Lazy import: keeps pytest collection offline and browser-free.
    from crawl4ai import AsyncWebCrawler  # type: ignore

    pages: List[Dict[str, Any]] = []
    extract = cfg.get("extract", "markdown")
    max_pages = int(cfg.get("maxPages", 10))

    async with AsyncWebCrawler(verbose=False) as crawler:
        for url in urls[:max_pages]:
            result = await crawler.arun(url=url)
            md = getattr(result, "markdown", "") or ""
            text = getattr(result, "cleaned_html", "") or getattr(
                result, "text", ""
            ) or ""
            meta = getattr(result, "metadata", {}) or {}
            title = meta.get("title") if isinstance(meta, dict) else None
            page: Dict[str, Any] = {
                "url": getattr(result, "url", url),
                "title": title or "",
                "metadata": meta if isinstance(meta, dict) else {},
            }
            page["markdown" if extract == "markdown" else "text"] = (
                md if extract == "markdown" else text
            )
            pages.append(page)
    return pages


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

    # Validate every seed URL up-front; SSRFError -> handled by main.py.
    safe_urls = [policy.check_url(u) for u in urls]

    crawl = run_crawl4ai  # late-bound so monkeypatch on the module wins.
    raw_pages = _run_coro(crawl(safe_urls, cfg))

    documents: List[Dict[str, Any]] = []
    extract = cfg["extract"]
    for p in raw_pages[: policy.max_pages]:
        doc = {
            "url": p.get("url", ""),
            "title": p.get("title", ""),
            "metadata": p.get("metadata", {}) or {},
        }
        if extract == "markdown":
            doc["markdown"] = p.get("markdown", "") or ""
        else:
            doc["text"] = p.get("text", "") or ""
        documents.append(doc)

    return {
        "outputs": {"documents": documents, "pageCount": len(documents)},
        "usage": {},
        "metadata": {"crawler": "crawl4ai"},
    }
