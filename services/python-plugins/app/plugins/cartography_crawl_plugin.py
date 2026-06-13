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

Module outcome classification (the load-bearing safety rule)
------------------------------------------------------------
Each requested module is invoked in its OWN cartography process so one
module's failure can't blow away another's data. After the invocation
we classify the outcome into one of three values — the contract
bulwark's Cartography projection gates close-by-absence on:

  * ``complete``  — cartography exited 0. The module fully collected
                    its entity types. Safe for close-by-absence
                    reconciliation downstream.
  * ``excluded``  — cartography failed BUT the error matches a
                    *structurally permanent* pattern (e.g.
                    ``ValidationException: not supported for account
                    instances of IAM Identity Center``). The module
                    can never succeed on this account/config; its
                    entity types simply aren't collected from this
                    source. **The crawl is STILL COMPLETE for every
                    other module** — bulwark will skip those entity
                    types in close-by-absence, but the rest reconcile
                    normally. Exit 0.
  * ``failed``    — cartography failed for any other reason
                    (throttling, transient auth, network, timeout,
                    generic). The module *might* have produced data;
                    absence is NOT informative. This makes the crawl
                    **partial**, which would tombstone live assets if
                    a downstream projection close-by-absences against
                    it. **The handler raises** (fatal) so the trace is
                    loud and the prior good inventory stays intact.
                    This will be relaxed to non-fatal once bulwark
                    gates close-by-absence on per-module completeness.

When unsure: default to ``failed``/fatal. **Never silently downgrade a
real failure to ``excluded`` / skip** — that's how stale inventory
silently rots and how the tombstoning safety problem creeps back in.

ConnectError(INVALID_ARGUMENT|INTERNAL) flows through the bridge and the
runtime surfaces the failure on the execution trace where it belongs.

Provenance contract (ADR-0030)
------------------------------
Each run emits `metadata.crawlId` + `metadata.crawledAt` derived from the
runtime context (`request.context.requestId` — already on the wire). The
per-module status envelope and any observations a downstream transform
stamps via `inputs.metadata.crawlId` carry the SAME identifier, which is
how bulwark's gated windowed close-by-absence correlates "modules complete
in crawl N" with "observations stamped crawlId N." See ADR-0030 for the
full contract.
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
    # IAM Identity Center is its own top-level module in cartography
    # 0.96+. It commonly fails on AWS accounts that aren't the IAM
    # Identity Center organisation root (ValidationException on
    # ListPermissionSets); the per-module isolation in `handle` keeps
    # that failure from killing every other module's data.
    "identitycenter",
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

# Entity types each cartography module collects, surfaced per-module on
# the output envelope so bulwark's projection knows WHICH types this
# module owns. Bulwark gates close-by-absence per-entity-type using this
# list — an `excluded` / `failed` module never closes-by-absence the
# types it would have collected. NOT EXHAUSTIVE; covers the modules in
# the allowlist and the entities cartography's own schema docs list as
# their headline outputs. Operators with custom schemas can override
# via `entityTypeOverrides` on the node config (future enhancement).
MODULE_ENTITY_TYPES: Dict[str, Tuple[str, ...]] = {
    "aws": (
        "AWSAccount", "AWSRegion", "EC2Instance", "EC2SecurityGroup",
        "EC2Subnet", "EBSVolume", "VPC", "RDSInstance", "RDSCluster",
        "S3Bucket", "LoadBalancer", "LoadBalancerV2", "AWSPolicy",
        "AWSRole", "AWSUser", "AWSGroup", "AutoScalingGroup",
        "LaunchConfiguration", "ECSCluster", "ECSService", "ECSTask",
        "EKSCluster", "ElasticIPAddress", "DNSZone", "DNSRecord",
        "CloudTrailTrail", "CloudWatchLogGroup",
    ),
    "azure": (
        "AzureTenant", "AzureSubscription", "AzureVirtualMachine",
        "AzureVirtualNetwork", "AzureSubnet", "AzureStorageAccount",
        "AzureSQLServer", "AzureKeyVault",
    ),
    "gcp": (
        "GCPOrganization", "GCPFolder", "GCPProject", "GCPInstance",
        "GCPNetwork", "GCPSubnet", "GCPBucket", "GCPRole",
        "GKECluster",
    ),
    "oci": ("OCITenancy", "OCICompartment", "OCIUser", "OCIGroup"),
    "github": (
        "GitHubOrganization", "GitHubUser", "GitHubRepository",
        "GitHubTeam", "GitHubBranch",
    ),
    "gsuite": ("GSuiteUser", "GSuiteGroup"),
    "okta": (
        "OktaOrganization", "OktaUser", "OktaGroup", "OktaApplication",
        "OktaRole",
    ),
    "identitycenter": (
        "AWSIdentityCenter", "AWSIdentityCenterUser",
        "AWSIdentityCenterGroup", "AWSPermissionSet",
        "AWSAccountAssignment",
    ),
    "kubernetes": (
        "KubernetesCluster", "KubernetesNamespace", "KubernetesNode",
        "KubernetesPod", "KubernetesContainer", "KubernetesService",
    ),
    "crowdstrike": ("CrowdstrikeHost", "CrowdstrikeVulnerability"),
    "duo": ("DuoUser", "DuoGroup", "DuoEndpoint"),
    "jamf": ("JamfComputer", "JamfMobileDevice"),
    "kandji": ("KandjiDevice",),
    "lastpass": ("LastPassUser",),
    "pagerduty": ("PagerDutyUser", "PagerDutyTeam", "PagerDutyService"),
    "semgrep": ("SemgrepDeployment", "SemgrepFinding"),
    "snipeit": ("SnipeITAsset", "SnipeITUser"),
    "tailscale": ("TailscaleTailnet", "TailscaleDevice", "TailscaleUser"),
}


