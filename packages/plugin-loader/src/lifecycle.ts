/**
 * PLUGIN-ARCH-1: per-source plugin load lifecycle.
 *
 * Each `PluginSource` becomes a sequence of steps:
 *
 *   1. (git only) resolve `ref` → `sha` on the remote
 *   2. (git only) ensure `<cacheDir>/<repoId>/<sha>/` exists
 *   3. compute the import target (built-in: in-tree module; git:
 *      working-copy + subpath)
 *   4. dynamic-import the entry module
 *   5. scan its exports with `isInProcessPlugin` /
 *      `isConnectionDriverPlugin` (the existing duck-types — the
 *      contract is unchanged) and register each into a fresh
 *      `PluginRegistry`, stamping `RegisteredPlugin.source`
 *      provenance.
 *
 * The output is a `SourceLoadStatus` per source so the refresh
 * report can show the operator added/updated/failed sources at a
 * glance, AND a tally of how many plugins each source contributed.
 *
 * Per-source isolation: any step throwing produces a `failed` status
 * with the stage + message — it does NOT crash the load. The other
 * sources are independent and proceed.
 *
 * ESM-cache correctness: a git source's working copy lives at a
 * sha-named path. Different commits = different paths = different
 * import URLs = different ESM cache entries → no stale code. The
 * fast-path "sha unchanged since last load" returns immediately
 * without re-importing.
 */

import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  PluginRegistry,
  type InProcessPlugin,
  type PluginSourceProvenance,
  type RegisteredPlugin
} from "../../plugin-sdk/src/index.ts";
import {
  isConnectionDriverPlugin,
  registerConnectionDriverPlugin
} from "../../external-connections/src/index.ts";
import {
  ensureCommitOnDisk,
  GitFetchError,
  resolveRefToSha
} from "./git-fetcher.ts";
import { ensureDependenciesInstalled, InstallError } from "./install-deps.ts";
import {
  verifyCommitSignature,
  SignatureVerifyError,
  type VerifyResult
} from "./verify-signature.ts";
import {
  BUILTIN_SOURCE_ID,
  SAMPLE_TEXT_SOURCE_ID,
  type PluginSource
} from "./sources.ts";

/**
 * Outcome of loading one source. `failed` carries the stage so the
 * UI can tell "couldn't reach the git remote" apart from "exported
 * something that wasn't a plugin."
 */
export interface SourceLoadStatus {
  id: string;
  kind: "local" | "git";
  status: "loaded" | "skipped" | "failed";
  /** Resolved commit sha (git only) — present even on `failed` when
   *  the failure was after the resolve step. */
  commitSha?: string;
  /** Operator-supplied ref (git only). */
  ref?: string;
  /** Number of plugins registered from this source. 0 when failed. */
  pluginCount: number;
  /** When the load attempt completed (ISO-8601 UTC). */
  loadedAt: string;
  /** Set when status === "failed" — operator-facing reason. */
  error?: string;
  /** Set when status === "failed" — what stage broke. */
  errorStage?:
    | "resolve"
    | "clone"
    | "install"
    | "verify"
    | "import"
    | "scan"
    | "register"
    | "disabled";
  /** PLUGIN-ARCH-1 close-out: signature verification result. Present
   *  for git sources where `requireSignature: true`; absent for
   *  sources that don't opt into signing. */
  signatureVerified?: boolean;
  signedBy?: string;
}

/**
 * Strategy seam — how to dynamic-import a module from a working-copy
 * path. Default uses Node's `import()`. Tests inject a stub so they
 * can exercise the lifecycle without filesystem state.
 */
export type ImportFn = (specifier: string) => Promise<Record<string, unknown>>;

const realImport: ImportFn = (specifier) =>
  import(specifier) as Promise<Record<string, unknown>>;

/**
 * Cache of {repoId → sha → already-loaded plugin list}. A refresh
 * for an unchanged sha hits this cache and skips the re-import,
 * matching the user's "unchanged sha is a true no-op" requirement.
 *
 * Process-global state — same shape as Node's ESM cache lives
 * alongside (the ESM cache holds the modules, this holds our
 * already-extracted RegisteredPlugin objects so the refresh path
 * doesn't have to re-scan the module's exports).
 */
