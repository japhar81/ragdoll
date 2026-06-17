/**
 * PLUGIN-ARCH-1: git fetcher.
 *
 * Resolves a `git_url + ref` to a commit sha and ensures a working
 * copy at that sha exists under `<cacheDir>/<repoId>/<sha>/`. The
 * directory path is content-addressed by the sha — different commits
 * land in different paths, which is what lets the loader rely on
 * Node's ESM-cache-by-URL behaviour without bespoke invalidation
 * (`import("…/sha1/index.ts")` and `import("…/sha2/index.ts")` are
 * distinct cache entries; a new commit is fresh code by construction).
 *
 * Implementation hygiene:
 *
 *   - shells out to the system `git` binary; no jsgit dep
 *   - `git ls-remote` resolves the ref → sha BEFORE clone, so we
 *     never pay for a fetch when the sha is already on disk
 *   - clones with `--depth 1` for the exact sha (since git fetch
 *     supports a sha as a refspec on the modern protocol used by
 *     github/gitlab/bitbucket — fallback to a full clone + checkout
 *     when partial fetch fails)
 *   - if the directory already exists at the resolved sha, the
 *     fetcher is a no-op (the cache layer is the loader's contract)
 *   - errors bubble up as Error subclasses with .stage so the
 *     refresh report can attribute failures cleanly
 */

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where cloned repos live. The cache is content-addressed by sha, so
 * the same dir can hold many commits of the same source without
 * collision. Env-overridable so operators can put it on a faster /
 * larger volume (`RAGDOLL_PLUGIN_CACHE_DIR`).
 */
export function defaultCacheDir(): string {
  return process.env.RAGDOLL_PLUGIN_CACHE_DIR ?? "/tmp/ragdoll-plugin-cache";
}

/** Outcome of a fetch — what the loader needs to drive the import. */
export interface FetchedSource {
  /** Resolved commit sha for the requested ref. */
  commitSha: string;
  /** Absolute path on disk where the working copy lives. The loader
   *  joins `subpath` onto this when dynamic-importing. */
  workingCopyPath: string;
}

/**
 * Stage where a fetch failed — surfaced on the per-source status so
 * the operator sees "resolve ref" vs "clone" vs "verify" without
 * having to parse stderr.
 */
export type FetchStage = "resolve" | "clone" | "verify";

export class GitFetchError extends Error {
  readonly stage: FetchStage;
  readonly underlying?: unknown;
  constructor(message: string, stage: FetchStage, underlying?: unknown) {
    super(message);
    this.name = "GitFetchError";
    this.stage = stage;
    this.underlying = underlying;
  }
}

/**
 * Resolve `ref` (branch / tag / commit-ish) on the remote to its
 * canonical sha. `git ls-remote` is cheap (one round-trip) and
 * doesn't touch the working copy, so we always do this BEFORE
 * touching the cache dir — a sha already on disk skips the clone
 * entirely.
 *
 * When `ref` is already a 40-char sha, this is a one-line shortcut.
 * For other refs we ask the remote and prefer matches in this order:
 *   1) HEAD          (`ref` was "main"/"master"/default)
 *   2) refs/heads/*  (branch)
 *   3) refs/tags/*   (tag — peeled if annotated)
 */
export async function resolveRefToSha(
  gitUrl: string,
  ref: string
): Promise<string> {
  const trimmedRef = ref.trim();
  if (/^[0-9a-f]{40}$/i.test(trimmedRef)) {
    return trimmedRef.toLowerCase();
  }
  let stdout: string;
  try {
    stdout = await runGit(["ls-remote", "--", gitUrl, trimmedRef]);
  } catch (e) {
    throw new GitFetchError(
      `git ls-remote ${gitUrl} ${trimmedRef} failed: ${(e as Error).message}`,
      "resolve",
      e
    );
  }
  const lines = stdout.split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new GitFetchError(
      `ref ${r(trimmedRef)} not found on ${gitUrl}`,
      "resolve"
    );
  }
  // ls-remote output: `<sha>\t<refname>`. Prefer annotated-tag peels
  // (refs ending with `^{}`) when present so we get the tagged commit
  // rather than the tag object.
  const peeled = lines.find((l) => l.endsWith("^{}"));
  const chosen = peeled ?? lines[0];
  const sha = chosen.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new GitFetchError(
      `git ls-remote returned a non-sha first column: ${chosen}`,
      "resolve"
    );
  }
  return sha.toLowerCase();
}

