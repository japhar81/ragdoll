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
    # Per-module entries in metadata.modules — both `complete`, each
    # carries a durationMs and an entityTypes list (the contract
    # bulwark gates close-by-absence on).
    assert [m["status"] for m in meta["modules"]] == ["complete", "complete"]
    assert all("durationMs" in m for m in meta["modules"])
    assert all(m["entityTypes"] for m in meta["modules"])
    # env identical across invocations and carries neo4j creds + the
    # parsed AWS creds-block keys.
    for inv in invocations:
        env = inv["env"]
        assert env["NEO4J_URI"] == "bolt://neo4j:7687"
        assert env["NEO4J_USER"] == "neo4j"
        assert env["NEO4J_PASSWORD"] == "hunter2"
        assert env["AWS_ACCESS_KEY_ID"] == "AKIA"
        assert env["AWS_SECRET_ACCESS_KEY"] == "secret"


def test_structurally_incompatible_module_is_excluded_crawl_completes(monkeypatch):
    # bulwark's exact pattern: identitycenter throws ValidationException
    # for a non-org account. That's STRUCTURAL — the module can never
    # succeed on this account/config. We classify it as `excluded`,
    # log it, and the rest of the crawl proceeds AS COMPLETE.
    #
    # This is the safe behaviour: excluded modules' entity types simply
    # aren't collected from this source. bulwark's projection will skip
    # close-by-absence on those types but reconcile every other module
    # normally. No tombstoning.
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
    out = plugin.handle(req)  # no raise — the excluded module is safe
    meta = out["outputs"]["metadata"]
    assert calls == ["aws", "identitycenter", "gcp"]
    statuses = {m["module"]: m["status"] for m in meta["modules"]}
    assert statuses == {
        "aws": "complete",
        "identitycenter": "excluded",
        "gcp": "complete",
    }
    # Every module entry carries entityTypes — the contract bulwark
    # gates close-by-absence on.
    by_module = {m["module"]: m for m in meta["modules"]}
    assert "EC2Instance" in by_module["aws"]["entityTypes"]
    assert "AWSPermissionSet" in by_module["identitycenter"]["entityTypes"]
    assert "GCPProject" in by_module["gcp"]["entityTypes"]
    # The excluded entry carries the actual matched line as `reason`
    # so the operator sees the structural cause without digging.
    assert "IAM Identity Center" in by_module["identitycenter"]["reason"]
    # Top-level summary so the operator spots partial coverage at a
    # glance without scanning the per-module list.
    assert "excludedSummary" in meta
    assert "identitycenter" in meta["excludedSummary"]
    # No `warning` field for failed modules — there ARE no failed
    # modules, just an excluded one.


def test_excluded_recognises_each_canonical_pattern(monkeypatch):
    # Spot-check that the classifier matches the canonical phrases we
    # documented in _EXCLUDED_SUBSTRINGS — not exhaustive, but covers
    # the AWS / GCP / regional / API-not-enabled flavours.
    cases = [
        ("not supported for account instances of IAM Identity Center", True),
        ("This API method only works on IAM Identity Center instances of type", True),
        ("OptInRequired: This service is not supported in this region.", True),
        ("API has not been enabled for project 'foo'", True),
        ("Cloud Resource Manager API has not been used in project 12345", True),
        # Genuine transient errors stay FAILED.
        ("ThrottlingException: Rate exceeded", False),
        ("AccessDenied: User isn't authorized", False),
        ("ConnectionTimeoutError", False),
    ]
    from app.plugins import cartography_crawl_plugin as p
    for stderr_text, should_exclude in cases:
        status, reason = p.classify_module_outcome(1, stderr_text)
        if should_exclude:
            assert status == "excluded", f"expected excluded for: {stderr_text!r}"
        else:
            assert status == "failed", f"expected failed for: {stderr_text!r}"