interface PluginCacheEntry {
  plugins: RegisteredPlugin[];
  /** Captured at first-successful-load and replayed on subsequent
   *  cache hits — install + verify are deterministic for a given
   *  sha, so the cached envelope is honest. */
  verify?: VerifyResult;
}

const pluginCache = new Map<string, PluginCacheEntry>();

function cacheKey(repoId: string, commitSha: string | undefined): string {
  return `${repoId}@${commitSha ?? "local"}`;
}

/** Test seam — clear the in-process plugin cache. */
export function __clearPluginCacheForTests(): void {
  pluginCache.clear();
}

export interface LoadOpts {
  /** Inject a custom `import()` (test seam). */
  importFn?: ImportFn;
  /** Override the cache root for git fetches (test seam). */
  cacheDir?: string;
  /** Skip the actual git fetch (test seam) — the lifecycle uses
   *  the resolved sha but does not touch the filesystem. */
  skipFetch?: boolean;
  /** Override how built-in sources resolve their import target.
   *  Test fixtures point this at a path-shape that exists in the
   *  test environment. */
  resolveBuiltinPath?: (source: PluginSource) => string;
  /** PLUGIN-ARCH-1 close-out: test seam for the npm-install step.
   *  Default: real `ensureDependenciesInstalled` from
   *  install-deps.ts. Tests inject a stub that simulates install
   *  success / failure without actually spawning npm. */
  installFn?: (workingCopy: string) => Promise<void>;
  /** Skip the install step entirely (test seam). Used by tests
   *  that exercise non-install code paths without writing a fake
   *  package.json into the working copy. */
  skipInstall?: boolean;
  /** PLUGIN-ARCH-1 close-out: test seam for the git verify-commit
   *  step. Default: real `verifyCommitSignature` from
   *  verify-signature.ts. */
  verifyFn?: (args: {
    workingCopy: string;
    sha: string;
    allowedSigners: string;
  }) => Promise<VerifyResult>;
}

/**
 * Load one source into `registry`. Returns the per-source status.
 * NEVER throws on a per-source failure — the status carries the
 * error and the caller proceeds to the next source.
 */
