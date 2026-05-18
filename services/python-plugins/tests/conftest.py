"""Shared test fixtures.

These tests run with ONLY the dev deps (fastapi, httpx, pytest). They never
touch the network, never spawn a browser, and never start a Twisted reactor.
That works because crawl4ai/scrapy are imported lazily *inside* the run
functions, and the tests monkeypatch those run functions before dispatch.
"""

from __future__ import annotations

import pathlib
import sys

import pytest

# Make the service root importable as `app` when pytest is invoked from
# anywhere inside the repo.
SERVICE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def make_request_body(plugin_id: str, config: dict) -> dict:
    """Build a minimal but contract-complete /execute body."""
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
