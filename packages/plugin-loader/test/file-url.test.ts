/**
 * PLUGIN-ARCH-1: file:// transport — end-to-end integration test.
 *
 * Operators with a local mirror, an air-gapped install, or a dev
 * workflow that bypasses a hosted Git server can point a plugin
 * source at a `file:///path/to/bare-repo.git` URL. git supports
 * file:// natively; the lifecycle's existing resolve → fetch →
 * scan → register path covers it without a code branch.
 *
 * The load-bearing invariants this test pins:
 *
 *   - `resolveRefToSha("file://…", "main")` returns the sha of
 *     HEAD on the bare repo's `main` branch.
 *   - `ensureCommitOnDisk` clones into `<cacheDir>/<repoId>/<sha>/`
 *     and the checkout contains the source files at the resolved
 *     sha.
 *   - `loadSource` against the file:// URL exits `loaded` with the
 *     plugin discovered and its provenance stamped with
 *     `kind: "git"` + the resolved sha (the local clone is still a
 *     `git` source — the kind reflects HOW it loaded, not WHERE
 *     the bytes live).
 *   - Concurrent mutation of the SOURCE bare repo doesn't leak
 *     into the cached working copy (the `--no-hardlinks` guarantee
 *     — a write to the source's .git/objects/ after the clone must
 *     NOT appear in the cache).
 *
 * Skipped automatically when the `git` binary isn't on PATH (the
 * sandbox / CI image always has it, but make the test honest).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __clearPluginCacheForTests,
  loadSource
} from "../src/lifecycle.ts";
import {
  ensureCommitOnDisk,
  resolveRefToSha
} from "../src/git-fetcher.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";

function gitAvailable(): boolean {
  const probe = spawnSync("git", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

/** Run `git` with args; throw on non-zero exit with the stderr. */
function gitOrThrow(args: string[], cwd?: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // Make commits reproducible across machines.
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid"
    }
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout ?? "";
}

/**
 * Create a bare repo + a working repo that pushes to it, with a
 * single commit on `main`. Returns the bare repo's file:// URL,
 * the working repo path (for later mutation tests), and the sha
 * of the initial commit.
 */
