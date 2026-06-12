"""``cartography_crawl`` plugin handler — Python sidecar implementation.

Why this lives in the python-plugins sidecar
--------------------------------------------
The original cartography_crawl shipped as a Node plugin that shelled out to
the ``cartography`` binary. The worker image doesn't include cartography
(and shouldn't — bundling every cloud-graph tool into the Node runtime
explodes the image and conflates the worker's responsibilities). Moving
the handler here:

  * runs cartography in the python-plugins container where it's installed
    via pip (a real Python dep declared in pyproject.toml),
  * keeps the worker image lean — adding the next discovery tool means a
    new entry in this directory, not a new layer on every worker,
  * matches the architectural direction in ADR-0024 (plugin-as-service).

Wire contract
-------------
The TS-side ``cartography_crawl`` manifest declares ``mode: "external"``
pointing at this sidecar. It serializes the resolved Neo4j connection
through the ADR-0023 dataset envelope, so this handler reaches it via
``request.dataset.bindings.target.connection``:

  - ``connection.kind``        — guaranteed to be ``"neo4j"`` (manifest
                                  ``requires: [{binding: "target",
                                  kind: "neo4j"}]`` enforces it).
  - ``connection.options``     — non-secret config (``uri``, optional
                                  ``database``, etc.).
  - ``connection.secret``      — the resolved credential string. Format is
                                  whatever the operator stored; we parse
                                  ``user:pass`` / ``{"username", "password"}``
                                  / raw password forms.

The output envelope mirrors the Node plugin's contract verbatim (the same
``metadata.modules[*]`` shape downstream nodes branch on) so swapping the
implementation is transparent.

Failure behaviour
-----------------
The Node implementation USED to catch every spawn error and return success
with ``status: "failed"`` per module. That hid binary-not-found and
connectivity failures — the run trace reported the node succeeded and the
downstream graph reads ran against an unpopulated DB. This handler raises
ValueError when:

  * configuration is invalid (no modules, unknown module name),
  * the bound target binding isn't present / isn't neo4j,
  * cartography is missing from the sidecar image (``FileNotFoundError``),
  * any module exits non-zero.

ConnectError(INVALID_ARGUMENT|INTERNAL) flows through the bridge and the
runtime surfaces the failure on the execution trace where it belongs.
"""

from __future__ import annotations

import logging
import os
import subprocess  # noqa: S404 — shelling out to cartography is the design
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

PLUGIN_ID = "cartography_crawl"

# Mirror the TS-side allowlist (plugins/builtin-rag/src/cartography.ts).
# Keep alphabetical for diff-friendliness; if you add one here, also add
# it to the TS manifest's `configSchema.modules.items.enum`.
CARTOGRAPHY_MODULES = (
    "aws",
    "azure",
    "crowdstrike",
    "duo",
    "gcp",
    "github",
    "gsuite",
    "jamf",
    "kandji",
    "kubernetes",
    "lastpass",
    "oci",
    "okta",
    "pagerduty",
    "semgrep",
    "snipeit",
    "tailscale",
)

DEFAULT_TIMEOUT_MS = 1_800_000  # 30 minutes — long crawls are normal
# Default points at the isolated venv the Dockerfile sets up so
# cartography's eager-import landmine can't be triggered by other deps
# in the main poetry env (see ADR-0026 §#2 follow-up). Operators can
# override with `config.cartographyBin` when they install cartography
# elsewhere in the image.
DEFAULT_BIN = "/opt/cartography-venv/bin/cartography"

logger = logging.getLogger("ragdoll.python-plugins.cartography")


