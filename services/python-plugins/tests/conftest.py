"""Shared test fixtures for the python-plugins sidecar.

These tests run with ONLY the dev deps (pytest, pytest-asyncio). They never
touch the network, never spawn a browser, and never start a Twisted reactor.
That works because crawl4ai/scrapy are imported lazily *inside* the run
functions, and the tests monkeypatch those run functions before dispatch.

The `client` fixture exposes a small `FakeClient` that calls the HANDLERS
dispatch directly (no HTTP). It preserves the
`client.post("/execute", json=body)` / `client.get("/healthz")` shape so
per-plugin unit tests can target the handler dispatch logic without
spinning up a server. Wire fidelity (real Connect protocol round-trip) is
covered by `tests/e2e/cross-language-plugin.e2e.test.ts` on the Node side,
which hits the running sidecar container.
"""

from __future__ import annotations

import pathlib
import sys
from typing import Any, Dict

import pytest
from pydantic import ValidationError

# Make the service root importable as `app` when pytest is invoked from
# anywhere inside the repo.
SERVICE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


class _FakeResponse:
    """Minimal duck of requests.Response — just the bits the tests touch."""

    def __init__(self, status_code: int, payload: Dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Dict[str, Any]:
        return self._payload


class _FakeClient:
    """In-process dispatcher that mirrors the per-plugin HTTP semantics.

    Tests call `client.get("/healthz")` / `client.post("/execute", json=body)`
    exactly as they would against an HTTP server; this class resolves both
    by calling `HANDLERS[body.plugin.id]` directly and wrapping the result
    in the standard envelope. Same envelope shape the connect-rpc bridge
    builds in production.
    """

    def __init__(self) -> None:
        # Lazy import so the SERVICE_ROOT sys.path tweak above is in effect.
        from app.main import HANDLERS, PLUGIN_IDS
        from app.models import ExecuteRequest

        self._handlers = HANDLERS
        self._plugin_ids = PLUGIN_IDS
        self._ExecuteRequest = ExecuteRequest

    # /healthz — same payload the Starlette shim returns in production.
    def get(self, path: str) -> _FakeResponse:
        if path != "/healthz":
            return _FakeResponse(404, {"error": f"unknown path {path}"})
        return _FakeResponse(200, {"ok": True, "plugins": self._plugin_ids})

    # /execute — test-only dispatch mirror. Production serves the equivalent
    # over the Connect `PluginRuntime.Execute` RPC; the per-plugin dispatch
    # + error mapping below is shared logic the bridge calls into.
    def post(self, path: str, json: Dict[str, Any]) -> _FakeResponse:
        if path != "/execute":
            return _FakeResponse(404, {"error": f"unknown path {path}"})
        try:
            request = self._ExecuteRequest.model_validate(json)
        except ValidationError as exc:
            return _FakeResponse(200, {"error": f"invalid request body: {exc.errors()}"})
        plugin_id = request.plugin.id
        handler = self._handlers.get(plugin_id)
        if handler is None:
            return _FakeResponse(200, {"error": f"unknown plugin {plugin_id}"})
        try:
            result = handler(request)
        except ValueError as exc:
            return _FakeResponse(200, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            return _FakeResponse(500, {"error": f"internal error: {exc}"})
        envelope: Dict[str, Any] = {"outputs": result.get("outputs", {})}
        if result.get("metadata") is not None:
            envelope["metadata"] = result["metadata"]
        if result.get("usage") is not None:
            envelope["usage"] = result["usage"]
        if result.get("artifacts") is not None:
            envelope["artifacts"] = result["artifacts"]
        return _FakeResponse(200, envelope)


@pytest.fixture()
def client() -> _FakeClient:
    return _FakeClient()


def make_request_body(plugin_id: str, config: dict) -> dict:
    """Build a minimal but contract-complete request body."""
    return {
        "plugin": {"category": "crawler", "id": plugin_id, "version": "1.0.0"},
        "node": {"id": "node-1", "config": {}, "secrets": {}},
        "inputs": {},
        "config": config,
        "secrets": {},
        "context": {
            "requestId": "req-1",
            "executionId": "exec-1",
            "tenantId": "tenant-1",
            "pipelineId": "pipe-1",
            "pipelineVersionId": "pipe-v1",
            "environment": "test",
            "deadline": None,
            "resolvedConfig": {"values": {}},
        },
    }
