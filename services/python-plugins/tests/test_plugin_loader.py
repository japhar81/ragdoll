"""PLUGIN-ARCH-2: git plugin loader — integration tests.

These build a real bare git repo (`git init --bare`) with a Python
plugin module and run the loader against a `file://` URL, covering the
end-to-end path the sidecar takes for an external plugin:

  resolve ref → sha → clone (content-addressed) → import → scan →
  register, with provenance + per-source isolation.

Auto-skip when `git` isn't on PATH (the sidecar image has it; a bare
dev box might not).
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

import pytest

SERVICE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app import plugin_loader  # noqa: E402
from app.git_source import ensure_commit_on_disk, resolve_ref_to_sha  # noqa: E402


def _git_available() -> bool:
    return shutil.which("git") is not None


pytestmark = pytest.mark.skipif(not _git_available(), reason="git not on PATH")


PLUGIN_SRC = '''
PLUGIN_ID = "acme_hello"

MANIFEST = {
    "id": "acme_hello",
    "name": "Acme Hello",
    "version": "1.0.0",
    "category": "datasource",
    "description": "git-loaded test plugin",
    "outputPorts": [{"name": "out"}],
}

def handle(request):
    return {"outputs": {"greeting": "hello from acme"}}
'''


def _git(args, cwd=None):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "T",
        "GIT_AUTHOR_EMAIL": "t@x.invalid",
        "GIT_COMMITTER_NAME": "T",
        "GIT_COMMITTER_EMAIL": "t@x.invalid",
    }
    res = subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True
    )
    if res.returncode != 0:
        raise RuntimeError(f"git {args} failed: {res.stderr or res.stdout}")
    return res.stdout


@pytest.fixture()
def fixture_repo():
    """A bare repo with a plugin module under `plugins/hello.py`, plus
    the initial sha. Returns (file_url, work_dir, sha)."""
    root = tempfile.mkdtemp(prefix="ragdoll-pl-")
    bare = os.path.join(root, "bare.git")
    work = os.path.join(root, "work")
    _git(["init", "--quiet", "--bare", bare])
    _git(["init", "--quiet", "-b", "main", work])
    os.makedirs(os.path.join(work, "plugins"))
    with open(os.path.join(work, "plugins", "hello.py"), "w", encoding="utf-8") as fh:
        fh.write(PLUGIN_SRC)
    _git(["add", "."], cwd=work)
    _git(["commit", "--quiet", "-m", "init"], cwd=work)
    _git(["remote", "add", "origin", bare], cwd=work)
    _git(["push", "--quiet", "origin", "main"], cwd=work)
    sha = _git(["rev-parse", "HEAD"], cwd=work).strip()
    yield (f"file://{bare}", work, sha)
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(autouse=True)
def _clean_registry():
    plugin_loader.__clear_for_tests()
    yield
    plugin_loader.__clear_for_tests()


# ---------------------------------------------------------------------------
# git_source
# ---------------------------------------------------------------------------


def test_resolve_ref_to_sha_resolves_main(fixture_repo):
    url, _work, sha = fixture_repo
    assert resolve_ref_to_sha(url, "main") == sha


def test_resolve_ref_to_sha_short_circuits_a_full_sha(fixture_repo):
    _url, _work, sha = fixture_repo
    # A 40-char sha is returned as-is without a remote round-trip.
    assert resolve_ref_to_sha("file:///does/not/matter", sha) == sha


def test_ensure_commit_on_disk_is_content_addressed_and_idempotent(fixture_repo, tmp_path):
    url, _work, sha = fixture_repo
    a = ensure_commit_on_disk(repo_id="acme", git_url=url, sha=sha, cache_dir=str(tmp_path))
    assert a.working_copy_path == str(tmp_path / "acme" / sha)
    assert os.path.isfile(os.path.join(a.working_copy_path, "plugins", "hello.py"))
    # Touch a marker, re-fetch — second call is a no-op (no re-clone).
    marker = os.path.join(a.working_copy_path, ".marker")
    with open(marker, "w") as fh:
        fh.write("1")
    b = ensure_commit_on_disk(repo_id="acme", git_url=url, sha=sha, cache_dir=str(tmp_path))
    assert b.working_copy_path == a.working_copy_path
    assert os.path.isfile(marker)


# ---------------------------------------------------------------------------
# load_sources — the end-to-end path
# ---------------------------------------------------------------------------


def test_load_sources_imports_registers_and_stamps_provenance(fixture_repo, tmp_path):
    url, _work, sha = fixture_repo
    statuses = plugin_loader.load_sources(
        [plugin_loader.PluginSource(id="acme", git_url=url, ref="main", subpath="plugins")],
        cache_dir=str(tmp_path),
    )
    assert len(statuses) == 1
    s = statuses[0]
    assert s.status == "loaded", s.error
    assert s.commit_sha == sha
    assert s.plugin_ids == ["acme_hello"]
    # Registered + callable + provenance.
    reg = plugin_loader.loaded_plugins()
    assert "acme_hello" in reg
    loaded = reg["acme_hello"]
    assert loaded.source_id == "acme"
    assert loaded.commit_sha == sha
    assert loaded.manifest is not None and loaded.manifest["id"] == "acme_hello"
    out = loaded.handle(object())
    assert out["outputs"]["greeting"] == "hello from acme"


def test_load_sources_second_call_same_sha_hits_cache(fixture_repo, tmp_path):
    url, _work, _sha = fixture_repo
    src = [plugin_loader.PluginSource(id="acme", git_url=url, ref="main", subpath="plugins")]
    plugin_loader.load_sources(src, cache_dir=str(tmp_path))
    first = plugin_loader.loaded_plugins()["acme_hello"]
    # Re-load: same sha → cache hit → SAME LoadedPlugin object replayed.
    plugin_loader.load_sources(src, cache_dir=str(tmp_path))
    second = plugin_loader.loaded_plugins()["acme_hello"]
    assert first is second


def test_load_sources_disabled_source_is_skipped(fixture_repo, tmp_path):
    url, _work, _sha = fixture_repo
    statuses = plugin_loader.load_sources(
        [plugin_loader.PluginSource(id="acme", git_url=url, ref="main", subpath="plugins", enabled=False)],
        cache_dir=str(tmp_path),
    )
    assert statuses[0].status == "skipped"
    assert statuses[0].error_stage == "disabled"
    assert plugin_loader.loaded_plugins() == {}


def test_load_sources_isolates_a_bad_source_and_keeps_the_good_one(fixture_repo, tmp_path):
    url, _work, _sha = fixture_repo
    bad = plugin_loader.PluginSource(
        id="bad", git_url="file:///nonexistent/repo.git", ref="main"
    )
    good = plugin_loader.PluginSource(id="acme", git_url=url, ref="main", subpath="plugins")
    statuses = plugin_loader.load_sources([bad, good], cache_dir=str(tmp_path))
    by_id = {s.id: s for s in statuses}
    assert by_id["bad"].status == "failed"
    assert by_id["bad"].error_stage in ("resolve", "clone")
    assert by_id["acme"].status == "loaded"
    # The good source's plugin still registered despite the bad one failing.
    assert "acme_hello" in plugin_loader.loaded_plugins()


def test_load_sources_module_with_no_plugin_export_registers_nothing(tmp_path):
    # A repo whose subpath has a .py file that ISN'T a plugin (no
    # PLUGIN_ID / handle) loads cleanly with zero plugins.
    root = tempfile.mkdtemp(prefix="ragdoll-pl-nop-")
    bare = os.path.join(root, "bare.git")
    work = os.path.join(root, "work")
    try:
        _git(["init", "--quiet", "--bare", bare])
        _git(["init", "--quiet", "-b", "main", work])
        with open(os.path.join(work, "helper.py"), "w") as fh:
            fh.write("X = 1\n")
        _git(["add", "."], cwd=work)
        _git(["commit", "--quiet", "-m", "init"], cwd=work)
        _git(["remote", "add", "origin", bare], cwd=work)
        _git(["push", "--quiet", "origin", "main"], cwd=work)
        statuses = plugin_loader.load_sources(
            [plugin_loader.PluginSource(id="nop", git_url=f"file://{bare}", ref="main")],
            cache_dir=str(tmp_path),
        )
        assert statuses[0].status == "loaded"
        assert statuses[0].plugin_count == 0
        assert plugin_loader.loaded_plugins() == {}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_load_sources_removed_source_disappears_on_reload(fixture_repo, tmp_path):
    url, _work, _sha = fixture_repo
    src = plugin_loader.PluginSource(id="acme", git_url=url, ref="main", subpath="plugins")
    plugin_loader.load_sources([src], cache_dir=str(tmp_path))
    assert "acme_hello" in plugin_loader.loaded_plugins()
    # Reload with an EMPTY source list — the plugin is gone (the swap
    # replaces the whole registry, matching the TS holder swap).
    plugin_loader.load_sources([], cache_dir=str(tmp_path))
    assert plugin_loader.loaded_plugins() == {}


# ---------------------------------------------------------------------------
# parse_sources_env
# ---------------------------------------------------------------------------


def test_parse_sources_env_reads_a_json_array():
    raw = json.dumps(
        [
            {"id": "a", "gitUrl": "https://x/a.git", "ref": "v1", "subpath": "src"},
            {"id": "b", "gitUrl": "https://x/b.git"},
        ]
    )
    out = plugin_loader.parse_sources_env(raw)
    assert [s.id for s in out] == ["a", "b"]
    assert out[0].ref == "v1"
    assert out[0].subpath == "src"
    assert out[1].ref == "main"  # default


def test_parse_sources_env_tolerates_garbage():
    assert plugin_loader.parse_sources_env(None) == []
    assert plugin_loader.parse_sources_env("") == []
    assert plugin_loader.parse_sources_env("not json") == []
    assert plugin_loader.parse_sources_env('{"not": "an array"}') == []
    # Rows missing id / gitUrl are dropped, not fatal.
    assert plugin_loader.parse_sources_env('[{"id": "x"}]') == []
