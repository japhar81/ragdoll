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
import urllib.parse
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

# Plugin paths + versions — `registry: local` path (OSS, no Hub login).
#
# The cloudquery CLI's default registry (`cloudquery`) pulls plugins
# from CloudQuery Hub which now requires `cloudquery login` even for
# the OSS plugins. We pre-download the plugin BINARIES into the sidecar
# image (see services/python-plugins/Dockerfile) and run them via
# `registry: local` — cloudquery just exec()s them; no auth, no
# network, no docker-in-docker.
#
# Defaults match the Dockerfile-installed binaries. The `version`
# field on `registry: local` specs is informational (carried for the
# trace + cloudquery internals); the actual binary is the one at
# `path`. Operators with a private mirror can override either via
# env (CLOUDQUERY_*) or per-node config (`awsPluginPath` /
# `pgPluginPath` / `awsPluginVersion` / `pgPluginVersion`).
CLOUDQUERY_AWS_PLUGIN_PATH = os.environ.get(
    "CLOUDQUERY_AWS_PLUGIN_PATH", "/opt/cq-plugins/source-aws"
)
CLOUDQUERY_PG_PLUGIN_PATH = os.environ.get(
    "CLOUDQUERY_PG_PLUGIN_PATH", "/opt/cq-plugins/destination-postgresql"
)
CLOUDQUERY_AWS_SOURCE_VERSION = os.environ.get(
    "CLOUDQUERY_AWS_SOURCE_VERSION", "v22.19.2"
)
CLOUDQUERY_POSTGRESQL_DEST_VERSION = os.environ.get(
    "CLOUDQUERY_POSTGRESQL_DEST_VERSION", "v7.3.0"
)
# Registry vocabulary — `local` is the OSS path (no Hub auth). `docker`
# requires docker socket access (not available in our sidecar). `grpc`
# is out-of-band — the plugin runs as a separate process and cloudquery
# connects to its gRPC address. `cloudquery` is the Hub default and
# requires login. We default to `local` so the OSS path is the one
# operators get for free; the others stay available as escape hatches.
ALLOWED_REGISTRIES = ("local", "grpc", "docker", "cloudquery")

logger = logging.getLogger("ragdoll.python-plugins.cloudquery")


def _ensure_sslmode_disable_default(dsn: str) -> str:
    """Append `sslmode=disable` when the DSN doesn't already specify one.

    Why: cloudquery's PostgreSQL destination uses pgx, whose default
    sslmode is `prefer`. Against a dev Postgres without TLS (the
    common bulwark setup, where the bound connection has no certs)
    the prefer-flow handshake can fail mid-init with libpq's "SSL
    connection has been closed unexpectedly." Be explicit when the
    operator's DSN doesn't pin one — operators with TLS pin
    `sslmode=require` (or stronger) and we leave it alone.

    Preserved as-is when the DSN already carries any `sslmode=...`
    value, including `sslmode=disable` — never overwrite operator
    intent.
    """
    if not dsn:
        return dsn
    if "sslmode=" in dsn:
        return dsn
    sep = "&" if "?" in dsn else "?"
    return f"{dsn}{sep}sslmode=disable"


def _assemble_pg_dsn_from_fields(options: Dict[str, Any]) -> Optional[str]:
    """Build a `postgres://user:pass@host:port/db?sslmode=…` DSN from
    the discrete fields bulwark's postgres connection config carries
    (`host`, `port`, `user`, `password`, `database`, `sslmode`).

    Returns `None` when there's not enough to build a useful DSN
    (the caller falls back to the next resolution path). Special-
    chars in user / password are percent-encoded so DSNs with `:`,
    `@`, `/`, or `+` in the credentials still round-trip cleanly.
    """
    host = options.get("host")
    database = options.get("database")
    if not host or not database:
        return None
    user = options.get("user")
    password = options.get("password")
    port = options.get("port")
    sslmode = options.get("sslmode")

    user_part = ""
    if user is not None and str(user) != "":
        user_part = urllib.parse.quote_plus(str(user))
        if password is not None and str(password) != "":
            user_part += f":{urllib.parse.quote_plus(str(password))}"
        user_part += "@"
    port_part = f":{int(port)}" if port not in (None, "") else ""
    dsn = f"postgres://{user_part}{host}/{database}".replace(
        f"{host}/", f"{host}{port_part}/", 1
    )
    if sslmode:
        dsn += f"?sslmode={sslmode}"
    return dsn


