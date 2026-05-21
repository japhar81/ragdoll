/**
 * End-to-end test for {@link ShellGitBackend} against a real `git`
 * binary. Skipped automatically when `git` isn't installed so the suite
 * stays install-free.
 *
 * Uses a local bare repo as the remote — no network, no auth — to
 * exercise clone, commit, push, pull, diffNames, list, read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRepo } from "../src/backend.ts";

const exec = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await exec("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function makeBareRepo(root: string, branch: string): Promise<string> {
  const bare = join(root, "remote.git");
  await mkdir(bare, { recursive: true });
  // Use `git init --bare -b <branch>` so the default HEAD matches what
  // our clone will check out. Older `git` (<2.28) doesn't support -b on
  // bare init; fall back to writing HEAD manually.
  try {
    await exec("git", ["init", "--bare", "-b", branch, bare]);
  } catch {
    await exec("git", ["init", "--bare", bare]);
    await writeFile(join(bare, "HEAD"), `ref: refs/heads/${branch}\n`);
  }
  // Seed the bare repo with an empty initial commit on the branch so a
  // fresh clone has something to check out (otherwise `git clone -b`
  // fails on an empty remote).
  const seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await exec("git", ["init", "-q", "-b", branch, seed]).catch(async () => {
    await exec("git", ["init", "-q", seed]);
    await exec("git", ["-C", seed, "checkout", "-b", branch]);
  });
  await exec("git", ["-C", seed, "config", "user.email", "test@x"]);
  await exec("git", ["-C", seed, "config", "user.name", "test"]);
  await writeFile(join(seed, "README.md"), "seed\n");
  await exec("git", ["-C", seed, "add", "README.md"]);
  await exec("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  await exec("git", ["-C", seed, "remote", "add", "origin", bare]);
  await exec("git", ["-C", seed, "push", "-q", "origin", branch]);
  return bare;
}

test("ShellGitBackend clones, commits, pulls, diffs against a real local repo", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git binary not installed");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ragdoll-git-test-"));
  try {
    const bare = await makeBareRepo(root, "main");
    const workRoot = join(root, "worktrees");

    // First open clones from scratch.
    const backend = await openRepo({
      remoteUrl: bare,
      branch: "main",
      auth: { method: "https", credential: "ignored-no-auth-needed" },
      workRoot,
      tenantId: "tenant-uuid-1"
    });
    try {
      const initialSha = await backend.headSha();
      assert.match(initialSha, /^[0-9a-f]{40}$/);

      // First commit: add two files.
      const r1 = await backend.commitAndPush({
        message: "ragdoll: first",
        authorName: "RAGdoll",
        authorEmail: "ragdoll@localhost",
        files: {
          "platform/acme/dev/manifest.yaml": "kind: Manifest\n",
          "platform/acme/dev/pipelines/intake.yaml": "kind: Pipeline\nspec: {}\n"
        }
      });
      assert.ok(r1.sha, "expected a commit sha");
      assert.notEqual(r1.sha, initialSha);

      // list() should surface only the files under the prefix.
      const lsAll = await backend.list("platform");
      assert.deepEqual(
        lsAll.sort(),
        [
          "platform/acme/dev/manifest.yaml",
          "platform/acme/dev/pipelines/intake.yaml"
        ]
      );

      // read() returns content verbatim.
      const text = await backend.read("platform/acme/dev/manifest.yaml");
      assert.equal(text, "kind: Manifest\n");

      // diffNames between two shas returns the changed files only.
      const r2 = await backend.commitAndPush({
        message: "ragdoll: second",
        authorName: "RAGdoll",
        authorEmail: "ragdoll@localhost",
        files: {
          "platform/acme/dev/configs/values.yaml": "kind: ConfigValues\nvalues: []\n"
        }
      });
      assert.ok(r2.sha);
      const diffs = await backend.diffNames(r1.sha!, r2.sha!);
      assert.deepEqual(diffs, ["platform/acme/dev/configs/values.yaml"]);

      // Re-open from the same workRoot — should be a fetch, not a clone.
      const reopened = await openRepo({
        remoteUrl: bare,
        branch: "main",
        auth: { method: "https", credential: "ignored" },
        workRoot,
        tenantId: "tenant-uuid-1"
      });
      try {
        assert.equal(await reopened.headSha(), r2.sha);
      } finally {
        await reopened.close();
      }
    } finally {
      await backend.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commitAndPush returns sha=null when nothing actually changed", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git binary not installed");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ragdoll-git-noop-"));
  try {
    const bare = await makeBareRepo(root, "main");
    const backend = await openRepo({
      remoteUrl: bare,
      branch: "main",
      auth: { method: "https", credential: "x" },
      workRoot: join(root, "worktrees"),
      tenantId: "noop-tenant"
    });
    try {
      const r1 = await backend.commitAndPush({
        message: "ragdoll: a",
        authorName: "R",
        authorEmail: "r@x",
        files: { "x.txt": "hello\n" }
      });
      assert.ok(r1.sha);
      // Same content again — git status should be empty.
      const r2 = await backend.commitAndPush({
        message: "ragdoll: a",
        authorName: "R",
        authorEmail: "r@x",
        files: { "x.txt": "hello\n" }
      });
      assert.equal(r2.sha, null);
    } finally {
      await backend.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
