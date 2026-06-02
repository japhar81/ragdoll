"""ASGI entrypoint for the python-plugins sidecar.

Phase B follow-up (2026-06-01): the legacy HTTP contract v1 (`POST /execute`
with the JSON envelope built by `buildExternalRequestBody`) has been
removed. The Node runtime is exclusively on connect-rpc since Phase A and
the only in-tree consumer of the legacy wire (`rerank_bge_local` via
`plugins/builtin-rag/src/retrieval-v2.ts`) was migrated alongside this
cleanup.

Routes (in dispatch order):
  /healthz                                 → 5-line Starlette shim
                                              (k8s probe + the operator's
                                              cheapest reachability check)
  /ragdoll.plugin.v1.PluginRuntime/*       → Connect ASGI (PluginRuntime
                                              proto contract — ADR 0022)
  everything else                          → 404

`app/connect_bridge.py` translates between the proto request shape and the
pydantic `ExecuteRequest` the handlers (`crawl4ai_plugin`, `scrapy_plugin`,
`rerank_bge_plugin`) accept. Handlers are wire-agnostic.

Error model (Connect):
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
from app.plugins import crawl4ai_plugin, rerank_bge_plugin, scrapy_plugin

# plugin.id -> handler(ExecuteRequest) -> dict with outputs/usage/metadata
HANDLERS: Dict[str, Callable[[ExecuteRequest], Dict[str, Any]]] = {
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


# --- Connect-RPC app (primary) ---------------------------------------------

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
