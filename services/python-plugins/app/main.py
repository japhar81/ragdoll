"""ASGI entrypoint for the python-plugins sidecar.

Two routes:

  /healthz                                 → 5-line Starlette shim (k8s probe)
  /ragdoll.plugin.v1.PluginRuntime/*       → Connect ASGI (PluginRuntime
                                              proto contract — ADR 0022)
  everything else                          → 404

`app/connect_bridge.py` builds the Connect ASGI app over the HANDLERS dict
declared below — each handler receives a pydantic `ExecuteRequest` and
returns a dict the bridge wraps as a proto `ExecuteResponse`. Handlers are
wire-agnostic.

Error model:
    Expected failures (unknown plugin / SSRF-blocked / bad config) →
    `ConnectError(code=INVALID_ARGUMENT)`; unexpected →
    `ConnectError(code=INTERNAL)`. connectrpc serialises these into the
    protocol-appropriate frame for whichever wire the caller is using.
"""

from __future__ import annotations

from typing import Any, Callable, Dict

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.connect_bridge import build_connect_app
from app.models import ExecuteRequest
from app.plugins import (
    cartography_crawl_plugin,
    cloudquery_aws_sync_plugin,
    crawl4ai_plugin,
    rerank_bge_plugin,
    scrapy_plugin,
)

# plugin.id -> handler(ExecuteRequest) -> dict with outputs/usage/metadata
HANDLERS: Dict[str, Callable[[ExecuteRequest], Dict[str, Any]]] = {
    cartography_crawl_plugin.PLUGIN_ID: cartography_crawl_plugin.handle,
    cloudquery_aws_sync_plugin.PLUGIN_ID: cloudquery_aws_sync_plugin.handle,
    crawl4ai_plugin.PLUGIN_ID: crawl4ai_plugin.handle,
    rerank_bge_plugin.PLUGIN_ID: rerank_bge_plugin.handle,
    scrapy_plugin.PLUGIN_ID: scrapy_plugin.handle,
}

PLUGIN_IDS = list(HANDLERS.keys())

# --- /healthz shim ----------------------------------------------------------
# K8s liveness probes hit `/healthz`. Capability probes (which plugins are
# served?) should use the Connect `PluginRuntime.Health` RPC — same answer
# from the same HANDLERS dict, but typed over the proto contract.

async def _healthz(_scope: Scope, _receive: Receive, send: Send) -> None:
    body = {"ok": True, "plugins": PLUGIN_IDS}
    response = JSONResponse(body)
    await response(_scope, _receive, send)


# --- Connect-RPC app --------------------------------------------------------

connect_app = build_connect_app(HANDLERS, PLUGIN_IDS)


# --- ASGI composition ------------------------------------------------------

async def app(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["type"] != "http":
        # Hypercorn's lifespan events (startup/shutdown) — the Connect app
        # handles them; the /healthz shim has no state to manage.
        await connect_app(scope, receive, send)
        return
    if scope.get("path") == "/healthz":
        await _healthz(scope, receive, send)
        return
    await connect_app(scope, receive, send)
