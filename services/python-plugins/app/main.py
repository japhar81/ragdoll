"""ASGI entrypoint composing two protocols over the same handlers.

Phase B: this sidecar now serves the new connect-rpc PluginRuntime contract
(`ragdoll.plugin.v1.PluginRuntime/*`) in addition to the legacy HTTP/JSON
`POST /execute` route. Both delegate to the same HANDLERS dict — the
crawl4ai / scrapy / rerank_bge implementations are wire-agnostic.

Layout (in dispatch order):

  /healthz                                 → FastAPI (k8s probe; unchanged)
  /execute                                 → FastAPI (legacy contract v1)
  /ragdoll.plugin.v1.PluginRuntime/*       → Connect ASGI (new)
  everything else                          → 404

Legacy /execute is kept during the cutover so existing TS callers that
haven't migrated to the Connect transport keep working. Once the Node
runtime is exclusively on Connect (the default since Phase A) the legacy
route becomes dead code and can be removed in a follow-up.

Dispatch model (legacy /execute, unchanged from Phase A):
    POST /execute -> validate body with pydantic -> look up plugin.id in
    HANDLERS -> call handler(request) -> wrap result in the success envelope.

Dispatch model (Connect /ragdoll.plugin.v1.PluginRuntime/Execute):
    proto ExecuteRequest -> translate to the same pydantic ExecuteRequest
    the legacy handler expects -> call handler -> proto ExecuteResponse.

Error model (legacy):
    Expected failures -> HTTP 200 {"error": ...}; unexpected -> HTTP 500.
Error model (Connect):
    Expected failures -> ConnectError(code=INTERNAL or INVALID_ARGUMENT);
    unexpected -> ConnectError(code=INTERNAL) — connectrpc serialises
    these as the protocol-appropriate frame for whichever wire is in use.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.types import ASGIApp, Receive, Scope, Send

from app.connect_bridge import build_connect_app
from app.models import ExecuteRequest, HealthResponse
from app.plugins import crawl4ai_plugin, rerank_bge_plugin, scrapy_plugin

logger = logging.getLogger("ragdoll.python-plugins")

# plugin.id -> handler(ExecuteRequest) -> dict with outputs/usage/metadata
HANDLERS: Dict[str, Callable[[ExecuteRequest], Dict[str, Any]]] = {
    crawl4ai_plugin.PLUGIN_ID: crawl4ai_plugin.handle,
    rerank_bge_plugin.PLUGIN_ID: rerank_bge_plugin.handle,
    scrapy_plugin.PLUGIN_ID: scrapy_plugin.handle,
}

PLUGIN_IDS = list(HANDLERS.keys())

# --- Legacy FastAPI app (contract v1) --------------------------------------

legacy = FastAPI(title="RAGdoll Python Plugins (legacy HTTP contract v1)", version="1.0.0")


@legacy.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(ok=True, plugins=PLUGIN_IDS)


def _build_envelope(result: Dict[str, Any]) -> Dict[str, Any]:
    """Construct the success envelope, including only present optional keys."""
    envelope: Dict[str, Any] = {"outputs": result.get("outputs", {})}
    if result.get("metadata") is not None:
        envelope["metadata"] = result["metadata"]
    if result.get("usage") is not None:
        envelope["usage"] = result["usage"]
    if result.get("artifacts") is not None:
        envelope["artifacts"] = result["artifacts"]
    return envelope


@legacy.post("/execute")
async def execute(raw: Request) -> JSONResponse:
    # Parse JSON body manually so a malformed body becomes a 200 {"error"}
    # rather than FastAPI's default 422.
    try:
        body = await raw.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid JSON request body"}, status_code=200)

    try:
        request = ExecuteRequest.model_validate(body)
    except ValidationError as exc:
        return JSONResponse(
            {"error": f"invalid request body: {exc.errors()}"}, status_code=200
        )

    plugin_id = request.plugin.id
    handler = HANDLERS.get(plugin_id)
    if handler is None:
        return JSONResponse(
            {"error": f"unknown plugin {plugin_id}"}, status_code=200
        )

    try:
        result = handler(request)
    except ValueError as exc:
        # Covers SSRFError (a ValueError subclass) and bad-config errors.
        return JSONResponse({"error": str(exc)}, status_code=200)
    except Exception as exc:  # noqa: BLE001
        # Truly unexpected -> let it surface as a 500 per the contract.
        logger.exception("unhandled error in plugin %s", plugin_id)
        return JSONResponse(
            {"error": f"internal error: {exc}"}, status_code=500
        )

    return JSONResponse(_build_envelope(result), status_code=200)


# --- Connect-RPC app (new) -------------------------------------------------

connect_app = build_connect_app(HANDLERS, PLUGIN_IDS)


# --- ASGI composition ------------------------------------------------------
# A manual two-route dispatcher avoids Starlette's Mount("/") path-stripping
# (which strips the leading slash and breaks connectrpc's ASGI matcher).
# The dispatch table is exact-path: legacy paths win, everything else falls
# through to the Connect app, which 404s on unknown paths itself.

LEGACY_PATHS = {"/healthz", "/execute"}


async def app(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["type"] != "http":
        # Lifespan / websocket — Hypercorn drives lifespan for the legacy
        # FastAPI app (startup/shutdown hooks); pass through there.
        await legacy(scope, receive, send)
        return
    path = scope.get("path", "")
    target: ASGIApp = legacy if path in LEGACY_PATHS else connect_app
    await target(scope, receive, send)
