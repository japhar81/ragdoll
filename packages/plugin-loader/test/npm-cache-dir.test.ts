/**
 * npm must NEVER derive its cache from $HOME.
 *
 * Under an arbitrary-UID runtime (OpenShift restricted SCC assigns e.g. uid
 * 1000680000 with no /etc/passwd entry) $HOME resolves to `/`, so npm tries to
 * `mkdir /.npm` on the root filesystem and the install dies:
 *
 *   npm error code EACCES / syscall mkdir / path /.npm
 *
 * This bit EVERY plugin source with a package.json — file:// and git:// alike.
 * `ensureDependenciesInstalled` now pins NPM_CONFIG_CACHE (+ HOME) under the
 * plugin cache root, which is writable by construction because we clone the
 * working copies into it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ensureDependenciesInstalled, npmCacheDir } from "../src/install-deps.ts";

/** Minimal successful-`npm` stub that records the env it was handed. */
function recordingSpawn(seen: { env?: NodeJS.ProcessEnv; cwd?: string }) {
  return ((_cmd: string, _argv: string[], opts: Record<string, unknown>) => {
    seen.env = opts.env as NodeJS.ProcessEnv;
    seen.cwd = opts.cwd as string;
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => proc.emit("close", 0));
    return proc;
  }) as never;
}

async function pluginDirWithPackageJson(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ragdoll-npmcache-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "p" }));
  return dir;
}

test("npm cache is pinned off $HOME — never the filesystem root", async (t) => {
  const prevCache = process.env.NPM_CONFIG_CACHE;
  const prevRoot = process.env.RAGDOLL_PLUGIN_CACHE_DIR;
  const root = await mkdtemp(join(tmpdir(), "ragdoll-cacheroot-"));
  delete process.env.NPM_CONFIG_CACHE;
  process.env.RAGDOLL_PLUGIN_CACHE_DIR = root;
  // npm injects this into anything it spawns (`npm test` — including THIS
  // run) with its own $HOME-derived value. It must not win: on OpenShift that
  // value IS `/.npm`, the very thing we're avoiding. See npmCacheDir().
  process.env.npm_config_cache = "/.npm";
  t.after(async () => {
    if (prevCache === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = prevCache;
    if (prevRoot === undefined) delete process.env.RAGDOLL_PLUGIN_CACHE_DIR;
    else process.env.RAGDOLL_PLUGIN_CACHE_DIR = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  const dir = await pluginDirWithPackageJson();
  const seen: { env?: NodeJS.ProcessEnv } = {};
  const result = await ensureDependenciesInstalled(dir, {
    spawn: recordingSpawn(seen)
  });
  assert.equal(result, "installed");

  const expected = join(root, ".npm");
  // The npm-injected npm_config_cache=/.npm above must NOT have won.
  assert.equal(npmCacheDir(), expected);
  // Both casings are overridden on the way down — npm reads either, and the
  // inherited lowercase one has to be stomped, not merely ignored by us.
  assert.equal(seen.env?.NPM_CONFIG_CACHE, expected);
  assert.equal(seen.env?.npm_config_cache, expected);
  // The actual OpenShift failure: HOME=/ → npm mkdir /.npm → EACCES.
  assert.equal(seen.env?.HOME, expected);
  assert.notEqual(seen.env?.HOME, "/");

  await rm(dir, { recursive: true, force: true });
});

test("an operator-set NPM_CONFIG_CACHE is honored verbatim", async (t) => {
  const prev = process.env.NPM_CONFIG_CACHE;
  const custom = await mkdtemp(join(tmpdir(), "ragdoll-opnpm-"));
  process.env.NPM_CONFIG_CACHE = custom;
  t.after(async () => {
    if (prev === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = prev;
    await rm(custom, { recursive: true, force: true });
  });

  const dir = await pluginDirWithPackageJson();
  const seen: { env?: NodeJS.ProcessEnv } = {};
  await ensureDependenciesInstalled(dir, { spawn: recordingSpawn(seen) });

  assert.equal(npmCacheDir(), custom);
  assert.equal(seen.env?.NPM_CONFIG_CACHE, custom);

  await rm(dir, { recursive: true, force: true });
});

test("an uncreatable cache dir fails loud, naming the knob to set", async (t) => {
  const prev = process.env.NPM_CONFIG_CACHE;
  // /proc is real but not writable — mkdir under it fails on Linux and macOS.
  process.env.NPM_CONFIG_CACHE = "/proc/ragdoll-cannot-create-this";
  t.after(() => {
    if (prev === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = prev;
  });

  const dir = await pluginDirWithPackageJson();
  await assert.rejects(
    () => ensureDependenciesInstalled(dir, { spawn: recordingSpawn({}) }),
    /not creatable.*RAGDOLL_PLUGIN_CACHE_DIR|NPM_CONFIG_CACHE/s
  );
  await rm(dir, { recursive: true, force: true });
});
