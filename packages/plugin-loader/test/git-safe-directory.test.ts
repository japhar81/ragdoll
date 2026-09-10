/**
 * PLUGIN-ARCH: git "dubious ownership" (CVE-2022-24765) hardening.
 *
 * A bind-mounted `file://` plugin source is owned by the host user while the
 * runtime user inside the container is someone else. Git then aborts every
 * command against that repo with `fatal: detected dubious ownership …`, which is
 * why adding a *sidecar* plugin source failed even though the (same-URL) Node
 * source worked — the two run as different uids.
 *
 * `gitSubprocessEnv` opts our git subprocesses out via a temp *global* gitconfig
 * (`GIT_CONFIG_GLOBAL`) carrying `safe.directory=*`. The global-config file
 * matters over scoped `GIT_CONFIG_*` env vars: a `file://` remote forks a
 * separate `git-upload-pack` child that re-reads global config and does NOT see
 * the inline vars — so the earlier scoped-env fix cleared `git -C …` but left
 * `git ls-remote file://…` still aborting. These tests pin the env shape AND
 * prove the guard is lifted for BOTH the direct-command path and the `file://`
 * transport, using git's own `GIT_TEST_ASSUME_DIFFERENT_OWNER` hook to force the
 * check without needing a second uid.
 *
 * Note: `GIT_TEST_ASSUME_DIFFERENT_OWNER` fires for direct `-C` commands on both
 * macOS and Linux, but for the forked `file://` upload-pack only on Linux. So the
 * `file://` assertion is conditional: on a platform/uid where the guard doesn't
 * reproduce we only assert the fix doesn't break git; in CI/containers it proves
 * the fix. Auto-skips when `git` isn't on PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSubprocessEnv } from "../src/git-fetcher.ts";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A source repo with one commit; returns its absolute path. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rd-git-safe-"));
  execFileSync("git", ["init", "-q", "-b", "main", "src"], { cwd: dir });
  const repo = join(dir, "src");
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init"
  ]);
  return repo;
}

test("gitSubprocessEnv points GIT_CONFIG_GLOBAL at a safe.directory=* config", () => {
  const env = gitSubprocessEnv({ FOO: "bar" } as NodeJS.ProcessEnv);
  assert.equal(env.FOO, "bar", "base env is preserved");
  assert.ok(env.GIT_CONFIG_GLOBAL, "GIT_CONFIG_GLOBAL is set");
  const cfg = readFileSync(env.GIT_CONFIG_GLOBAL as string, "utf8");
  assert.match(cfg, /\[safe\]/);
  assert.match(cfg, /directory = \*/);
  // It must also chain the caller's existing global config via [include].
  assert.match(cfg, /\[include\]/);
});

test("gitSubprocessEnv neutralizes the guard for `git -C` (direct path)", { skip: !hasGit() }, () => {
  const repo = makeRepo();
  const assumeDifferentOwner: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1"
  };
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { env, encoding: "utf8" });

  const withFix = run(gitSubprocessEnv(assumeDifferentOwner));
  const without = run(assumeDifferentOwner);

  if (without.status !== 0 && /dubious ownership/.test(without.stderr)) {
    assert.equal(withFix.status, 0, `expected success, stderr: ${withFix.stderr}`);
    assert.match(withFix.stdout.trim(), /^[0-9a-f]{40}$/);
  } else {
    // Couldn't reproduce (e.g. running as root, which git exempts) — at minimum
    // the injected env must not break a normal command.
    assert.equal(withFix.status, 0, `gitSubprocessEnv must not break git: ${withFix.stderr}`);
  }
});

test("gitSubprocessEnv neutralizes the guard for `git ls-remote file://`", { skip: !hasGit() }, () => {
  // This is the transport that the earlier scoped-env fix MISSED: ls-remote on a
  // file:// URL forks an upload-pack child that re-reads global config.
  const repo = makeRepo();
  const url = `file://${repo}`;
  const assumeDifferentOwner: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1"
  };
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync("git", ["ls-remote", "--", url, "main"], { env, encoding: "utf8" });

  const withFix = run(gitSubprocessEnv(assumeDifferentOwner));
  const without = run(assumeDifferentOwner);

  if (without.status !== 0 && /dubious ownership/.test(without.stderr)) {
    // Guard reproduced (Linux/CI) — the fix MUST lift it for the file:// path.
    assert.equal(withFix.status, 0, `expected ls-remote success, stderr: ${withFix.stderr}`);
    assert.match(withFix.stdout.trim(), /^[0-9a-f]{40}\s/);
  } else {
    // Guard doesn't fire for file:// here (e.g. macOS) — assert the fix at least
    // doesn't break a normal ls-remote.
    assert.equal(withFix.status, 0, `gitSubprocessEnv must not break ls-remote: ${withFix.stderr}`);
  }
});
