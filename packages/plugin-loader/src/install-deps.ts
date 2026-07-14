/**
 * PLUGIN-ARCH-1 close-out: dependency install.
 *
 * A repo plugin's working copy is a bare git checkout — if its
 * module `import`s an npm package (e.g. `lodash`), the dynamic
 * `import()` step fails with `ERR_MODULE_NOT_FOUND`. The lifecycle's
 * per-source isolation surfaces that as `failed{stage:'import'}`,
 * but the plugin can't actually load. We close the gap with an
 * install step BETWEEN clone and import, content-addressed exactly
 * like the clone — once per `(repoId, sha)`. A subsequent refresh
 * for the same sha skips the install (marker file present) so it's
 * paid once per commit, matching the cache discipline.
 *
 * KISS safety:
 *
 *   - `--ignore-scripts` is the default. Plugins that need
 *     lifecycle scripts are a future opt-in (named in ADR-0034 as
 *     a trust-tier concern). Most plugins don't need them; the
 *     reduction in attack surface is one flag for almost no cost.
 *   - `--omit=dev` so test/dev deps aren't pulled into the working
 *     copy at sync time.
 *   - `--no-audit --no-fund` so the install doesn't try to phone
 *     home, get rate-limited, or print noise into the trace.
 *   - Hard timeout, env-overridable. A hung registry / metro can't
 *     wedge a refresh.
 *
 * Trust boundary (named, not enforced here): postinstall scripts
 * are deliberately disabled via `--ignore-scripts` to keep the KISS
 * floor honest. The richer trust tier (signature → tier policy) is
 * the next ADR; for now: install works, scripts don't run.
 */

import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultCacheDir } from "./git-fetcher.ts";

/**
 * Where npm keeps its cache (and its `_logs`) for OUR installs.
 *
 * npm derives the cache from `$HOME` (`$HOME/.npm`). Under an arbitrary-UID
 * runtime — OpenShift's restricted SCC assigns e.g. uid 1000680000 with no
 * /etc/passwd entry — `$HOME` resolves to `/`, so npm tries to mkdir `/.npm`
 * on the (root-owned) filesystem root and dies:
 *
 *   npm error code EACCES / syscall mkdir / path /.npm
 *
 * That has nothing to do with the plugin source: it bites every plugin with a
 * package.json, file:// or git://. Pin the cache next to the plugin working
 * copies instead — that root is somewhere we already clone into, so it is
 * writable by construction, and one env var (RAGDOLL_PLUGIN_CACHE_DIR) keeps
 * cache + working copies on the same volume.
 *
 * Honors an operator-set NPM_CONFIG_CACHE verbatim.
 *
 * Deliberately does NOT read the lowercase `npm_config_cache`: npm injects
 * that into every process it spawns (`npm start`, `npm test`, …) and sets it
 * to npm's OWN $HOME-derived default — i.e. exactly the `/.npm` we are here to
 * avoid. Honoring it would silently reintroduce this bug for anyone who
 * launches the worker through an npm script. The uppercase name is the one an
 * operator actually sets (container env); the lowercase one is npm talking to
 * itself, and we override it on the way down.
 */
export function npmCacheDir(): string {
  return process.env.NPM_CONFIG_CACHE ?? join(defaultCacheDir(), ".npm");
}

/** Default install timeout — 5 minutes covers everything but a
 *  pathologically slow registry. Env-overridable so an operator on
 *  a slow link can lift it. */