def _require_neo4j_connection(request_dataset: Dict[str, Any]) -> Dict[str, Any]:
    """Pull the resolved neo4j connection off the dataset envelope.

    Raises ValueError with an actionable message if the binding isn't
    present or isn't a neo4j connection — same error vocabulary the TS
    `requireNeo4jConnection` helper uses, so log messages stay
    consistent across the two transports.
    """
    bindings = (request_dataset or {}).get("bindings") or {}
    binding = bindings.get("target")
    if not binding or not binding.get("connection"):
        raise ValueError(
            "cartography_crawl: node has no resolved 'target' binding — "
            "wire a dataset whose `bindings.target.connection` points at a "
            "neo4j connection."
        )
    conn = binding["connection"]
    if conn.get("kind") != "neo4j":
        raise ValueError(
            "cartography_crawl: 'target' binding must be backed by a neo4j "
            f"connection (got kind={conn.get('kind')!r}, slug={conn.get('slug')!r})."
        )
    return conn


def _parse_neo4j_credentials(
    secret: Optional[str], default_username: str = "neo4j"
) -> Tuple[str, str]:
    """Accept any of the formats RAGdoll has historically allowed.

    Handles JSON ``{"username", "password"}``, ``user:pass``, or a raw
    password string. Mirrors `parseNeo4jCredentials` in the TS neo4j
    driver so creds shaped one way for /probe also work here.
    """
    if not secret:
        return default_username, ""
    s = secret.strip()
    # JSON shape
    if s.startswith("{"):
        import json

        try:
            obj = json.loads(s)
            return str(obj.get("username") or default_username), str(
                obj.get("password") or ""
            )
        except json.JSONDecodeError:
            pass
    # user:pass shape (NOT bolt:// — guard against parsing a URI)
    if ":" in s and "//" not in s:
        user, _, password = s.partition(":")
        return user or default_username, password
    return default_username, s


