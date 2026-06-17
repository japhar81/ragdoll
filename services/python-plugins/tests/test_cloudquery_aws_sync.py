"""Unit tests for the ``cloudquery_aws_sync`` Python handler.

These cover the contract the Node-side manifest promises: configuration
shape, spec-YAML emission (source + destination blocks), env injection,
exit handling, the dry-run envelope, per-table row-count parsing from
cloudquery's structured log output, and the seam-discipline guarantee
that the handler computes NOTHING about the rows themselves.

The real ``cloudquery`` binary is monkeypatched via ``subprocess.run``
so the test suite never actually syncs AWS. Lives next to the other
in-container plugin tests and runs via ``poetry run pytest`` inside
the python-plugins service.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any, Dict, List

import pytest

from app.plugins import cloudquery_aws_sync_plugin as plugin


def _build_request(
    *,
    config: Dict[str, Any],
    connection: Dict[str, Any] | None = None,
    secrets: Dict[str, Any] | None = None,
    request_id: str | None = "req-1",
):
    """Construct an ExecuteRequest the handler accepts.

    Mirrors ``_build_request`` in test_cartography_crawl.py; the handler
    reaches the postgres connection through
    ``request.dataset.bindings.destination.connection``.
    """
    from app.models import ExecuteRequest

    context: Dict[str, Any] = {
        "tenantId": "tenant-1",
        "environment": "test",
        "resolvedConfig": {"values": {}},
    }
    if request_id is not None:
        context["requestId"] = request_id
    body = {
        "plugin": {"category": "datasource", "id": "cloudquery_aws_sync", "version": "1.0.0"},
        "node": {"id": "n1", "config": {}, "secrets": {}},
        "inputs": {},
        "config": config,
        "secrets": secrets or {},
        "dataset": (
            {"bindings": {"destination": {"connection": connection}}}
            if connection is not None
            else {}
        ),
        "context": context,
    }
    return ExecuteRequest.model_validate(body)


def _pg_conn(slug: str = "bulwark-pg") -> Dict[str, Any]:
    return {
        "kind": "postgres",
        "slug": slug,
        "options": {"database": "bulwark"},
        # Postgres uses DSN-as-the-secret (postgres-core.ts) — the
        # handler hands this straight to cloudquery's destination spec.
        "secret": "postgres://cq:hunter2@db:5432/bulwark",
    }


# ---------------------------------------------------------------------------
# config validation
# ---------------------------------------------------------------------------


def test_rejects_table_outside_the_allowlist():
    req = _build_request(
        config={"tables": ["aws_iam_users"]},  # NOT in the allowlist
        connection=_pg_conn(),
    )
    with pytest.raises(ValueError, match="not in the allowlist"):
        plugin.handle(req)


def test_rejects_empty_tables_array_but_allows_omitted():
    # Omitted → uses the default route-table set (the Z6a headline).
    req_default = _build_request(config={"runner": "dry-run"}, connection=_pg_conn())
    out = plugin.handle(req_default)
    tables = [t["table"] for t in out["outputs"]["metadata"]["tables"]]
    assert tables == ["aws_ec2_route_tables", "aws_ec2_routes"]
    # Explicit empty array → loud refusal (likely an operator config bug).
    req_empty = _build_request(config={"tables": []}, connection=_pg_conn())
    with pytest.raises(ValueError, match="non-empty array"):
        plugin.handle(req_empty)


def test_rejects_unknown_write_mode():
    req = _build_request(
        config={"writeMode": "no-such-mode"},
        connection=_pg_conn(),
    )
    with pytest.raises(ValueError, match="unknown writeMode"):
        plugin.handle(req)


def test_rejects_missing_destination_binding():
    req = _build_request(config={}, connection=None)
    with pytest.raises(ValueError, match="resolved 'destination' binding"):
        plugin.handle(req)


def test_rejects_non_postgres_destination_kind():
    req = _build_request(
        config={},
        connection={"kind": "qdrant", "slug": "vectors"},
    )
    with pytest.raises(ValueError, match="must be backed by a postgres"):
        plugin.handle(req)


def test_rejects_missing_pg_dsn_secret():
    req = _build_request(
        config={},
        connection={"kind": "postgres", "slug": "pg", "secret": ""},
    )
    with pytest.raises(ValueError, match="has no resolved DSN secret"):
        plugin.handle(req)


# ---------------------------------------------------------------------------
# dry-run mode
# ---------------------------------------------------------------------------


def test_dry_run_emits_synthetic_metadata_no_subprocess(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("subprocess.run called in dry-run mode")

    monkeypatch.setattr(subprocess, "run", boom)
    req = _build_request(
        config={
            "tables": ["aws_ec2_route_tables", "aws_ec2_routes"],
            "runner": "dry-run",
        },
        connection=_pg_conn("bulwark-pg"),
    )
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert meta["mode"] == "dry-run"
    assert meta["target"] == {"connectionSlug": "bulwark-pg", "database": "bulwark"}
    assert [t["table"] for t in meta["tables"]] == [
        "aws_ec2_route_tables",
        "aws_ec2_routes",
    ]
    assert all(t["rowsSynced"] == 0 for t in meta["tables"])
    assert meta["syncId"] == "req-1"


# ---------------------------------------------------------------------------
# subprocess path
# ---------------------------------------------------------------------------


class _FakeCompleted:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_subprocess_writes_two_doc_yaml_spec_and_invokes_cloudquery(monkeypatch):
    captured: Dict[str, Any] = {}

    def fake_run(argv, env=None, timeout=None, capture_output=False, text=False, check=False):
        captured["argv"] = argv
        captured["env"] = env
        captured["timeout"] = timeout
        # Read the spec file the handler wrote — argv[2] is the path.
        with open(argv[2], encoding="utf-8") as f:
            captured["spec"] = f.read()
        # Mimic cloudquery emitting "table sync finished" JSON log lines.
        stderr = "\n".join(
            json.dumps(
                {
                    "level": "info",
                    "message": "table sync finished",
                    "table": t,
                    "rows": rows,
                }
            )
            for t, rows in (
                ("aws_ec2_route_tables", 42),
                ("aws_ec2_routes", 1337),
            )
        )
        return _FakeCompleted(returncode=0, stdout="done\n", stderr=stderr)

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={
            "tables": ["aws_ec2_route_tables", "aws_ec2_routes"],
            "regions": ["us-east-1", "eu-west-1"],
            "accountId": "123456789012",
            "credsSecretRef": "aws-prod",
        },
        connection=_pg_conn("bulwark-pg"),
        secrets={
            "aws-prod": "AWS_ACCESS_KEY_ID=AKIA\nAWS_SECRET_ACCESS_KEY=secret"
        },
    )
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]

    # argv: <bin> sync <spec-path> --log-format json
    assert captured["argv"][0] == "/opt/cloudquery/cloudquery"
    assert captured["argv"][1] == "sync"
    assert captured["argv"][3:] == ["--log-format", "json"]
    # The spec file the handler wrote is a TWO-doc YAML: a source block
    # (kind: source, AWS) and a destination block (kind: destination,
    # postgresql) separated by `---`. Each block is valid JSON (a strict
    # subset of YAML) so we can json.loads each half.
    src_yaml, _, dst_yaml = captured["spec"].partition("\n---\n")
    src = json.loads(src_yaml)
    dst = json.loads(dst_yaml)
    assert src["kind"] == "source"
    assert src["spec"]["name"] == "aws"
    assert src["spec"]["path"] == "cloudquery/aws"
    assert src["spec"]["tables"] == [
        "aws_ec2_route_tables",
        "aws_ec2_routes",
    ]
    assert src["spec"]["destinations"] == ["postgresql"]
    aws_spec = src["spec"]["spec"]
    assert aws_spec["regions"] == ["us-east-1", "eu-west-1"]
    # accountId scopes the sync — cloudquery's `accounts` array.
    assert aws_spec["accounts"] == [{"id": "123456789012", "local_profile": ""}]
    assert dst["kind"] == "destination"
    assert dst["spec"]["name"] == "postgresql"
    # The PG DSN comes from connection.secret, NOT from any config knob
    # — the seam discipline (host/port/dsn not exposed in config).
    assert dst["spec"]["spec"] == {
        "connection_string": "postgres://cq:hunter2@db:5432/bulwark"
    }
    # Default writeMode is "overwrite" — safest for evidence pulls.
    assert dst["spec"]["write_mode"] == "overwrite"

    # AWS creds env exported into cloudquery's subprocess env.
    assert captured["env"]["AWS_ACCESS_KEY_ID"] == "AKIA"
    assert captured["env"]["AWS_SECRET_ACCESS_KEY"] == "secret"

    # Per-table row counts parsed from the JSON log stream.
    by_table = {t["table"]: t["rowsSynced"] for t in meta["tables"]}
    assert by_table == {"aws_ec2_route_tables": 42, "aws_ec2_routes": 1337}
    assert meta["totalRowsSynced"] == 42 + 1337
    assert meta["mode"] == "subprocess"
    assert meta["exitCode"] == 0
    # Provenance: syncId derives from RuntimeContext.requestId.
    assert meta["syncId"] == "req-1"


def test_zero_rows_per_table_is_NOT_a_failure_just_an_empty_account(monkeypatch):
    # An account with no route tables in the requested region legitimately
    # syncs 0 rows. We must NOT treat that as a failure — bulwark's
    # close-by-absence (Z6) consumes empty syncs the same way it consumes
    # populated ones, so long as the sync itself completed cleanly.
    def fake_run(argv, env=None, timeout=None, capture_output=False, text=False, check=False):
        return _FakeCompleted(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(config={}, connection=_pg_conn())
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert meta["exitCode"] == 0
    assert meta["totalRowsSynced"] == 0
    assert all(t["rowsSynced"] == 0 for t in meta["tables"])


def test_non_zero_exit_raises_loudly_with_stderr_tail_in_envelope(monkeypatch):
    def fake_run(argv, env=None, timeout=None, capture_output=False, text=False, check=False):
        return _FakeCompleted(
            returncode=2,
            stdout="",
            stderr=(
                'time="..." level=error msg="failed to authenticate AWS: '
                'AccessDenied: User is not authorized to perform: ec2:DescribeRouteTables"'
            ),
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(config={}, connection=_pg_conn())
    with pytest.raises(ValueError) as exc:
        plugin.handle(req)
    msg = str(exc.value)
    assert "exited 2" in msg
    assert "AccessDenied" in msg
    # Full envelope attached so a debugger / trace can pluck it off.
    meta = exc.value.metadata  # type: ignore[attr-defined]
    assert meta["exitCode"] == 2
    assert "AccessDenied" in meta["cloudqueryStderrTail"]


def test_missing_cloudquery_binary_raises_actionable_error(monkeypatch):
    def fake_run(*args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "cloudquery")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(config={}, connection=_pg_conn())
    with pytest.raises(ValueError, match="cloudquery binary not found"):
        plugin.handle(req)


def test_credsSecretRef_set_but_no_matching_secret_attaches_credsWarning(monkeypatch):
    # Same operator-trap cartography_crawl surfaces: ref set in config
    # but no companion `node.secrets` declaration → cloudquery silently
    # runs without AWS env vars → empty sync. We must FLAG this.
    def fake_run(argv, env=None, timeout=None, capture_output=False, text=False, check=False):
        return _FakeCompleted(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={"credsSecretRef": "aws-prod"},  # ref present
        connection=_pg_conn(),
        secrets={},  # but nothing resolves the name
    )
    out = plugin.handle(req)
    meta = out["outputs"]["metadata"]
    assert "credsWarning" in meta
    assert "aws-prod" in meta["credsWarning"]
    assert "node.secrets" in meta["credsWarning"]


def test_seam_discipline_handler_emits_only_telemetry_no_row_payload(monkeypatch):
    # The single most important assertion in this file: the handler
    # does NOT carry the synced rows in its output. cloudquery's
    # postgres sink wrote them; bulwark reads them from postgres
    # directly. If a future contributor adds e.g. `outputs.rows` or
    # `outputs.routes`, that's the seam being crossed — this test
    # fails until they push that logic back to bulwark.
    def fake_run(argv, env=None, timeout=None, capture_output=False, text=False, check=False):
        return _FakeCompleted(
            returncode=0,
            stdout="done",
            stderr=json.dumps(
                {"table": "aws_ec2_routes", "rows": 5, "message": "table sync finished"}
            ),
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(config={}, connection=_pg_conn())
    out = plugin.handle(req)
    # Only `metadata` (the telemetry envelope) — no `rows` / `data` /
    # `routes` / etc. RAGdoll's job ends at "rows are in Postgres."
    assert set(out["outputs"].keys()) == {"metadata"}


# ---------------------------------------------------------------------------
# count parser — defensive secondary signal
# ---------------------------------------------------------------------------


def test_parse_table_counts_takes_max_of_progress_lines():
    # cloudquery sometimes emits intermediate "rows synced so far"
    # lines; the final tally should win.
    stderr = "\n".join(
        [
            json.dumps({"table": "aws_ec2_routes", "rows": 100}),
            json.dumps({"table": "aws_ec2_routes", "rows": 250}),
            json.dumps({"table": "aws_ec2_routes", "rows": 500}),
        ]
    )
    counts = plugin._parse_table_counts(stderr)
    assert counts == {"aws_ec2_routes": 500}


def test_parse_table_counts_skips_unparseable_lines_without_failing():
    stderr = (
        "this is not json\n"
        + json.dumps({"table": "aws_ec2_routes", "rows": 7})
        + "\nsome other noise"
    )
    assert plugin._parse_table_counts(stderr) == {"aws_ec2_routes": 7}


def test_parse_banner_counts_as_defensive_fallback():
    # When JSON logging isn't engaged (or cloudquery's keys change),
    # the human-readable banner is the secondary signal. We take the
    # max of the two parsers so one regressing silently doesn't zero
    # out the counts.
    text = (
        "Some progress noise\n"
        "Synced 123 rows to table aws_ec2_route_tables\n"
        "Wrote 4567 rows to aws_ec2_routes\n"
    )
    counts = plugin._parse_banner_counts(text)
    assert counts["aws_ec2_route_tables"] == 123
    assert counts["aws_ec2_routes"] == 4567