export const DEFAULT_INSTALL_TIMEOUT_MS = (() => {
  const raw = process.env.RAGDOLL_PLUGIN_INSTALL_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();

/** Sentinel file the lifecycle drops into the working copy after a
 *  successful install. Its presence is what makes a refresh-for-the-
 *  same-sha a no-op. We use a file (not just `node_modules`) because
 *  a partial install can leave `node_modules` half-populated — the
 *  marker is written LAST so it never lies. */
export const INSTALL_MARKER_BASENAME = ".ragdoll-installed";

/** Stage seam — surfaces up to the lifecycle's `errorStage` union as
 *  `install` so the refresh report's per-source status can tell
 *  install failures apart from clone / import / scan. */
export class InstallError extends Error {
  readonly stage: "install";
  readonly stderrTail?: string;
  constructor(message: string, stderrTail?: string) {
    super(message);
    this.name = "InstallError";
    this.stage = "install";
    this.stderrTail = stderrTail;
  }
}

export interface InstallOpts {
  /** Override the timeout (ms). */
  timeoutMs?: number;
  /** Test seam — swap out `child_process.spawn`. The default uses
   *  the real `npm` binary. */
  spawn?: typeof spawn;
}

/**
 * Run an install in `workingCopy` if it has a `package.json` AND the
 * sentinel marker isn't already present. Returns one of:
 *
 *   - `"installed"`     — install ran successfully; marker written
 *   - `"already-cached"`— marker present; install skipped (no-op)
 *   - `"not-needed"`    — no `package.json`; install skipped (no-op)
 *
 * Throws `InstallError` on any failure; the lifecycle catches it
 * and produces `failed{stage:'install'}` with the stderr tail on the
 * source status.
 */
export async function ensureDependenciesInstalled(
  workingCopy: string,
  opts: InstallOpts = {}
): Promise<"installed" | "already-cached" | "not-needed"> {
  // 1. No package.json → nothing to do. (A plugin that needs no
  //    third-party deps stays a single .ts file with the manifest
  //    + execute — the SDK is duck-typed so they don't even import
  //    @ragdoll/plugin-sdk.)
  const pkgPath = join(workingCopy, "package.json");
  if (!(await pathExists(pkgPath))) return "not-needed";

  // 2. Marker present → install already happened for this sha.
  //    Content-addressed cache: cheap.
  const markerPath = join(workingCopy, INSTALL_MARKER_BASENAME);
  if (await pathExists(markerPath)) return "already-cached";

  // 3. Decide install command. Prefer `npm ci` when a lockfile
  //    is present (exact-match, refuses to rewrite the lockfile);
  //    fall through to `npm install` otherwise.
  const hasLockfile =
    (await pathExists(join(workingCopy, "package-lock.json"))) ||
    (await pathExists(join(workingCopy, "npm-shrinkwrap.json")));
  const subcmd = hasLockfile ? "ci" : "install";
  const argv = [
    subcmd,
    "--omit=dev",
    // KISS: lifecycle scripts disabled by default. The richer trust
    // tier opens this back up per-source if/when needed.
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    // npm pre-9 emits a non-fatal warning when `npm ci` finds an
    // unused dep in a lockfile; the warning is loud and the install
    // still succeeds. Quiet it.
    "--loglevel=error"
  ];

  const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const spawnFn = opts.spawn ?? spawn;
  // Create the cache dir up-front. npm would create it itself, but only if it
  // can — pre-creating it turns a would-be EACCES deep inside npm into a plain
  // InstallError naming the directory we tried to use.
  const cacheDir = npmCacheDir();
  try {
    await mkdir(cacheDir, { recursive: true });
  } catch (e) {
    throw new InstallError(
      `npm cache dir ${cacheDir} is not creatable: ${(e as Error).message}. ` +
        `Set RAGDOLL_PLUGIN_CACHE_DIR (or NPM_CONFIG_CACHE) to a writable path.`
    );
  }
  // stderr is captured by runNpm but only emitted on failure (the
  // throw path) so a chatty install doesn't pollute the trace.
  await runNpm({ argv, cwd: workingCopy, timeoutMs, spawn: spawnFn, cacheDir });

  // 4. Drop the marker LAST. A crash mid-install leaves no marker,
  //    so the next refresh retries cleanly.
  await writeFile(
    markerPath,
    JSON.stringify(
      {
        version: 1,
        installedAt: new Date().toISOString(),
        subcommand: subcmd
      },
      null,
      2
    )
  );
  return "installed";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface RunNpmArgs {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  spawn: typeof spawn;
  /** Writable npm cache — see `npmCacheDir()`. */
  cacheDir: string;
}

function runNpm(args: RunNpmArgs): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = args.spawn("npm", args.argv, {
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Prevent the npm config from picking up an operator-set
        // global registry or auth token from $HOME — installs run
        // against the public default unless the operator pre-set
        // ENV vars (which we honor). This is belt-and-braces; the
        // sidecar / worker images are minimal.
        NPM_CONFIG_USERCONFIG: process.env.NPM_CONFIG_USERCONFIG ?? "",
        // Never let npm derive its cache from $HOME. Under an arbitrary-UID
        // runtime (OpenShift restricted SCC) the uid has no passwd entry, so
        // $HOME is `/` and npm dies with EACCES trying to mkdir /.npm. Both
        // vars are set because npm reads either casing, and HOME is pinned
        // too so anything else npm resolves relative to it (notably _logs)
        // also lands somewhere writable rather than on `/`.
        NPM_CONFIG_CACHE: args.cacheDir,
        npm_config_cache: args.cacheDir,
        HOME: args.cacheDir,
        // Refuse the install loud when the registry isn't reachable
        // rather than retrying forever inside the child.
        NPM_CONFIG_FETCH_RETRIES: "1",
        NPM_CONFIG_FETCH_RETRY_FACTOR: "1"
      }
    });
    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, args.timeoutMs);
    proc.stdout?.on("data", (c: Buffer) => stdoutBufs.push(c));
    proc.stderr?.on("data", (c: Buffer) => stderrBufs.push(c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new InstallError(`spawn npm ${args.argv.join(" ")} failed: ${e.message}`)
      );
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrBufs).toString("utf8");
      if (killed) {
        reject(
          new InstallError(
            `npm ${args.argv[0]} timed out after ${args.timeoutMs}ms`,
            stderr.slice(-2048)
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new InstallError(
            `npm ${args.argv[0]} exited ${code}`,
            stderr.slice(-2048)
          )
        );
        return;
      }
      resolve(Buffer.concat(stdoutBufs).toString("utf8"));
    });
  });
}