# Substrings that mean "this module is structurally incompatible with
# this account/config" — i.e. it can NEVER succeed here. Matched
# case-insensitively against the module's stderr. Keep the list TIGHT;
# every entry added here makes a class of failures non-fatal so the
# trace's burden of catching the operator's attention shifts to the
# `excluded` reason. Conservative-by-default — when in doubt, leave a
# pattern OUT and let the failure stay fatal.
#
# ============================================================================
# KNOWN-FRAGILE SURFACE — AUDIT WHEN YOU TOUCH THIS LIST
# ============================================================================
# Substring matching against vendor error prose is what works today
# but the failure direction is ASYMMETRIC and DANGEROUS:
#
#   too STRICT → real `excluded` slips through as `failed` → loud
#                failure. Operator notices; we tighten. Self-correcting.
#   too LOOSE  → real `failed` is misclassified `excluded` → crawl
#                reports complete-without-it → bulwark close-by-absences
#                the module's entity types → SILENT PARTIAL / TOMBSTONING.
#                Does not self-correct. The exact failure mode the whole
#                three-way revision exists to prevent.
#
# Two ways this drifts to "too loose" without anyone noticing:
#   1. Vendor rewords a structural error message and our substring now
#      ALSO matches a transient error.
#   2. A future API throws a new transient exception whose message
#      coincidentally contains one of our substrings.
#
# When editing this list:
#   * Re-read every entry against the cloud SDK's CURRENT error catalog,
#     not what it said when the entry was added.
#   * When a cloud SDK we use is upgraded, sweep its changelog for
#     error-message changes.
#   * When a new module is added to CARTOGRAPHY_MODULES, audit whether
#     its structurally-permanent errors hit these substrings (and
#     whether any TRANSIENT errors do too — that's the dangerous case).
#
# Prefer STRUCTURED CODES over prose for any future entry. AWS exposes
# error codes (`ValidationException`, `OptInRequired`, …) and GCP
# `google.api_core.exceptions` classes + `reason` enums that are far
# more stable than free-form messages. When the structured code IS
# present in cartography's stderr (e.g. "Error Code:
# ValidationException"), match the code, not the prose. See
# ADR-0029 §"Known-fragile surface" for the route to less fragility.
#
# Sources for the canonical phrases currently in the list:
#   - AWS ValidationException for IAM Identity Center on a non-org-root
#     account: ``not supported for account instances of IAM Identity
#     Center``.
#   - AWS OptInRequired for services that need an explicit enable per
#     region/account.
#   - GCP "API has not been used in project X before or it is disabled"
#     when the operator hasn't enabled the relevant API.
#   - Azure "subscription doesn't contain a Microsoft.<provider>"
#     resource-provider-not-registered errors.
_EXCLUDED_SUBSTRINGS: Tuple[str, ...] = (
    "not supported for account instances",  # IAM Identity Center
    "is not supported for this account",
    "is not supported in this region",
    "operation is not supported in this region",
    # OptInRequired — service available globally but the account has
    # not opted in. The operator could enable it, but for this run it's
    # structurally unavailable.
    "the subscription is not registered",
    "service is not supported in this region",
    "this api method only works on iam identity center instances of type",
    # GCP — API has not been enabled. Structurally absent until the
    # operator enables it; close-by-absence on its types would tombstone
    # things that are simply not visible here.
    "has not been used in project",
    "api has not been enabled",
    "consumer has been disabled",
)