def _resolve_pg_dsn(conn: Dict[str, Any]) -> str:
    """Resolve the PostgreSQL DSN cloudquery's destination plugin needs.

    Bulwark's `kind=postgres` connection config carries the
    full DSN in `options.connectionString` AND in `options.url`,
    plus discrete fields (`host`, `port`, `user`, `password`,
    `database`, `sslmode`). The original RAGdoll postgres-core
    driver convention (ADR-0024) puts the DSN in
    `connection.secret`. Both shapes need to work.

    Resolution order (first non-empty wins):
      1. `options.connectionString`  — bulwark's primary key
      2. `options.url`               — bulwark's alias
      3. Assembled from discrete `options.{host,...}` fields
      4. `connection.secret`         — historical RAGdoll convention

    Final step: append `sslmode=disable` when the resolved DSN
    doesn't already specify one (the bulwark-dev-Postgres path
    has no TLS; pgx's `prefer` default can fail handshake — see
    `_ensure_sslmode_disable_default`).
    """
    options = conn.get("options") or {}
    if isinstance(options, dict):
        for key in ("connectionString", "url"):
            v = options.get(key)
            if isinstance(v, str) and v.strip():
                return _ensure_sslmode_disable_default(v.strip())
        assembled = _assemble_pg_dsn_from_fields(options)
        if assembled:
            return _ensure_sslmode_disable_default(assembled)
    secret = conn.get("secret")
    if isinstance(secret, str) and secret.strip():
        return _ensure_sslmode_disable_default(secret.strip())
    return ""


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

    registry = str(cfg.get("registry") or "local")
    if registry not in ALLOWED_REGISTRIES:
        raise ValueError(
            f"cloudquery_aws_sync: unknown registry {registry!r} — "
            f"allowed: {', '.join(ALLOWED_REGISTRIES)}"
        )

    cfg["_tables"] = tables
    cfg["_regions"] = regions
    cfg["_account_id"] = account_id
    cfg["_write_mode"] = write_mode
    cfg["_runner"] = runner
    cfg["_registry"] = registry
    cfg["_bin"] = str(cfg.get("cloudqueryBin") or DEFAULT_BIN)
    cfg["_timeout_ms"] = int(cfg.get("timeoutMs") or DEFAULT_TIMEOUT_MS)
    # Plugin path / version resolution. Config wins over env wins over
    # the in-image defaults — operators can point at a private mirror
    # without rebuilding the sidecar.
    cfg["_aws_plugin_path"] = str(
        cfg.get("awsPluginPath") or CLOUDQUERY_AWS_PLUGIN_PATH
    )
    cfg["_pg_plugin_path"] = str(
        cfg.get("pgPluginPath") or CLOUDQUERY_PG_PLUGIN_PATH
    )
    cfg["_aws_plugin_version"] = str(
        cfg.get("awsPluginVersion") or CLOUDQUERY_AWS_SOURCE_VERSION
    )
    cfg["_pg_plugin_version"] = str(
        cfg.get("pgPluginVersion") or CLOUDQUERY_POSTGRESQL_DEST_VERSION
    )
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
    registry: str,
    aws_plugin_path: str,
    pg_plugin_path: str,
    aws_plugin_version: str,
    pg_plugin_version: str,
) -> str:
    """Produce the YAML spec cloudquery's `sync` subcommand consumes.

    Two documents in one file (the cloudquery convention):
      1. source plugin block (AWS) — tables + regions + scope
      2. destination plugin block (postgresql) — connection_string +
         write_mode

    The `registry` arg drives the source/destination block's registry
    field, which in turn changes the meaning of `path`:

      * `local` (DEFAULT, OSS path)   `path` is the local FS path to
                                       the plugin binary. cloudquery
                                       exec()s it. No Hub auth.
      * `grpc`                         `path` is the gRPC address of an
                                       already-running plugin process.
                                       No Hub auth.
      * `docker`                       `path` is a docker image
                                       reference; cloudquery `docker
                                       pull` + `docker run`s it. The
                                       sidecar needs docker socket
                                       access (NOT default in our
                                       compose stack).
      * `cloudquery`                   Hub default — requires
                                       `cloudquery login` /
                                       CLOUDQUERY_API_KEY for any
                                       non-trivial plugin (including
                                       OSS plugins). Avoid.

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
            "registry": registry,
            "path": aws_plugin_path,
            "version": aws_plugin_version,
            "tables": tables,
            "destinations": ["postgresql"],
            "spec": aws_spec,
        },
    }
    dst = {
        "kind": "destination",
        "spec": {
            "name": "postgresql",
            "registry": registry,
            "path": pg_plugin_path,
            "version": pg_plugin_version,
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
    # Resolve from options first (bulwark's primary path: `url` /
    # `connectionString` / discrete fields) then fall back to
    # `secret` (the historical RAGdoll postgres-core convention).
    # See `_resolve_pg_dsn` for the full precedence ladder.
    pg_dsn = _resolve_pg_dsn(conn)

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
            f"cloudquery_aws_sync: postgres connection {target_slug!r} did not "
            "yield a usable DSN — looked at `options.connectionString`, "
            "`options.url`, the discrete `options.{host,port,user,password,"
            "database,sslmode}` fields, and `connection.secret`. Set ONE of "
            "those on the bound postgres connection so cloudquery's "
            "destination plugin has a `postgres://user:pass@host:port/db` "
            "connection string."
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

    # Sanity-check: when registry=local, the plugin binaries MUST
    # exist on disk. Catching this here makes the error legible
    # ("plugin binary missing — rebuild the sidecar image OR override
    # awsPluginPath / pgPluginPath") rather than waiting for
    # cloudquery to fail with a cryptic exec error.
    if cfg["_registry"] == "local":
        for label, path in (
            ("awsPluginPath", cfg["_aws_plugin_path"]),
            ("pgPluginPath", cfg["_pg_plugin_path"]),
        ):
            if not os.path.exists(path):
                raise ValueError(
                    f"cloudquery_aws_sync: registry=local but {label} {path!r} "
                    "does not exist in the sidecar. Rebuild the python-plugins "
                    "image (Dockerfile installs the OSS plugin binaries under "
                    "/opt/cq-plugins/) OR set config.awsPluginPath / "
                    "config.pgPluginPath to a path that does."
                )

    spec_yaml = _build_spec(
        tables=cfg["_tables"],
        regions=cfg["_regions"],
        account_id=cfg["_account_id"],
        write_mode=cfg["_write_mode"],
        pg_dsn=pg_dsn,
        registry=cfg["_registry"],
        aws_plugin_path=cfg["_aws_plugin_path"],
        pg_plugin_path=cfg["_pg_plugin_path"],
        aws_plugin_version=cfg["_aws_plugin_version"],
        pg_plugin_version=cfg["_pg_plugin_version"],
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
