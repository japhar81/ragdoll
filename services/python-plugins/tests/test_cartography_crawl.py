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


def test_subprocess_invokes_cartography_once_per_module_with_neo4j_env(monkeypatch):
    # ADR-0026 §#3 / "per-module isolation": cartography is invoked
    # ONCE per requested module (not once with a comma-separated list).
    # One module's failure can't blow away the rest.
    invocations: List[Dict[str, Any]] = []

    def fake_run(argv: List[str], env=None, timeout=None, capture_output=False, text=False, check=False):
        invocations.append({"argv": argv, "env": env, "timeout": timeout})
        # Mimic cartography's "real work" log so the empty-run heuristic
        # marks each module as succeeded (not no_data).
        return _FakeCompleted(
            returncode=0,
            stdout="ok\n",
            stderr=f"Syncing for account 123 ({argv[-1]})\n",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws", "gcp"], "incremental": True},
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
    # Two invocations — one per module — each with --selected-modules
    # pointing at exactly that module (no comma list).
    assert len(invocations) == 2
    modules_seen: List[str] = []
    for inv in invocations:
        argv = inv["argv"]
        assert argv[0] == "/opt/cartography-venv/bin/cartography"
        assert "--selected-modules" in argv
        modules_seen.append(argv[argv.index("--selected-modules") + 1])
        assert "--update-tag" in argv  # incremental=true propagates
    assert modules_seen == ["aws", "gcp"]
    # Per-module entries in metadata.modules — both succeeded, each
    # carries a durationMs.
    assert [m["status"] for m in meta["modules"]] == ["succeeded", "succeeded"]
    assert all("durationMs" in m for m in meta["modules"])
    # env identical across invocations and carries neo4j creds + the
    # parsed AWS creds-block keys.
    for inv in invocations:
        env = inv["env"]
        assert env["NEO4J_URI"] == "bolt://neo4j:7687"
        assert env["NEO4J_USER"] == "neo4j"
        assert env["NEO4J_PASSWORD"] == "hunter2"
        assert env["AWS_ACCESS_KEY_ID"] == "AKIA"
        assert env["AWS_SECRET_ACCESS_KEY"] == "secret"


def test_one_module_failure_does_not_abort_the_rest(monkeypatch):
    # The bulwark report's exact pattern: identitycenter throws
    # ValidationException for a non-org account, exits 1; the historical
    # plugin would treat that as a fatal error and discard AWS / GCP
    # output too. The new posture: log a warning, keep going, exit 0
    # with the partial inventory and a per-module breakdown.
    calls: List[str] = []

    def fake_run(argv: List[str], **_kwargs):
        module = argv[argv.index("--selected-modules") + 1]
        calls.append(module)
        if module == "identitycenter":
            return _FakeCompleted(
                returncode=1,
                stdout="",
                stderr=(
                    "botocore.exceptions.ClientError: An error occurred (ValidationException) "
                    "when calling the ListPermissionSets operation: not supported for account "
                    "instances of IAM Identity Center\n"
                ),
            )
        return _FakeCompleted(
            returncode=0,
            stdout="ok\n",
            stderr=f"Syncing things for account 123 ({module})\n",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws", "identitycenter", "gcp"]},
        connection={
            "kind": "neo4j",
            "slug": "prod",
            "options": {"uri": "bolt://x"},
            "secret": "neo4j:pw",
        },
    )
    out = plugin.handle(req)  # no exception — the historical posture
    meta = out["outputs"]["metadata"]
    # Every module was attempted (no early bail on the failing one).
    assert calls == ["aws", "identitycenter", "gcp"]
    statuses = {m["module"]: m["status"] for m in meta["modules"]}
    assert statuses == {
        "aws": "succeeded",
        "identitycenter": "failed",
        "gcp": "succeeded",
    }
    # The failing module's entry carries enough diagnostics to act on.
    failed_entry = next(m for m in meta["modules"] if m["module"] == "identitycenter")
    assert failed_entry["exitCode"] == 1
    assert "ValidationException" in failed_entry["stderrTail"]
    # Aggregate exitCode reflects the first failure (1 here), not 0,
    # so a caller scripting on top can spot the partial state.
    assert meta["exitCode"] == 1
    # Top-level warning surfaces the per-module summary without the
    # operator grepping for it.
    assert "warning" in meta
    assert "identitycenter" in meta["warning"]
    assert "partial inventory" in meta["warning"]


def test_every_module_failing_still_returns_normally(monkeypatch):
    # Pathological case: all modules fail. We still don't raise —
    # bulwark gets the per-module breakdown and decides what to do.
    def fake_run(argv: List[str], **_kwargs):
        return _FakeCompleted(returncode=1, stdout="", stderr="boom\n")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws", "gcp"]},
        connection={"kind": "neo4j", "slug": "n", "options": {"uri": "bolt://x"}, "secret": "neo4j:pw"},
    )
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert all(m["status"] == "failed" for m in meta["modules"])
    assert meta["exitCode"] == 1
    # Single warning, mentioning both modules.
    assert "2 of 2" in meta["warning"]
    assert "aws" in meta["warning"] and "gcp" in meta["warning"]


