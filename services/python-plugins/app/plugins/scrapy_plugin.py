"""``scrapy_spider`` plugin handler.

Scrapy drives a Twisted reactor, which cannot coexist with uvicorn's asyncio
loop in the same process (and a reactor can only run once per process). We
therefore run the spider in a *child process* via ``multiprocessing``. The
child writes scraped items to a temp JSONL file which the parent reads back.

:func:`run_scrapy` is the single seam tests monkeypatch so unit tests neither
spawn a process nor start a reactor. ``scrapy`` is imported lazily inside the
child entry point only.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import tempfile
from typing import Any, Dict, List

from app.safety import SafetyPolicy

PLUGIN_ID = "scrapy_spider"

DEFAULTS: Dict[str, Any] = {
    "maxPages": 20,
    "maxDepth": 2,
    "allowPrivateNetworks": False,
    "allowedDomains": [],
}


def _resolve_config(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = {**DEFAULTS, **(config or {})}
    start_urls = cfg.get("startUrls")
    if not start_urls or not isinstance(start_urls, (list, tuple)):
        raise ValueError("scrapy_spider requires config.startUrls (list of strings)")
    cfg["startUrls"] = [str(u) for u in start_urls]
    cfg["allowedDomains"] = list(cfg.get("allowedDomains") or [])
    return cfg


def _child_run(
    start_urls: List[str],
    allowed_domains: List[str],
    max_pages: int,
    max_depth: int,
    out_path: str,
) -> None:
    """Runs inside the child process: builds a CrawlerProcess and crawls.

    Imported lazily so the parent/test process never pulls in Twisted.
    """
    from scrapy import Spider  # type: ignore
    from scrapy.crawler import CrawlerProcess  # type: ignore
    from scrapy.linkextractors import LinkExtractor  # type: ignore

    fh = open(out_path, "w", encoding="utf-8")

    class _PluginSpider(Spider):
        name = "ragdoll_scrapy_spider"
        custom_settings = {
            "LOG_ENABLED": False,
            "ROBOTSTXT_OBEY": True,
            "CLOSESPIDER_PAGECOUNT": max_pages,
            "DEPTH_LIMIT": max_depth,
            "TELNETCONSOLE_ENABLED": False,
        }

        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.allowed_domains = list(allowed_domains)
            self.start_urls = list(start_urls)
            self._link_extractor = LinkExtractor()
            self._count = 0

        def parse(self, response):
            if self._count >= max_pages:
                return
            self._count += 1
            title = ""
            try:
                title = (response.css("title::text").get() or "").strip()
            except Exception:  # noqa: BLE001
                title = ""
            body = ""
            try:
                body = " ".join(response.css("::text").getall()).strip()
            except Exception:  # noqa: BLE001
                body = ""
            item = {
                "url": response.url,
                "title": title,
                "text": body,
                "metadata": {"status": response.status},
            }
            fh.write(json.dumps(item) + "\n")
            fh.flush()
            if response.meta.get("depth", 0) < max_depth:
                for link in self._link_extractor.extract_links(response):
                    yield response.follow(link.url, callback=self.parse)

    process = CrawlerProcess(settings={"LOG_ENABLED": False})
    process.crawl(_PluginSpider)
    try:
        process.start()  # blocks until crawl finished (this process only)
    finally:
        fh.close()


def run_scrapy(
    start_urls: List[str], cfg: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Spawn a child process to crawl with Scrapy; collect items via JSONL.

    This is the single seam tests replace; it must stay importable without
    importing scrapy at module load.
    """
    max_pages = int(cfg.get("maxPages", 20))
    max_depth = int(cfg.get("maxDepth", 2))
    allowed_domains = list(cfg.get("allowedDomains") or [])

    fd, out_path = tempfile.mkstemp(prefix="ragdoll_scrapy_", suffix=".jsonl")
    os.close(fd)
    try:
        ctx = multiprocessing.get_context("spawn")
        proc = ctx.Process(
            target=_child_run,
            args=(start_urls, allowed_domains, max_pages, max_depth, out_path),
        )
        proc.start()
        timeout_s = max(1.0, int(cfg.get("timeoutMs", 60_000)) / 1000.0)
        proc.join(timeout=timeout_s)
        if proc.is_alive():
            proc.terminate()
            proc.join(5)

        items: List[Dict[str, Any]] = []
        with open(out_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    items.append(json.loads(line))
        return items
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass


def handle(request) -> Dict[str, Any]:
    """Entry point dispatched from main.py for ``scrapy_spider``."""
    cfg = _resolve_config(request.effective_config())
    start_urls = cfg["startUrls"]

    policy = SafetyPolicy(
        allow_private_networks=bool(cfg["allowPrivateNetworks"]),
        allowed_domains=list(cfg.get("allowedDomains") or []),
        same_domain_only=False,  # scrapy_spider relies on allowedDomains
        max_pages=int(cfg["maxPages"]),
        max_depth=int(cfg["maxDepth"]),
        timeout_ms=int(cfg.get("timeoutMs", 60_000)),
    ).seed_from(start_urls)

    safe_urls = [policy.check_url(u) for u in start_urls]

    crawl = run_scrapy  # late-bound for monkeypatch.
    raw_items = crawl(safe_urls, cfg)

    documents: List[Dict[str, Any]] = []
    for it in raw_items[: policy.max_pages]:
        documents.append(
            {
                "url": it.get("url", ""),
                "title": it.get("title", ""),
                "text": it.get("text", "") or "",
                "metadata": it.get("metadata", {}) or {},
            }
        )

    return {
        "outputs": {"documents": documents, "pageCount": len(documents)},
        "usage": {},
        "metadata": {"crawler": "scrapy"},
    }