export async function loadSource(
  source: PluginSource,
  registry: PluginRegistry,
  opts: LoadOpts = {}
): Promise<SourceLoadStatus> {
  const loadedAt = new Date().toISOString();
  if (!source.enabled) {
    return {
      id: source.id,
      kind: source.kind,
      status: "skipped",
      pluginCount: 0,
      loadedAt,
      errorStage: "disabled"
    };
  }

  // -------------------------- resolve target path / sha
  let commitSha: string | undefined;
  let importTarget: string;
  let workingCopyPath: string | undefined;
  let verifyResult: VerifyResult | undefined;
  try {
    if (source.kind === "git") {
      const gitUrl = source.gitUrl;
      const ref = source.ref ?? "main";
      if (!gitUrl) {
        return failed(source, "verify", "git source has no gitUrl", loadedAt);
      }
      // Resolve ref → sha. Failure here is a `resolve` stage error.
      let sha: string;
      try {
        sha = await resolveRefToSha(gitUrl, ref);
      } catch (e) {
        const stage =
          e instanceof GitFetchError ? e.stage : "resolve";
        return failed(source, stage, (e as Error).message, loadedAt, { ref });
      }
      commitSha = sha;
      // Ensure the working copy exists. Test mode (`skipFetch`)
      // synthesises a path that the import stub knows how to handle
      // AND sets `workingCopyPath` to that same synthetic path so the
      // install + verify branches downstream still fire — tests
      // exercise the full lifecycle by injecting `installFn` /
      // `verifyFn` stubs that recognise the `__memory__/` prefix.
      if (opts.skipFetch) {
        const syntheticPath = `__memory__/${source.id}/${sha}/${source.subpath ?? ""}`;
        importTarget = syntheticPath;
        workingCopyPath = syntheticPath;
      } else {
        try {
          const fetched = await ensureCommitOnDisk({
            repoId: source.id,
            gitUrl,
            sha,
            cacheDir: opts.cacheDir
          });
          workingCopyPath = fetched.workingCopyPath;
          importTarget = resolvePath(workingCopyPath, source.subpath ?? "");
        } catch (e) {
          const stage =
            e instanceof GitFetchError ? e.stage : "clone";
          return failed(source, stage, (e as Error).message, loadedAt, {
            ref,
            commitSha: sha
          });
        }
      }
    } else {
      // Built-in / local source. Map the well-known ids to the in-tree
      // module paths via the override (the runtime never has a
      // fileURL for the in-source TS modules — they're imported by
      // the calling Node process from a fixed location).
      if (opts.resolveBuiltinPath) {
        importTarget = opts.resolveBuiltinPath(source);
      } else if (source.id === BUILTIN_SOURCE_ID) {
        importTarget = builtinRagImportTarget();
      } else if (source.id === SAMPLE_TEXT_SOURCE_ID) {
        importTarget = sampleTextImportTarget();
      } else {
        return failed(
          source,
          "verify",
          `local source ${source.id} has no known in-tree path; pass resolveBuiltinPath`,
          loadedAt
        );
      }
    }
  } catch (e) {
    return failed(source, "verify", (e as Error).message, loadedAt);
  }

  // -------------------------- cache hit?
  // Both install + verify are deterministic for a given sha; if
  // we've already loaded this (repoId, sha) successfully this
  // process, the cache replays the same plugin set + the same
  // verify metadata. A refresh-against-unchanged-sha is a no-op
  // for install AND verify — the operator sees the
  // signed-by / signatureVerified replay from the original load.
  const key = cacheKey(source.id, commitSha);
  const cached = pluginCache.get(key);
  if (cached) {
    for (const p of cached.plugins) registry.register(p);
    return {
      id: source.id,
      kind: source.kind,
      status: "loaded",
      commitSha,
      ref: source.ref,
      pluginCount: cached.plugins.length,
      loadedAt,
      ...(cached.verify
        ? {
            signatureVerified: cached.verify.signatureVerified,
            ...(cached.verify.signedBy
              ? { signedBy: cached.verify.signedBy }
              : {})
          }
        : {})
    };
  }

  // -------------------------- verify (KISS: opt-in per source)
  // PLUGIN-ARCH-1 close-out Build 2. Runs in the existing `verify`
  // stage AFTER the cache check (so a cache hit replays the prior
  // verify result via `cached.verify`) but BEFORE install (so an
  // untrusted source never triggers `npm install`). A
  // bad/missing/untrusted signature is `failed{stage:'verify'}`;
  // the plugin never reaches scan/register.
  if (
    source.kind === "git" &&
    source.requireSignature === true &&
    workingCopyPath !== undefined &&
    commitSha !== undefined
  ) {
    const allowed = source.allowedSigners ?? "";
    if (!allowed.trim()) {
      return failed(
        source,
        "verify",
        `requireSignature is true but allowedSigners is empty — populate the per-source signer list before re-enabling verification`,
        loadedAt,
        { ref: source.ref, commitSha }
      );
    }
    try {
      const verifyFn = opts.verifyFn ?? verifyCommitSignature;
      verifyResult = await verifyFn({
        workingCopy: workingCopyPath,
        sha: commitSha,
        allowedSigners: allowed
      });
    } catch (e) {
      const msg = e instanceof SignatureVerifyError
        ? `${e.message}: ${e.stderrTail ?? "(no stderr)"}`
        : (e as Error).message;
      return failed(source, "verify", msg, loadedAt, {
        ref: source.ref,
        commitSha
      });
    }
  }

  // -------------------------- install (KISS: per-sha cached)
  // PLUGIN-ARCH-1 close-out Build 1. Runs AFTER verify (so an
  // untrusted source never reaches `npm install`) but BEFORE
  // import (so the plugin's transitive deps resolve). Idempotent
  // by `<workingCopy>/.ragdoll-installed` — re-runs that hit the
  // marker are a no-op.
  if (
    source.kind === "git" &&
    !opts.skipInstall &&
    workingCopyPath !== undefined
  ) {
    const installFn =
      opts.installFn ??
      (async (wc: string) => {
        await ensureDependenciesInstalled(wc);
      });
    try {
      await installFn(workingCopyPath);
    } catch (e) {
      const msg = e instanceof InstallError
        ? `${e.message}: ${e.stderrTail ?? "(no stderr)"}`
        : (e as Error).message;
      return failed(source, "install", msg, loadedAt, {
        ref: source.ref,
        commitSha
      });
    }
  }

  // -------------------------- import
  let moduleNs: Record<string, unknown>;
  try {
    const importFn = opts.importFn ?? realImport;
    moduleNs = await importFn(toImportSpecifier(importTarget));
  } catch (e) {
    return failed(source, "import", (e as Error).message, loadedAt, {
      ref: source.ref,
      commitSha
    });
  }

  // -------------------------- scan + register (provenance-stamped)
  const provenance: PluginSourceProvenance = {
    repoId: source.id,
    kind: source.kind,
    gitUrl: source.gitUrl,
    ref: source.ref,
    commitSha,
    subpath: source.subpath || undefined,
    loadedAt,
    ...(verifyResult
      ? {
          signatureVerified: verifyResult.signatureVerified,
          ...(verifyResult.signedBy ? { signedBy: verifyResult.signedBy } : {})
        }
      : {})
  };
  let registered: RegisteredPlugin[];
  try {
    registered = scanAndRegister(moduleNs, provenance);
  } catch (e) {
    return failed(source, "scan", (e as Error).message, loadedAt, {
      ref: source.ref,
      commitSha
    });
  }
  try {
    for (const p of registered) registry.register(p);
  } catch (e) {
    return failed(source, "register", (e as Error).message, loadedAt, {
      ref: source.ref,
      commitSha
    });
  }

  pluginCache.set(key, { plugins: registered, verify: verifyResult });
  return {
    id: source.id,
    kind: source.kind,
    status: "loaded",
    commitSha,
    ref: source.ref,
    pluginCount: registered.length,
    loadedAt,
    ...(verifyResult
      ? {
          signatureVerified: verifyResult.signatureVerified,
          ...(verifyResult.signedBy ? { signedBy: verifyResult.signedBy } : {})
        }
      : {})
  };
}