def _resolve_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize the per-node config.

    Raises ValueError on every malformed input — the bridge maps that
    to ConnectError(INVALID_ARGUMENT) so the operator sees the cause
    on the execution trace, not a generic INTERNAL.
    """
    cfg = dict(config or {})
    modules_raw = cfg.get("modules") or []
    if not isinstance(modules_raw, list) or not modules_raw:
        raise ValueError("cartography_crawl: config.modules must be a non-empty array")
    modules: List[str] = []
    for m in modules_raw:
        ms = str(m)
        if ms not in CARTOGRAPHY_MODULES:
            raise ValueError(
                f"cartography_crawl: unknown module {ms!r} — allowed: "
                f"{', '.join(CARTOGRAPHY_MODULES)}"
            )
        modules.append(ms)
    runner = str(cfg.get("runner") or "subprocess")
    if runner not in ("subprocess", "dry-run"):
        raise ValueError(f"cartography_crawl: unknown runner {runner!r}")
    cfg["_modules"] = modules
    cfg["_runner"] = runner
    cfg["_bin"] = str(cfg.get("cartographyBin") or DEFAULT_BIN)
    cfg["_timeout_ms"] = int(cfg.get("timeoutMs") or DEFAULT_TIMEOUT_MS)
    cfg["_incremental"] = bool(cfg.get("incremental") or False)
    selectors = cfg.get("accountSelectors")
    cfg["_selectors"] = selectors if isinstance(selectors, dict) else {}
    extra = cfg.get("extraArgs")
    cfg["_extra_args"] = [str(a) for a in extra] if isinstance(extra, list) else []
    return cfg


def _build_args(modules: List[str], cfg: Dict[str, Any]) -> List[str]:
    """Translate the resolved config into a cartography CLI argv tail.

    Cartography takes a single ``--selected-modules`` flag with a
    comma-separated list of module names (NOT ``-m <module>`` per
    module — that's a build-system convention that doesn't apply here
    and previously caused a runtime ``unrecognized arguments: -m aws``
    failure for every cloud).

    ``--update-tag`` only when ``incremental`` is true. Per-module
    selectors and ``extraArgs`` are appended verbatim.
    """
    args: List[str] = ["--selected-modules", ",".join(modules)]
    if cfg["_incremental"]:
        args.extend(("--update-tag", str(int(time.time()))))
    selectors = cfg["_selectors"]
    for module, flags in (selectors or {}).items():
        if not isinstance(flags, dict):
            continue
        for flag, value in flags.items():
            args.extend((f"--{module}-{flag}", str(value)))
    args.extend(cfg["_extra_args"])
    return args


def _build_env(
    *, neo4j_uri: str, neo4j_user: str, neo4j_pass: str, creds_secret: Optional[str]
) -> Dict[str, str]:
    """Compose the environment cartography expects.

    Cartography reads NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD by
    convention. Cloud creds are forwarded verbatim when the operator
    provided a `creds` secret — typically an AWS credentials block or
    Azure SP JSON; cartography's per-module loaders pick the env vars
    they need (AWS_PROFILE / AWS_ACCESS_KEY_ID / etc.).

    When no neo4j password is set we DO NOT export NEO4J_PASSWORD at
    all (rather than exporting an empty string). Cartography treats
    unset as "no creds, use Bolt's no-auth handshake," which matches
    a neo4j-community instance launched with NEO4J_AUTH=none.
    Exporting an empty value would make some configs send a basic
    auth token with an empty credential — neither the no-auth server
    nor the auth-enabled server accepts that.
    """
    env = dict(os.environ)
    env["NEO4J_URI"] = neo4j_uri
    env["NEO4J_USER"] = neo4j_user
    if neo4j_pass:
        env["NEO4J_PASSWORD"] = neo4j_pass
    else:
        env.pop("NEO4J_PASSWORD", None)
    if creds_secret:
        # If it's a multi-line .env-style block, fold every line into the
        # environment so cartography's per-cloud loaders can see them.
        for line in str(creds_secret).splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def handle(request) -> Dict[str, Any]:
    """ExecuteRequest -> {outputs.metadata, ...} envelope.

    Throws on every failure path (binary missing, non-zero exit,
    bad config) so the runtime surfaces it on the execution trace
    instead of reporting succeeded-with-failed-modules.
    """
    config: Dict[str, Any] = request.effective_config()
    cfg = _resolve_config(config)
    conn = _require_neo4j_connection(request.dataset)
    target_slug = str(conn.get("slug") or "")
    options: Dict[str, Any] = conn.get("options") or {}
    target_db = options.get("database")
    neo4j_uri = str(options.get("uri") or "")
    crawl_id = str(uuid.uuid4())
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    if cfg["_runner"] == "dry-run":
        return {
            "outputs": {
                "metadata": {
                    "crawlId": crawl_id,
                    "startedAt": started_at,
                    "completedAt": started_at,
                    "mode": "dry-run",
                    "target": {"connectionSlug": target_slug, "database": target_db},
                    "modules": [
                        {"module": m, "status": "skipped", "counts": 0}
                        for m in cfg["_modules"]
                    ],
                }
            }
        }

    if not neo4j_uri:
        raise ValueError(
            f"cartography_crawl: connection {target_slug!r} has no options.uri — "
            "cartography needs a Bolt URI (e.g. bolt://neo4j:7687)."
        )

    user, password = _parse_neo4j_credentials(conn.get("secret"))
    creds_secret_ref = config.get("credsSecretRef")
    secrets = request.secrets or {}
    creds_secret = (
        secrets.get(str(creds_secret_ref))
        if isinstance(creds_secret_ref, str)
        else secrets.get("creds")
    )
    # Surface "configured a credsSecretRef but the runtime didn't
    # resolve it" loudly. Without this, cartography quietly runs with
    # no AWS creds, the AWS SDK's default credential chain finds
    # nothing in the sidecar's env, cartography exits 0 having done
    # zero work — and the operator sees `status: "succeeded"` for a
    # crawl that produced an empty graph. This is the most common
    # cause of "creds are known-good but I get no data back."
    creds_warning: Optional[str] = None
    if isinstance(creds_secret_ref, str) and not creds_secret:
        creds_warning = (
            f"credsSecretRef={creds_secret_ref!r} is set in config but no "
            f"matching entry was found in input.secrets — the spec node must "
            f"also declare `secrets: {{ {creds_secret_ref!s}: <secret-ref> }}` "
            f"so the runtime resolves it through the SecretProvider. "
            f"cartography ran without cloud creds and likely scanned nothing."
        )
        logger.warning("cartography_crawl: %s", creds_warning)

    args = [cfg["_bin"], *_build_args(cfg["_modules"], cfg)]
    env = _build_env(
        neo4j_uri=neo4j_uri,
        neo4j_user=user,
        neo4j_pass=password,
        creds_secret=creds_secret if isinstance(creds_secret, str) else None,
    )
    timeout_s = max(1, cfg["_timeout_ms"] // 1000)

    try:
        result = subprocess.run(  # noqa: S603 — argv is constructed from the validated config
            args,
            env=env,
            timeout=timeout_s,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        # Loud failure — operators should see "cartography missing" on
        # the trace, not a per-module status that the UI lies about.
        raise ValueError(
            "cartography_crawl: cartography binary not found in the python-plugins "
            "sidecar — rebuild the image with cartography installed (it ships as a "
            "Python entrypoint when you `pip install cartography`)."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError(
            f"cartography_crawl: timed out after {timeout_s}s. Increase "
            "`config.timeoutMs` or split the modules list."
        ) from exc

    completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if result.returncode != 0:
        # Tail the stderr for the operator. We don't pretend per-module
        # success/failure — cartography's CLI doesn't surface that — but
        # we DO fail the node so the run is unambiguously bad.
        err_tail = (result.stderr or "")[-1024:]
        raise ValueError(
            f"cartography_crawl: cartography exited {result.returncode}. "
            f"stderr tail:\n{err_tail or '<empty>'}"
        )

    # Surface what cartography actually said. The CLI logs progress to
    # stderr (boto3 calls, "Syncing X for account Y", etc.) AND a
    # summary count when work runs. On a misconfigured run (no AWS
    # creds → boto3 default chain finds nothing → cartography exits 0
    # silently) the tail will explicitly show no sync activity, which
    # is far more useful than a bare `status: "succeeded"`.
    stdout_tail = (result.stdout or "")[-2048:]
    stderr_tail = (result.stderr or "")[-2048:]
    # Heuristic flag for "ran but did nothing useful." If the combined
    # output doesn't mention any sync activity, mark each module with
    # status "no_data" so downstream nodes and the trace UI can
    # distinguish a genuine success from a silent no-op.
    combined = (stdout_tail + "\n" + stderr_tail).lower()
    looks_empty = not any(
        marker in combined
        for marker in ("syncing", "sync stage", "loaded", "synced", "writing")
    )
    module_status = "no_data" if looks_empty else "succeeded"

    metadata: Dict[str, Any] = {
        "crawlId": crawl_id,
        "startedAt": started_at,
        "completedAt": completed_at,
        "mode": "subprocess",
        "target": {"connectionSlug": target_slug, "database": target_db},
        "modules": [
            {"module": m, "status": module_status} for m in cfg["_modules"]
        ],
        "exitCode": result.returncode,
        # Tails of cartography's own logging — both stdout and stderr,
        # capped at 2KB each so the trace stays readable. This is what
        # the operator was reaching for when our envelope just said
        # `status: "succeeded"` for a clearly-empty crawl.
        "cartographyStdoutTail": stdout_tail,
        "cartographyStderrTail": stderr_tail,
    }
    if creds_warning:
        metadata["credsWarning"] = creds_warning
    if looks_empty:
        metadata["warning"] = (
            "cartography ran cleanly but its output shows no sync activity — "
            "either AWS credentials didn't reach the sidecar (see "
            "cartographyStderrTail + credsWarning if set), the account "
            "actually has no resources, or the module selectors filtered "
            "everything out. Real syncs typically log 'Syncing <resource> "
            "for account <id>' lines."
        )
    logger.info(
        "cartography_crawl completed crawl=%s target=%s modules=%s status=%s",
        crawl_id,
        target_slug,
        ",".join(cfg["_modules"]),
        module_status,
    )
    return {"outputs": {"metadata": metadata}}