async function makeFixtureRepo(args: {
  pluginExports: Record<string, string>;
}): Promise<{
  bareUrl: string;
  workdir: string;
  initialSha: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ragdoll-file-url-"));
  const barePath = join(root, "bare.git");
  const workPath = join(root, "work");
  gitOrThrow(["init", "--quiet", "--bare", barePath]);
  gitOrThrow(["init", "--quiet", "-b", "main", workPath]);
  // Write the plugin module(s) into the work dir.
  for (const [name, content] of Object.entries(args.pluginExports)) {
    await writeFile(join(workPath, name), content);
  }
  gitOrThrow(["add", "."], workPath);
  gitOrThrow(["commit", "--quiet", "-m", "initial"], workPath);
  gitOrThrow(["remote", "add", "origin", barePath], workPath);
  gitOrThrow(["push", "--quiet", "origin", "main"], workPath);
  const sha = gitOrThrow(["rev-parse", "HEAD"], workPath).trim();
  return {
    bareUrl: `file://${barePath}`,
    workdir: workPath,
    initialSha: sha,
    cleanup: async () => {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
}

const SKIP = !gitAvailable();
const conditional = SKIP ? test.skip : test;

// ---------------------------------------------------------------------------
// resolveRefToSha against a file:// URL
// ---------------------------------------------------------------------------

conditional("file://: resolveRefToSha resolves `main` to the bare repo's HEAD sha", async () => {
  const fixture = await makeFixtureRepo({
    pluginExports: { "noop.ts": "/* no plugin here */ export const x = 1;\n" }
  });
  try {
    const sha = await resolveRefToSha(fixture.bareUrl, "main");
    assert.equal(sha, fixture.initialSha);
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ensureCommitOnDisk: clone + checkout into a content-addressed dir
// ---------------------------------------------------------------------------

conditional("file://: ensureCommitOnDisk clones into <cacheDir>/<repoId>/<sha>/ and the file is present", async () => {
  const fixture = await makeFixtureRepo({
    pluginExports: {
      "plugin.ts":
        "export const myPlugin = { manifest: { id:'fileplug', name:'F', version:'1.0.0', category:'datasource', description:'' }, execute: async () => ({ outputs: {} }) };\n"
    }
  });
  const cacheDir = await mkdtemp(join(tmpdir(), "ragdoll-cache-"));
  try {
    const fetched = await ensureCommitOnDisk({
      repoId: "file-fixture",
      gitUrl: fixture.bareUrl,
      sha: fixture.initialSha,
      cacheDir
    });
    assert.equal(fetched.commitSha, fixture.initialSha);
    assert.equal(
      fetched.workingCopyPath,
      join(cacheDir, "file-fixture", fixture.initialSha)
    );
    // The plugin source file is present at the working copy.
    const text = await readFile(
      join(fetched.workingCopyPath, "plugin.ts"),
      "utf8"
    );
    assert.match(text, /myPlugin/);
  } finally {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

conditional("file://: ensureCommitOnDisk is a no-op on a second call (sha-keyed cache)", async () => {
  const fixture = await makeFixtureRepo({
    pluginExports: { "x.txt": "hello\n" }
  });
  const cacheDir = await mkdtemp(join(tmpdir(), "ragdoll-cache-"));
  try {
    const a = await ensureCommitOnDisk({
      repoId: "noop-cache",
      gitUrl: fixture.bareUrl,
      sha: fixture.initialSha,
      cacheDir
    });
    // Touch the cached file to PROVE the second call doesn't
    // re-clone (a re-clone would overwrite our marker).
    await writeFile(join(a.workingCopyPath, ".marker"), "1");
    const b = await ensureCommitOnDisk({
      repoId: "noop-cache",
      gitUrl: fixture.bareUrl,
      sha: fixture.initialSha,
      cacheDir
    });
    assert.equal(b.workingCopyPath, a.workingCopyPath);
    const marker = await readFile(
      join(b.workingCopyPath, ".marker"),
      "utf8"
    );
    assert.equal(marker, "1");
  } finally {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --no-hardlinks: mutating the SOURCE bare repo must NOT leak into the cache
// ---------------------------------------------------------------------------

conditional("file://: clone uses --no-hardlinks — touching the source bare repo's objects after clone leaves the cache intact", async () => {
  const fixture = await makeFixtureRepo({
    pluginExports: { "plugin.ts": "export const a = 1;\n" }
  });
  const cacheDir = await mkdtemp(join(tmpdir(), "ragdoll-cache-"));
  try {
    const fetched = await ensureCommitOnDisk({
      repoId: "nohard",
      gitUrl: fixture.bareUrl,
      sha: fixture.initialSha,
      cacheDir
    });
    const cachedPlugin = join(fetched.workingCopyPath, "plugin.ts");
    const before = await readFile(cachedPlugin, "utf8");
    assert.match(before, /a = 1/);
    // Mutate the source: pack-prune all objects and force-push a
    // brand-new commit. With hardlinks ON, the cache's loose
    // objects would be the SAME inode and the working copy could
    // see the change. With --no-hardlinks, the cache is a real
    // copy and unaffected.
    gitOrThrow(["gc", "--prune=now"], fixture.workdir);
    await writeFile(
      join(fixture.workdir, "plugin.ts"),
      "export const a = 999; // mutated\n"
    );
    gitOrThrow(["add", "."], fixture.workdir);
    gitOrThrow(["commit", "--quiet", "-m", "mutate"], fixture.workdir);
    gitOrThrow(["push", "--quiet", "-f", "origin", "main"], fixture.workdir);
    // Re-read the cached working copy — must be unchanged.
    const after = await readFile(cachedPlugin, "utf8");
    assert.equal(after, before, "cached working copy must NOT change when the source repo is mutated post-clone");
  } finally {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end: loadSource against a file:// URL with a plugin export
// ---------------------------------------------------------------------------

conditional("file://: loadSource clones the bare repo, imports the entry module, registers the plugin with `kind: git` provenance + the resolved sha", async () => {
  // Plugin source uses plain JS so we don't have to deal with .ts
  // transformation for the dynamic import — the duck-type is just
  // `{ manifest:{id,...}, execute }`.
  const pluginJs = `
    export const filePlugin = {
      manifest: {
        id: 'file_url_plug',
        name: 'File URL Plug',
        version: '1.0.0',
        category: 'datasource',
        description: 'loaded from a file:// URL'
      },
      execute: async () => ({ outputs: {} })
    };
  `;
  const fixture = await makeFixtureRepo({
    pluginExports: { "index.mjs": pluginJs }
  });
  const cacheDir = await mkdtemp(join(tmpdir(), "ragdoll-cache-"));
  __clearPluginCacheForTests();
  try {
    const registry = new PluginRegistry();
    const status = await loadSource(
      {
        id: "ext-file",
        kind: "git",
        enabled: true,
        gitUrl: fixture.bareUrl,
        ref: fixture.initialSha, // sha as ref → short-circuits ls-remote
        subpath: "index.mjs"
      },
      registry,
      { cacheDir, skipInstall: true }
    );
    assert.equal(status.status, "loaded", `expected loaded, got ${status.status} (${status.error})`);
    assert.equal(status.commitSha, fixture.initialSha);
    assert.equal(status.pluginCount, 1);
    const plugin = registry.get({
      category: "datasource",
      id: "file_url_plug",
      version: "1.0.0"
    });
    assert.ok(plugin, "plugin must be registered");
    // Provenance: kind=git (the loader doesn't have a "file"
    // sub-kind; the URL is just how the bytes arrived). The
    // operator sees the file:// URL on the catalog row and
    // intuits the source.
    assert.equal(plugin?.source?.kind, "git");
    assert.equal(plugin?.source?.commitSha, fixture.initialSha);
    assert.equal(plugin?.source?.gitUrl, fixture.bareUrl);
  } finally {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
