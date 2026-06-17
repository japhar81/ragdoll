"""``cloudquery_aws_sync`` plugin handler — Python sidecar implementation.

Why this lives in the python-plugins sidecar
--------------------------------------------
cloudquery is a Go binary, not a Python package and not a Node module.
Bundling it into the Node worker image (or worse, wrapping a Go bridge
into the worker) inflates the image and pulls Go-specific surface into
the Node runtime — exactly what the `plugin-sdk/transport` subpath
split exists to prevent. The sidecar is where every CLI-shaped data
source already lives (cartography is right next door); the cloudquery
binary installs as one extra layer in the sidecar Dockerfile and the
Node worker stays lean.

Seam discipline (the NON-NEGOTIABLE rule of this plugin)
--------------------------------------------------------
bulwark AUTHORS the pipeline that uses this plugin; bulwark owns the
canonical mapping (rows → RouteTable nodes — Z4) and the multi-source
merge (`Route exists?` — Z6). **RAGdoll PULLS only.** This handler:

  * runs `cloudquery sync` against a temp spec file (AWS source plugin
    → Postgres destination plugin),
  * reports per-table row counts parsed from cloudquery's structured
    JSON log output,
  * surfaces a sync envelope on `metadata` so the operator sees what
    ran.

It does NOTHING with the rows themselves. cloudquery's Postgres
destination owns the destination DDL and the row shape; bulwark reads
those tables from Postgres directly. If you find yourself reaching
for resolution / canonical-node logic in here, that's the seam being
crossed — push it back to bulwark.

Wire contract
-------------
The TS-side manifest declares `mode: "external"` pointing at this
sidecar. It serializes the resolved Postgres connection through the
ADR-0023 dataset envelope, so this handler reaches it via
``request.dataset.bindings.destination.connection``:

  - ``connection.kind``   — guaranteed to be ``"postgres"`` (manifest
                            ``requires: [{binding: "destination",
                            kind: "postgres"}]`` enforces it).
  - ``connection.secret`` — the resolved Postgres DSN, e.g.
                            ``postgres://user:pass@host:5432/db``. The
                            postgres driver uses DSN-as-the-secret;
                            we pass it straight to cloudquery's
                            postgresql destination plugin's
                            ``connection_string`` spec field.

AWS credentials come from ``request.secrets[credsSecretRef]`` as a
``.env``-style block (same shape as cartography_crawl) and are
exported into cloudquery's subprocess env.

Error model
-----------
Expected failures (binary missing, bad config, AWS creds-but-no-secret
plumb) → ``ValueError`` → ``ConnectError(INVALID_ARGUMENT)``;
cloudquery returning a non-zero exit → raise with the stderr tail
(loud — the operator should see the failure on the trace, not a
silently empty Postgres). Per-table row counts that come back as 0
are NOT a failure: an account with no route tables in the requested
region legitimately syncs 0 rows.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess  # noqa: S404 — shelling out to cloudquery is the design
import tempfile
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

PLUGIN_ID = "cloudquery_aws_sync"

# Keep in sync with `plugins/builtin-rag/src/cloudquery.ts:CLOUDQUERY_AWS_ALLOWED_TABLES`.
# A mismatch where the TS dropdown advertises a table this allowlist refuses
# is a split-source-of-truth bug — the same pattern cartography's parallel
# allowlist comment warns about.
CLOUDQUERY_AWS_ALLOWED_TABLES: Tuple[str, ...] = (
    # Route tables — the Z6a headline scope.
    "aws_ec2_route_tables",
    "aws_ec2_routes",
    # Network primitives — canonical IDs route tables reference.
    "aws_ec2_vpcs",
    "aws_ec2_subnets",
    "aws_ec2_internet_gateways",
    "aws_ec2_nat_gateways",
    "aws_ec2_transit_gateways",
    "aws_ec2_transit_gateway_attachments",
    "aws_ec2_vpc_peering_connections",
    "aws_ec2_vpc_endpoints",
    # Load balancers + listeners — exposure dimension joined against
    # route tables (target group IDs ↔ subnets).
    "aws_elbv2_load_balancers",
    "aws_elbv2_target_groups",
    "aws_elbv2_listeners",
)

CLOUDQUERY_WRITE_MODES: Tuple[str, ...] = (
    "overwrite",
    "append",
    "overwrite-delete-stale",
)

DEFAULT_TABLES: Tuple[str, ...] = ("aws_ec2_route_tables", "aws_ec2_routes")

# Default install location set up by the sidecar Dockerfile. Operators who
# install cloudquery elsewhere override via `config.cloudqueryBin`.
DEFAULT_BIN = "/opt/cloudquery/cloudquery"

DEFAULT_TIMEOUT_MS = 1_800_000  # 30 minutes — long multi-region syncs are normal

# Plugin versions pinned at build time. cloudquery's spec file pins the
# source + destination plugin versions independently of the CLI binary;
# bumping requires confirming bulwark's Z4 adapter still understands
# the row shape (cloudquery follows semver — major bumps can rename
# columns or split tables). Override at runtime via env if a tenant
# needs a specific build.
CLOUDQUERY_AWS_SOURCE_VERSION = os.environ.get(
    "CLOUDQUERY_AWS_SOURCE_VERSION", "v32.0.0"
)
CLOUDQUERY_POSTGRESQL_DEST_VERSION = os.environ.get(
    "CLOUDQUERY_POSTGRESQL_DEST_VERSION", "v8.0.0"
)

logger = logging.getLogger("ragdoll.python-plugins.cloudquery")


def _require_postgres_connection(request_dataset: Dict[str, Any]) -> Dict[str, Any]:
    """Pull the resolved postgres connection off the dataset envelope.

    Raises ValueError with an actionable message if the binding isn't
    present or isn't a postgres connection. Mirrors the TS-side
    requireXxxConnection helpers so log messages stay consistent.
    """
    bindings = (request_dataset or {}).get("bindings") or {}
    binding = bindings.get("destination")
    if not binding or not binding.get("connection"):
        raise ValueError(
            "cloudquery_aws_sync: node has no resolved 'destination' binding — "
            "wire a dataset whose `bindings.destination.connection` points at a "
            "postgres connection (cloudquery's native sink)."
        )
    conn = binding["connection"]
    if conn.get("kind") != "postgres":
        raise ValueError(
            "cloudquery_aws_sync: 'destination' binding must be backed by a postgres "
            f"connection (got kind={conn.get('kind')!r}, slug={conn.get('slug')!r})."
        )
    return conn


def _resolve_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize the per-node config.

    Raises ValueError on every malformed input — the bridge maps that
    to ConnectError(INVALID_ARGUMENT) so the operator sees the cause
    on the execution trace, not a generic INTERNAL.
    """
    cfg = dict(config or {})
    tables_raw = cfg.get("tables")
    if tables_raw is None:
        tables = list(DEFAULT_TABLES)
    elif not isinstance(tables_raw, list) or not tables_raw:
        raise ValueError(
            "cloudquery_aws_sync: config.tables must be a non-empty array (omit "
            "to use the default route-table set)."
        )
    else:
        tables = []
        for t in tables_raw:
            ts = str(t)
            if ts not in CLOUDQUERY_AWS_ALLOWED_TABLES:
                raise ValueError(
                    f"cloudquery_aws_sync: table {ts!r} is not in the allowlist. "
                    f"Allowed: {', '.join(CLOUDQUERY_AWS_ALLOWED_TABLES)}"
                )
            tables.append(ts)

    regions_raw = cfg.get("regions")
    regions: Optional[List[str]] = None
    if regions_raw is not None:
        if not isinstance(regions_raw, list):
            raise ValueError("cloudquery_aws_sync: config.regions must be an array")
        regions = [str(r) for r in regions_raw if str(r)]

    account_id = cfg.get("accountId")
    if account_id is not None and not isinstance(account_id, str):
        raise ValueError("cloudquery_aws_sync: config.accountId must be a string")

    write_mode = str(cfg.get("writeMode") or "overwrite")
    if write_mode not in CLOUDQUERY_WRITE_MODES:
        raise ValueError(
            f"cloudquery_aws_sync: unknown writeMode {write_mode!r} — "
            f"allowed: {', '.join(CLOUDQUERY_WRITE_MODES)}"
        )

    runner = str(cfg.get("runner") or "subprocess")
    if runner not in ("subprocess", "dry-run"):
        raise ValueError(f"cloudquery_aws_sync: unknown runner {runner!r}")

    cfg["_tables"] = tables
    cfg["_regions"] = regions
    cfg["_account_id"] = account_id
    cfg["_write_mode"] = write_mode
    cfg["_runner"] = runner
    cfg["_bin"] = str(cfg.get("cloudqueryBin") or DEFAULT_BIN)
    cfg["_timeout_ms"] = int(cfg.get("timeoutMs") or DEFAULT_TIMEOUT_MS)
    return cfg


