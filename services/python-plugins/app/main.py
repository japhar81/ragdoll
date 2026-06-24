"""ASGI entrypoint for the python-plugins sidecar.

Routes:

  /healthz                                 → liveness probe + plugin list
  /manifests                               → git-loaded plugin manifests
                                              (PLUGIN-ARCH-2 discovery —
                                              RAGdoll registers these)
  /admin/reload                            → reload git sources (token-gated)
  /ragdoll.plugin.v1.PluginRuntime/*       → Connect ASGI (PluginRuntime
                                              proto contract — ADR 0022)
  everything else                          → 404

`app/connect_bridge.py` builds the Connect ASGI app over a LIVE handler
resolver (`_resolve_handler`) so git-loaded plugins (PLUGIN-ARCH-2)
appear without rebuilding the app.

Error model:
    Expected failures (unknown plugin / SSRF-blocked / bad config) →
    `ConnectError(code=INVALID_ARGUMENT)`; unexpected →
    `ConnectError(code=INTERNAL)`.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Callable, Dict, List

from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

from app.connect_bridge import build_connect_app
from app.models import ExecuteRequest
from app import plugin_loader
from app.plugins import (
    cartography_crawl_plugin,
    cloudquery_aws_sync_plugin,
    crawl4ai_plugin,
    rerank_bge_plugin,
    scrapy_plugin,
)

logger = logging.getLogger("ragdoll.python-plugins.main")

# --- static built-in handlers ----------------------------------------------
# plugin.id -> handler(ExecuteRequest) -> dict with outputs/usage/metadata.
# These ship in the image; git-loaded plugins (PLUGIN-ARCH-2) layer on top.
BUILTIN_HANDLERS: Dict[str, Callable[[ExecuteRequest], Dict[str, Any]]] = {
    cartography_crawl_plugin.PLUGIN_ID: cartography_crawl_plugin.handle,
    cloudquery_aws_sync_plugin.PLUGIN_ID: cloudquery_aws_sync_plugin.handle,
    crawl4ai_plugin.PLUGIN_ID: crawl4ai_plugin.handle,
    rerank_bge_plugin.PLUGIN_ID: rerank_bge_plugin.handle,
    scrapy_plugin.PLUGIN_ID: scrapy_plugin.handle,
}


# --- live registry view (built-ins + git-loaded) ---------------------------


def _resolve_handler(plugin_id: str):
    """Built-ins win over git-loaded on an id collision — a vendor repo
    can't shadow a first-party plugin."""
    if plugin_id in BUILTIN_HANDLERS:
        return BUILTIN_HANDLERS[plugin_id]
    loaded = plugin_loader.loaded_plugins().get(plugin_id)
    return loaded.handle if loaded else None


def _live_plugin_ids() -> List[str]:
    ids = list(BUILTIN_HANDLERS.keys())
    for pid in plugin_loader.loaded_plugins().keys():
        if pid not in BUILTIN_HANDLERS:
            ids.append(pid)
    return ids


# --- startup: load git sources from env ------------------------------------


def _initial_load() -> None:
    sources = plugin_loader.parse_sources_env(
        os.environ.get("RAGDOLL_PYTHON_PLUGIN_SOURCES")
    )
    if not sources:
        return
    statuses = plugin_loader.load_sources(sources)
    for s in statuses:
        if s.status == "loaded":
            logger.info(
                "git plugin source %s loaded %d plugin(s) @ %s",
                s.id,
                s.plugin_count,
                (s.commit_sha or "")[:7],
            )
        elif s.status == "failed":
            logger.warning(
                "git plugin source %s FAILED at %s: %s",
                s.id,
                s.error_stage,
                s.error,
            )


_initial_load()


# --- HTTP shims -------------------------------------------------------------


async def _healthz(scope: Scope, receive: Receive, send: Send) -> None:
    body = {"ok": True, "plugins": _live_plugin_ids()}
    await JSONResponse(body)(scope, receive, send)


async def _manifests(scope: Scope, receive: Receive, send: Send) -> None:
    """PLUGIN-ARCH-2 discovery: every git-loaded plugin's manifest +
    provenance. RAGdoll's loader queries this to register the plugins
    in the builder palette. Built-in plugins are NOT listed here —
    they carry hand-authored TS manifests RAGdoll already knows."""
    out: List[Dict[str, Any]] = []
    for p in plugin_loader.loaded_plugins().values():
        out.append(
            {
                "id": p.plugin_id,
                "manifest": p.manifest,  # may be None if the module omits MANIFEST
                "source": {
                    "repoId": p.source_id,
                    "kind": "git",
                    "commitSha": p.commit_sha,
                },
            }
        )
    await JSONResponse({"plugins": out})(scope, receive, send)


async def _admin_reload(scope: Scope, receive: Receive, send: Send) -> None:
    """Reload git sources. Token-gated via RAGDOLL_SIDECAR_ADMIN_TOKEN.

    The source list comes from the request body (`{"sources":[...]}`)
    when provided — so RAGdoll can push the current `plugin_sources`
    rows — else falls back to the `RAGDOLL_PYTHON_PLUGIN_SOURCES` env.
    Returns the per-source status report.
    """
    expected = os.environ.get("RAGDOLL_SIDECAR_ADMIN_TOKEN")
    if expected:
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        token = headers.get("x-ragdoll-admin-token", "")
        if token != expected:
            await JSONResponse({"error": "unauthorized"}, status_code=401)(
                scope, receive, send
            )
            return
    # Read the body.
    body_bytes = b""
    more = True
    while more:
        message = await receive()
        body_bytes += message.get("body", b"")
        more = message.get("more_body", False)
    sources: List[plugin_loader.PluginSource]
    if body_bytes.strip():
        try:
            sources = plugin_loader.parse_sources_env(body_bytes.decode("utf-8"))
            # parse_sources_env expects a bare JSON array; accept {"sources":[...]} too.
            if not sources:
                parsed = json.loads(body_bytes.decode("utf-8"))
                if isinstance(parsed, dict) and isinstance(parsed.get("sources"), list):
                    sources = plugin_loader.parse_sources_env(
                        json.dumps(parsed["sources"])
                    )
        except (json.JSONDecodeError, UnicodeDecodeError):
            await JSONResponse({"error": "bad request body"}, status_code=400)(
                scope, receive, send
            )
            return
    else:
        sources = plugin_loader.parse_sources_env(
            os.environ.get("RAGDOLL_PYTHON_PLUGIN_SOURCES")
        )
    statuses = plugin_loader.load_sources(sources)
    report = {
        "sources": [
            {
                "id": s.id,
                "status": s.status,
                "pluginCount": s.plugin_count,
                "commitSha": s.commit_sha,
                "ref": s.ref,
                "error": s.error,
                "errorStage": s.error_stage,
                "pluginIds": s.plugin_ids,
            }
            for s in statuses
        ]
    }
    await JSONResponse(report)(scope, receive, send)


# --- Connect-RPC app (reads the LIVE registry) -----------------------------

connect_app = build_connect_app(_resolve_handler, _live_plugin_ids)


# --- ASGI composition ------------------------------------------------------


async def app(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["type"] != "http":
        await connect_app(scope, receive, send)
        return
    path = scope.get("path")
    method = scope.get("method", "GET")
    if path == "/healthz":
        await _healthz(scope, receive, send)
        return
    if path == "/manifests" and method == "GET":
        await _manifests(scope, receive, send)
        return
    if path == "/admin/reload" and method == "POST":
        await _admin_reload(scope, receive, send)
        return
    await connect_app(scope, receive, send)