// Tiny pseudo-format helper so the error message above doesn't ship
// raw operator input as a substring (avoids accidental injection into
// downstream rendering); equivalent of JSON-stringifying the value.
function r(v: string): string {
  return JSON.stringify(v);
}

/**
 * Ensure `<cacheDir>/<repoId>/<sha>/` exists with the repo cloned
 * at `sha`. Idempotent: a repeat call on the same `(repoId, sha)`
 * returns immediately without touching git.
 */
export async function ensureCommitOnDisk(args: {
  repoId: string;
  gitUrl: string;
  sha: string;
  cacheDir?: string;
}): Promise<FetchedSource> {
  const cacheDir = args.cacheDir ?? defaultCacheDir();
  if (!/^[A-Za-z0-9_.-]+$/.test(args.repoId)) {
    throw new GitFetchError(
      `repoId ${r(args.repoId)} must be [A-Za-z0-9_.-]+`,
      "verify"
    );
  }
  if (!/^[0-9a-f]{40}$/.test(args.sha)) {
    throw new GitFetchError(
      `sha must be a 40-char lowercase hex string; got ${r(args.sha)}`,
      "verify"
    );
  }
  const repoCacheRoot = join(cacheDir, args.repoId);
  const workingCopyPath = join(repoCacheRoot, args.sha);
  // Fast path: already on disk → no-op.
  if (await dirExists(workingCopyPath)) {
    return { commitSha: args.sha, workingCopyPath };
  }
  await mkdir(repoCacheRoot, { recursive: true });
  // Clone the repo to a tmp dir first, then move into the sha-named
  // dir. Two-step pattern keeps the cache directory atomic — a
  // concurrent reader either sees no `<sha>` dir, or sees one that's
  // fully populated. (Concurrent loads of the same `(repoId, sha)`
  // race the mv into place; the second loser sees EEXIST or an
  // already-good dir and is a no-op.)
  const tmpPath = `${workingCopyPath}.partial-${process.pid}-${nonce()}`;
  try {
    await runGit([
      "clone",
      "--quiet",
      "--no-tags",
      "--filter=blob:none",
      args.gitUrl,
      tmpPath
    ]);
    await runGit(["-C", tmpPath, "fetch", "--depth=1", "origin", args.sha]);
    await runGit(["-C", tmpPath, "checkout", "--quiet", args.sha]);
  } catch (e) {
    throw new GitFetchError(
      `git clone/checkout ${args.gitUrl} @ ${args.sha} failed: ${(e as Error).message}`,
      "clone",
      e
    );
  }
  try {
    const { rename } = await import("node:fs/promises");
    await rename(tmpPath, workingCopyPath);
  } catch (e) {
    // Lost the race? If the final path now exists, accept it.
    if (await dirExists(workingCopyPath)) {
      // best-effort cleanup of the partial
      try {
        const { rm } = await import("node:fs/promises");
        await rm(tmpPath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else {
      throw new GitFetchError(
        `rename ${tmpPath} → ${workingCopyPath} failed: ${(e as Error).message}`,
        "clone",
        e
      );
    }
  }
  return { commitSha: args.sha, workingCopyPath };
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function nonce(): string {
  // Cheap unique suffix without pulling in crypto. Process-pid is
  // already prefixed; counter handles same-process races.
  nonceCounter += 1;
  return `${nonceCounter}-${process.hrtime.bigint().toString(36)}`;
}
let nonceCounter = 0;

/**
 * Run `git` with the given args. Returns stdout. Throws on non-zero
 * exit with the stderr text in the message. Five-second hard timeout
 * on the resolve step is generous for ls-remote; clones can take much
 * longer so we don't set one (the refresh endpoint has its own
 * deadline).
 */
function runGit(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (c) => stdout.push(c));
    proc.stderr.on("data", (c) => stderr.push(c));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        const err = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`git ${args[0]} exited ${code}: ${err || "(no stderr)"}`));
      }
    });
  });
}
