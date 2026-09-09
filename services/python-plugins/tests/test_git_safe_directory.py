"""PLUGIN-ARCH: git "dubious ownership" (CVE-2022-24765) hardening.

A bind-mounted ``file://`` plugin source is owned by the host user while the
sidecar's runtime user is someone else, so git aborts every command against it
with ``fatal: detected dubious ownership …``. ``_git_env`` opts our subprocesses
out via ``safe.directory=*`` (scoped ``GIT_CONFIG_*`` env vars, no global
gitconfig write). These tests pin the env shape and prove it lifts the guard,
using git's own ``GIT_TEST_ASSUME_DIFFERENT_OWNER`` hook to force the check
without a second uid.

Auto-skips when ``git`` isn't on PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from app.git_source import _git_env, _run_git

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not on PATH")


def test_git_env_sets_scoped_safe_directory() -> None:
    env = _git_env()
    assert env["GIT_CONFIG_COUNT"] == "1"
    assert env["GIT_CONFIG_KEY_0"] == "safe.directory"
    assert env["GIT_CONFIG_VALUE_0"] == "*"
    # It copies (does not mutate) the process environment.
    assert "GIT_CONFIG_KEY_0" not in os.environ


def test_run_git_survives_dubious_ownership(tmp_path, monkeypatch) -> None:
    src = tmp_path / "src"
    subprocess.run(["git", "init", "-q", "-b", "main", str(src)], check=True)
    subprocess.run(
        ["git", "-C", str(src), "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "--allow-empty", "-m", "init"],
        check=True,
    )

    # Git's own hook: behave as if the repo is owned by a different user.
    monkeypatch.setenv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1")

    # Raw git (no safe.directory) reproduces the guard; _run_git injects it.
    raw = subprocess.run(
        ["git", "-C", str(src), "rev-parse", "HEAD"],
        capture_output=True, text=True,
    )
    if raw.returncode != 0 and "dubious ownership" in raw.stderr:
        out = _run_git(["-C", str(src), "rev-parse", "HEAD"])
        assert len(out.strip()) == 40
    else:
        # Couldn't reproduce (e.g. running as root) — at minimum the fix path must work.
        out = _run_git(["-C", str(src), "rev-parse", "HEAD"])
        assert len(out.strip()) == 40