def _parse_aws_env(creds_secret: Optional[str]) -> Dict[str, str]:
    """Parse a .env-style AWS credentials block into a dict of env vars.

    Mirrors the cartography_crawl behaviour: one `KEY=VALUE` per line,
    blank lines + `#` comments skipped, quoted values unquoted. Empty
    input → empty dict (caller may decide to surface a credsWarning).
    """
    out: Dict[str, str] = {}
    if not creds_secret:
        return out
    for raw in str(creds_secret).splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def _build_spec(
    *,
    tables: List[str],
    regions: Optional[List[str]],
    account_id: Optional[str],
    write_mode: str,
    pg_dsn: str,
) -> str:
    """Produce the YAML spec cloudquery's `sync` subcommand consumes.

    Two documents in one file (the cloudquery convention):
      1. source plugin block (AWS) — names the tables + regions + scope
      2. destination plugin block (postgresql) — connection_string + write_mode

    YAML is hand-rolled (no PyYAML dep in the main sidecar env). The
    structure is small + deterministic so manual emission is fine and
    avoids pulling another runtime dep into the sidecar's import chain.
    """
    aws_spec: Dict[str, Any] = {"regions": regions or ["*"]}
    if account_id:
        # cloudquery's AWS source plugin scopes via an `accounts` list;
        # passing a single id pins the sync to that account and refuses
        # cross-account creds (the "wrong-account creds" guard the
        # manifest description promises).
        aws_spec["accounts"] = [{"id": account_id, "local_profile": ""}]

    src = {
        "kind": "source",
        "spec": {
            "name": "aws",
            "registry": "cloudquery",
            "path": "cloudquery/aws",
            "version": CLOUDQUERY_AWS_SOURCE_VERSION,
            "tables": tables,
            "destinations": ["postgresql"],
            "spec": aws_spec,
        },
    }
    dst = {
        "kind": "destination",
        "spec": {
            "name": "postgresql",
            "registry": "cloudquery",
            "path": "cloudquery/postgresql",
            "version": CLOUDQUERY_POSTGRESQL_DEST_VERSION,
            "write_mode": write_mode,
            "spec": {"connection_string": pg_dsn},
        },
    }
    # Serialize each block as JSON inside a YAML "---" doc. JSON is a
    # strict subset of YAML 1.2, so this parses identically and avoids
    # needing PyYAML for a multi-doc emit.
    return (
        json.dumps(src, indent=2)
        + "\n---\n"
        + json.dumps(dst, indent=2)
        + "\n"
    )