def classify_module_outcome(
    returncode: int, stderr_tail: str
) -> Tuple[str, Optional[str]]:
    """Classify a single module's invocation into one of three buckets.

    Returns ``(status, reason)`` where status is one of
    ``"complete"`` / ``"excluded"`` / ``"failed"`` and ``reason`` is a
    short human-readable phrase (the matched substring + a snippet of
    the surrounding stderr line) when status is ``excluded`` or
    ``failed``. The reason field on `excluded` is the operator-facing
    "why this module didn't run" — kept short so it fits on the trace
    UI without an expand-collapse.
    """
    if returncode == 0:
        return ("complete", None)
    # Match the FIRST excluded substring that appears anywhere in the
    # stderr tail. We don't try to match per-line — cartography
    # sometimes spreads the relevant exception across a multi-line
    # traceback and the canonical phrase is what matters.
    lower = stderr_tail.lower()
    for pattern in _EXCLUDED_SUBSTRINGS:
        if pattern in lower:
            # Snip the line containing the match so the reason field
            # is the actual operator-facing sentence, not 2KB of
            # traceback.
            for line in stderr_tail.splitlines():
                if pattern in line.lower():
                    return ("excluded", line.strip()[:200])
            return ("excluded", pattern)
    return ("failed", None)
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


def _build_args_for_module(module: str, cfg: Dict[str, Any]) -> List[str]:
    """Translate the resolved config into a cartography CLI argv tail
    for a SINGLE module.

    We invoke cartography once per module rather than once with a
    comma-separated list (which used to be `--selected-modules
    aws,gcp,...`). The reason is per-module isolation: cartography
    exits 1 on the first module that fails, throwing away every
    other module's data, and historically a single unsupported
    sub-sync (e.g. `identitycenter` calling ListPermissionSets on an
    account that isn't an IAM Identity Center org instance — fires
    ValidationException) shredded otherwise-successful AWS / GCP
    runs. Looping per module turns each module into its own
    success/fail observation; the plugin aggregates them into the
    metadata envelope and never lets one module's failure cascade.

    Cartography's `--selected-modules` flag still wants a comma list
    even for a single entry, so we pass `--selected-modules <m>`.

    `--update-tag` only when `incremental` is true. Per-module
    selectors apply only to the matching module. `extraArgs` are
    appended verbatim to every invocation.
    """
    args: List[str] = ["--selected-modules", module]
    if cfg["_incremental"]:
        args.extend(("--update-tag", str(int(time.time()))))
    # Per-module selectors gate themselves on `module`, so only the
    # entries targeting this module's CLI flags reach argv.
    module_selectors = (cfg["_selectors"] or {}).get(module)
    if isinstance(module_selectors, dict):
        for flag, value in module_selectors.items():
            args.extend((f"--{module}-{flag}", str(value)))
    args.extend(cfg["_extra_args"])
    return args


def _looks_empty(stdout_tail: str, stderr_tail: str) -> bool:
    """Heuristic: did cartography do any real work on this invocation?

    Real syncs log lines like ``Syncing EC2 for account 123...`` to
    stderr. A misconfigured run (no creds, default boto3 chain finds
    nothing) exits 0 silently. We use a small marker set to flip the
    per-module status from `succeeded` → `no_data` when nothing
    sync-shaped appears.
    """
    combined = (stdout_tail + "\n" + stderr_tail).lower()
    return not any(
        marker in combined
        for marker in ("syncing", "sync stage", "loaded", "synced", "writing")
    )


