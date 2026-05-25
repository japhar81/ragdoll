"""FastAPI app implementing EXTERNAL PLUGIN HTTP CONTRACT v1.

Server side only. A TS client calls these endpoints.

Dispatch model:
    POST /execute -> validate body with pydantic -> look up plugin.id in
    HANDLERS -> call handler(request) -> wrap result in the success envelope.

Error model (per contract):
    - Unknown plugin / bad config / SSRF rejection -> HTTP 200 {"error": ...}
      (expected failures the TS side treats as plugin failure).
    - Truly unexpected exceptions -> surface as HTTP 500.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

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

app = FastAPI(title="RAGdoll Python Plugins", version="1.0.0")


@app.get("/healthz", response_model=HealthResponse)
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


@app.post("/execute")
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