/**
 * Walk a module's exports and produce `RegisteredPlugin` rows for
 * every duck-typed plugin or connection-driver plugin. Stamps
 * `source` provenance on each emitted row.
 *
 * NOTE: connection drivers register themselves into the imperative
 * driver registry (the legacy contract — see ADR-0024). The
 * `RegisteredPlugin` row returned for a driver has its mode set to
 * `in_process` but no `implementation` — they don't appear in
 * /api/plugins. We still emit them so the source-status pluginCount
 * is honest.
 */
function scanAndRegister(
  moduleNs: Record<string, unknown>,
  source: PluginSourceProvenance
): RegisteredPlugin[] {
  const out: RegisteredPlugin[] = [];
  for (const exported of Object.values(moduleNs)) {
    if (isConnectionDriverPlugin(exported)) {
      // Register into the imperative driver registry (the established
      // contract). We don't put drivers into the PluginRegistry list
      // because /api/plugins explicitly excludes them.
      registerConnectionDriverPlugin(exported);
      continue;
    }
    if (!isInProcessPlugin(exported)) continue;
    const plugin = exported;
    out.push({
      mode: "in_process",
      manifest: plugin.manifest,
      implementation: plugin,
      source
    });
  }
  return out;
}

function isInProcessPlugin(value: unknown): value is InProcessPlugin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { manifest?: unknown; execute?: unknown };
  if (typeof candidate.execute !== "function") return false;
  const manifest = candidate.manifest as { id?: unknown } | undefined;
  if (!manifest || typeof manifest !== "object") return false;
  return typeof (manifest as { id?: unknown }).id === "string";
}

function failed(
  source: PluginSource,
  stage: SourceLoadStatus["errorStage"],
  message: string,
  loadedAt: string,
  extra: { ref?: string; commitSha?: string } = {}
): SourceLoadStatus {
  return {
    id: source.id,
    kind: source.kind,
    status: "failed",
    ref: extra.ref ?? source.ref,
    commitSha: extra.commitSha,
    pluginCount: 0,
    loadedAt,
    error: message,
    errorStage: stage
  };
}

function toImportSpecifier(absPath: string): string {
  // Test seam: `__memory__/...` is recognised by the stub importer.
  if (absPath.startsWith("__memory__/")) return absPath;
  return pathToFileURL(absPath).href;
}

// In-tree module-path helpers. Resolved relative to THIS file so the
// runtime (workspace) finds the source modules without an env var.
// External operators who care can override via `resolveBuiltinPath`
// in `LoadOpts`.
function builtinRagImportTarget(): string {
  return resolvePath(import.meta.dirname, "../../../plugins/builtin-rag/src/index.ts");
}
function sampleTextImportTarget(): string {
  return resolvePath(import.meta.dirname, "../../../plugins/sample-text/index.ts");
}