def test_transient_module_failure_is_fatal_loud(monkeypatch):
    # Throttling / generic API error / network glitch ≠ structural. The
    # module *might* have produced data; absence is uninformative; close-
    # by-absence downstream would tombstone live assets. So the handler
    # RAISES — loud failure is safer than silent partial.
    def fake_run(argv: List[str], **_kwargs):
        module = argv[argv.index("--selected-modules") + 1]
        if module == "gcp":
            return _FakeCompleted(
                returncode=1,
                stdout="",
                stderr=(
                    "google.api_core.exceptions.ServiceUnavailable: 503 Backend Error\n"
                ),
            )
        return _FakeCompleted(
            returncode=0, stdout="ok\n", stderr=f"Syncing for {module}\n"
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws", "gcp"]},
        connection={
            "kind": "neo4j",
            "slug": "n",
            "options": {"uri": "bolt://x"},
            "secret": "neo4j:pw",
        },
    )
    with pytest.raises(ValueError) as exc_info:
        plugin.handle(req)
    # Error message carries the full per-module breakdown so the trace
    # shows what completed before the failure.
    msg = str(exc_info.value)
    assert "FAILED" in msg
    assert "gcp" in msg
    assert "Backend Error" in msg
    # The full metadata envelope is preserved on the exception so a
    # debugger can reach the entityTypes / per-module statuses without
    # re-running.
    meta = getattr(exc_info.value, "metadata", None)
    assert meta is not None
    statuses = {m["module"]: m["status"] for m in meta["modules"]}
    assert statuses == {"aws": "complete", "gcp": "failed"}


def test_timeout_is_transient_and_therefore_fatal(monkeypatch):
    # Timeout could be a slow account or a network problem. Either way
    # we can't tell if the module would have completed, so it's a
    # `failed` (not `excluded`) — and the handler raises.
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
    with pytest.raises(ValueError) as exc_info:
        plugin.handle(req)
    meta = getattr(exc_info.value, "metadata", None)
    assert meta is not None
    aws_entry = next(m for m in meta["modules"] if m["module"] == "aws")
    assert aws_entry["status"] == "failed"
    assert "timed out" in aws_entry["reason"]


def test_all_modules_complete_returns_normally_with_per_module_status(monkeypatch):
    # Happy path: every module exit 0. Per-module status of `complete`,
    # entityTypes attached, no excludedSummary / warning.
    def fake_run(argv: List[str], **_kwargs):
        module = argv[argv.index("--selected-modules") + 1]
        return _FakeCompleted(
            returncode=0, stdout="ok\n", stderr=f"Syncing for {module}\n"
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"modules": ["aws", "gcp"]},
        connection={"kind": "neo4j", "slug": "n", "options": {"uri": "bolt://x"}, "secret": "neo4j:pw"},
    )
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert all(m["status"] == "complete" for m in meta["modules"])
    assert "excludedSummary" not in meta
    assert "warning" not in meta
    assert meta["exitCode"] == 0
    # Every module carries its entityTypes list.
    by_module = {m["module"]: m for m in meta["modules"]}
    assert by_module["aws"]["entityTypes"], "aws must publish entityTypes"
    assert by_module["gcp"]["entityTypes"], "gcp must publish entityTypes"


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


def test_exit_zero_with_no_sync_output_keeps_status_complete_but_warns(monkeypatch):
    # The "creds are known-good but no data" scenario: cartography
    # exits 0 silently because the AWS SDK default chain found nothing
    # in the sidecar's env, so no boto3 calls happened, so no
    # "Syncing X for account Y" lines were logged.
    #
    # Per the three-way contract (complete / excluded / failed) the
    # status stays `complete` — cartography said it finished. We do
    # NOT silently demote a clean exit to a non-complete bucket; that
    # would risk bulwark gating close-by-absence on the wrong signal.
    # Instead we attach a top-level `warning` that the heuristic spotted
    # no sync activity, so the operator can investigate without the
    # module's outcome being misclassified.
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
    assert all(m["status"] == "complete" for m in meta["modules"])
    assert "warning" in meta
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
