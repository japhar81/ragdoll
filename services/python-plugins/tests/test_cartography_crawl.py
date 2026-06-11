"""Unit tests for the ``cartography_crawl`` Python handler.

These cover the contract the Node-side manifest promises: configuration
shape, argv assembly, env injection, failure handling (throw instead of
report-succeeded-on-fail), and the dry-run envelope. The real
``cartography`` binary is monkeypatched via ``subprocess.run`` so the
test suite never actually crawls AWS.

Lives next to the other in-container plugin tests (test_crawl_bfs.py,
test_safety.py) and runs via ``poetry run pytest`` inside the
python-plugins service.
"""

from __future__ import annotations

import subprocess
from typing import Any, Dict, List

import pytest

from app.plugins import cartography_crawl_plugin as plugin


def _build_request(
    *,
    config: Dict[str, Any],
    connection: Dict[str, Any] | None = None,
    secrets: Dict[str, Any] | None = None,
):
    """Construct an ExecuteRequest the handler accepts.

    The cartography handler reaches the neo4j connection through
    `request.dataset.bindings.target.connection`, mirroring the
    serialized ADR-0023 resolved-dataset envelope the Node runtime
    sends over the Connect wire.
    """
    from app.models import ExecuteRequest

    body = {
        "plugin": {"category": "datasource", "id": "cartography_crawl", "version": "1.0.0"},
        "node": {"id": "n1", "config": {}, "secrets": {}},
        "inputs": {},
        "config": config,
        "secrets": secrets or {},
        "dataset": (
            {"bindings": {"target": {"connection": connection}}}
            if connection is not None
            else {}
        ),
        "context": {
            "requestId": "req-1",
            "tenantId": "tenant-1",
            "environment": "test",
            "resolvedConfig": {"values": {}},
        },
    }
    return ExecuteRequest.model_validate(body)


# ---------------------------------------------------------------------------
# config validation
# ---------------------------------------------------------------------------


def test_rejects_empty_modules_list():
    req = _build_request(config={"modules": []}, connection={"kind": "neo4j", "slug": "n", "options": {"uri": "bolt://x"}})
    with pytest.raises(ValueError, match="modules must be a non-empty array"):
        plugin.handle(req)


def test_rejects_unknown_module():
    req = _build_request(
        config={"modules": ["nope"]},
        connection={"kind": "neo4j", "slug": "n", "options": {"uri": "bolt://x"}},
    )
    with pytest.raises(ValueError, match="unknown module 'nope'"):
        plugin.handle(req)


def test_rejects_missing_target_binding():
    req = _build_request(config={"modules": ["aws"]})  # no connection
    with pytest.raises(ValueError, match="no resolved 'target' binding"):
        plugin.handle(req)


def test_rejects_non_neo4j_target_kind():
    req = _build_request(
        config={"modules": ["aws"]},
        connection={"kind": "postgres", "slug": "pg", "options": {}},
    )
    with pytest.raises(ValueError, match="must be backed by a neo4j connection"):
        plugin.handle(req)


def test_rejects_missing_neo4j_uri():
    # subprocess runner explicitly needs options.uri — dry-run does not.
    req = _build_request(
        config={"modules": ["aws"]},
        connection={"kind": "neo4j", "slug": "n", "options": {}},
    )
    with pytest.raises(ValueError, match="needs a Bolt URI"):
        plugin.handle(req)


# ---------------------------------------------------------------------------
# dry-run path
# ---------------------------------------------------------------------------


def test_dry_run_emits_synthetic_metadata(monkeypatch):
    # subprocess.run must NEVER be called in dry-run mode.
    def boom(*args, **kwargs):
        raise AssertionError("subprocess.run called in dry-run mode")

    monkeypatch.setattr(subprocess, "run", boom)
    req = _build_request(
        config={"modules": ["aws", "gcp"], "runner": "dry-run"},
        connection={"kind": "neo4j", "slug": "graph", "options": {"uri": "bolt://x"}},
    )
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert meta["mode"] == "dry-run"
    assert meta["target"] == {"connectionSlug": "graph", "database": None}
    assert [m["module"] for m in meta["modules"]] == ["aws", "gcp"]
    assert all(m["status"] == "skipped" for m in meta["modules"])


