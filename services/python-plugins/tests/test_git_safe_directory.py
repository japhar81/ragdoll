"""PLUGIN-ARCH: git "dubious ownership" (CVE-2022-24765) hardening.

A bind-mounted ``file://`` plugin source is owned by the host user while the
sidecar's runtime user is someone else, so git aborts every command against it
with ``fatal: detected dubious ownership …``. ``_git_env`` opts our subprocesses
out via a temp *global* gitconfig (``GIT_CONFIG_GLOBAL``) carrying
``safe.directory=*``.

The global-config file matters over scoped ``GIT_CONFIG_*`` env vars: a
``file://`` remote forks a separate ``git-upload-pack`` child that re-reads
global config and does NOT see the inline vars — so the earlier scoped-env fix
cleared direct commands but left ``git ls-remote file://…`` (the actual sidecar
path, via :func:`resolve_ref_to_sha`) still aborting. These tests pin the env
shape AND prove the guard is lifted for BOTH the direct-command path and the
``file://`` transport, using git's own ``GIT_TEST_ASSUME_DIFFERENT_OWNER`` hook
to force the check without a second uid.

Note: that hook fires for direct ``-C`` commands on both macOS and Linux, but
for the forked ``file://`` upload-pack only on Linux. So the ``file://``
assertion is conditional — on a platform/uid where the guard doesn't reproduce
we only assert the fix doesn't break git; in CI/containers it proves the fix.
Auto-skips when ``git`` isn't on PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from app.git_source import _git_env, _run_git, resolve_ref_to_sha

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not on PATH")


def _make_repo(path) -> None:
    subprocess.run(["git", "init", "-q", "-b", "main", str(path)], check=True)
    subprocess.run(
        ["git", "-C", str(path), "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "--allow-empty", "-m", "init"],
        check=True,
    )


def test_git_env_points_global_config_at_safe_directory(tmp_path) -> None:
    env = _git_env()
    cfg = env["GIT_CONFIG_GLOBAL"]
    assert os.path.isfile(cfg)
    body = open(cfg, encoding="utf-8").read()
    assert "[safe]" in body
    assert "directory = *" in body
    # Chains the caller's existing global config so operator settings survive.
    assert "[include]" in body
    # It copies (does not mutate) the process environment.
    assert "GIT_CONFIG_GLOBAL" not in os.environ or os.environ.get(
        "GIT_CONFIG_GLOBAL"
    ) != cfg


def test_run_git_survives_dubious_ownership_direct(tmp_path, monkeypatch) -> None:
    src = tmp_path / "src"
    _make_repo(src)
    # Git's own hook: behave as if the repo is owned by a different user.
    monkeypatch.setenv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1")
    # Whether or not the raw guard reproduces here, the fix path must work.
    out = _run_git(["-C", str(src), "rev-parse", "HEAD"])
    assert len(out.strip()) == 40


def test_resolve_ref_survives_dubious_ownership_file_url(tmp_path, monkeypatch) -> None:
    """The path that actually failed in the sidecar: ls-remote on a file:// URL.

    ``resolve_ref_to_sha`` shells out to ``git ls-remote file://<repo>``, which
    forks an upload-pack child — the case the scoped-env fix could not cover.
    """
    src = tmp_path / "src"
    _make_repo(src)
    url = f"file://{src}"

    monkeypatch.setenv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1")

    # Does the raw guard reproduce for the file:// path on this host? (Linux: yes.)
    raw = subprocess.run(
        ["git", "ls-remote", "--", url, "main"],
        capture_output=True, text=True,
    )
    reproduced = raw.returncode != 0 and "dubious ownership" in raw.stderr

    sha = resolve_ref_to_sha(url, "main")
    assert len(sha) == 40
    if reproduced:
        # We proved the fix lifts the guard on the exact failing transport.
        assert raw.returncode != 0  # sanity: the guard really did fire raw