# cloudquery's JSON log lines for a sync look like
#   {"level":"info","message":"table sync finished","table":"aws_ec2_routes","rows":15,"errors":0}
# (the exact shape varies slightly across CLI minor versions; the keys
# we care about — `table` + `rows` — have been stable). We parse every
# line and accumulate per-table counts. This is more reliable than
# `cloudquery sync --output json` which is currently inconsistent
# across plugin versions, and degrades gracefully (an unparseable line
# is skipped, not a sync failure).
def _parse_table_counts(stderr: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for raw in stderr.splitlines():
        line = raw.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        table = obj.get("table")
        rows = obj.get("rows")
        if not isinstance(table, str) or not isinstance(rows, (int, float)):
            continue
        # Some lines are intermediate ("rows synced so far"); we keep
        # the MAX seen per table so the final tally wins regardless of
        # how cloudquery chose to emit the progress log.
        counts[table] = max(counts.get(table, 0), int(rows))
    return counts


# Fallback parser: the human-readable end-of-sync banner cloudquery
# prints when JSON logging isn't engaged. Looks like
#   "Synced 1234 rows to table aws_ec2_routes"
# We use this as a defensive secondary signal so a JSON-log format
# change doesn't silently zero out the counts. Per-table; takes the
# max of the two parsers.
_BANNER_RE = re.compile(
    r"(?:synced|wrote)\s+(\d+)\s+rows?(?:\s+to)?\s+(?:table\s+)?(\w+)",
    re.IGNORECASE,
)


def _parse_banner_counts(text: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for match in _BANNER_RE.finditer(text):
        rows = int(match.group(1))
        table = match.group(2)
        counts[table] = max(counts.get(table, 0), rows)
    return counts


def handle(request) -> Dict[str, Any]:
    """ExecuteRequest -> {outputs.metadata, ...} envelope.

    Raises on every failure path (binary missing, non-zero exit, bad
    config) so the runtime surfaces it on the execution trace instead
    of reporting succeeded-with-empty-tables.
    """
    config: Dict[str, Any] = request.effective_config()
    cfg = _resolve_config(config)
    conn = _require_postgres_connection(request.dataset)
    target_slug = str(conn.get("slug") or "")
    pg_dsn = str(conn.get("secret") or "")

    # Provenance — same shape cartography_crawl uses (ADR-0030). We call
    # it `syncId` here because the noun upstream is "sync," but it
    # carries the same per-execution requestId. Falls back to a fresh
    # UUID for dry-runs / tests; production callers always carry one.
    sync_id = (
        getattr(request.context, "requestId", None) or str(uuid.uuid4())
    )
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    target_envelope = {
        "connectionSlug": target_slug,
        "database": (conn.get("options") or {}).get("database"),
    }

    if cfg["_runner"] == "dry-run":
        return {
            "outputs": {
                "metadata": {
                    "syncId": sync_id,
                    "startedAt": started_at,
                    "completedAt": started_at,
                    "mode": "dry-run",
                    "target": target_envelope,
                    "tables": [
                        {"table": t, "rowsSynced": 0} for t in cfg["_tables"]
                    ],
                    "totalRowsSynced": 0,
                }
            }
        }

    if not pg_dsn:
        raise ValueError(
            f"cloudquery_aws_sync: postgres connection {target_slug!r} has no "
            "resolved DSN secret — cloudquery's destination plugin needs a "
            "`postgres://user:pass@host:5432/db` connection string."
        )

    creds_secret_ref = config.get("credsSecretRef")
    secrets = request.secrets or {}
    creds_secret = (
        secrets.get(str(creds_secret_ref))
        if isinstance(creds_secret_ref, str)
        else secrets.get("creds")
    )
    creds_warning: Optional[str] = None
    if isinstance(creds_secret_ref, str) and not creds_secret:
        # The same "wired one half, not the other" trap cartography_crawl
        # surfaces. Without the AWS env vars cloudquery's AWS plugin
        # falls back to its default credential chain (instance profile
        # / shared file / SSO), which on a sidecar container almost
        # never finds anything — sync exits clean with zero rows.
        creds_warning = (
            f"credsSecretRef={creds_secret_ref!r} is set in config but no "
            f"matching entry was found in input.secrets — the spec node must "
            f"also declare `secrets: {{ {creds_secret_ref!s}: <secret-ref> }}` "
            f"so the runtime resolves it through the SecretProvider. "
            f"cloudquery ran without AWS creds and likely synced nothing."
        )
        logger.warning("cloudquery_aws_sync: %s", creds_warning)

    aws_env = _parse_aws_env(creds_secret if isinstance(creds_secret, str) else None)
    env = dict(os.environ)
    env.update(aws_env)

    spec_yaml = _build_spec(
        tables=cfg["_tables"],
        regions=cfg["_regions"],
        account_id=cfg["_account_id"],
        write_mode=cfg["_write_mode"],
        pg_dsn=pg_dsn,
    )

    # Write the spec to a temp file; cloudquery's `sync` takes a path
    # (or multiple paths) — there's no stdin mode. tempfile auto-cleans
    # on context exit; we keep delete=False because subprocess needs
    # the path to outlive the `with` block on some platforms.
    timeout_s = max(60, cfg["_timeout_ms"] // 1000)
    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".yml",
        prefix="cq-spec-",
        delete=False,
    ) as spec_file:
        spec_file.write(spec_yaml)
        spec_path = spec_file.name

    try:
        argv = [cfg["_bin"], "sync", spec_path, "--log-format", "json"]
        sync_started = time.time()
        try:
            result = subprocess.run(  # noqa: S603 — argv from validated config
                argv,
                env=env,
                timeout=timeout_s,
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError as exc:
            raise ValueError(
                "cloudquery_aws_sync: cloudquery binary not found in the python-plugins "
                "sidecar — rebuild the image with cloudquery installed (the Dockerfile "
                "installs the static binary into /opt/cloudquery/cloudquery)."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ValueError(
                f"cloudquery_aws_sync: sync exceeded the per-call timeout "
                f"({timeout_s}s — raise config.timeoutMs for larger fleets)."
            ) from exc

        stdout_tail = (result.stdout or "")[-4096:]
        stderr_tail = (result.stderr or "")[-4096:]

        # Two independent count parsers; take the max so a JSON-log
        # format change doesn't silently zero out the row counts.
        json_counts = _parse_table_counts(result.stderr or "")
        banner_counts = _parse_banner_counts((result.stdout or "") + (result.stderr or ""))
        per_table_counts: Dict[str, int] = {}
        for table in cfg["_tables"]:
            per_table_counts[table] = max(
                json_counts.get(table, 0), banner_counts.get(table, 0)
            )

        completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        tables_envelope: List[Dict[str, Any]] = [
            {"table": t, "rowsSynced": per_table_counts.get(t, 0)}
            for t in cfg["_tables"]
        ]
        total_rows = sum(per_table_counts.values())
        metadata: Dict[str, Any] = {
            "syncId": sync_id,
            "startedAt": started_at,
            "completedAt": completed_at,
            "mode": "subprocess",
            "target": target_envelope,
            "tables": tables_envelope,
            "totalRowsSynced": total_rows,
            "durationMs": int((time.time() - sync_started) * 1000),
            "exitCode": result.returncode,
            "cloudqueryStdoutTail": stdout_tail,
            "cloudqueryStderrTail": stderr_tail,
        }
        if creds_warning:
            metadata["credsWarning"] = creds_warning

        if result.returncode != 0:
            # Loud failure — operator sees the actual cloudquery stderr
            # on the trace. err.metadata is the full envelope so the
            # debugger can pluck it off.
            err = ValueError(
                f"cloudquery_aws_sync: sync exited {result.returncode} — "
                f"stderr tail: {stderr_tail[-512:]}"
            )
            err.metadata = metadata  # type: ignore[attr-defined]
            raise err

        return {"outputs": {"metadata": metadata}}
    finally:
        try:
            os.unlink(spec_path)
        except OSError:
            pass