# ---------------------------------------------------------------------------
# subprocess path
# ---------------------------------------------------------------------------


class _FakeCompleted:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_subprocess_success_passes_modules_to_argv_and_neo4j_env(monkeypatch):
    captured: Dict[str, Any] = {}

    def fake_run(argv: List[str], env=None, timeout=None, capture_output=False, text=False, check=False):
        captured["argv"] = argv
        captured["env"] = env
        return _FakeCompleted(returncode=0, stdout="ok\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws"], "incremental": True},
        connection={
            "kind": "neo4j",
            "slug": "prod",
            "options": {"uri": "bolt://neo4j:7687", "database": "graph1"},
            "secret": '{"username":"neo4j","password":"hunter2"}',
        },
        secrets={"creds": "AWS_ACCESS_KEY_ID=AKIA\nAWS_SECRET_ACCESS_KEY=secret"},
    )
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert meta["mode"] == "subprocess"
    assert meta["target"] == {"connectionSlug": "prod", "database": "graph1"}
    assert meta["exitCode"] == 0
    assert all(m["status"] == "succeeded" for m in meta["modules"])
    # argv carries the cartography binary, -m flag per module, and
    # --update-tag (incremental=true). Selectors / extraArgs are tested
    # implicitly — none here, so none in argv.
    assert captured["argv"][0] == "cartography"
    assert "-m" in captured["argv"] and "aws" in captured["argv"]
    assert "--update-tag" in captured["argv"]
    # env carries neo4j creds + the parsed creds-block keys.
    env = captured["env"]
    assert env["NEO4J_URI"] == "bolt://neo4j:7687"
    assert env["NEO4J_USER"] == "neo4j"
    assert env["NEO4J_PASSWORD"] == "hunter2"
    assert env["AWS_ACCESS_KEY_ID"] == "AKIA"
    assert env["AWS_SECRET_ACCESS_KEY"] == "secret"


def test_subprocess_nonzero_exit_throws_not_swallows(monkeypatch):
    def fake_run(*args, **kwargs):
        return _FakeCompleted(returncode=2, stdout="", stderr="boom: auth failed")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws"]},
        connection={
            "kind": "neo4j",
            "slug": "n",
            "options": {"uri": "bolt://x"},
            "secret": "neo4j:pw",
        },
    )
    # Pre-fix behaviour: returned success with status="failed" per module.
    # New behaviour: raise so the runtime marks the node failed.
    with pytest.raises(ValueError, match="cartography exited 2.*boom: auth failed"):
        plugin.handle(req)


def test_subprocess_binary_missing_throws_actionable_error(monkeypatch):
    def fake_run(*args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory: 'cartography'")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws"]},
        connection={"kind": "neo4j", "slug": "n", "options": {"uri": "bolt://x"}, "secret": "neo4j:pw"},
    )
    with pytest.raises(ValueError, match="cartography binary not found"):
        plugin.handle(req)


def test_subprocess_timeout_throws(monkeypatch):
    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="cartography", timeout=1)

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws"], "timeoutMs": 1000},
        connection={"kind": "neo4j", "slug": "n", "options": {"uri": "bolt://x"}, "secret": "neo4j:pw"},
    )
    with pytest.raises(ValueError, match="timed out"):
        plugin.handle(req)


# ---------------------------------------------------------------------------
# secret parsing helpers
# ---------------------------------------------------------------------------


def test_parse_neo4j_credentials_handles_json_shape():
    user, pw = plugin._parse_neo4j_credentials('{"username":"u","password":"p"}')
    assert (user, pw) == ("u", "p")


def test_parse_neo4j_credentials_handles_user_colon_pass():
    user, pw = plugin._parse_neo4j_credentials("alice:secret")
    assert (user, pw) == ("alice", "secret")


def test_parse_neo4j_credentials_handles_raw_password():
    user, pw = plugin._parse_neo4j_credentials("hunter2")
    assert (user, pw) == ("neo4j", "hunter2")  # default username


def test_parse_neo4j_credentials_handles_none():
    user, pw = plugin._parse_neo4j_credentials(None)
    assert (user, pw) == ("neo4j", "")
