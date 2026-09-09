/**
 * PLUGIN-ARCH: git "dubious ownership" (CVE-2022-24765) hardening.
 *
 * A bind-mounted `file://` plugin source is owned by the host user while the
 * runtime user inside the container is someone else. Git then aborts every
 * command against that repo with `fatal: detected dubious ownership …`, which is
 * why adding a *sidecar* plugin source failed even though the (same-URL) Node
 * source worked — the two run as different uids.
 *
 * `gitSubprocessEnv` opts our git subprocesses out via `safe.directory=*` scoped
 * through `GIT_CONFIG_*` env vars. These tests pin the env shape AND prove it
 * actually neutralizes the guard, using git's own `GIT_TEST_ASSUME_DIFFERENT_OWNER`
 * hook to force the check without needing a second uid.
 *
 * Auto-skips when `git` isn't on PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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

test("gitSubprocessEnv injects safe.directory=* and preserves the base env", () => {
  const env = gitSubprocessEnv({ FOO: "bar" } as NodeJS.ProcessEnv);
  assert.equal(env.FOO, "bar", "base env is preserved");
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "safe.directory");
  assert.equal(env.GIT_CONFIG_VALUE_0, "*");
});

test("gitSubprocessEnv neutralizes git's dubious-ownership guard", { skip: !hasGit() }, () => {
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

  // Git's own hook: behave as if the repo is owned by a different user.
  const assumeDifferentOwner: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1"
  };
  const runRevParse = (env: NodeJS.ProcessEnv) =>
    spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { env, encoding: "utf8" });

  const withFix = runRevParse(gitSubprocessEnv(assumeDifferentOwner));

  const without = runRevParse(assumeDifferentOwner);
  if (without.status !== 0 && /dubious ownership/.test(without.stderr)) {
    // Guard reproduced — the fix must lift it.
    assert.equal(withFix.status, 0, `expected success, stderr: ${withFix.stderr}`);
    assert.match(withFix.stdout.trim(), /^[0-9a-f]{40}$/);
  } else {
    // Couldn't reproduce (e.g. running as root, which git exempts) — at minimum
    // the injected env must not break a normal command.
    assert.equal(withFix.status, 0, `gitSubprocessEnv must not break git: ${withFix.stderr}`);
  }
});
