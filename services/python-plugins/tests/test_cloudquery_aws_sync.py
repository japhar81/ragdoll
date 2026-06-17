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
import os
import subprocess
from typing import Any, Dict, List

import pytest

from app.plugins import cloudquery_aws_sync_plugin as plugin


# The handler short-circuits with a loud error when registry=local and
# either plugin binary is missing from disk. That's the right behaviour
# in the sidecar (where the Dockerfile installs the binaries), but in
# the pytest environment those paths don't exist. Auto-mock
# `os.path.exists` to return True for the cq-plugins paths so the rest
# of the test surface (config validation, spec emission, subprocess
# path) is reachable. Tests that specifically exercise the
# missing-binary guard set `_plugin_paths_exist` to False locally.
@pytest.fixture(autouse=True)
def _plugin_paths_exist(monkeypatch):
    real_exists = os.path.exists

    def fake_exists(p):
        if isinstance(p, str) and p.startswith("/opt/cq-plugins/"):
            return True
        return real_exists(p)

    monkeypatch.setattr(os.path, "exists", fake_exists)
    return fake_exists


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
    """Default postgres connection — DSN lives in `options.url` /
    `options.connectionString` AND in discrete fields, mirroring
    EXACTLY what bulwark writes into the connection record:

        SELECT jsonb_pretty(config) FROM connections WHERE kind='postgres';
        →  { url, connectionString, host, port, user, password,
             database, sslmode }

    `secret` is None — bulwark's connection has no separate secret-ref;
    everything is in the options blob. The handler resolves this via
    `_resolve_pg_dsn`'s precedence ladder.
    """
    return {
        "kind": "postgres",
        "slug": slug,
        "options": {
            "url": "postgres://bulwark:bulwark@host.docker.internal:5442/bulwark",
            "connectionString": "postgres://bulwark:bulwark@host.docker.internal:5442/bulwark",
            "host": "host.docker.internal",
            "port": 5442,
            "user": "bulwark",
            "password": "bulwark",
            "database": "bulwark",
            "sslmode": "disable",
        },
        "secret": None,
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


def test_rejects_when_no_dsn_anywhere_on_connection():
    # No `options.connectionString` / `url` / discrete fields, no
    # `secret` either — handler must refuse loudly with an
    # actionable message naming every place it looked.
    req = _build_request(
        config={},
        connection={"kind": "postgres", "slug": "pg", "options": {}, "secret": None},
    )
    with pytest.raises(
        ValueError, match="did not yield a usable DSN.*options.connectionString.*options.url",
    ):
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
    # CRITICAL — registry MUST default to `local` (OSS path, no
    # CloudQuery Hub login required). A regression that flips this back
    # to `cloudquery` breaks every operator without a Hub account.
    assert src["spec"]["registry"] == "local"
    # And `path` MUST be the on-disk binary location, NOT the Hub
    # plugin slug `cloudquery/aws`.
    assert src["spec"]["path"] == "/opt/cq-plugins/source-aws"
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
    # Destination registry + path mirror the source — `local` with the
    # on-disk binary.
    assert dst["spec"]["registry"] == "local"
    assert dst["spec"]["path"] == "/opt/cq-plugins/destination-postgresql"
    # The PG DSN is resolved from the BOUND CONNECTION's options
    # (bulwark writes `url` + `connectionString` + discrete fields
    # into the connection.config blob — see _pg_conn). The seam
    # discipline still holds: no host/port/dsn exposed in plugin
    # config; we only read from the dataset binding.
    assert dst["spec"]["spec"] == {
        "connection_string": "postgres://bulwark:bulwark@host.docker.internal:5442/bulwark?sslmode=disable"
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


def test_missing_plugin_binary_under_registry_local_raises_actionable_error(monkeypatch):
    # When the sidecar image was built without the plugin binaries (or
    # the operator pointed `awsPluginPath` at a path that doesn't
    # exist), we MUST refuse loudly BEFORE invoking cloudquery — a
    # cryptic exec error from cloudquery is much harder to act on.
    # Override the autouse fixture so the paths really look missing.
    real_exists = os.path.exists
    monkeypatch.setattr(os.path, "exists", real_exists)
    req = _build_request(
        config={"awsPluginPath": "/does/not/exist/aws-plugin"},
        connection=_pg_conn(),
    )
    with pytest.raises(ValueError, match="awsPluginPath.*does not exist"):
        plugin.handle(req)


def test_registry_grpc_skips_path_existence_check(monkeypatch):
    # `registry: grpc` means `path` is a network address, not a file —
    # the existence check MUST NOT fire on it. Operator points cloudquery
    # at an out-of-band plugin process and the sync proceeds.
    real_exists = os.path.exists
    monkeypatch.setattr(os.path, "exists", real_exists)

    captured: Dict[str, Any] = {}

    def fake_run(argv, env=None, timeout=None, capture_output=False, text=False, check=False):
        with open(argv[2], encoding="utf-8") as f:
            captured["spec"] = f.read()
        return _FakeCompleted(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    req = _build_request(
        config={
            "registry": "grpc",
            "awsPluginPath": "localhost:7777",
            "pgPluginPath": "localhost:7778",
        },
        connection=_pg_conn(),
    )
    out = plugin.handle(req)
    assert out["outputs"]["metadata"]["exitCode"] == 0
    src_yaml, _, dst_yaml = captured["spec"].partition("\n---\n")
    src = json.loads(src_yaml)
    dst = json.loads(dst_yaml)
    assert src["spec"]["registry"] == "grpc"
    assert src["spec"]["path"] == "localhost:7777"
    assert dst["spec"]["registry"] == "grpc"
    assert dst["spec"]["path"] == "localhost:7778"


def test_rejects_unknown_registry():
    req = _build_request(
        config={"registry": "no-such-registry"},
        connection=_pg_conn(),
    )
    with pytest.raises(ValueError, match="unknown registry"):
        plugin.handle(req)


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
    # The warning names the missing companion declaration (the
    # `secrets: { <name>: <secret-ref> }` block on the spec node)
    # so the operator can act on it without a docs lookup.
    assert "secrets:" in meta["credsWarning"]
    assert "spec node" in meta["credsWarning"]


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


# ---------------------------------------------------------------------------
# PG DSN resolution ladder — `_resolve_pg_dsn` covers four shapes a
# bound postgres connection can arrive in. These tests pin each rung
# of the ladder so a future contributor refactoring the resolver
# can't silently drop a path that bulwark (or a legacy operator)
# depends on.
# ---------------------------------------------------------------------------


def test_resolve_pg_dsn_prefers_options_connectionString_over_url():
    # Bulwark sends BOTH `connectionString` and `url`. They should be
    # equal in practice, but the resolver picks `connectionString`
    # first — that's the canonical key in bulwark's
    # connectionConfigFor("postgres") shape.
    conn = {
        "options": {
            "connectionString": "postgres://A@a/db1",
            "url": "postgres://B@b/db2",
            "host": "ignored",
        }
    }
    assert plugin._resolve_pg_dsn(conn) == "postgres://A@a/db1?sslmode=disable"


def test_resolve_pg_dsn_falls_back_to_options_url_when_connectionString_missing():
    conn = {"options": {"url": "postgres://x@h/db"}}
    assert plugin._resolve_pg_dsn(conn) == "postgres://x@h/db?sslmode=disable"


def test_resolve_pg_dsn_assembles_from_discrete_fields_when_no_dsn_string():
    # The path some operators wire when their connection authoring UI
    # exposes per-field inputs instead of a full DSN. Must produce a
    # libpq-parseable DSN with port + sslmode threaded through.
    conn = {
        "options": {
            "host": "host.docker.internal",
            "port": 5442,
            "user": "bulwark",
            "password": "bulwark",
            "database": "bulwark",
            "sslmode": "disable",
        }
    }
    assert (
        plugin._resolve_pg_dsn(conn)
        == "postgres://bulwark:bulwark@host.docker.internal:5442/bulwark?sslmode=disable"
    )


def test_resolve_pg_dsn_percent_encodes_special_chars_in_credentials():
    # A password like `p:ss/w@rd` would otherwise break the DSN parser.
    conn = {
        "options": {
            "host": "h",
            "user": "u@x",
            "password": "p:ss/w@rd",
            "database": "db",
        }
    }
    out = plugin._resolve_pg_dsn(conn)
    # The user `u@x` and password `p:ss/w@rd` are percent-encoded;
    # the host is left alone.
    assert "u%40x" in out
    assert "p%3Ass%2Fw%40rd" in out
    assert "@h/db" in out


def test_resolve_pg_dsn_falls_back_to_connection_secret_when_options_empty():
    # The historical RAGdoll postgres-core convention (ADR-0024):
    # connections that pre-date bulwark's options-as-config shape
    # carry the DSN in `secret`. The resolver still honors them.
    conn = {"options": {}, "secret": "postgres://legacy@h/db"}
    assert plugin._resolve_pg_dsn(conn) == "postgres://legacy@h/db?sslmode=disable"


def test_resolve_pg_dsn_returns_empty_when_nothing_to_work_with():
    assert plugin._resolve_pg_dsn({}) == ""
    assert plugin._resolve_pg_dsn({"options": {}, "secret": ""}) == ""
    # `options.host` alone (no database) isn't enough to assemble.
    assert plugin._resolve_pg_dsn({"options": {"host": "h"}}) == ""


def test_ensure_sslmode_disable_default_appends_when_absent():
    assert (
        plugin._ensure_sslmode_disable_default("postgres://u@h/db")
        == "postgres://u@h/db?sslmode=disable"
    )
    # Already has a query string → append with `&`, not a second `?`.
    assert (
        plugin._ensure_sslmode_disable_default("postgres://u@h/db?foo=1")
        == "postgres://u@h/db?foo=1&sslmode=disable"
    )


def test_ensure_sslmode_disable_NEVER_overrides_explicit_sslmode():
    # Operator pinning `sslmode=require` (or any other value) MUST
    # keep that value — never silently downgrade to disable.
    for dsn in (
        "postgres://u@h/db?sslmode=require",
        "postgres://u@h/db?sslmode=verify-full",
        "postgres://u@h/db?sslmode=disable",
        "postgres://u@h/db?foo=1&sslmode=require&bar=2",
    ):
        assert plugin._ensure_sslmode_disable_default(dsn) == dsn


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
