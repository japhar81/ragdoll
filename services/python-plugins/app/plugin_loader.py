"""PLUGIN-ARCH-2: git-sourced plugin loading for the Python sidecar.

The sidecar's built-in handlers (cartography / cloudquery / crawl4ai /
scrapy / rerank_bge) are registered statically in `app/main.py`. This
module adds the ability to load ADDITIONAL handlers from external
(internal/trusted) git repos — the Python mirror of PLUGIN-ARCH-1's
TS in-process loader (ADR-0034).

A git-sourced plugin module exposes the SAME duck-type every built-in
sidecar plugin already uses:

    PLUGIN_ID = "my_plugin"          # str — the id RAGdoll references
    def handle(request) -> dict: ... # the ExecuteRequest handler

and OPTIONALLY a manifest dict so RAGdoll can register it in the
builder palette without a hand-authored TS manifest:

    MANIFEST = {
      "id": "my_plugin", "name": "My Plugin", "version": "1.0.0",
      "category": "datasource", "description": "...",
      "configSchema": {...}, "outputPorts": [...], ...
    }

Lifecycle per source (mirrors the TS stages):

  resolve → clone (content-addressed) → install deps → import → scan
  → register.

Per-source isolation: any stage failing produces a `failed` status
with the stage + message; the other sources still load. Provenance
(repoId, commitSha) rides on each discovered descriptor so
`/manifests` can show "from <repo> @ <sha>" and RAGdoll's catalog can
surface it.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import subprocess  # noqa: S404 — pip install of trusted plugin deps
import sys
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from app.git_source import GitFetchError, ensure_commit_on_disk, resolve_ref_to_sha

logger = logging.getLogger("ragdoll.python-plugins.loader")

# Marker dropped into a working copy after a successful dep install —
# makes a re-load of the same sha a no-op (content-addressed cache,
# like the TS `.ragdoll-installed`).
_INSTALL_MARKER = ".ragdoll-py-installed"
_DEPS_DIR = ".ragdoll_deps"
_INSTALL_TIMEOUT_S = int(os.environ.get("RAGDOLL_PY_INSTALL_TIMEOUT_S", "300"))


@dataclass
class PluginSource:
    """One git source descriptor (the wire shape RAGdoll pushes)."""

    id: str
    git_url: str
    ref: str = "main"
    subpath: str = ""
    enabled: bool = True


@dataclass
class LoadedPlugin:
    """A handler discovered from a source, with its provenance."""

    plugin_id: str
    handle: Callable[[Any], Dict[str, Any]]
    manifest: Optional[Dict[str, Any]]
    source_id: str
    commit_sha: Optional[str]


@dataclass
class SourceStatus:
    """Per-source load outcome — mirrors the TS `SourceLoadStatus`."""

    id: str
    status: str  # "loaded" | "skipped" | "failed"
    plugin_count: int = 0
    commit_sha: Optional[str] = None
    ref: Optional[str] = None
    error: Optional[str] = None
    error_stage: Optional[str] = None  # resolve|clone|install|import|scan|register|disabled
    plugin_ids: List[str] = field(default_factory=list)


# Process-global registry of git-loaded plugins. `app/main.py` merges
# this with the static built-ins. A refresh REPLACES this wholesale so
# a removed source's plugins disappear (matching the TS swap).
_LOADED: Dict[str, LoadedPlugin] = {}

# Cache of (source_id, sha) -> already-imported LoadedPlugin list, so a
# refresh against an unchanged sha is a no-op (no re-import).
_CACHE: Dict[str, List[LoadedPlugin]] = {}


def loaded_plugins() -> Dict[str, LoadedPlugin]:
    """Live view of the currently git-loaded plugins (id -> descriptor)."""
    return dict(_LOADED)


def _cache_key(source_id: str, sha: Optional[str]) -> str:
    return f"{source_id}@{sha or 'none'}"


def _install_deps(working_copy: str) -> None:
    """Pip-install a plugin's requirements.txt into an isolated, content-
    addressed `.ragdoll_deps` dir inside the working copy (added to
    sys.path at import time). No-op when there's no requirements.txt or
    the marker is already present (re-load of the same sha).

    KISS posture mirrors the TS `--ignore-scripts` reasoning: deps are
    installed with `--no-build-isolation` off (default) but into a
    target dir so they don't pollute the sidecar's site-packages. The
    trust boundary (a requirements.txt can pull arbitrary packages) is
    the same internal/trusted assumption the whole repo-source model
    rests on — named in ADR-0034, owned by the future trust tier.
    """
    req = os.path.join(working_copy, "requirements.txt")
    if not os.path.isfile(req):
        return
    marker = os.path.join(working_copy, _INSTALL_MARKER)
    if os.path.isfile(marker):
        return
    target = os.path.join(working_copy, _DEPS_DIR)
    result = subprocess.run(  # noqa: S603 — pip on a trusted requirements file
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--quiet",
            "--no-input",
            "--disable-pip-version-check",
            "--target",
            target,
            "-r",
            req,
        ],
        capture_output=True,
        text=True,
        timeout=_INSTALL_TIMEOUT_S,
        check=False,
    )
    if result.returncode != 0:
        raise GitFetchError(
            f"pip install -r requirements.txt failed: "
            f"{(result.stderr or '')[-1024:]}",
            "install",
        )
    # Drop the marker LAST so a crash mid-install retries cleanly.
    with open(marker, "w", encoding="utf-8") as fh:
        fh.write("ok\n")


def _candidate_modules(scan_root: str) -> List[str]:
    """Return the .py file paths to import for a source.

    If `scan_root` is a file, import just it. If a directory, import
    every top-level `.py` (excluding dunder + the deps dir) — the
    Python analogue of the TS "scan the module's exports".
    """
    if os.path.isfile(scan_root):
        return [scan_root]
    out: List[str] = []
    for name in sorted(os.listdir(scan_root)):
        if not name.endswith(".py"):
            continue
        if name.startswith("__"):
            continue
        out.append(os.path.join(scan_root, name))
    return out


def _import_module_from_path(path: str, source_id: str, deps_dir: Optional[str]):
    """Import a .py file as a uniquely-named module.

    The module name embeds a nonce so two shas of the same source (or
    two sources exporting the same filename) don't collide in
    `sys.modules` — the import-cache analogue of the TS content-
    addressed URL.
    """
    mod_name = f"ragdoll_gitplugin_{source_id}_{uuid.uuid4().hex[:8]}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise GitFetchError(f"could not build import spec for {path}", "import")
    module = importlib.util.module_from_spec(spec)
    # Make the plugin's own deps importable while it executes.
    added = False
    if deps_dir and os.path.isdir(deps_dir) and deps_dir not in sys.path:
        sys.path.insert(0, deps_dir)
        added = True
    try:
        sys.modules[mod_name] = module
        spec.loader.exec_module(module)
    finally:
        if added:
            try:
                sys.path.remove(deps_dir)
            except ValueError:
                pass
    return module


def _scan_module(module, source_id: str, commit_sha: Optional[str]) -> List[LoadedPlugin]:
    """Duck-type a module: it's a plugin iff it has a string `PLUGIN_ID`
    and a callable `handle`. Optional `MANIFEST` dict is carried for
    RAGdoll discovery."""
    plugin_id = getattr(module, "PLUGIN_ID", None)
    handle = getattr(module, "handle", None)
    if not isinstance(plugin_id, str) or not callable(handle):
        return []
    manifest = getattr(module, "MANIFEST", None)
    if manifest is not None and not isinstance(manifest, dict):
        manifest = None
    return [
        LoadedPlugin(
            plugin_id=plugin_id,
            handle=handle,
            manifest=manifest,
            source_id=source_id,
            commit_sha=commit_sha,
        )
    ]


def _load_one(
    source: PluginSource, cache_dir: Optional[str]
) -> tuple[SourceStatus, List[LoadedPlugin]]:
    """Load a single source. NEVER raises — returns a `failed` status on
    any stage error so the caller proceeds to the next source."""
    if not source.enabled:
        return (
            SourceStatus(id=source.id, status="skipped", error_stage="disabled"),
            [],
        )
    # resolve
    try:
        sha = resolve_ref_to_sha(source.git_url, source.ref)
    except GitFetchError as exc:
        return (
            SourceStatus(
                id=source.id,
                status="failed",
                ref=source.ref,
                error=str(exc),
                error_stage=getattr(exc, "stage", "resolve"),
            ),
            [],
        )
    # cache hit?
    key = _cache_key(source.id, sha)
    cached = _CACHE.get(key)
    if cached is not None:
        return (
            SourceStatus(
                id=source.id,
                status="loaded",
                commit_sha=sha,
                ref=source.ref,
                plugin_count=len(cached),
                plugin_ids=[p.plugin_id for p in cached],
            ),
            cached,
        )
    # clone
    try:
        fetched = ensure_commit_on_disk(
            repo_id=source.id,
            git_url=source.git_url,
            sha=sha,
            cache_dir=cache_dir,
        )
    except GitFetchError as exc:
        return (
            SourceStatus(
                id=source.id,
                status="failed",
                ref=source.ref,
                commit_sha=sha,
                error=str(exc),
                error_stage=getattr(exc, "stage", "clone"),
            ),
            [],
        )
    scan_root = (
        os.path.join(fetched.working_copy_path, source.subpath)
        if source.subpath
        else fetched.working_copy_path
    )
    # install deps
    try:
        _install_deps(fetched.working_copy_path)
    except GitFetchError as exc:
        return (
            SourceStatus(
                id=source.id,
                status="failed",
                ref=source.ref,
                commit_sha=sha,
                error=str(exc),
                error_stage="install",
            ),
            [],
        )
    # import + scan
    deps_dir = os.path.join(fetched.working_copy_path, _DEPS_DIR)
    found: List[LoadedPlugin] = []
    try:
        if not os.path.exists(scan_root):
            raise GitFetchError(
                f"subpath {source.subpath!r} does not exist in the repo",
                "import",
            )
        for mod_path in _candidate_modules(scan_root):
            module = _import_module_from_path(mod_path, source.id, deps_dir)
            found.extend(_scan_module(module, source.id, sha))
    except GitFetchError as exc:
        return (
            SourceStatus(
                id=source.id,
                status="failed",
                ref=source.ref,
                commit_sha=sha,
                error=str(exc),
                error_stage=getattr(exc, "stage", "import"),
            ),
            [],
        )
    except Exception as exc:  # noqa: BLE001 — a module that throws on import
        return (
            SourceStatus(
                id=source.id,
                status="failed",
                ref=source.ref,
                commit_sha=sha,
                error=f"{type(exc).__name__}: {exc}",
                error_stage="import",
            ),
            [],
        )
    _CACHE[key] = found
    return (
        SourceStatus(
            id=source.id,
            status="loaded",
            commit_sha=sha,
            ref=source.ref,
            plugin_count=len(found),
            plugin_ids=[p.plugin_id for p in found],
        ),
        found,
    )


def load_sources(
    sources: List[PluginSource], cache_dir: Optional[str] = None
) -> List[SourceStatus]:
    """Load every source + REPLACE the live registry with the union of
    their plugins. Per-source failures are isolated + surfaced. Returns
    the per-source status list (the refresh report)."""
    statuses: List[SourceStatus] = []
    next_registry: Dict[str, LoadedPlugin] = {}
    for source in sources:
        status, plugins = _load_one(source, cache_dir)
        statuses.append(status)
        for p in plugins:
            # Last-source-wins on id collision (deterministic by the
            # caller's source order).
            next_registry[p.plugin_id] = p
    _LOADED.clear()
    _LOADED.update(next_registry)
    return statuses


def parse_sources_env(raw: Optional[str]) -> List[PluginSource]:
    """Parse `RAGDOLL_PYTHON_PLUGIN_SOURCES` (a JSON array of
    {id, gitUrl, ref?, subpath?, enabled?}) into PluginSource objects.
    Returns [] for empty / malformed input (logged), so a bad env var
    never crashes sidecar startup."""
    if not raw or not raw.strip():
        return []
    import json

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning("RAGDOLL_PYTHON_PLUGIN_SOURCES is not valid JSON: %s", exc)
        return []
    if not isinstance(data, list):
        logger.warning("RAGDOLL_PYTHON_PLUGIN_SOURCES must be a JSON array")
        return []
    out: List[PluginSource] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        sid = item.get("id")
        url = item.get("gitUrl") or item.get("git_url")
        if not isinstance(sid, str) or not isinstance(url, str):
            continue
        out.append(
            PluginSource(
                id=sid,
                git_url=url,
                ref=str(item.get("ref") or "main"),
                subpath=str(item.get("subpath") or ""),
                enabled=item.get("enabled", True) is not False,
            )
        )
    return out


def __clear_for_tests() -> None:
    _LOADED.clear()
    _CACHE.clear()