def test_per_module_timeout_marks_only_that_module_failed(monkeypatch):
    # Slow module shouldn't poison the fast one. We test by raising
    # TimeoutExpired for `aws` and a clean run for `gcp`.
    def fake_run(argv: List[str], **_kwargs):
        module = argv[argv.index("--selected-modules") + 1]
        if module == "aws":
            raise subprocess.TimeoutExpired(cmd="cartography", timeout=1)
        return _FakeCompleted(returncode=0, stdout="ok\n", stderr="Syncing X\n")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws", "gcp"], "timeoutMs": 120_000},
        connection={"kind": "neo4j", "slug": "n", "options": {"uri": "bolt://x"}, "secret": "neo4j:pw"},
    )
    out = plugin.handle(req)
    statuses = {m["module"]: m["status"] for m in out["outputs"]["metadata"]["modules"]}
    assert statuses == {"aws": "failed", "gcp": "succeeded"}
    aws_entry = next(m for m in out["outputs"]["metadata"]["modules"] if m["module"] == "aws")
    assert "timed out" in aws_entry["error"]


def test_subprocess_binary_missing_throws_actionable_error(monkeypatch):
    # Binary missing is a sidecar-image bug, not a per-module failure
    # — bubble it. The first module's invocation tries to spawn and
    # FileNotFoundError fires immediately; the plugin must raise so
    # the trace clearly shows "rebuild the sidecar."
    def fake_run(*args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory: 'cartography'")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws"]},
        connection={"kind": "neo4j", "slug": "n", "options": {"uri": "bolt://x"}, "secret": "neo4j:pw"},
    )
    with pytest.raises(ValueError, match="cartography binary not found"):
        plugin.handle(req)


# ---------------------------------------------------------------------------
# diagnostic envelope: empty-run detection + creds-warning
# ---------------------------------------------------------------------------


def test_exit_zero_with_no_sync_output_marks_module_no_data(monkeypatch):
    # The "creds are known-good but no data" scenario: cartography
    # exits 0 silently because the AWS SDK default chain found nothing
    # in the sidecar's env, so no boto3 calls happened, so no
    # "Syncing X for account Y" lines were logged. We mark the module
    # as no_data + attach a warning so the operator sees the cause
    # instead of a confusing `status: "succeeded"`.
    def fake_run(*args, **kwargs):
        return _FakeCompleted(returncode=0, stdout="", stderr="")

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
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert all(m["status"] == "no_data" for m in meta["modules"])
    assert "warning" in meta
    # The per-module wording was tightened with the isolation refactor
    # to make it clear no module did any work (vs the old global-level
    # heuristic).
    assert "no module shows sync activity" in meta["warning"]


def test_credssecretref_set_but_missing_secret_attaches_creds_warning(monkeypatch):
    # Bulwark's most likely real failure mode: spec sets
    # `config.credsSecretRef` but the spec node didn't ALSO declare
    # `secrets: { <key>: <ref> }` so the runtime never resolved the
    # secret into input.secrets. cartography then runs with no AWS
    # creds. Plugin attaches a credsWarning so the operator sees the
    # provisioning gap directly on the trace.
    def fake_run(*args, **kwargs):
        return _FakeCompleted(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws"], "credsSecretRef": "aws-prod"},
        connection={
            "kind": "neo4j",
            "slug": "n",
            "options": {"uri": "bolt://x"},
            "secret": "neo4j:pw",
        },
        # No `aws-prod` key in secrets — that's the gap.
        secrets={},
    )
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert "credsWarning" in meta
    assert "credsSecretRef" in meta["credsWarning"]
    assert "aws-prod" in meta["credsWarning"]


def test_metadata_always_carries_cartography_output_tails(monkeypatch):
    # Even on a happy run we surface a tail of cartography's logging
    # so the operator can correlate. Tails are capped at 2KB each.
    def fake_run(*args, **kwargs):
        return _FakeCompleted(
            returncode=0,
            stdout="hello stdout\n",
            stderr="Syncing EC2 for account 12345\n",
        )

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
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert "cartographyStdoutTail" in meta
    assert "cartographyStderrTail" in meta
    assert "hello stdout" in meta["cartographyStdoutTail"]
    assert "Syncing EC2" in meta["cartographyStderrTail"]


# ---------------------------------------------------------------------------
# secret parsing helpers
# ---------------------------------------------------------------------------


def test_env_user_and_password_are_set_together_or_unset_together(monkeypatch):
    # Cartography uses the Python neo4j-driver, which builds an auth
    # token from whichever of NEO4J_USER / NEO4J_PASSWORD it finds.
    # If only NEO4J_USER is exported the token is malformed and the
    # server rejects with "Unsupported authentication token, missing
    # key `scheme`" — the regression bulwark hit when their secret
    # resolved to an empty password.
    captured: Dict[str, Any] = {}

    def fake_run(argv, env=None, **_kwargs):
        captured["env"] = env
        return _FakeCompleted(returncode=0, stdout="", stderr="Syncing X\n")

    monkeypatch.setattr(subprocess, "run", fake_run)
    # Empty-password connection: both vars must be unset.
    plugin.handle(
        _build_request(
            config={"modules": ["aws"]},
            connection={
                "kind": "neo4j",
                "slug": "n",
                "options": {"uri": "bolt://x"},
                "secret": "",  # parses to user="neo4j", password=""
            },
        )
    )
    assert "NEO4J_USER" not in captured["env"], (
        "NEO4J_USER must NOT be set when there's no password — "
        "leaves cartography's neo4j-driver building a malformed auth token"
    )
    assert "NEO4J_PASSWORD" not in captured["env"]

    # Real-password connection: both vars set.
    plugin.handle(
        _build_request(
            config={"modules": ["aws"]},
            connection={
                "kind": "neo4j",
                "slug": "n",
                "options": {"uri": "bolt://x"},
                "secret": "neo4j:hunter2",
            },
        )
    )
    assert captured["env"]["NEO4J_USER"] == "neo4j"
    assert captured["env"]["NEO4J_PASSWORD"] == "hunter2"


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
