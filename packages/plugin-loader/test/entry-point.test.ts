/**
 * A git plugin source whose `subpath` names a DIRECTORY (empty, or a folder
 * like "plugins") must load. `importTarget` is then `<workingCopy>/<subpath>`,
 * a directory — and Node's ESM loader has no directory-import fallback (unlike
 * CJS's implicit `/index.js`), so `import(dir)` throws:
 *
 *   Directory import '…/<sha>/plugins' is not supported resolving ES modules
 *
 * `resolveEntryPoint()` turns the directory into an explicit entry file before
 * the import. These tests pin every branch of that resolution against a REAL
 * file:// clone driven through the full `loadSource` lifecycle — the exact
 * path the reported bug took.
 *
 * Skipped automatically when `git` isn't on PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { __clearPluginCacheForTests, loadSource } from "../src/lifecycle.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}
const conditional = gitAvailable() ? test : test.skip;

function git(args: string[], cwd?: string): void {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid"
    }
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
}

/** A plugin module exporting a single duck-typed plugin with the given id. */
function pluginModule(id: string): string {
  return (
    `export const ${id} = { manifest: { id: ${JSON.stringify(id)}, ` +
    `name: ${JSON.stringify(id)}, version: "1.0.0", category: "transformer", ` +
    `description: "t" }, execute: async () => ({ outputs: {} }) };\n`
  );
}

/** Build a bare repo whose single commit contains `files` (paths relative to
 *  the repo root, nested dirs created as needed). Returns the file:// URL. */
async function makeRepo(files: Record<string, string>): Promise<{
  url: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ragdoll-entry-"));
  const bare = join(root, "bare.git");
  const work = join(root, "work");
  git(["init", "--quiet", "--bare", bare]);
  git(["init", "--quiet", "-b", "main", work]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(work, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  git(["add", "."], work);
  git(["commit", "--quiet", "-m", "init"], work);
  git(["remote", "add", "origin", bare], work);
  git(["push", "--quiet", "origin", "main"], work);
  return {
    url: `file://${bare}`,
    cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {})
  };
}

async function load(url: string, subpath: string) {
  __clearPluginCacheForTests();
  const registry = new PluginRegistry();
  const cacheDir = await mkdtemp(join(tmpdir(), "ragdoll-entrycache-"));
  const status = await loadSource(
    { id: "s", kind: "git", enabled: true, gitUrl: url, ref: "main", subpath },
    registry,
    { cacheDir, skipInstall: true }
  );
  const ids = (registry.list?.() ?? []).map((p) => p.manifest.id);
  return { status, ids };
}

conditional("subpath names a directory → resolves index.ts (the reported bug)", async () => {
  const repo = await makeRepo({ "plugins/index.ts": pluginModule("demo") });
  try {
    const { status, ids } = await load(repo.url, "plugins");
    assert.equal(status.status, "loaded", status.error);
    assert.deepEqual(ids, ["demo"]);
  } finally {
    await repo.cleanup();
  }
});

conditional("empty subpath → resolves a root-level index.ts", async () => {
  const repo = await makeRepo({ "index.ts": pluginModule("rootplug") });
  try {
    const { status, ids } = await load(repo.url, "");
    assert.equal(status.status, "loaded", status.error);
    assert.deepEqual(ids, ["rootplug"]);
  } finally {
    await repo.cleanup();
  }
});

conditional("package.json main wins over index probes", async () => {
  const repo = await makeRepo({
    "pkg/package.json": JSON.stringify({ type: "module", main: "dist/entry.js" }),
    "pkg/dist/entry.js": pluginModule("mainplug")
  });
  try {
    const { status, ids } = await load(repo.url, "pkg");
    assert.equal(status.status, "loaded", status.error);
    assert.deepEqual(ids, ["mainplug"]);
  } finally {
    await repo.cleanup();
  }
});

conditional("package.json exports import-condition is honored", async () => {
  const repo = await makeRepo({
    "e/package.json": JSON.stringify({
      type: "module",
      exports: { ".": { import: "./lib/e.mjs" } }
    }),
    "e/lib/e.mjs": pluginModule("expplug")
  });
  try {
    const { status, ids } = await load(repo.url, "e");
    assert.equal(status.status, "loaded", status.error);
    assert.deepEqual(ids, ["expplug"]);
  } finally {
    await repo.cleanup();
  }
});

conditional("a subpath naming a file directly still works (extension short-circuit)", async () => {
  const repo = await makeRepo({ "dist/plugin.js": pluginModule("fileplug") });
  try {
    const { status, ids } = await load(repo.url, "dist/plugin.js");
    assert.equal(status.status, "loaded", status.error);
    assert.deepEqual(ids, ["fileplug"]);
  } finally {
    await repo.cleanup();
  }
});

conditional("a directory with no entry point → failed{stage:import} with guidance", async () => {
  const repo = await makeRepo({ "docs/README.md": "# not a plugin\n" });
  try {
    const { status } = await load(repo.url, "docs");
    assert.equal(status.status, "failed");
    assert.equal(status.errorStage, "import");
    assert.match(status.error ?? "", /no ESM entry point/);
    assert.match(status.error ?? "", /index\.js/); // names what it looked for
  } finally {
    await repo.cleanup();
  }
});