def _build_env(
    *, neo4j_uri: str, neo4j_user: str, neo4j_pass: str, creds_secret: Optional[str]
) -> Dict[str, str]:
    """Compose the environment cartography expects.

    Cartography reads NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD by
    convention. Cloud creds are forwarded verbatim when the operator
    provided a `creds` secret — typically an AWS credentials block or
    Azure SP JSON; cartography's per-module loaders pick the env vars
    they need (AWS_PROFILE / AWS_ACCESS_KEY_ID / etc.).

    NEO4J_USER and NEO4J_PASSWORD are set OR unset TOGETHER. The
    Python neo4j-driver builds the auth token from whichever of the
    two it finds; with only NEO4J_USER set (no password), it produces
    a malformed token missing the `scheme` field and the server
    rejects the handshake with "Unsupported authentication token,
    missing key `scheme`". Keeping the two env vars coherent avoids
    that whole class of failure: either we have basic-auth creds
    (both set) or we don't (both unset → cartography's neo4j driver
    falls back to anonymous, which works against NEO4J_AUTH=none
    community installs).
    """
    env = dict(os.environ)
    env["NEO4J_URI"] = neo4j_uri
    if neo4j_pass:
        env["NEO4J_USER"] = neo4j_user
        env["NEO4J_PASSWORD"] = neo4j_pass
    else:
        env.pop("NEO4J_USER", None)
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
    # Provenance — the contract bulwark's gated windowed close-by-absence
    # consumes (ADR-0030):
    #   * `crawlId` is the run-scoped identifier the operator can correlate
    #     against /api/executions/<id> in RAGdoll. We derive it from
    #     `request.context.requestId` (already on the wire — TS-side
    #     `ctx.requestId` is set per pipeline execution and threaded
    #     through buildExecuteRequest). Falls back to a fresh UUID when
    #     absent so tests / dry-runs without a real runtime context keep
    #     working — but the fall-back loses correlation with RAGdoll's
    #     execution row and should NOT be relied on for production
    #     reconciliation.
    #   * `crawledAt` is the ISO-8601 timestamp at the moment this run
    #     started; it's what bulwark uses as the window-age anchor (i.e.
    #     "this observation was re-stamped at T; window-age = now - T").
    # The same `crawlId` is emitted at the top of `metadata` and is what
    # bulwark's transform stamps onto every observation row via
    # `inputs.metadata.crawlId` so the per-module status envelope and the
    # written observations correlate. See ADR-0030 for the full contract.
    crawl_id = (
        getattr(request.context, "requestId", None) or str(uuid.uuid4())
    )
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    crawled_at = started_at  # alias surfaced under the provenance contract name

    if cfg["_runner"] == "dry-run":
        return {
            "outputs": {
                "metadata": {
                    "crawlId": crawl_id,
                    "crawledAt": crawled_at,
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

    env = _build_env(
        neo4j_uri=neo4j_uri,
        neo4j_user=user,
        neo4j_pass=password,
        creds_secret=creds_secret if isinstance(creds_secret, str) else None,
    )
    # Per-module timeout, with the configured total spread across all
    # requested modules. We don't want one slow module to starve the
    # rest, but we also don't want to allow N × the full budget. Floor
    # at 60s so a degenerate config (3600ms / 30 modules) doesn't
    # produce a 120ms ceiling that no module could ever meet.
    per_module_timeout_s = max(
        60, (cfg["_timeout_ms"] // 1000) // max(1, len(cfg["_modules"]))
    )

    # Aggregated stdout/stderr tails across every module, for the
    # top-level envelope. Per-module tails live on each module entry
    # so the operator can see exactly which module said what.
    aggregate_stdout_parts: List[str] = []
    aggregate_stderr_parts: List[str] = []
    module_entries: List[Dict[str, Any]] = []
    # Top-level exitCode reflects the FIRST module that failed (or
    # 0 if every module is complete OR excluded — excluded means
    # "structurally absent here, the OTHER modules' crawl is still
    # whole"). The handler raises when any module is failed, so a
    # non-fatal exitCode != 0 only happens when at least one module
    # was excluded (which is intentional — the operator may want to
    # spot partial coverage at a glance).
    aggregate_exit_code: int = 0

    # First pass: invoke every module, classify each outcome. We loop
    # to completion before raising on any `failed` so the metadata
    # envelope (and the trace) shows the full per-module picture, not
    # just the first failure.
    for module in cfg["_modules"]:
        argv = [cfg["_bin"], *_build_args_for_module(module, cfg)]
        module_started = time.time()
        entity_types = list(MODULE_ENTITY_TYPES.get(module, ()))
        try:
            result = subprocess.run(  # noqa: S603 — argv from validated config
                argv,
                env=env,
                timeout=per_module_timeout_s,
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError as exc:
            # Binary missing is a sidecar-image bug, not a per-module
            # failure — bubble it. Without this, the operator would see
            # every module fail with the same opaque error.
            raise ValueError(
                "cartography_crawl: cartography binary not found in the python-plugins "
                "sidecar — rebuild the image with cartography installed (it ships as a "
                "Python entrypoint when you `pip install cartography`)."
            ) from exc
        except subprocess.TimeoutExpired:
            # Timeout is a TRANSIENT failure — could be a slow account,
            # could be cartography hitting throttling. Classify as
            # `failed`; the handler raises after the loop. The reason
            # field carries enough detail to act on.
            module_entries.append({
                "module": module,
                "status": "failed",
                "reason": (
                    f"timed out after {per_module_timeout_s}s (per-module budget "
                    f"derived from config.timeoutMs ÷ N modules)"
                ),
                "entityTypes": entity_types,
                "durationMs": int((time.time() - module_started) * 1000),
            })
            if aggregate_exit_code == 0:
                aggregate_exit_code = -1
            logger.warning(
                "cartography_crawl module %s timed out after %ss",
                module,
                per_module_timeout_s,
            )
            continue
        stdout_tail = (result.stdout or "")[-2048:]
        stderr_tail = (result.stderr or "")[-2048:]
        aggregate_stdout_parts.append(f"[{module}]\n{stdout_tail}")
        aggregate_stderr_parts.append(f"[{module}]\n{stderr_tail}")

        status, reason = classify_module_outcome(result.returncode, stderr_tail)
        # `no_data` heuristic only applies to a clean exit — when
        # cartography exited 0 but its log shows no sync activity, the
        # account is either genuinely empty or the creds didn't reach
        # the SDK chain. We surface that via a top-level warning, NOT
        # by demoting the per-module status — `complete` means
        # "cartography said it finished," which is what bulwark needs
        # to gate close-by-absence on.
        entry: Dict[str, Any] = {
            "module": module,
            "status": status,
            "entityTypes": entity_types,
            "durationMs": int((time.time() - module_started) * 1000),
        }
        if status == "complete":
            pass  # nothing else to add
        else:
            # excluded OR failed — both carry diagnostic detail.
            entry["exitCode"] = result.returncode
            entry["stderrTail"] = stderr_tail
            if reason:
                entry["reason"] = reason
            if status == "excluded":
                logger.info(
                    "cartography_crawl module %s excluded (structurally incompatible): %s",
                    module,
                    reason or "<unknown>",
                )
            else:
                logger.warning(
                    "cartography_crawl module %s failed (transient): exit=%s stderr=%s",
                    module,
                    result.returncode,
                    stderr_tail or "<empty>",
                )
            if aggregate_exit_code == 0:
                aggregate_exit_code = result.returncode

        module_entries.append(entry)

    completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    aggregate_stdout = "\n".join(aggregate_stdout_parts)[-4096:]
    aggregate_stderr = "\n".join(aggregate_stderr_parts)[-4096:]

    complete_modules = [m for m in module_entries if m["status"] == "complete"]
    excluded_modules = [m for m in module_entries if m["status"] == "excluded"]
    failed_modules = [m for m in module_entries if m["status"] == "failed"]
    no_data_modules = [
        m for m in module_entries
        if m["status"] == "complete"
        and _looks_empty_from_aggregate(aggregate_stdout, aggregate_stderr, m["module"])
    ]

    metadata: Dict[str, Any] = {
        # Provenance contract (ADR-0030) — bulwark's transform stamps
        # `crawlId` + `crawledAt` onto every observation row via
        # `inputs.metadata.crawlId` / `inputs.metadata.crawledAt`, so the
        # per-module status envelope below and the written observations
        # correlate. The SAME crawlId appears on both sides of the
        # contract, which is how bulwark's gated windowed close-by-
        # absence pairs "modules complete in crawl N" with "observations
        # stamped crawlId N."
        "crawlId": crawl_id,
        "crawledAt": crawled_at,
        "startedAt": started_at,
        "completedAt": completed_at,
        "mode": "subprocess",
        "target": {"connectionSlug": target_slug, "database": target_db},
        "modules": module_entries,
        "exitCode": aggregate_exit_code,
        "cartographyStdoutTail": aggregate_stdout,
        "cartographyStderrTail": aggregate_stderr,
    }
    if creds_warning:
        metadata["credsWarning"] = creds_warning
    if excluded_modules:
        metadata["excludedSummary"] = (
            f"{len(excluded_modules)} of {len(module_entries)} module(s) "
            f"are structurally absent from this account/config — "
            f"{', '.join(m['module'] for m in excluded_modules)}. The crawl is "
            f"COMPLETE for every other module; bulwark's projection will skip "
            f"close-by-absence on the entity types these modules would have "
            f"collected (see each entry's `entityTypes`)."
        )
    if no_data_modules and not failed_modules:
        metadata["warning"] = (
            "cartography ran cleanly but no module shows sync activity — "
            "either cloud credentials didn't reach the sidecar (see "
            "cartographyStderrTail + credsWarning if set), the account "
            "actually has no resources, or the module selectors filtered "
            "everything out. Real syncs typically log 'Syncing <resource> "
            "for account <id>' lines."
        )

    # TRANSIENT failure → fatal. This stays until bulwark's projection
    # gates close-by-absence on per-module completeness — once it does,
    # a failed module can downgrade to non-fatal because bulwark will
    # refuse to tombstone its entity types. Until then, a silent partial
    # is more dangerous than a loud failure, so we raise.
    if failed_modules:
        summary_lines = [
            f"cartography_crawl: {len(failed_modules)} of "
            f"{len(module_entries)} module(s) failed (TRANSIENT). The other "
            f"modules' inventory may be valid but a partial crawl risks "
            f"tombstoning live assets — see ADR-0029. Per-module:"
        ]
        for m in module_entries:
            status = m["status"]
            if status == "complete":
                summary_lines.append(f"  {m['module']}: complete")
            elif status == "excluded":
                summary_lines.append(
                    f"  {m['module']}: excluded ({m.get('reason', 'structurally absent')})"
                )
            else:
                tail = (m.get("stderrTail") or m.get("reason") or "")[-400:]
                summary_lines.append(
                    f"  {m['module']}: FAILED exit={m.get('exitCode')} — {tail}"
                )
        # Stash the full envelope on the exception so a debugging caller
        # can pluck it off the trace if they go looking.
        err = ValueError("\n".join(summary_lines))
        setattr(err, "metadata", metadata)
        raise err

    logger.info(
        "cartography_crawl completed crawl=%s target=%s complete=%s excluded=%s",
        crawl_id,
        target_slug,
        len(complete_modules),
        len(excluded_modules),
    )
    return {"outputs": {"metadata": metadata}}


def _looks_empty_from_aggregate(
    stdout: str, stderr: str, module: str
) -> bool:
    """Module-scoped variant of `_looks_empty`: did the section labelled
    ``[module]`` in the aggregate tails show any sync activity? We slice
    out the per-module section by header so a noisy module doesn't mask
    a silent one (or vice versa).
    """
    sections = _split_module_sections(stdout) + _split_module_sections(stderr)
    for section_module, section_body in sections:
        if section_module == module and _looks_empty(section_body, ""):
            continue  # this section had no markers — check next
        if section_module == module:
            return False
    return True


def _split_module_sections(text: str) -> List[Tuple[str, str]]:
    """Split an aggregate tail (`[module]\\n<body>\\n[module2]\\n...`) into
    `(module, body)` pairs. Best-effort — the format is just human-
    readable concatenation, not a strict protocol."""
    out: List[Tuple[str, str]] = []
    current_module: Optional[str] = None
    current_body: List[str] = []
    for line in text.splitlines():
        if line.startswith("[") and line.endswith("]") and " " not in line:
            if current_module is not None:
                out.append((current_module, "\n".join(current_body)))
            current_module = line[1:-1]
            current_body = []
        else:
            current_body.append(line)
    if current_module is not None:
        out.append((current_module, "\n".join(current_body)))
    return out
