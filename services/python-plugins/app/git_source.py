"""PLUGIN-ARCH-2: content-addressed git fetch for the Python sidecar.

Mirrors the TS-side `packages/plugin-loader/src/git-fetcher.ts`:

  - resolve a ref (branch / tag / commit) to a sha via `git ls-remote`
    BEFORE any clone, so an already-fetched sha skips the clone;
  - clone into `<cacheDir>/<repoId>/<sha>/` — content-addressed, so a
    new commit lands in a new path (a new Python import path → fresh
    module, no stale-import games);
  - `--no-hardlinks` so a `file://` source repo modified after the
    clone can't mutate the cached working copy (the same invariant the
    TS loader pins).

Shells out to the system `git` binary (installed in the sidecar
image). No GitPython dep — keeps the import surface minimal and the
behaviour identical to the TS path.
"""

from __future__ import annotations

import os
import re
import subprocess  # noqa: S404 — shelling out to git is the design
import tempfile
from dataclasses import dataclass
from typing import Optional

_SHA_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
_REPO_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


class GitFetchError(Exception):
    """A fetch failed at a named stage (`resolve` / `clone` / `verify`)."""

    def __init__(self, message: str, stage: str):
        super().__init__(message)
        self.stage = stage


@dataclass
class FetchedSource:
    commit_sha: str
    working_copy_path: str


def default_cache_dir() -> str:
    """Where cloned repos live. Env-overridable so an operator can put
    it on a larger / faster volume."""
    return os.environ.get(
        "RAGDOLL_PY_PLUGIN_CACHE_DIR", "/tmp/ragdoll-py-plugin-cache"
    )


def _run_git(args: list[str], timeout: Optional[float] = None) -> str:
    """Run git; return stdout; raise with stderr on non-zero exit."""
    try:
        result = subprocess.run(  # noqa: S603 — argv built from validated input
            ["git", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise GitFetchError(
            "git binary not found in the python-plugins sidecar — rebuild "
            "the image with git installed",
            "clone",
        ) from exc
    if result.returncode != 0:
        raise GitFetchError(
            f"git {args[0]} exited {result.returncode}: "
            f"{(result.stderr or '').strip() or '(no stderr)'}",
            "clone",
        )
    return result.stdout or ""


def resolve_ref_to_sha(git_url: str, ref: str) -> str:
    """Resolve `ref` on the remote to its canonical sha.

    A 40-char sha short-circuits (no round-trip). Otherwise `git
    ls-remote` is asked; annotated-tag peels (`^{}`) win over the tag
    object so we get the tagged commit.
    """
    trimmed = ref.strip()
    if _SHA_RE.match(trimmed):
        return trimmed.lower()
    try:
        out = _run_git(["ls-remote", "--", git_url, trimmed], timeout=30)
    except GitFetchError as exc:
        raise GitFetchError(
            f"git ls-remote {git_url} {trimmed!r} failed: {exc}", "resolve"
        ) from exc
    lines = [ln for ln in out.split("\n") if ln.strip()]
    if not lines:
        raise GitFetchError(
            f"ref {trimmed!r} not found on {git_url}", "resolve"
        )
    peeled = next((ln for ln in lines if ln.endswith("^{}")), None)
    chosen = peeled or lines[0]
    sha = chosen.split()[0]
    if not _SHA_RE.match(sha):
        raise GitFetchError(
            f"git ls-remote returned a non-sha first column: {chosen}",
            "resolve",
        )
    return sha.lower()


def ensure_commit_on_disk(
    *, repo_id: str, git_url: str, sha: str, cache_dir: Optional[str] = None
) -> FetchedSource:
    """Ensure `<cacheDir>/<repoId>/<sha>/` exists with the repo at `sha`.

    Idempotent: a repeat call on the same `(repoId, sha)` returns
    immediately without touching git.
    """
    cache = cache_dir or default_cache_dir()
    if not _REPO_ID_RE.match(repo_id):
        raise GitFetchError(
            f"repoId {repo_id!r} must be [A-Za-z0-9_.-]+", "verify"
        )
    if not _SHA_RE.match(sha):
        raise GitFetchError(
            f"sha must be a 40-char hex string; got {sha!r}", "verify"
        )
    sha = sha.lower()
    repo_root = os.path.join(cache, repo_id)
    working_copy = os.path.join(repo_root, sha)
    if os.path.isdir(working_copy):
        return FetchedSource(commit_sha=sha, working_copy_path=working_copy)
    os.makedirs(repo_root, exist_ok=True)
    # Clone to a tmp dir then atomically rename into the sha-named dir,
    # so a concurrent reader never sees a half-populated `<sha>/`.
    tmp = tempfile.mkdtemp(prefix=f"{sha}.partial-", dir=repo_root)
    try:
        # --no-hardlinks: file:// clones default to hardlinking objects
        # from the source; a later write to the source would mutate this
        # cache entry, breaking the content-addressed invariant. No-op
        # on https/ssh. Kept on unconditionally.
        _run_git(
            [
                "clone",
                "--quiet",
                "--no-tags",
                "--no-hardlinks",
                "--filter=blob:none",
                git_url,
                tmp,
            ]
        )
        _run_git(["-C", tmp, "fetch", "--depth=1", "origin", sha])
        _run_git(["-C", tmp, "checkout", "--quiet", sha])
    except GitFetchError as exc:
        _rmtree_quiet(tmp)
        raise GitFetchError(
            f"git clone/checkout {git_url} @ {sha} failed: {exc}", "clone"
        ) from exc
    try:
        os.rename(tmp, working_copy)
    except OSError:
        # Lost the race to a concurrent loader? Accept the existing dir.
        if os.path.isdir(working_copy):
            _rmtree_quiet(tmp)
        else:
            _rmtree_quiet(tmp)
            raise
    return FetchedSource(commit_sha=sha, working_copy_path=working_copy)


def _rmtree_quiet(path: str) -> None:
    import shutil

    try:
        shutil.rmtree(path, ignore_errors=True)
    except OSError:
        pass
